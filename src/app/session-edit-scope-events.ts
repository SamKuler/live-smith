import type { EditScope } from "../agent/edit-scopes.js";
import { storageScopeKey } from "../storage/scope.js";

export interface SessionEditScopesChange {
  sessionId: string;
  editScopes: EditScope[];
  updatedAt: string;
}

type SessionEditScopesListener = (change: SessionEditScopesChange) => void;
type SessionEditScopesInvalidationListener = (sessionId: string) => void;

const listenersByStorage = new Map<string | symbol, Set<SessionEditScopesListener>>();
const invalidationListenersByStorage = new Map<
  string | symbol,
  Set<SessionEditScopesInvalidationListener>
>();

export function subscribeSessionEditScopesChanges(
  storageDirectory: string | undefined,
  listener: SessionEditScopesListener,
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

export function publishSessionEditScopesChange(
  storageDirectory: string | undefined,
  change: SessionEditScopesChange,
): void {
  const listeners = listenersByStorage.get(storageScopeKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener({
        sessionId: change.sessionId,
        editScopes: [...change.editScopes],
        updatedAt: change.updatedAt,
      });
    } catch {
      // UI notification failures must not change the durable Session update.
    }
  }
}

export function subscribeSessionEditScopesInvalidations(
  storageDirectory: string | undefined,
  listener: SessionEditScopesInvalidationListener,
): () => void {
  const key = storageScopeKey(storageDirectory);
  const listeners = invalidationListenersByStorage.get(key) ?? new Set();
  listeners.add(listener);
  invalidationListenersByStorage.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) invalidationListenersByStorage.delete(key);
  };
}

export function invalidateSessionEditScopes(
  storageDirectory: string | undefined,
  sessionId: string,
): void {
  const listeners = invalidationListenersByStorage.get(storageScopeKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(sessionId);
    } catch {
      // One listener must not prevent other running requests from failing closed.
    }
  }
}
