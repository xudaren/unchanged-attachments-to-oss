import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type OssPlugin from "./main";
import {
  establishedStorageIdentityKey,
  normalizeOssConfig,
  storageIdentityKey,
} from "./config";
import { OssClient } from "./oss/client";
import { formatCredentialNotice } from "./oss/errors";
import { LifecycleQuiescedError } from "./lifecycle";
import { scanLocalInsuranceCopies } from "./upload/local-copies";
import { formatAttachmentSize } from "./upload/input";

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
  private masterPassword = "";
  private masterPasswordConfirmation = "";

  constructor(app: App, private readonly plugin: OssPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "阿里云 OSS 配置",
      desc: "配置凭证、自动上传、签名 URL 与本地保险副本维护",
      aliases: ["Region", "Bucket", "AccessKey", "Endpoint", "Object Key", "自动上传", "保险副本", "重试", "分片"],
      render: (setting) => {
        setting.settingEl.addClass("oss-settings-root");
        setting.infoEl.remove();
        this.renderSettings(setting.settingEl);
      },
    }];
  }

  private renderSettings(containerEl: HTMLElement): void {
    const { plugin } = this;
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

    new Setting(containerEl).setName("阿里云 OSS 配置").setHeading();
    containerEl.createEl("p", {
      text: "私有 Bucket + 客户端 Signature V4。AK/SK 使用主密码加密后随 Vault 同步，主密码只用于当前运行期解锁。",
      cls: "setting-item-description",
    });

    if (plugin.isCredentialsLocked()) {
      const unlock = new Setting(containerEl)
        .setName("凭证已锁定")
        .setDesc("输入主密码解锁本次运行；主密码不会保存");
      unlock.addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("主密码").onChange((value) => { this.masterPassword = value; });
      });
      unlock.addButton((button) => button.setButtonText("解锁").setCta().onClick(async () => {
        await this.runWhileActive(async () => {
          try {
            await plugin.unlockCredentials(this.masterPassword);
            this.masterPassword = "";
            new Notice("OSS 凭证已解锁");
            this.update();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        });
      }));
    } else if (plugin.hasEncryptedCredentials()) {
      new Setting(containerEl)
        .setName("凭证已解锁")
        .setDesc("解密后的 AK/SK 和派生密钥只存在于当前插件实例内存")
        .addButton((button) => button.setButtonText("立即锁定").onClick(() => {
          plugin.lockCredentials();
          this.update();
        }));
    } else if (plugin.needsCredentialEncryption()) {
      containerEl.createEl("p", {
        text: "检测到旧版明文凭证。设置主密码并保存校验成功后，将自动迁移为密文。",
        cls: "setting-item-description mod-warning",
      });
    }

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

    new Setting(containerEl).setName("OSS 凭证").setHeading();
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

    if (!plugin.hasEncryptedCredentials() || plugin.isCredentialsLocked()) {
      new Setting(containerEl)
        .setName(plugin.isCredentialsLocked() ? "新主密码" : "主密码")
        .setDesc(plugin.isCredentialsLocked()
          ? "仅在忘记原主密码、准备使用新 AK/SK 覆盖旧密文时填写"
          : "至少 10 个字符；不会保存，忘记后只能重新填写 AK/SK")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(this.masterPassword).onChange((value) => { this.masterPassword = value; });
        });
      new Setting(containerEl)
        .setName("确认主密码")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(this.masterPasswordConfirmation).onChange((value) => {
            this.masterPasswordConfirmation = value;
          });
        });
    }

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

    new Setting(containerEl).setName("维护").setHeading();

    const localCopiesSetting = new Setting(containerEl)
      .setName("本地保险副本")
      .setDesc("正在读取本地保险副本…")
      .addButton((button) => button.setButtonText("查看并管理").onClick(() => {
        plugin.openLocalInsuranceCopies();
      }));
    void scanLocalInsuranceCopies(plugin.app.vault, plugin.settings.pendingUploads).then((localCopies) => {
      if (!containerEl.isConnected) return;
      localCopiesSetting.setDesc(
        localCopies.copies.length === 0
          ? "当前没有保险副本，不占用额外空间"
          : `当前 ${localCopies.copies.length} 份，共占用 ${formatAttachmentSize(localCopies.totalSize)}；可查看、恢复或继续处理`,
      );
    });

    new Setting(containerEl)
      .setName("重试未完成任务")
      .setDesc("继续上传、写入文档引用，并在确认安全后清理本地保险副本")
      .addButton((b) =>
        b.setButtonText("立即重试").onClick(async () => {
          await this.runWhileActive(async () => {
            await plugin.retryPendingUploads();
            this.update();
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
              this.update();
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
    const needsPassword = !plugin.hasEncryptedCredentials() || plugin.isCredentialsLocked();
    if (needsPassword && this.masterPassword !== this.masterPasswordConfirmation) {
      new Notice("两次输入的主密码不一致");
      return;
    }
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
      window.setTimeout(() => notice.hide(), 10000);
      return;
    }
    try {
      plugin.lifecycle.assertActive("应用已校验 OSS 配置");
      await plugin.applyVerifiedConfig(normalized, needsPassword ? this.masterPassword : undefined);
      this.masterPassword = "";
      this.masterPasswordConfirmation = "";
      this.draft = {
        ...normalized,
        signedUrlExpireSeconds: String(normalized.signedUrlExpireSeconds),
      };
      notice.setMessage("凭证校验通过，已保存");
      window.setTimeout(() => notice.hide(), 3000);
    } catch (error) {
      if (error instanceof LifecycleQuiescedError) throw error;
      notice.setMessage(`凭证校验通过，但配置保存失败：${(error as Error).message}`);
      window.setTimeout(() => notice.hide(), 10000);
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
