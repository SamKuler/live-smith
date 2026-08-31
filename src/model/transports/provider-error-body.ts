import {
  clearTimeout as cancelTimeout,
  setTimeout as scheduleTimeout,
} from "node:timers";

import {
  createHostAbortController,
  throwIfAborted,
} from "../../runtime/host.js";
import { readBoundedJsonResponse } from "./response-body.js";

const maximumProviderErrorResponseBytes = 64 * 1024;
const maximumProviderErrorReadMs = 25;

export async function readBoundedProviderErrorJson(
  response: Response,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = createHostAbortController();
  const relayAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relayAbort, { once: true });
  if (signal?.aborted) relayAbort();
  // Error details are best-effort diagnostics. Admit already-buffered JSON, but
  // never let a body that produces no first chunk block HTTP classification.
  const timeout = scheduleTimeout(
    () => controller.abort(new Error(`${label} read timed out.`)),
    maximumProviderErrorReadMs,
  );
  timeout.unref();
  try {
    const payload = await readBoundedJsonResponse(response, {
      label,
      maximumBytes: maximumProviderErrorResponseBytes,
      signal: controller.signal,
    });
    throwIfAborted(signal);
    return payload;
  } catch {
    throwIfAborted(signal);
    return undefined;
  } finally {
    cancelTimeout(timeout);
    signal?.removeEventListener("abort", relayAbort);
  }
}
