import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer, connect, type Socket } from "node:net";
import { throwIfAborted } from "./host.js";

/** A private CONNECT tunnel gives WebKit an explicit *direct* route. No TLS is
 * intercepted; website requests retain their real HTTPS origin and certificate. */
export async function createNativeVerificationDirectProxy(signal: AbortSignal, connectUpstream: typeof connect = connect): Promise<{
  url: string; username: string; password: string; close(): Promise<void>;
}> {
  throwIfAborted(signal);
  const username = "live-smith";
  const password = randomBytes(32).toString("hex");
  const authorization = Buffer.from("Basic " + Buffer.from(`${username}:${password}`).toString("base64"));
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 16_384) { client.destroy(); return; }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.removeListener("data", onData);
      client.pause();
      const lines = header.subarray(0, end).toString("ascii").split("\r\n");
      const target = /^CONNECT ([a-zA-Z0-9.-]+):443 HTTP\/1\.[01]$/u.exec(lines.shift() ?? "")?.[1]?.toLowerCase();
      const supplied = lines.filter(line => /^proxy-authorization:/iu.test(line));
      const credentials = Buffer.from(supplied[0]?.slice(supplied[0].indexOf(":") + 1).trim() ?? "");
      if (supplied.length !== 1 || credentials.length !== authorization.length || !timingSafeEqual(credentials, authorization)) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Live Smith\"\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!target || !allowedVerificationHost(target)) { client.destroy(); return; }
      const upstream = connectUpstream({ host: target, port: 443 });
      sockets.add(upstream);
      upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => { upstream.destroy(); client.destroy(); });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = header.subarray(end + 4);
        if (remainder.length) upstream.write(remainder);
        header = Buffer.alloc(0);
        client.pipe(upstream).pipe(client);
        client.resume();
      });
    };
    client.on("data", onData);
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => {
    signal.removeEventListener("abort", onAbort);
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  const onAbort = () => { void close(); };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    throwIfAborted(signal);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    return { url: `http://127.0.0.1:${address.port}`, username, password, close };
  } catch {
    await close();
    throwIfAborted(signal);
    throw new Error("The verification network route could not be opened.");
  }
}

function allowedVerificationHost(host: string): boolean {
  return ["suno.com", "suno.ai", "hcaptcha.com"].some(domain => host === domain || host.endsWith("." + domain)) ||
    host === "challenges.cloudflare.com";
}
