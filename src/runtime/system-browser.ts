import { URL } from "node:url";

import { throwIfAborted } from "./host.js";
import { createSystemOpener, type SystemOpenerOptions } from "./system-open.js";

export interface SystemBrowserOpenerOptions extends SystemOpenerOptions {
  /** Resource-specific callers must still validate the exact local route. */
  allowLoopbackHttp?: boolean;
}

/** Callers own destination allowlists; this module owns only the OS handler. */
export function createSystemBrowserOpener(
  options: SystemBrowserOpenerOptions = {},
): (target: string, signal?: AbortSignal) => Promise<void> {
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const open = createSystemOpener("system browser", options);

  return async (target, signal) => {
    throwIfAborted(signal);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error("The system browser requires a valid HTTPS URL.");
    }
    if (
      (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port)) ||
      url.username ||
      url.password
    ) {
      throw new Error("The system browser requires a valid HTTPS URL.");
    }
    await open(url.toString(), signal);
  };
}
