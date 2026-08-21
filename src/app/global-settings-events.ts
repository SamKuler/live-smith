import * as path from "node:path";

import type {
  DefaultFollowUpBehavior,
  DefaultFollowUpBehaviorRevision,
} from "../model/profile.js";

export interface GlobalSettingsChange {
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
  commandId: string;
}

type GlobalSettingsListener = (change: GlobalSettingsChange) => void;

const memoryStorageKey = Symbol("live-smith-memory-storage");
const listenersByStorage = new Map<
  string | symbol,
  Set<GlobalSettingsListener>
>();

function storageKey(storageDirectory: string | undefined): string | symbol {
  return storageDirectory === undefined
    ? memoryStorageKey
    : path.resolve(storageDirectory);
}

export function subscribeGlobalSettingsChanges(
  storageDirectory: string | undefined,
  listener: GlobalSettingsListener,
): () => void {
  const key = storageKey(storageDirectory);
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
  const listeners = listenersByStorage.get(storageKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // UI notification failures must not change the outcome of a durable save.
    }
  }
}
