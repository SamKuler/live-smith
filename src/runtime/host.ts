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

export function resolveHostFormData(): typeof FormData {
  const HostFormData = globalThis.FormData;
  if (typeof HostFormData !== "function") {
    throw new Error("File uploads require Ableton Live 12.4.15b5 or later (FormData is unavailable).");
  }
  return HostFormData;
}

export function combineHostAbortSignals(signals: AbortSignal[]): AbortSignal {
  const HostAbortSignal = globalThis.AbortSignal;
  if (typeof HostAbortSignal?.any !== "function") {
    throw new Error("This operation requires Ableton Live 12.4.15b5 or later (AbortSignal.any is unavailable).");
  }
  return HostAbortSignal.any(signals);
}

export function fetchRequestSignal(input: Parameters<typeof fetch>[0], init?: RequestInit): AbortSignal | undefined {
  if (init?.signal === null) return undefined;
  return init?.signal ?? (typeof input === "object" && "signal" in input ? input.signal : undefined);
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
    // The operation already exists even when this caller cannot wait for it.
    // Own its rejection so a late failure cannot escape as an unhandled promise.
    void operation.catch(() => undefined);
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
