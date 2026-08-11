import { Notice } from "obsidian";
import { normalizeObjectKeyPrefix, normalizeOssEndpoint } from "../config";
import { OssClient, OssError } from "../oss/client";
import { normalizeSigningRegion } from "../oss/signer";
import { LifecycleGate, LifecycleQuiescedError } from "../lifecycle";
import {
  PendingReferenceLocator,
  PendingUpload,
  PluginSettings,
  StorageIdentity,
  UploadPhase,
  mimeOf,
} from "../types";

const PART_SIZE = 4 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export interface UploadRequest {
  blob: Blob;
  ext: string;
  sourcePath: string;
  localPath?: string;
  stagingPath?: string;
  tempId?: string;
  displayName?: string;
  locator?: PendingReferenceLocator;
  sourceMtime?: number;
  resume?: PendingUpload;
  occurrenceId?: string;
  /** Automatic editor/create flow. Manual retry and migration intentionally omit this. */
  automatic?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface UploadResult {
  objectKey: string;
  tempId: string;
}

export interface PrepareStagedUploadRequest {
  tempId: string;
  ext: string;
  size: number;
  sourcePath: string;
  localPath: string;
  stagingPath: string;
  displayName: string;
  occurrenceId: string;
  locator: PendingReferenceLocator;
  sourceMtime?: number;
}

export class UploadPausedError extends Error {
  constructor(public readonly tempId: string, public readonly reason: unknown) {
    super(`上传已暂停，可稍后续传：${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "UploadPausedError";
  }
}

export function isLifecycleUploadPause(error: unknown): boolean {
  return error instanceof LifecycleQuiescedError ||
    error instanceof UploadPausedError && error.reason instanceof LifecycleQuiescedError;
}

export class AutoUploadPausedError extends Error {
  constructor() {
    super("自动上传已关闭，任务已安全暂停");
    this.name = "AutoUploadPausedError";
  }
}

export class LegacyStorageIdentityError extends Error {
  constructor(public readonly tempId: string) {
    super("旧上传任务缺少 Bucket / Endpoint 身份，无法安全确认其远端归属；本地文件与任务日志已保留");
    this.name = "LegacyStorageIdentityError";
  }
}

export class StorageIdentityMismatchError extends Error {
  constructor(public readonly tempId: string) {
    super("上传任务属于另一组 Bucket / Endpoint / Region / Object Key 前缀，请恢复原存储配置后重试");
    this.name = "StorageIdentityMismatchError";
  }
}

export class UploadSourceChangedError extends Error {
  constructor(public readonly tempId: string) {
    super("本地附件的大小、扩展名或修改时间已变化，已阻止续传到旧任务");
    this.name = "UploadSourceChangedError";
  }
}

/** Durable Multipart state machine shared by direct input, fallback and migration. */
export class UploadManager {
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    private client: OssClient,
    private readonly settings: PluginSettings,
    private readonly persist: () => Promise<void>,
    private readonly lifecycle?: LifecycleGate,
  ) {}

  /** Switch credentials/client for future calls; task identity validation still gates every resume. */
  setClient(client: OssClient): void {
    this.client = client;
  }

  /** Journal a direct-input task after its staging bytes exist and before any network call. */
  async prepareStagedTask(req: PrepareStagedUploadRequest): Promise<PendingUpload> {
    const existing = this.settings.pendingUploads[req.tempId];
    if (existing) return existing;
    const prefix = normalizeObjectKeyPrefix(this.settings.objectKeyPrefix);
    const pending: PendingUpload = {
      tempId: req.tempId,
      objectKey: `${prefix}/${crypto.randomUUID()}.${req.ext.toLowerCase()}`,
      uploadId: "",
      ext: req.ext.toLowerCase(),
      size: req.size,
      parts: [],
      phase: "staged",
      sourcePath: req.sourcePath,
      occurrenceId: req.occurrenceId,
      localPath: req.localPath,
      stagingPath: req.stagingPath,
      displayName: req.displayName,
      locator: req.locator,
      storageIdentity: currentStorageIdentity(this.settings),
      sourceMtime: req.sourceMtime,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.settings.pendingUploads[pending.tempId] = pending;
    await this.persistState();
    return pending;
  }

  async discardMissingStagingTask(tempId: string): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (!pending || phaseOf(pending) !== "staged" || pending.uploadId) return;
    delete this.settings.pendingUploads[tempId];
    await this.persistState();
  }

  async upload(req: UploadRequest): Promise<UploadResult> {
    this.lifecycle?.assertActive("开始上传任务");
    const beforeSend = req.automatic
      ? () => this.assertAutomaticUploadEnabled(req)
      : undefined;
    const size = req.blob.size;
    const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
    if (totalParts > MAX_PARTS) {
      throw new Error(`附件过大：固定 4 MB 分片最多支持 ${MAX_PARTS} 片`);
    }

    let pending = req.resume ?? this.findResume(req);
    if (pending) {
      if (!pending.storageIdentity && req.automatic) this.assertAutomaticUploadEnabled(req);
      await this.ensureTaskStorageIdentity(pending, beforeSend);
      this.assertResumeSource(pending, req);
    } else {
      const tempId = req.tempId ?? crypto.randomUUID();
      const prefix = normalizeObjectKeyPrefix(this.settings.objectKeyPrefix);
      pending = {
        tempId,
        objectKey: `${prefix.replace(/\/+$/, "")}/${crypto.randomUUID()}.${req.ext.toLowerCase()}`,
        uploadId: "",
        ext: req.ext.toLowerCase(),
        size,
        parts: [],
        phase: "staged",
        sourcePath: req.sourcePath,
        occurrenceId: req.occurrenceId,
        localPath: req.localPath,
        stagingPath: req.stagingPath,
        displayName: req.displayName,
        locator: req.locator,
        storageIdentity: currentStorageIdentity(this.settings),
        sourceMtime: req.sourceMtime,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.settings.pendingUploads[tempId] = pending;
      // No network request is allowed until the staged task is durable.
      await this.persistState();
    }

    const phase = phaseOf(pending);
    if (phase === "uploaded" || phase === "reference_committing" || phase === "cleanup_pending") {
      return resultOf(pending);
    }

    try {
      if (phaseOf(pending) === "staged") {
        const { uploadId } = await withRetry(
          () => {
            this.assertAutomaticUploadEnabled(req);
            return this.client.initiateMultipart(
              pending!.objectKey,
              mimeOf(pending!.ext),
              beforeSend,
            );
          },
          isRecoverableUploadError,
          this.lifecycle,
        );
        pending.uploadId = uploadId;
        await this.transition(pending, "uploading");
      }

      if (phaseOf(pending) === "uploading") {
        const doneNumbers = new Set(pending.parts.map((part) => part.partNumber));
        req.onProgress?.(doneNumbers.size, totalParts);
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
          if (doneNumbers.has(partNumber)) continue;
          const start = (partNumber - 1) * PART_SIZE;
          const body = await req.blob.slice(start, Math.min(start + PART_SIZE, size)).arrayBuffer();
          const { etag } = await withRetry(
            () => {
              this.assertAutomaticUploadEnabled(req);
              return this.client.uploadPart({
                key: pending!.objectKey,
                uploadId: pending!.uploadId,
                partNumber,
                body,
                beforeSend,
              });
            },
            isRecoverableUploadError,
            this.lifecycle,
          );
          pending.parts.push({ partNumber, etag });
          pending.updatedAt = Date.now();
          await this.persistState();
          req.onProgress?.(pending.parts.length, totalParts);
        }
        // Persist the ambiguous boundary before asking OSS to assemble the object.
        await this.transition(pending, "completing");
      }

      if (phaseOf(pending) === "completing") {
        let completeFailed = false;
        let completeError: unknown;
        let confirmation: Awaited<ReturnType<OssClient["completeMultipart"]>> | undefined;
        try {
          confirmation = await withRetry(
            () => {
              this.assertAutomaticUploadEnabled(req);
              return this.client.completeMultipart({
                key: pending!.objectKey,
                uploadId: pending!.uploadId,
                parts: pending!.parts,
                beforeSend,
              });
            },
            isRecoverableUploadError,
            this.lifecycle,
          );
        } catch (error) {
          completeFailed = true;
          completeError = error;
        }
        if (completeFailed) {
          if (completeError instanceof AutoUploadPausedError) throw completeError;
          const exists = await this.confirmCompletedObject(
            pending.objectKey,
            completeError,
            beforeSend,
          );
          if (!exists) throw completeError;
        } else if (!isCompleteConfirmation(confirmation, pending.objectKey)) {
          const exists = await this.client.headObject(pending.objectKey, beforeSend);
          if (!exists) throw new Error("CompleteMultipartUpload 响应无法确认，且目标 Object 不存在");
        }
        await this.transition(pending, "uploaded");
      }

      return resultOf(pending);
    } catch (error) {
      if (error instanceof StorageIdentityMismatchError || error instanceof UploadSourceChangedError) throw error;
      // Once Complete has been attempted, even a nominally non-recoverable OSS
      // error is ambiguous until HEAD confirms the target state. Never Abort and
      // forget this boundary merely because the confirmation request also failed.
      if (req.automatic && !this.settings.autoUpload ||
          error instanceof AutoUploadPausedError || error instanceof LifecycleQuiescedError ||
          isRecoverableUploadError(error) ||
          phaseOf(pending) === "completing" ||
          phaseOf(pending) === "uploaded") {
        pending.updatedAt = Date.now();
        await this.persistState().catch(() => undefined);
        throw new UploadPausedError(
          pending.tempId,
          req.automatic && !this.settings.autoUpload ? new AutoUploadPausedError() : error,
        );
      }
      await this.abortAndForget(pending, error, beforeSend);
      throw error;
    }
  }

  getPending(tempId: string): PendingUpload | undefined {
    return this.settings.pendingUploads[tempId];
  }

  /** Verify and bind a legacy journal before any remote or destructive continuation. */
  async ensurePendingStorageIdentity(tempId: string): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (pending) await this.ensureTaskStorageIdentity(pending);
  }

  findPendingFor(req: Pick<UploadRequest, "localPath" | "sourcePath" | "occurrenceId">): PendingUpload | undefined {
    return Object.values(this.settings.pendingUploads).find((pending) =>
      Boolean(req.localPath) &&
      pending.localPath === req.localPath &&
      pending.sourcePath === req.sourcePath &&
      pending.occurrenceId === req.occurrenceId
    );
  }

  async bindLocalPath(tempId: string, localPath: string, clearStaging = false): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (!pending) return;
    pending.localPath = localPath;
    if (clearStaging) pending.stagingPath = undefined;
    pending.updatedAt = Date.now();
    await this.persistState();
  }

  /** Persist the exact ordinary-local reference before its staging copy is removed. */
  async bindLocalRecovery(
    tempId: string,
    localPath: string,
    locator: PendingReferenceLocator,
    sourceMtime: number,
    clearStaging = false,
  ): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (!pending) return;
    pending.localPath = localPath;
    pending.locator = locator;
    pending.sourceMtime = sourceMtime;
    if (clearStaging) pending.stagingPath = undefined;
    pending.updatedAt = Date.now();
    await this.persistState();
  }

  async markReferenceCommitting(tempId: string): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (pending && phaseOf(pending) !== "cleanup_pending") {
      await this.transition(pending, "reference_committing");
    }
  }

  async markCleanupPending(tempId: string): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (pending) await this.transition(pending, "cleanup_pending");
  }

  /** Remove one task only after its reference and local cleanup are both durable. */
  async finalize(tempId: string): Promise<void> {
    if (!this.settings.pendingUploads[tempId]) return;
    delete this.settings.pendingUploads[tempId];
    await this.persistState();
  }

  async finalizeCleanupForPath(localPath: string): Promise<void> {
    let changed = false;
    for (const [tempId, pending] of Object.entries(this.settings.pendingUploads)) {
      if (pending.localPath === localPath && phaseOf(pending) === "cleanup_pending") {
        delete this.settings.pendingUploads[tempId];
        changed = true;
      }
    }
    if (changed) await this.persistState();
  }

  async abort(tempId: string): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (!pending) return;
    this.assertTaskStorageIdentity(pending);
    await this.abortRemote(pending);
    delete this.settings.pendingUploads[tempId];
    await this.persistState();
  }

  /**
   * Manual cleanup only aborts old tasks proven to belong to this local journal.
   * Prefix-scoped remote unknown uploads are reported, never destroyed.
   */
  async cleanupOrphans(maxAgeMs: number = 24 * 3600 * 1000): Promise<number> {
    this.lifecycle?.assertActive("清理孤儿分片");
    // Validate scope before any management request. In particular, never turn a
    // legacy leading-slash prefix into a different namespace by trimming it.
    const prefix = normalizeObjectKeyPrefix(this.settings.objectKeyPrefix);
    const now = Date.now();
    let cleaned = 0;
    for (const pending of Object.values(this.settings.pendingUploads)) {
      const phase = phaseOf(pending);
      if (!pending.uploadId || phase === "staged" || phase === "uploaded" ||
          phase === "reference_committing" || phase === "cleanup_pending") continue;
      if (now - pending.updatedAt <= maxAgeMs) continue;
      try {
        this.assertTaskStorageIdentity(pending);
        if (phase === "completing") {
          // Complete may have succeeded even when its response was lost. HEAD is
          // the only safe discriminator before touching the multipart session.
          const exists = await this.client.headObject(pending.objectKey);
          if (exists) {
            await this.transition(pending, "uploaded");
            continue;
          }
        }
        await this.abortRemote(pending);
        pending.uploadId = "";
        pending.parts = [];
        await this.transition(pending, "staged");
        cleaned++;
      } catch (error) {
        console.warn("[oss-upload] 本地已知任务清理失败或完成状态不确定，journal 已保留", pending, error);
      }
    }

    let unknownRemoteCount = 0;
    let listingFailed = false;
    try {
      const remotes = await this.client.listMultipartUploads(`${prefix}/`);
      const localIds = new Set(Object.values(this.settings.pendingUploads).map((pending) => pending.uploadId));
      unknownRemoteCount = remotes.filter((remote) => !localIds.has(remote.uploadId)).length;
    } catch (error) {
      listingFailed = true;
      console.warn("[oss-upload] 无法读取前缀内 MultipartUpload，仅完成本地已知任务清理", error);
    }

    if (listingFailed) {
      new Notice(`本地已知孤儿分片已清理 ${cleaned} 个；远端分片列表查询失败，请检查 ListMultipartUploads 权限或网络后重试`);
    } else if (cleaned > 0 || unknownRemoteCount > 0) {
      const unknown = unknownRemoteCount > 0 ? `；发现 ${unknownRemoteCount} 个远端未知任务，未自动中止` : "";
      new Notice(`已清理 ${cleaned} 个本地已知孤儿分片${unknown}`);
    } else {
      new Notice("未发现可清理的本地已知分片，远端前缀下也没有未知分片任务");
    }
    return cleaned;
  }

  private findResume(req: UploadRequest): PendingUpload | undefined {
    if (req.tempId && this.settings.pendingUploads[req.tempId]) return this.settings.pendingUploads[req.tempId];
    if (!req.localPath) return undefined;
    return this.findPendingFor(req);
  }

  private assertResumeSource(pending: PendingUpload, req: UploadRequest): void {
    const mtimeChanged = pending.sourceMtime !== undefined && req.sourceMtime !== undefined &&
      pending.sourceMtime !== req.sourceMtime;
    if (pending.size !== req.blob.size || pending.ext !== req.ext.toLowerCase() || mtimeChanged) {
      throw new UploadSourceChangedError(pending.tempId);
    }
  }

  private assertTaskStorageIdentity(pending: PendingUpload): void {
    const identity = pending.storageIdentity;
    if (!identity) throw new LegacyStorageIdentityError(pending.tempId);
    if (!sameStorageIdentity(identity, currentStorageIdentity(this.settings))) {
      throw new StorageIdentityMismatchError(pending.tempId);
    }
  }

  private async ensureTaskStorageIdentity(
    pending: PendingUpload,
    beforeSend?: () => void,
  ): Promise<void> {
    if (pending.storageIdentity) {
      this.assertTaskStorageIdentity(pending);
      return;
    }
    const phase = phaseOf(pending);
    if (phase === "staged" && !pending.uploadId && pending.parts.length === 0) {
      pending.storageIdentity = currentStorageIdentity(this.settings);
      pending.updatedAt = Date.now();
      await this.persistState();
      return;
    }
    if (phase === "uploaded" || phase === "reference_committing" || phase === "cleanup_pending" ||
        phase === "completing") {
      let exists = false;
      try {
        exists = await this.client.headObject(pending.objectKey, beforeSend);
      } catch (error) {
        if (error instanceof LifecycleQuiescedError || error instanceof AutoUploadPausedError) throw error;
        throw new LegacyStorageIdentityError(pending.tempId);
      }
      if (!exists) throw new LegacyStorageIdentityError(pending.tempId);
      pending.storageIdentity = currentStorageIdentity(this.settings);
      if (phase === "completing") pending.phase = "uploaded";
      pending.updatedAt = Date.now();
      await this.persistState();
      return;
    }
    // An UploadId cannot be safely probed across Buckets without already knowing
    // which Bucket owns it. Never adopt a legacy uploading journal by assumption.
    throw new LegacyStorageIdentityError(pending.tempId);
  }

  private assertAutomaticUploadEnabled(req: UploadRequest): void {
    if (req.automatic && !this.settings.autoUpload) throw new AutoUploadPausedError();
  }

  private async transition(pending: PendingUpload, phase: UploadPhase): Promise<void> {
    pending.phase = phase;
    pending.updatedAt = Date.now();
    await this.persistState();
  }

  private async confirmCompletedObject(
    objectKey: string,
    originalError: unknown,
    beforeSend?: () => void,
  ): Promise<boolean> {
    try {
      return await this.client.headObject(objectKey, beforeSend);
    } catch (headError) {
      if (!isRecoverableUploadError(originalError)) throw originalError;
      throw headError;
    }
  }

  private async abortAndForget(
    pending: PendingUpload,
    error: unknown,
    beforeSend?: () => void,
  ): Promise<void> {
    console.error("[oss-upload] 不可恢复错误，触发 Abort", error);
    this.assertTaskStorageIdentity(pending);
    try {
      await this.abortRemote(pending, beforeSend);
    } catch (abortError) {
      pending.updatedAt = Date.now();
      await this.persistState().catch(() => undefined);
      console.warn("[oss-upload] Abort 失败，journal 保留以供重试", abortError);
      if (abortError instanceof LifecycleQuiescedError || abortError instanceof AutoUploadPausedError) {
        throw new UploadPausedError(pending.tempId, abortError);
      }
      throw abortError;
    }
    delete this.settings.pendingUploads[pending.tempId];
    await this.persistState();
  }

  private async abortRemote(pending: PendingUpload, beforeSend?: () => void): Promise<void> {
    if (!pending.uploadId) return;
    try {
      await this.client.abortMultipart(pending.objectKey, pending.uploadId, beforeSend);
    } catch (error) {
      if (error instanceof OssError && error.status === 404 && error.code === "NoSuchUpload") return;
      throw error;
    }
  }

  private persistState(): Promise<void> {
    const run = this.persistTail.then(() => this.persist());
    this.persistTail = run.catch(() => undefined);
    return run;
  }
}

function phaseOf(pending: PendingUpload): UploadPhase {
  return pending.phase ?? "uploading";
}

function resultOf(pending: PendingUpload): UploadResult {
  return { tempId: pending.tempId, objectKey: pending.objectKey };
}

function isCompleteConfirmation(
  result: { key: string | null; requestId: string | null } | null | undefined,
  expectedKey: string,
): boolean {
  return Boolean(result?.requestId && result.key === expectedKey);
}

function currentStorageIdentity(settings: PluginSettings): StorageIdentity {
  const region = normalizeSigningRegion(settings.region);
  return {
    region,
    bucketName: settings.bucketName.trim().toLowerCase(),
    endpoint: normalizeOssEndpoint(settings.endpoint, region),
    objectKeyPrefix: normalizeObjectKeyPrefix(settings.objectKeyPrefix),
  };
}

function sameStorageIdentity(left: StorageIdentity, right: StorageIdentity): boolean {
  return left.region === right.region &&
    left.bucketName === right.bucketName &&
    left.endpoint === right.endpoint &&
    left.objectKeyPrefix === right.objectKeyPrefix;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  lifecycle?: LifecycleGate,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
      if (attempt < MAX_RETRIES) {
        await interruptibleSleep(BASE_DELAY_MS * Math.pow(2, attempt), lifecycle);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function interruptibleSleep(ms: number, lifecycle?: LifecycleGate): Promise<void> {
  if (!lifecycle) return sleep(ms);
  let removeListener: () => void = () => undefined;
  const quiesced = new Promise<void>((resolve) => {
    removeListener = lifecycle.onQuiesce(resolve);
  });
  try {
    await Promise.race([sleep(ms), quiesced]);
  } finally {
    removeListener();
  }
}

function isRecoverableUploadError(error: unknown): boolean {
  if (error instanceof AutoUploadPausedError || error instanceof LifecycleQuiescedError) return false;
  if (!(error instanceof OssError)) return true;
  if (["RequestTimeout", "OperationAborted", "ServiceUnavailable", "InternalError"].includes(error.code)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}
