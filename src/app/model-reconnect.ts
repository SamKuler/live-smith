import { clearTimeout, setTimeout } from "node:timers";

import {
  ModelConnectionError,
  ModelRetryableError,
} from "../model/connection-error.js";
import { throwIfAborted } from "../runtime/host.js";

const reconnectDelaysMs = [500, 1_000, 2_000, 4_000, 8_000] as const;
const reconnectAttemptLimit = reconnectDelaysMs.length;
const maximumAutomaticRetryDelayMs = 300_000;

export interface ModelReconnectAttempt {
  markResponseStarted(): Promise<void>;
  readonly reconnectState: object;
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
  /** Test-only clock seam; production uses the cancellable retry schedule. */
  waitForDelay?: ModelReconnectWait;
}

export async function requestModelWithReconnect<T>(
  options: ModelReconnectOptions<T>,
): Promise<{ value: T; reconnected: boolean }> {
  let reconnectAttempt = 0;
  let reconnected = false;
  let retryKind: "connection" | "provider" | undefined;
  const reconnectState = {};
  for (;;) {
    throwIfAborted(options.signal);
    let responseStarted: Promise<void> | undefined;
    const markResponseStarted = (): Promise<void> => {
      if (reconnectAttempt === 0) return Promise.resolve();
      responseStarted ??= (async () => {
        await options.onProgress(
          retryKind === "connection"
            ? "Reconnected. Reading model response"
            : "Retry succeeded. Reading model response",
        );
        reconnected = true;
      })();
      return responseStarted;
    };

    try {
      const value = await options.request({ markResponseStarted, reconnectState });
      await markResponseStarted();
      return { value, reconnected };
    } catch (error) {
      throwIfAborted(options.signal);
      if (!(error instanceof ModelRetryableError)) throw error;
      if (
        error.retryAfterMs !== undefined &&
        error.retryAfterMs > maximumAutomaticRetryDelayMs
      ) {
        throw new Error(
          `${error.message} The provider requested waiting longer than the ` +
            "5-minute automatic retry window; try again later.",
        );
      }
      if (reconnectAttempt >= reconnectAttemptLimit) {
        if (error instanceof ModelConnectionError) {
          throw new Error(
            `${error.message} Reconnect limit reached after ${reconnectAttemptLimit} attempts.`,
          );
        }
        throw new Error(
          `${error.message} Retry limit reached after ${reconnectAttemptLimit} attempts.`,
        );
      }
      await options.resetTransient();
      throwIfAborted(options.signal);
      reconnectAttempt += 1;
      retryKind = error instanceof ModelConnectionError ? "connection" : "provider";
      const scheduledDelay = reconnectDelaysMs[reconnectAttempt - 1]!;
      const retryDelayMs = Math.max(scheduledDelay, error.retryAfterMs ?? 0);
      await options.onProgress(
        retryKind === "connection"
          ? `${error.message} Reconnecting ` +
            `(${reconnectAttempt}/${reconnectAttemptLimit}) in ${retryDelayMs} ms…`
          : `${error.message} Retrying ` +
            `(${reconnectAttempt}/${reconnectAttemptLimit}) in ${retryDelayMs} ms…`,
      );
      throwIfAborted(options.signal);
      try {
        await (options.waitForDelay ?? waitForReconnectDelay)(
          retryDelayMs,
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
