import * as path from "node:path";

import { throwIfAborted } from "../runtime/host.js";

interface PendingSessionMutation {
  started: boolean;
  start(): void;
  cancel(): void;
}

export class SessionMutationFence {
  private readonly queues = new Map<string, PendingSessionMutation[]>();

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
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      const entry: PendingSessionMutation = {
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
    storageDirectory === undefined ? null : path.resolve(storageDirectory),
    sessionId,
  ]);
}
