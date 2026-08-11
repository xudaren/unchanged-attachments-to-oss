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
