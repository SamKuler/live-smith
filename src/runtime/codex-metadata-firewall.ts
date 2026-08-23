import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { throwIfAborted } from "./host.js";

export interface CodexMetadataFirewall {
  readonly chatgptBaseUrl: string;
  close(): Promise<void>;
}

const loopbackAddress = "127.0.0.1";

export async function startCodexMetadataFirewall(
  signal?: AbortSignal,
): Promise<CodexMetadataFirewall> {
  throwIfAborted(signal);
  const routePrefix = `/${randomBytes(32).toString("hex")}/backend-api/`;
  const responses = new Map<string, string>([
    [
      `${routePrefix}wham/settings/user`,
      JSON.stringify({ commit_attribution_enabled: false }),
    ],
    // A safe empty bundle prevents external cloud-config traffic. It does not
    // assert that workspace-managed subscription plans are eligible.
    [`${routePrefix}wham/config/bundle`, JSON.stringify({})],
  ]);
  const server = createServer((request, response) => {
    request.resume();
    const body = request.method === "GET"
      ? responses.get(request.url ?? "")
      : undefined;
    if (body === undefined) {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        Connection: "close",
        "Content-Length": "0",
      }).end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      Connection: "close",
      "Content-Length": String(body.length),
      "Content-Type": "application/json; charset=utf-8",
    }).end(body);
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  try {
    await listenOnLoopback(server, signal);
    throwIfAborted(signal);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    try {
      throwIfAborted(signal);
    } catch (abortError) {
      throw abortError;
    }
    throw new Error("Codex metadata firewall could not be started.");
  }
  const address = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== loopbackAddress ||
    address.port <= 0
  ) {
    await closeServer(server).catch(() => undefined);
    throw new Error("Codex metadata firewall could not be started.");
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeServer(server);
    return closePromise;
  };
  server.on("error", () => {
    void close().catch(() => undefined);
  });
  return {
    chatgptBaseUrl: `http://${loopbackAddress}:${address.port}${routePrefix}`,
    close,
  };
}

async function listenOnLoopback(
  server: Server,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      let reason: unknown = new Error("Operation aborted.");
      try {
        throwIfAborted(signal);
      } catch (error) {
        reason = error;
      }
      void closeServer(server).then(
        () => {
          cleanup();
          reject(reason);
        },
        () => {
          cleanup();
          reject(reason);
        },
      );
    };
    server.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      server.listen(0, loopbackAddress, () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });
    } catch (error) {
      onError(error as Error);
    }
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}
