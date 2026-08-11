import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OssPlugin from "./main";
import {
  establishedStorageIdentityKey,
  normalizeOssConfig,
  storageIdentityKey,
} from "./config";
import { OssClient } from "./oss/client";
import { formatCredentialNotice } from "./oss/errors";
import { LifecycleQuiescedError } from "./lifecycle";

/** 凭证相关字段的草稿缓冲 */
interface CredentialDraft {
  region: string;
  bucketName: string;
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  objectKeyPrefix: string;
  signedUrlExpireSeconds: string;
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
      objectKeyPrefix: plugin.settings.objectKeyPrefix,
      signedUrlExpireSeconds: String(plugin.settings.signedUrlExpireSeconds),
    };

    containerEl.createEl("h2", { text: "阿里云 OSS 配置" });
    containerEl.createEl("p", {
      text: "私有 Bucket + 客户端 Signature V4。AK/SK 当前明文保存在 data.json，仅限个人使用。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("自动上传")
      .setDesc("关闭后不接管新附件，进行中的自动任务会在下一次网络请求前安全暂停")
      .addToggle((t) =>
        t.setValue(plugin.settings.autoUpload).onChange(async (v) => {
          await this.runWhileActive(async () => {
            const previous = plugin.settings.autoUpload;
            plugin.settings.autoUpload = v;
            try {
              await plugin.saveSettings();
              plugin.autoUploadIndicator?.render();
              new Notice(v ? "自动上传已开启" : "自动上传已暂停");
            } catch (error) {
              plugin.settings.autoUpload = previous;
              t.setValue(previous);
              new Notice(`自动上传设置保存失败：${(error as Error).message}`);
            }
          });
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
      .setDesc("V4 签名地域，例如 cn-hangzhou；旧格式 oss-cn-hangzhou 会自动归一化")
      .addText((t) =>
        t
          .setPlaceholder("cn-hangzhou")
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
      .setDesc("只填标准 OSS hostname；不填则使用 oss-{region}.aliyuncs.com")
      .addText((t) =>
        t
          .setPlaceholder("oss-cn-hangzhou.aliyuncs.com")
          .setValue(this.draft.endpoint)
          .onChange((v) => { this.draft.endpoint = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("Object Key 前缀")
      .setDesc("上传命名空间，默认 Vault 名；不能为空或以 / 开头，也不能含 . / .. 路径段。空格属于真实 Key")
      .addText((t) =>
        t
          .setPlaceholder("My Vault")
          .setValue(this.draft.objectKeyPrefix)
          .onChange((v) => { this.draft.objectKeyPrefix = v; }),
      );

    new Setting(containerEl)
      .setName("签名 URL 有效期（秒）")
      .setDesc("允许 61–604800，默认 3600；插件会在过期前自动续签")
      .addText((t) =>
        t
          .setValue(this.draft.signedUrlExpireSeconds)
          .onChange((v) => { this.draft.signedUrlExpireSeconds = v.trim(); }),
      );

    new Setting(containerEl)
      .setName("保存并校验")
      .setDesc("向 OSS 发送轻量请求验证凭证有效性，通过后保存")
      .addButton((b) =>
        b.setButtonText("保存并校验").setCta().onClick(async () => {
          await this.runWhileActive(() => this.saveCredentialsWithVerification());
        }),
      );

    // ─── 维护 ────────────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "维护" });

    new Setting(containerEl)
      .setName("重试未完成任务")
      .setDesc("继续上传、提交引用或清理本地 staging；移动端也可从这里恢复")
      .addButton((b) =>
        b.setButtonText("立即重试").onClick(async () => {
          await this.runWhileActive(async () => {
            await plugin.retryPendingUploads();
            this.display();
          });
        }),
      );

    new Setting(containerEl)
      .setName("清理孤儿分片")
      .setDesc("仅中止本插件日志中 24h 以上的已知 MultipartUpload；同前缀未知任务只报告、不破坏")
      .addButton((b) =>
        b.setButtonText("立即清理").onClick(async () => {
          await this.runWhileActive(async () => {
            if (!plugin.isConfigured()) {
              new Notice("OSS 配置无效：请先填写并通过保存校验");
              return;
            }
            try {
              await plugin.uploadManager.cleanupOrphans();
              this.display();
            } catch (error) {
              if (error instanceof LifecycleQuiescedError) return;
              console.warn("[oss] 设置页清理孤儿分片失败", error);
              new Notice(`清理失败：${(error as Error).message}`);
            }
          });
        }),
      );

    const pendingCount = Object.keys(plugin.settings.pendingUploads).length;
    if (pendingCount > 0) {
      containerEl.createEl("p", {
        text: `当前有 ${pendingCount} 个未完成任务；可在此重试，超过 24 小时的未完成分片可手动清理。`,
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
    plugin.lifecycle.assertActive("校验并保存 OSS 配置");
    let normalized;
    try {
      const expiry = Number(this.draft.signedUrlExpireSeconds);
      normalized = normalizeOssConfig({
        ...this.draft,
        signedUrlExpireSeconds: expiry,
      });
    } catch (error) {
      new Notice((error as Error).message);
      return;
    }

    const identityChanged = this.storageIdentityChanged(normalized);
    if (identityChanged) {
      const pendingCount = Object.keys(plugin.settings.pendingUploads).length;
      if (pendingCount > 0) {
        new Notice(`仍有 ${pendingCount} 个未完成任务：请先恢复原存储配置并完成任务`);
        return;
      }
      if (establishedStorageIdentityKey(plugin.settings) !== null) {
        new Notice("已阻止切换存储身份：历史 oss:// 引用不携带 Bucket。当前可轮换 AK 或调整签名有效期；Bucket / Region / Endpoint / 前缀迁移需使用专用迁移流程");
        return;
      }
    }

    // 用草稿值构建临时 client 校验
    const tempSettings = { ...plugin.settings, ...normalized };
    const tempClient = new OssClient(
      tempSettings,
      undefined,
      undefined,
      () => plugin.lifecycle.assertActive("发送 OSS 凭证探针"),
    );

    const notice = new Notice("正在校验凭证…", 0);
    try {
      await tempClient.verifyCredentials();
    } catch (err) {
      if (err instanceof LifecycleQuiescedError) throw err;
      notice.setMessage(formatCredentialNotice(err));
      setTimeout(() => notice.hide(), 10000);
      return;
    }
    try {
      plugin.lifecycle.assertActive("应用已校验 OSS 配置");
      await plugin.applyVerifiedConfig(normalized);
      this.draft = {
        ...normalized,
        signedUrlExpireSeconds: String(normalized.signedUrlExpireSeconds),
      };
      notice.setMessage("凭证校验通过，已保存");
      setTimeout(() => notice.hide(), 3000);
    } catch (error) {
      if (error instanceof LifecycleQuiescedError) throw error;
      notice.setMessage(`凭证校验通过，但配置保存失败：${(error as Error).message}`);
      setTimeout(() => notice.hide(), 10000);
    }
  }

  private storageIdentityChanged(next: ReturnType<typeof normalizeOssConfig>): boolean {
    return establishedStorageIdentityKey(this.plugin.settings) !== storageIdentityKey(next);
  }

  private async runWhileActive(factory: () => Promise<void>): Promise<void> {
    try {
      await this.plugin.lifecycle.run(factory);
    } catch (error) {
      if (!(error instanceof LifecycleQuiescedError)) throw error;
    }
  }
}
