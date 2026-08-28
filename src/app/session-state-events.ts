import { storageScopeKey } from "../storage/scope.js";

export interface SessionStateInvalidation {
  sessionId: string;
  source: symbol;
}

export interface GlobalStateInvalidation {
  source: symbol;
}

type SessionStateInvalidationListener = (
  invalidation: SessionStateInvalidation,
) => void;

const listenersByStorage = new Map<
  string | symbol,
  Set<SessionStateInvalidationListener>
>();
const globalListenersByStorage = new Map<
  string | symbol,
  Set<(invalidation: GlobalStateInvalidation) => void>
>();

export function subscribeSessionStateInvalidations(
  storageDirectory: string | undefined,
  listener: SessionStateInvalidationListener,
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

export function invalidateSessionState(
  storageDirectory: string | undefined,
  invalidation: SessionStateInvalidation,
): void {
  const listeners = listenersByStorage.get(storageScopeKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(invalidation);
    } catch {
      // A UI notification failure must not change the committed Session mutation.
    }
  }
}

export function subscribeGlobalStateInvalidations(
  storageDirectory: string | undefined,
  listener: (invalidation: GlobalStateInvalidation) => void,
): () => void {
  const key = storageScopeKey(storageDirectory);
  const listeners = globalListenersByStorage.get(key) ?? new Set();
  listeners.add(listener);
  globalListenersByStorage.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalListenersByStorage.delete(key);
  };
}

export function invalidateGlobalState(
  storageDirectory: string | undefined,
  invalidation: GlobalStateInvalidation,
): void {
  const listeners = globalListenersByStorage.get(
    storageScopeKey(storageDirectory),
  );
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(invalidation);
    } catch {
      // A UI notification failure must not change the committed mutation.
    }
  }
}
