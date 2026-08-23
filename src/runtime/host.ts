import { setImmediate as yieldImmediate } from "node:timers/promises";

export function resolveFetchImplementation(
  injected?: typeof fetch,
): typeof fetch {
  if (injected) return injected;
  const hostFetch = globalThis.fetch;
  if (typeof hostFetch !== "function") {
    throw new Error("Extension host does not provide the Fetch API.");
  }
  return hostFetch.bind(globalThis);
}

export function createHostAbortController(): AbortController {
  const HostAbortController = globalThis.AbortController;
  if (typeof HostAbortController !== "function") {
    throw new Error("Extension host does not provide AbortController.");
  }
  return new HostAbortController();
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if ("reason" in signal) throw signal.reason;
  throw new Error("Operation aborted.");
}

/** Cancels only this caller's wait; ownership of the operation stays unchanged. */
export function waitForPromiseWithSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function yieldToHost(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await yieldImmediate();
  throwIfAborted(signal);
}
