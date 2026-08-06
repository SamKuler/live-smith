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
