import { clearTimeout, setTimeout } from "node:timers";

import { ModelConnectionError } from "../model/connection-error.js";
import { throwIfAborted } from "../runtime/host.js";

const reconnectDelaysMs = [500, 1_000, 2_000, 4_000, 8_000] as const;
const reconnectAttemptLimit = reconnectDelaysMs.length;
const reconnectExhaustedMessage =
  "Model connection was lost after 5 reconnect attempts.";

export interface ModelReconnectAttempt {
  markResponseStarted(): Promise<void>;
}

export type ModelReconnectWait = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

export interface ModelReconnectOptions<T> {
  signal: AbortSignal;
  request(attempt: ModelReconnectAttempt): Promise<T>;
  resetTransient(): Promise<void> | void;
  onProgress(message: string): Promise<void> | void;
  /** Test-only clock seam; production uses the cancellable fixed schedule. */
  waitForDelay?: ModelReconnectWait;
}

export async function requestModelWithReconnect<T>(
  options: ModelReconnectOptions<T>,
): Promise<{ value: T; reconnected: boolean }> {
  let reconnectAttempt = 0;
  let reconnected = false;
  for (;;) {
    throwIfAborted(options.signal);
    let responseStarted: Promise<void> | undefined;
    const markResponseStarted = (): Promise<void> => {
      if (reconnectAttempt === 0) return Promise.resolve();
      responseStarted ??= (async () => {
        await options.onProgress("Reconnected. Reading model response");
        reconnected = true;
      })();
      return responseStarted;
    };

    try {
      const value = await options.request({ markResponseStarted });
      await markResponseStarted();
      return { value, reconnected };
    } catch (error) {
      throwIfAborted(options.signal);
      if (!(error instanceof ModelConnectionError)) throw error;
      if (reconnectAttempt >= reconnectAttemptLimit) {
        throw new Error(reconnectExhaustedMessage);
      }
      await options.resetTransient();
      throwIfAborted(options.signal);
      reconnectAttempt += 1;
      await options.onProgress(
        `Model connection lost. Reconnecting (${reconnectAttempt}/${reconnectAttemptLimit})…`,
      );
      throwIfAborted(options.signal);
      try {
        await (options.waitForDelay ?? waitForReconnectDelay)(
          reconnectDelaysMs[reconnectAttempt - 1]!,
          options.signal,
        );
      } catch (error) {
        throwIfAborted(options.signal);
        throw error;
      }
    }
  }
}

function waitForReconnectDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
