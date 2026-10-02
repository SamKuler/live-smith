import { URL } from "node:url";
import { throwIfAborted } from "./host.js";
import { createSystemBrowserOpener, type SystemBrowserOpenerOptions } from "./system-browser.js";

/** Only a short-lived, resource-scoped local download ticket may leave the dialog. */
export function createMediaDownloadBrowserOpener(options: SystemBrowserOpenerOptions = {}) {
  const open = createSystemBrowserOpener({ ...options, allowLoopbackHttp: true });
  return async (target: string, signal?: AbortSignal): Promise<void> => {
    throwIfAborted(signal);
    let url: URL;
    try {
      url = new URL(target);
      const tickets = url.searchParams.getAll("token");
      if (url.href !== target || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.hash || !["/audio-download", "/midi-download"].includes(url.pathname) ||
        [...url.searchParams.keys()].length !== 1 || tickets.length !== 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(tickets[0]!)) throw new Error();
    } catch { throw new Error("Media export requires a resource-scoped local download link."); }
    await open(url.href, signal);
  };
}

export const openMediaDownload = createMediaDownloadBrowserOpener();
