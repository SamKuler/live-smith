import * as path from "node:path";

import type { ApprovalMode } from "../model/profile.js";

export interface SessionApprovalModeChange {
  sessionId: string;
  approvalMode: ApprovalMode;
}

type SessionApprovalModeListener = (change: SessionApprovalModeChange) => void;

const memoryStorageKey = Symbol("live-smith-memory-storage");
const listenersByStorage = new Map<
  string | symbol,
  Set<SessionApprovalModeListener>
>();

function storageKey(storageDirectory: string | undefined): string | symbol {
  return storageDirectory === undefined
    ? memoryStorageKey
    : path.resolve(storageDirectory);
}

export function subscribeSessionApprovalModeChanges(
  storageDirectory: string | undefined,
  listener: SessionApprovalModeListener,
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

export function publishSessionApprovalModeChange(
  storageDirectory: string | undefined,
  change: SessionApprovalModeChange,
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
