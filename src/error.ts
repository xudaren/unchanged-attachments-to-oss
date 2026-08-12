export function normalizeError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  try {
    return new Error(String(reason));
  } catch {
    return new Error("Unknown error");
  }
}
