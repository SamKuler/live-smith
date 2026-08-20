import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface CodexMetadataFirewall {
  readonly chatgptBaseUrl: string;
  close(): Promise<void>;
}

const loopbackAddress = "127.0.0.1";

export async function startCodexMetadataFirewall(): Promise<CodexMetadataFirewall> {
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
    await listenOnLoopback(server);
  } catch {
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

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, loopbackAddress, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}
