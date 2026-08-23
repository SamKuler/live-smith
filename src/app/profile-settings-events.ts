import { storageScopeKey } from "../storage/scope.js";

export interface ProfileSettingsChange {
  commandId: string;
}

type ProfileSettingsListener = (change: ProfileSettingsChange) => void;

const listenersByStorage = new Map<
  string | symbol,
  Set<ProfileSettingsListener>
>();

export function subscribeProfileSettingsChanges(
  storageDirectory: string | undefined,
  listener: ProfileSettingsListener,
): () => void {
  const key = storageScopeKey(storageDirectory);
  const listeners = listenersByStorage.get(key) ?? new Set();
  listeners.add(listener);
  listenersByStorage.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByStorage.delete(key);
  };
}

export function publishProfileSettingsChange(
  storageDirectory: string | undefined,
  change: ProfileSettingsChange,
): void {
  const listeners = listenersByStorage.get(storageScopeKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // UI notification failures must not change the durable Profile mutation.
    }
  }
}
