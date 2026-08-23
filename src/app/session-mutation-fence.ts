import { throwIfAborted } from "../runtime/host.js";
import { storageScopeKey } from "../storage/scope.js";

interface PendingSessionMutation {
  kind: string | undefined;
  started: boolean;
  start(): void;
  cancel(): void;
}

export class SessionMutationFence {
  private readonly queues = new Map<string, PendingSessionMutation[]>();

  hasQueuedOrActive(key: string, kind: string): boolean {
    return this.queues.get(key)?.some((entry) => entry.kind === kind) ?? false;
  }

  runNamed<T>(
    key: string,
    kind: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(key, kind, signal, operation);
  }

  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T>;
  run<T>(
    key: string,
    signalOrOperation: AbortSignal | (() => Promise<T>) | undefined,
    possibleOperation?: () => Promise<T>,
  ): Promise<T> {
    const signal = typeof signalOrOperation === "function"
      ? undefined
      : signalOrOperation;
    const operation = typeof signalOrOperation === "function"
      ? signalOrOperation
      : possibleOperation;
    if (!operation) {
      return Promise.reject(new Error("Session mutation operation is required."));
    }
    return this.enqueue(key, undefined, signal, operation);
  }

  private enqueue<T>(
    key: string,
    kind: string | undefined,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      const entry: PendingSessionMutation = {
        kind,
        started: false,
        start: () => {
          if (entry.started) return;
          entry.started = true;
          if (abortListener) signal?.removeEventListener("abort", abortListener);
          void Promise.resolve()
            .then(() => {
              throwIfAborted(signal);
              return operation();
            })
            .then(resolve, reject)
            .finally(() => this.release(key, entry));
        },
        cancel: () => {
          if (entry.started) return;
          const queue = this.queues.get(key);
          const index = queue?.indexOf(entry) ?? -1;
          if (!queue || index < 0) return;
          queue.splice(index, 1);
          if (abortListener) signal?.removeEventListener("abort", abortListener);
          if (queue.length === 0) this.queues.delete(key);
          try {
            throwIfAborted(signal);
            reject(new Error("Session mutation operation was cancelled."));
          } catch (error) {
            reject(error);
          }
          if (index === 0) queue[0]?.start();
        },
      };

      const queue = this.queues.get(key) ?? [];
      if (queue.length === 0) this.queues.set(key, queue);
      queue.push(entry);
      if (signal) {
        abortListener = entry.cancel;
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) entry.cancel();
      }
      if (queue[0] === entry) entry.start();
    });
  }

  private release(key: string, entry: PendingSessionMutation): void {
    const queue = this.queues.get(key);
    if (!queue || queue[0] !== entry) return;
    queue.shift();
    if (queue.length === 0) {
      this.queues.delete(key);
      return;
    }
    queue[0]?.start();
  }
}

export function sessionMutationFenceKey(
  storageDirectory: string | undefined,
  sessionId: string,
): string {
  return JSON.stringify([
    storageDirectory === undefined ? null : storageScopeKey(storageDirectory),
    sessionId,
  ]);
}
