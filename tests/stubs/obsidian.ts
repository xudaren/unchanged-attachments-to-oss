type RequestHandler = (request: Record<string, unknown>) => Promise<unknown>;

let requestHandler: RequestHandler = async () => {
  throw new Error("requestUrl test handler is not configured");
};

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  public name: string;
  constructor(
    path: string,
    name: string = path.split("/").pop() ?? path,
  ) {
    super(path);
    this.name = name;
  }
  get extension(): string {
    const dot = this.name.lastIndexOf(".");
    return dot >= 0 ? this.name.slice(dot + 1) : "";
  }
}

export class App {}
export class Plugin {}
export class MarkdownView { file: TFile | null = null; }

export class Menu {
  addItem(callback: (item: any) => void): this {
    callback({ setTitle() { return this; }, setIcon() { return this; }, onClick() { return this; } });
    return this;
  }
  addSeparator(): this { return this; }
  showAtMouseEvent(_event: unknown): void {}
}

export class Modal {
  contentEl: any = {};
  constructor(_app: unknown) {}
  open(): void { this.onOpen?.(); }
  close(): void {}
  onOpen?(): void;
}

export class Setting {
  constructor(_container: unknown) {}
  setName(_name: string): this { return this; }
  addToggle(_callback: (toggle: any) => void): this { return this; }
  addButton(_callback: (button: any) => void): this { return this; }
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
  setMessage(_message: string): void {}
  hide(): void {}
}

export function setRequestUrlHandler(handler: RequestHandler): void {
  requestHandler = handler;
}

export async function requestUrl(request: Record<string, unknown>): Promise<unknown> {
  return requestHandler(request);
}
