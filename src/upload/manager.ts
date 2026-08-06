import { Notice } from "obsidian";
import { OssClient, OssError } from "../oss/client";
import { PendingUpload, PluginSettings, mimeOf } from "../types";

const PART_SIZE = 4 * 1024 * 1024; // 4 MB
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 指数退避基底 1s

export interface UploadRequest {
  /** blob 内容源 */
  blob: Blob;
  /** 扩展名（不含 .） */
  ext: string;
  /** 关联 md 文件路径（失败回写用） */
  sourcePath: string;
  /** 已落地本地附件路径；续传身份校验用 */
  localPath?: string;
  /** 已存在的续传状态（可选） */
  resume?: PendingUpload;
  /** 引用实例标识，用于区分同一文档内的重复引用 */
  occurrenceId?: string;
  /** 进度回调：参数为已完成分片数和总分片数 */
  onProgress?: (done: number, total: number) => void;
}

export interface UploadResult {
  objectKey: string;
  tempId: string;
}

export class UploadPausedError extends Error {
  constructor(public readonly tempId: string, cause: unknown) {
    super(`上传已暂停，可稍后续传：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "UploadPausedError";
  }
}

/**
 * 上传管理器：负责所有附件的 Multipart 上传全流程。
 *
 * - 4 MB 分片，Blob.slice 惰性读取
 * - 每片成功后立即 persist 到 data.json，支持断点续传
 * - 失败调用 AbortMultipartUpload；未 abort 的挂起状态由启动时清理任务兜底
 */
export class UploadManager {
  constructor(
    private readonly client: OssClient,
    private readonly settings: PluginSettings,
    private readonly persist: () => Promise<void>,
  ) {}

  /**
   * 执行一次完整上传。抛出异常时 pendingUploads 中会保留状态，供后续续传。
   */
  async upload(req: UploadRequest): Promise<UploadResult> {
    const size = req.blob.size;
    let pending = req.resume ?? this.findResume(req);
    if (!pending) {
      const tempId = crypto.randomUUID();
      const prefix = this.settings.objectKeyPrefix || "obsidian";
      const objectKey = `${prefix.replace(/\/+$/, "")}/${crypto.randomUUID()}.${req.ext.toLowerCase()}`;
      const { uploadId } = await this.client.initiateMultipart(objectKey, mimeOf(req.ext));
      pending = {
        tempId,
        objectKey,
        uploadId,
        ext: req.ext.toLowerCase(),
        size,
        parts: [],
        phase: "uploading",
        sourcePath: req.sourcePath,
        occurrenceId: req.occurrenceId,
        localPath: req.localPath,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.settings.pendingUploads[tempId] = pending;
      await this.persist();
    }

    // OSS 对象已经完成，仅重试引用提交，不得重复上传。
    if (pending.phase === "uploaded") {
      return { tempId: pending.tempId, objectKey: pending.objectKey };
    }

    const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
    const doneNumbers = new Set(pending.parts.map((p) => p.partNumber));
    req.onProgress?.(doneNumbers.size, totalParts);

    try {
      for (let n = 1; n <= totalParts; n++) {
        if (doneNumbers.has(n)) continue;
        const start = (n - 1) * PART_SIZE;
        const end = Math.min(start + PART_SIZE, size);
        const chunk = req.blob.slice(start, end);
        const buf = await chunk.arrayBuffer();
        const { etag } = await withRetry(() =>
          this.client.uploadPart({
            key: pending!.objectKey,
            uploadId: pending!.uploadId,
            partNumber: n,
            body: buf,
          }),
          isRecoverableUploadError,
        );
        pending.parts.push({ partNumber: n, etag });
        pending.updatedAt = Date.now();
        await this.persist();
        req.onProgress?.(pending.parts.length, totalParts);
      }

      await withRetry(() =>
        this.client.completeMultipart({
          key: pending!.objectKey,
          uploadId: pending!.uploadId,
          parts: pending!.parts,
        }),
        isRecoverableUploadError,
      );

      pending.phase = "uploaded";
      pending.updatedAt = Date.now();
      await this.persist();
      return { tempId: pending.tempId, objectKey: pending.objectKey };
    } catch (err) {
      if (isRecoverableUploadError(err)) {
        pending.updatedAt = Date.now();
        await this.persist();
        throw new UploadPausedError(pending.tempId, err);
      }
      console.error("[oss-upload] 不可恢复错误，触发 Abort", err);
      try {
        await this.client.abortMultipart(pending.objectKey, pending.uploadId);
      } catch (abortErr) {
        console.warn("[oss-upload] Abort 失败（可能已被服务端清理）", abortErr);
      }
      delete this.settings.pendingUploads[pending.tempId];
      await this.persist();
      throw err;
    }
  }

  async bindLocalPath(tempId: string, localPath: string): Promise<void> {
    const pending = this.settings.pendingUploads[tempId];
    if (!pending) return;
    pending.localPath = localPath;
    pending.updatedAt = Date.now();
    await this.persist();
  }

  /** 引用提交及本地清理全部成功后结束任务。 */
  async finalize(tempId: string): Promise<void> {
    if (!this.settings.pendingUploads[tempId]) return;
    delete this.settings.pendingUploads[tempId];
    await this.persist();
  }

  private findResume(req: UploadRequest): PendingUpload | undefined {
    if (!req.localPath) return undefined;
    return Object.values(this.settings.pendingUploads).find((pending) =>
      pending.localPath === req.localPath &&
      pending.sourcePath === req.sourcePath &&
      pending.occurrenceId === req.occurrenceId &&
      pending.size === req.blob.size &&
      pending.ext === req.ext.toLowerCase()
    );
  }

  /** 主动放弃某个未完成上传：调 Abort 并清状态 */
  async abort(tempId: string): Promise<void> {
    const p = this.settings.pendingUploads[tempId];
    if (!p) return;
    try {
      await this.client.abortMultipart(p.objectKey, p.uploadId);
    } catch (err) {
      console.warn("[oss-upload] Abort 失败（可能已被服务端清理）", err);
    }
    delete this.settings.pendingUploads[tempId];
    await this.persist();
  }

  /** 启动清理：找出 24h 未更新的本地 pending + 服务端孤儿，全部 abort */
  async cleanupOrphans(maxAgeMs: number = 24 * 3600 * 1000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    // 1. 本地 pending 中 24h 未更新的
    for (const [tempId, p] of Object.entries(this.settings.pendingUploads)) {
      // 已完成对象不是孤儿分片，必须保留到引用提交成功。
      if (p.phase === "uploaded") continue;
      if (now - p.updatedAt > maxAgeMs) {
        await this.abort(tempId);
        cleaned++;
      }
    }

    // 2. 服务端存在但本地无记录的孤儿（Initiated 时间 > maxAge）
    try {
      const remotes = await this.client.listMultipartUploads();
      const localUploadIds = new Set(Object.values(this.settings.pendingUploads).map((p) => p.uploadId));
      for (const r of remotes) {
        if (localUploadIds.has(r.uploadId)) continue;
        const initiatedMs = Date.parse(r.initiated);
        if (Number.isFinite(initiatedMs) && now - initiatedMs > maxAgeMs) {
          try {
            await this.client.abortMultipart(r.key, r.uploadId);
            cleaned++;
          } catch (err) {
            console.warn("[oss-upload] Abort 孤儿分片失败", r, err);
          }
        }
      }
    } catch (err) {
      // ListMultipartUploads 失败不影响本地清理
      console.warn("[oss-upload] ListMultipartUploads 失败", err);
    }

    if (cleaned > 0) new Notice(`已清理 ${cleaned} 个孤儿分片上传`);
    return cleaned;
  }
}

/** 指数退避重试：最多 MAX_RETRIES 次，延迟 1s → 2s → 4s */
async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err)) throw err;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRecoverableUploadError(error: unknown): boolean {
  if (!(error instanceof OssError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}
