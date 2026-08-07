import { TFile, Vault } from "obsidian";
import { ListedObject } from "../oss/client";
import { OSS_URL_REGEX, PendingUpload } from "../types";

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

export async function scanVaultReferences(vault: Vault): Promise<Map<string, string[]>> {
  const referenced = new Map<string, string[]>();
  const files = vault.getFiles().filter(isReferenceSource);
  const reads = await Promise.allSettled(files.map(async (file) => ({
    file,
    content: await vault.cachedRead(file),
  })));
  for (const read of reads) {
    if (read.status !== "fulfilled") continue;
    for (const key of extractReferenceKeys(read.value.content)) {
      const sources = referenced.get(key) ?? [];
      sources.push(read.value.file.path);
      referenced.set(key, sources);
    }
  }
  return referenced;
}

export function reconcileObjects(
  referenced: Map<string, string[]>,
  objects: ListedObject[],
  pendingUploads: Record<string, PendingUpload>,
): AuditReport {
  const protectedPending = new Set(Object.values(pendingUploads).map((pending) => normalizeKey(pending.objectKey)));
  const visibleObjects = objects.filter((object) => !isInternalKey(object.key));
  const objectKeys = new Set(visibleObjects.map((object) => normalizeKey(object.key)));
  const healthy = visibleObjects.filter((object) => referenced.has(normalizeKey(object.key)) || protectedPending.has(normalizeKey(object.key)));
  const orphaned = visibleObjects.filter((object) => !referenced.has(normalizeKey(object.key)) && !protectedPending.has(normalizeKey(object.key)));
  const missing = [...referenced.keys()].filter((key) => !objectKeys.has(key)).sort();
  return { referenced, objects: visibleObjects, healthy, orphaned, missing, protectedPending };
}

export function isProtectedByAge(object: ListedObject, now = Date.now()): boolean {
  const modified = Date.parse(object.lastModified);
  return !Number.isFinite(modified) || now - modified < OBJECT_DELETE_PROTECTION_MS;
}

export function extractReferenceKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const re = new RegExp(OSS_URL_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) keys.add(normalizeKey(match[1]));
  return keys;
}

function isReferenceSource(file: TFile): boolean {
  return file.extension === "md" || file.extension === "canvas" || file.extension === "base";
}

function isInternalKey(key: string): boolean {
  return normalizeKey(key).split("/").includes(".oss-plugin-probe");
}

function normalizeKey(value: string): string {
  const stripped = value.replace(/^\/+/, "");
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}
