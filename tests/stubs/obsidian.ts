type RequestHandler = (request: Record<string, unknown>) => Promise<unknown>;

let requestHandler: RequestHandler = async () => {
  throw new Error("requestUrl test handler is not configured");
};

export function setRequestUrlHandler(handler: RequestHandler): void {
  requestHandler = handler;
}

export async function requestUrl(request: Record<string, unknown>): Promise<unknown> {
  return requestHandler(request);
}
