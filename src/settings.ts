import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OssPlugin from "./main";
import { OssClient } from "./oss/client";
import { formatCredentialNotice } from "./oss/errors";

/** 凭证相关字段的草稿缓冲 */
interface CredentialDraft {
  region: string;
  bucketName: string;
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  cname: string;
}

export class OssSettingTab extends PluginSettingTab {
  private draft!: CredentialDraft;

  constructor(app: App, private readonly plugin: OssPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();

    // 初始化草稿为当前已保存值
    this.draft = {
      region: plugin.settings.region,
      bucketName: plugin.settings.bucketName,
      accessKeyId: plugin.settings.accessKeyId,
      accessKeySecret: plugin.settings.accessKeySecret,
      endpoint: plugin.settings.endpoint,
      cname: plugin.settings.cname,
    };

    containerEl.createEl("h2", { text: "阿里云 OSS 配置" });
    containerEl.createEl("p", {
      text: "私有 Bucket + 客户端 V1 签名。AK/SK 明文保存在 data.json，仅限个人使用。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("自动上传")
      .setDesc("关闭后暂停自动上传（粘贴/拖入/落盘不再触发），方便调试或离线编辑")
      .addToggle((t) =>
        t.setValue(plugin.settings.autoUpload).onChange(async (v) => {
          plugin.settings.autoUpload = v;
          await plugin.saveSettings();
          plugin.autoUploadIndicator?.render();
          new Notice(v ? "自动上传已开启" : "自动上传已暂停");
        }),
      );

    // ─── 凭证区域（缓冲，不即时保存） ──────────────────────────────────────

    containerEl.createEl("h3", { text: "OSS 凭证" });
    containerEl.createEl("p", {
      text: "修改后需点击「保存并校验」，校验通过才会持久化。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Region")
      .setDesc("例如 oss-cn-hangzhou")
      .addText((t) =>
        t
          .setPlaceholder("oss-cn-hangzhou")
          .setValue(this.draft.region)
          .onChange((v) => { this.draft.region = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("Bucket")
      .addText((t) =>
        t
          .setPlaceholder("your-bucket")
          .setValue(this.draft.bucketName)
          .onChange((v) => { this.draft.bucketName = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("AccessKey ID")
      .addText((t) =>
        t
          .setValue(this.draft.accessKeyId)
          .onChange((v) => { this.draft.accessKeyId = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("AccessKey Secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.draft.accessKeySecret).onChange((v) => {
          this.draft.accessKeySecret = v.trim();
        });
      });

    new Setting(containerEl)
      .setName("Endpoint（可选）")
      .setDesc("不填则用 {region}.aliyuncs.com")
      .addText((t) =>
        t
          .setPlaceholder("oss-cn-hangzhou.aliyuncs.com")
          .setValue(this.draft.endpoint)
          .onChange((v) => { this.draft.endpoint = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("CNAME（可选）")
      .setDesc("填了会替代 bucket.endpoint，签名规则不变")
      .addText((t) =>
        t
          .setPlaceholder("cdn.example.com")
          .setValue(this.draft.cname)
          .onChange((v) => { this.draft.cname = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("保存并校验")
      .setDesc("向 OSS 发送轻量请求验证凭证有效性，通过后保存")
      .addButton((b) =>
        b.setButtonText("保存并校验").setCta().onClick(async () => {
          await this.saveCredentialsWithVerification();
        }),
      );

    // ─── 其他设置（即时保存，不需要凭证校验） ───────────────────────────────

    containerEl.createEl("h3", { text: "上传设置" });

    new Setting(containerEl)
      .setName("Object Key 前缀")
      .setDesc("上传路径的前缀，默认 vault 名")
      .addText((t) =>
        t
          .setPlaceholder("obsidian/my-vault")
          .setValue(plugin.settings.objectKeyPrefix)
          .onChange(async (v) => {
            plugin.settings.objectKeyPrefix = v.trim().replace(/^\/+|\/+$/g, "");
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("签名 URL 有效期（秒）")
      .setDesc("默认 3600，最大建议 86400")
      .addText((t) =>
        t
          .setValue(String(plugin.settings.signedUrlExpireSeconds))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              plugin.settings.signedUrlExpireSeconds = n;
              await plugin.saveSettings();
              plugin.urlCache.clear();
            }
          }),
      );

    // ─── 维护 ────────────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "维护" });

    new Setting(containerEl)
      .setName("清理孤儿分片")
      .setDesc("Abort 本地和服务端 24h 以上未完成的 MultipartUpload")
      .addButton((b) =>
        b.setButtonText("立即清理").onClick(async () => {
          await plugin.uploadManager.cleanupOrphans();
        }),
      );

    const pendingCount = Object.keys(plugin.settings.pendingUploads).length;
    if (pendingCount > 0) {
      containerEl.createEl("p", {
        text: `当前有 ${pendingCount} 个未完成上传，将在下次同名附件出现时续传或超时清理。`,
        cls: "setting-item-description",
      });
    }
  }

  /**
   * 用草稿值构建临时 OssClient 校验凭证，通过后才写入 settings 并持久化。
   * 失败则 Notice 报错，不保存。
   */
  private async saveCredentialsWithVerification(): Promise<void> {
    const { plugin } = this;
    const { region, bucketName, accessKeyId, accessKeySecret, endpoint, cname } = this.draft;

    if (!bucketName || !accessKeyId || !accessKeySecret) {
      new Notice("请填写 Bucket / AccessKey ID / AccessKey Secret");
      return;
    }

    // 用草稿值构建临时 client 校验
    const tempSettings = { ...plugin.settings, region, bucketName, accessKeyId, accessKeySecret, endpoint, cname };
    const tempClient = new OssClient(tempSettings);

    const notice = new Notice("正在校验凭证…", 0);
    try {
      await tempClient.verifyCredentials();
      // 校验通过，写入 settings
      plugin.settings.region = region;
      plugin.settings.bucketName = bucketName;
      plugin.settings.accessKeyId = accessKeyId;
      plugin.settings.accessKeySecret = accessKeySecret;
      plugin.settings.endpoint = endpoint;
      plugin.settings.cname = cname;
      await plugin.saveSettings();
      // 刷新主 client 实例以使用新凭证
      plugin.client = new OssClient(plugin.settings);
      notice.setMessage("凭证校验通过，已保存");
      setTimeout(() => notice.hide(), 3000);
    } catch (err) {
      notice.setMessage(formatCredentialNotice(err));
      setTimeout(() => notice.hide(), 10000);
    }
  }
}
