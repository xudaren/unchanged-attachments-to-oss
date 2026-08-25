import { Setting, setIcon } from "obsidian";

/**
 * 给密码输入框附加「眼睛」切换按钮，点击可在显示/隐藏明文之间切换。
 */
export function attachPasswordVisibilityToggle(
  setting: Setting,
  getInput: () => HTMLInputElement,
): void {
  setting.addExtraButton((button) => {
    button.extraSettingsEl.setAttribute("aria-label", "显示或隐藏密码");
    let visible = false;
    const renderIcon = (): void => {
      setIcon(button.extraSettingsEl, visible ? "lucide-eye-off" : "lucide-eye");
    };
    renderIcon();
    button.onClick(() => {
      visible = !visible;
      const input = getInput();
      input.type = visible ? "text" : "password";
      renderIcon();
      input.focus();
    });
  });
}
