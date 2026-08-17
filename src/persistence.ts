import { PluginSettings } from "./types";

/** Clone settings for whole-file persistence without leaking runtime credentials. */
export function createPersistedSettingsSnapshot(
  settings: PluginSettings,
  preserveLegacyPlaintext: boolean,
): Partial<PluginSettings> {
  const snapshot = JSON.parse(JSON.stringify(settings)) as Partial<PluginSettings>;
  if (!preserveLegacyPlaintext) {
    delete snapshot.accessKeyId;
    delete snapshot.accessKeySecret;
  }
  return snapshot;
}

/**
 * Persist once; on failure retry immediately so disk and the in-memory
 * mutation do not diverge. Returns on the first success, otherwise throws
 * the most recent error.
 *
 * Why: a failed save can leave disk holding a partial new state. If the
 * caller rolls back only in memory, a later reload may see new ciphertext
 * paired with the old decryption key and fail permanently.
 */
export async function persistOrRetry(
  persist: () => Promise<void>,
  retries = 1,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await persist();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
