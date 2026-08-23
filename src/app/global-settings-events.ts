import type {
  DefaultFollowUpBehavior,
  DefaultFollowUpBehaviorRevision,
} from "../model/profile.js";
import { storageScopeKey } from "../storage/scope.js";

export interface GlobalSettingsChange {
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
  commandId: string;
}

type GlobalSettingsListener = (change: GlobalSettingsChange) => void;

const listenersByStorage = new Map<
  string | symbol,
  Set<GlobalSettingsListener>
>();

export function subscribeGlobalSettingsChanges(
  storageDirectory: string | undefined,
  listener: GlobalSettingsListener,
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

export function publishGlobalSettingsChange(
  storageDirectory: string | undefined,
  change: GlobalSettingsChange,
): void {
  const listeners = listenersByStorage.get(storageScopeKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // UI notification failures must not change the outcome of a durable save.
    }
  }
}
