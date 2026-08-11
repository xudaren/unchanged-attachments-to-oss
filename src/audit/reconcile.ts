import { TFile, Vault } from "obsidian";
import { ListedObject } from "../oss/client";
import { normalizeObjectKey, scanOssReferences } from "../reference/codec";
import { PendingUpload } from "../types";

export { normalizeObjectKey } from "../reference/codec";

export const OBJECT_DELETE_PROTECTION_MS = 24 * 60 * 60 * 1000;

export interface ReferenceOccurrence {
  key: string;
  sourcePath: string;
}

export interface AuditReport {
  referenced: Map<string, string[]>;
  objects: ListedObject[];
  healthy: ListedObject[];
  orphaned: ListedObject[];
  missing: string[];
  protectedPending: Set<string>;
}

export interface FinalDeletionSelection {
  deletable: string[];
  skipped: string[];
}

export interface VaultReferenceScanProgress {
  scanned: number;
  total: number;
}

export interface VaultReferenceScanOptions {
  concurrency?: number;
  targetKeys?: ReadonlySet<string>;
  onProgress?: (progress: VaultReferenceScanProgress) => void;
}

export interface VaultReferenceScanResult {
  referenced: Map<string, string[]>;
  failedPaths: string[];
}

/** Read Vault reference sources with bounded memory and per-file failure isolation. */
export async function scanVaultReferences(
  vault: Vault,
  options: VaultReferenceScanOptions = {},
): Promise<VaultReferenceScanResult> {
  const referenced = new Map<string, string[]>();
  const files = vault.getFiles().filter(isReferenceSource);
  const failedPaths: string[] = [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, files.length || 1));
  let cursor = 0;
  let scanned = 0;
  options.onProgress?.({ scanned, total: files.length });

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const content = await vault.cachedRead(file);
        for (const key of extractReferenceKeys(content, options.targetKeys)) {
          const sources = referenced.get(key) ?? [];
          sources.push(file.path);
          referenced.set(key, sources);
        }
      } catch (error) {
        failedPaths.push(file.path);
        console.warn(`[oss-audit] 读取引用源失败：${file.path}`, error);
      } finally {
        scanned++;
        options.onProgress?.({ scanned, total: files.length });
      }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const unexpected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (unexpected) throw unexpected.reason;
  return { referenced, failedPaths };
}

export function referencesAreComplete(result: VaultReferenceScanResult): boolean {
  return result.failedPaths.length === 0;
}

export function describeScanFailures(result: VaultReferenceScanResult): string {
  if (referencesAreComplete(result)) return "";
  const preview = result.failedPaths.slice(0, 3).join("、");
  const remaining = result.failedPaths.length - Math.min(result.failedPaths.length, 3);
  return `${result.failedPaths.length} 个文件无法读取：${preview}${remaining > 0 ? ` 等 ${remaining} 个` : ""}`;
}

export function reconcileObjects(
  referenced: Map<string, string[]>,
  objects: ListedObject[],
  pendingUploads: Record<string, PendingUpload>,
): AuditReport {
  const protectedPending = new Set(Object.values(pendingUploads).map((pending) => normalizeObjectKey(pending.objectKey)));
  const visibleObjects = objects.filter((object) => !isInternalKey(object.key));
  const objectKeys = new Set(visibleObjects.map((object) => normalizeObjectKey(object.key)));
  const healthy = visibleObjects.filter((object) => referenced.has(normalizeObjectKey(object.key)) || protectedPending.has(normalizeObjectKey(object.key)));
  const orphaned = visibleObjects.filter((object) => !referenced.has(normalizeObjectKey(object.key)) && !protectedPending.has(normalizeObjectKey(object.key)));
  const missing = [...referenced.keys()].filter((key) => !objectKeys.has(key)).sort();
  return { referenced, objects: visibleObjects, healthy, orphaned, missing, protectedPending };
}

export function isProtectedByAge(object: ListedObject, now = Date.now()): boolean {
  const modified = Date.parse(object.lastModified);
  return !Number.isFinite(modified) || now - modified < OBJECT_DELETE_PROTECTION_MS;
}

/**
 * Re-validate destructive candidates against a fresh object listing, the latest
 * Vault scan and the live upload journal. Missing or recently replaced objects
 * are skipped instead of being treated as safe deletion targets.
 */
export function selectFinalDeletionCandidates(
  selectedKeys: readonly string[],
  referenced: ReadonlyMap<string, string[]>,
  pendingUploads: Record<string, PendingUpload>,
  latestObjects: readonly ListedObject[],
  now = Date.now(),
): FinalDeletionSelection {
  const pending = new Set(
    Object.values(pendingUploads).map((item) => normalizeObjectKey(item.objectKey)),
  );
  const objects = new Map(
    latestObjects.map((object) => [normalizeObjectKey(object.key), object]),
  );
  const deletable: string[] = [];
  const skipped: string[] = [];
  for (const originalKey of selectedKeys) {
    const key = normalizeObjectKey(originalKey);
    const object = objects.get(key);
    if (!object || referenced.has(key) || pending.has(key) || isProtectedByAge(object, now)) {
      skipped.push(originalKey);
    } else {
      deletable.push(originalKey);
    }
  }
  return { deletable, skipped };
}

export function extractReferenceKeys(content: string, targetKeys?: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const reference of scanOssReferences(content)) {
    const key = normalizeObjectKey(reference.key);
    if (key.startsWith("uploading/")) continue;
    if (!targetKeys || targetKeys.has(key)) keys.add(key);
  }
  return keys;
}

function isReferenceSource(file: TFile): boolean {
  return file.extension === "md" || file.extension === "canvas" || file.extension === "base";
}

function isInternalKey(key: string): boolean {
  return normalizeObjectKey(key).split("/").includes(".oss-plugin-probe");
}
