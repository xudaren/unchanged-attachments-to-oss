export const CREDENTIAL_CIPHER_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ADDITIONAL_DATA = encoder.encode("unchanged-attachments-to-oss:credentials:v1");

export interface OssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}

export interface EncryptedCredentials {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface UnlockedCredentials {
  credentials: OssCredentials;
  key: CryptoKey;
}

export function credentialPromptMode(input: {
  hasEncryptedCredentials: boolean;
  hasRuntimeCredentials: boolean;
  isUnlocked: boolean;
}): "migrate" | "unlock" | null {
  if (input.hasEncryptedCredentials) return input.isUnlocked ? null : "unlock";
  return input.hasRuntimeCredentials ? "migrate" : null;
}

export async function encryptCredentials(
  credentials: OssCredentials,
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<{ encrypted: EncryptedCredentials; key: CryptoKey }> {
  validatePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, iterations);
  return { encrypted: await encryptWithKey(credentials, key, salt, iterations), key };
}

export async function reencryptCredentials(
  credentials: OssCredentials,
  key: CryptoKey,
  previous: EncryptedCredentials,
): Promise<EncryptedCredentials> {
  validateEnvelope(previous);
  return encryptWithKey(credentials, key, fromBase64(previous.salt), previous.iterations);
}

export async function decryptCredentials(
  encrypted: EncryptedCredentials,
  password: string,
): Promise<UnlockedCredentials> {
  validatePassword(password);
  validateEnvelope(encrypted);
  const key = await deriveKey(password, fromBase64(encrypted.salt), encrypted.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(fromBase64(encrypted.iv)),
        additionalData: toArrayBuffer(ADDITIONAL_DATA),
        tagLength: 128,
      },
      key,
      toArrayBuffer(fromBase64(encrypted.ciphertext)),
    );
    const parsed = JSON.parse(decoder.decode(plaintext)) as Partial<OssCredentials>;
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.accessKeySecret !== "string") {
      throw new Error("凭证密文内容无效");
    }
    return { credentials: { accessKeyId: parsed.accessKeyId, accessKeySecret: parsed.accessKeySecret }, key };
  } catch (error) {
    if (error instanceof Error && error.message === "凭证密文内容无效") throw error;
    throw new Error("主密码错误或凭证密文已损坏");
  }
}

export function isEncryptedCredentials(value: unknown): value is EncryptedCredentials {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EncryptedCredentials>;
  return item.version === CREDENTIAL_CIPHER_VERSION &&
    item.kdf === "PBKDF2-SHA256" &&
    Number.isInteger(item.iterations) &&
    typeof item.salt === "string" &&
    typeof item.iv === "string" &&
    typeof item.ciphertext === "string";
}

function validatePassword(password: string): void {
  if (!password) throw new Error("主密码不能为空");
  if (password.length < 10) throw new Error("主密码至少需要 10 个字符");
}

function validateEnvelope(value: EncryptedCredentials): void {
  if (!isEncryptedCredentials(value)) throw new Error("凭证密文格式不受支持");
  if (value.iterations < 100_000 || value.iterations > 10_000_000) {
    throw new Error("凭证密文的 KDF 参数无效");
  }
  const salt = fromBase64(value.salt);
  const iv = fromBase64(value.iv);
  const ciphertext = fromBase64(value.ciphertext);
  if (salt.byteLength < 16 || iv.byteLength !== 12 || ciphertext.byteLength < 17) {
    throw new Error("凭证密文格式无效");
  }
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  // Normalize to NFC so passwords that look identical but use different
  // Unicode code-point sequences (e.g. precomposed é vs e + combining acute
  // from mobile keyboards) derive the same key. Otherwise a user who typed
  // their password on a device that produced NFD input could never decrypt.
  const normalized = password.normalize("NFC");
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalized),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptWithKey(
  credentials: OssCredentials,
  key: CryptoKey,
  salt: Uint8Array,
  iterations: number,
): Promise<EncryptedCredentials> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(ADDITIONAL_DATA),
      tagLength: 128,
    },
    key,
    plaintext,
  );
  return {
    version: CREDENTIAL_CIPHER_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new Error("凭证密文 Base64 无效");
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}
