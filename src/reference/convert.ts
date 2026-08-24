import { TFile, Vault } from "obsidian";
import { normalizeOssReferencesToAccessHost, normalizeReferenceHost } from "./codec";

export interface ReferenceConversionResult {
  scanned: number;
  converted: number;
  failedPaths: string[];
}

export interface ReferenceConversionOptions {
  concurrency?: number;
  /** Lifecycle gate: stop before the next write side effect once quiesced. */
  shouldContinue?: () => boolean;
}

function isReferenceSource(file: TFile): boolean {
  return file.extension === "md" || file.extension === "canvas" || file.extension === "base";
}

/**
 * One-shot, idempotent rewrite of every recognized reference (legacy
 * `oss://` and public URLs on retired access hosts) in md/canvas/base into
 * the canonical public URL form on the current access host. Files already
 * normalized are never touched, so repeated runs stay side-effect free.
 */
export async function normalizeVaultReferencesToAccessHost(
  vault: Vault,
  host: string,
  options: ReferenceConversionOptions = {},
): Promise<ReferenceConversionResult> {
  const normalizedHost = normalizeReferenceHost(host);
  const files = vault.getFiles().filter(isReferenceSource);
  const failedPaths: string[] = [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, files.length || 1));
  let cursor = 0;
  let scanned = 0;
  let converted = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (options.shouldContinue && !options.shouldContinue()) return;
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const content = await vault.read(file);
        scanned++;
        if (normalizeOssReferencesToAccessHost(content, normalizedHost) === content) continue;
        if (options.shouldContinue && !options.shouldContinue()) return;
        // `process` re-applies the rewrite on the freshest content, so a
        // concurrent edit between read and write cannot be overwritten.
        await vault.process(file, (current) =>
          normalizeOssReferencesToAccessHost(current, normalizedHost));
        converted++;
      } catch (error) {
        failedPaths.push(file.path);
        console.warn(`[oss] 引用归一读取失败：${file.path}`, error);
      }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const unexpected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (unexpected) throw unexpected.reason;
  return { scanned, converted, failedPaths };
}
