import type { SessionModelSelection } from "../storage/sessions.js";
import { storageScopeKey } from "../storage/scope.js";

export interface SessionModelSelectionChange {
  sessionId: string;
  modelSelection: SessionModelSelection;
}

type SessionModelSelectionListener = (
  change: SessionModelSelectionChange,
) => void;

const listenersByStorage = new Map<
  string | symbol,
  Set<SessionModelSelectionListener>
>();

export function subscribeSessionModelSelectionChanges(
  storageDirectory: string | undefined,
  listener: SessionModelSelectionListener,
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

export function publishSessionModelSelectionChange(
  storageDirectory: string | undefined,
  change: SessionModelSelectionChange,
): void {
  const listeners = listenersByStorage.get(storageScopeKey(storageDirectory));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener({
        sessionId: change.sessionId,
        modelSelection: {
          profileId: change.modelSelection.profileId,
          model: change.modelSelection.model,
          ...(change.modelSelection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: change.modelSelection.reasoningEffort }),
        },
      });
    } catch {
      // UI notification failures must not change the durable Session update.
    }
  }
}
