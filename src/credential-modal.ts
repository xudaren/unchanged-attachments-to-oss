import { App, Modal, Notice, Setting } from "obsidian";
import { attachPasswordVisibilityToggle } from "./password-toggle";

export type CredentialPromptMode = "migrate" | "unlock";

export class CredentialStartupModal extends Modal {
  private password = "";
  private confirmation = "";
  private busy = false;

  constructor(
    app: App,
    private readonly mode: CredentialPromptMode,
    private readonly submit: (password: string) => Promise<void>,
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const migrating = this.mode === "migrate";
    this.contentEl.empty();
    this.contentEl.createEl("h2", {
      text: migrating ? "加密 OSS 凭证" : "解锁 OSS 凭证",
    });
    this.contentEl.createEl("p", {
      text: migrating
        ? "检测到旧版明文 AK/SK。设置主密码后将加密并随 Vault 同步，主密码不会保存。"
        : "输入主密码解锁本次运行。关闭后插件保持锁定，不会访问 OSS。",
    });

    let submitButton: { setDisabled(disabled: boolean): unknown } | undefined;
    const passwordSetting = new Setting(this.contentEl)
      .setName(migrating ? "主密码" : "主密码")
      .setDesc(migrating ? "至少 10 个字符；忘记后只能重新填写 AK/SK" : "仅用于本次运行");
    let passwordInput: HTMLInputElement | undefined;
    passwordSetting.addText((text) => {
      passwordInput = text.inputEl;
      text.inputEl.type = "password";
      text.setPlaceholder("输入主密码").onChange((value) => { this.password = value; });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !migrating) void this.runSubmit(submitButton);
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    attachPasswordVisibilityToggle(passwordSetting, () => passwordInput as HTMLInputElement);

    if (migrating) {
      const confirmationSetting = new Setting(this.contentEl).setName("确认主密码");
      let confirmationInput: HTMLInputElement | undefined;
      confirmationSetting.addText((text) => {
        confirmationInput = text.inputEl;
        text.inputEl.type = "password";
        text.setPlaceholder("再次输入主密码").onChange((value) => { this.confirmation = value; });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void this.runSubmit(submitButton);
        });
      });
      attachPasswordVisibilityToggle(confirmationSetting, () => confirmationInput as HTMLInputElement);
    }

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("稍后处理").onClick(() => this.close()))
      .addButton((button) => {
        submitButton = button;
        button
          .setButtonText(migrating ? "加密并继续" : "解锁")
          .setCta()
          .onClick(() => void this.runSubmit(button));
      });
  }

  onClose(): void {
    this.password = "";
    this.confirmation = "";
    this.onClosed?.();
    this.contentEl.empty();
  }

  private async runSubmit(button?: { setDisabled(disabled: boolean): unknown }): Promise<void> {
    if (this.busy) return;
    if (this.mode === "migrate" && this.password !== this.confirmation) {
      new Notice("两次输入的主密码不一致");
      return;
    }
    this.busy = true;
    button?.setDisabled(true);
    try {
      await this.submit(this.password);
      new Notice(this.mode === "migrate" ? "OSS 凭证已加密保存" : "OSS 凭证已解锁");
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      button?.setDisabled(false);
    }
  }
}
