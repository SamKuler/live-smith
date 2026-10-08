import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { URL } from "node:url";
import { throwIfAborted } from "./host.js";

const CALLBACK_FLUSH_TIMEOUT_MS = 1_000;

export interface OAuthCallbackResult { code: string; iss?: string }
export interface OAuthLoopbackCallback {
  redirectUri: string;
  completion: Promise<OAuthCallbackResult>;
  cancel(reason?: unknown): void;
}

export async function startOAuthLoopbackCallback(options: {
  port: number;
  path: string;
  expectedState: string;
  signal: AbortSignal;
  successMessage: string;
  listenHost?: "127.0.0.1";
  redirectHost?: "localhost" | "127.0.0.1";
  timeoutMs?: number;
}): Promise<OAuthLoopbackCallback> {
  let settle!: (value: OAuthCallbackResult) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<OAuthCallbackResult>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  let server!: Server;
  const sockets = new Set<Socket>();
  let timeout: ReturnType<typeof scheduleTimeout> | undefined;
  let boundPort = options.port;
  const listenHost = options.listenHost ?? "127.0.0.1";
  const redirectHost = options.redirectHost ?? "localhost";
  const finish = (operation: () => void, callbackSocket?: Socket): void => {
    if (settled) return;
    settled = true;
    options.signal.removeEventListener("abort", onAbort);
    if (timeout !== undefined) cancelTimeout(timeout);
    let closeTimeout: ReturnType<typeof scheduleTimeout> | undefined;
    server.close(() => {
      if (closeTimeout !== undefined) cancelTimeout(closeTimeout);
      operation();
    });
    for (const socket of sockets) {
      if (socket !== callbackSocket) socket.destroy();
    }
    // Allow the terminal callback HTML to flush, but never let an idle or
    // non-reading browser connection retain the authorization lifecycle.
    if (callbackSocket && !callbackSocket.destroyed) {
      closeTimeout = scheduleTimeout(() => callbackSocket.destroy(), CALLBACK_FLUSH_TIMEOUT_MS);
      closeTimeout.unref();
    }
  };
  const onAbort = (): void => finish(() => {
    try {
      throwIfAborted(options.signal);
    } catch (error) {
      reject(error);
    }
  });
  server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "", `http://${redirectHost}:${boundPort}`);
      if (url.pathname !== options.path) {
        sendHtml(response, 404, "OAuth callback route not found.");
        return;
      }
      if (request.method !== "GET" || url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length > 1 || url.searchParams.getAll("iss").length > 1 ||
        url.searchParams.get("state") !== options.expectedState) {
        sendHtml(response, 400, "OAuth state did not match.");
        return;
      }
      if (url.searchParams.has("error")) {
        sendHtml(response, 400, "OAuth authorization did not complete.");
        finish(() => reject(new Error("OAuth authorization did not complete.")), request.socket);
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        sendHtml(response, 400, "OAuth callback did not contain a code.");
        return;
      }
      sendHtml(response, 200, options.successMessage);
      const issuer = url.searchParams.get("iss");
      finish(() => settle({ code, ...(issuer === null ? {} : { iss: issuer }) }), request.socket);
    } catch {
      sendHtml(response, 500, "OAuth callback could not be processed.");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (settled) socket.destroy();
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, listenHost, () => {
      server.removeListener("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectListen(new Error("OAuth callback server did not expose a TCP port."));
        return;
      }
      boundPort = address.port;
      resolve();
    });
  });
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  if (!settled) {
    timeout = scheduleTimeout(
      () => finish(() => reject(new Error("OAuth authorization timed out."))),
      options.timeoutMs ?? 5 * 60 * 1_000,
    );
    timeout.unref();
  }
  return {
    redirectUri: `http://${redirectHost}:${boundPort}${options.path}`,
    completion,
    cancel(reason = new Error("OAuth sign-in was canceled.")) {
      finish(() => reject(reason));
    },
  };
}

function sendHtml(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("connection", "close");
  response.end(`<!doctype html><meta charset="utf-8"><title>Live Smith</title><p>${escapeHtml(message)}</p>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}
