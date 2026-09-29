import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";

export interface PluginAppSandbox {
  register(csp?: McpUiResourceCsp): { url: string; dispose(): void };
  close(): Promise<void>;
}

const CSP_FIELDS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const;
const MAX_DOMAINS_PER_FIELD = 32;

export async function startPluginAppSandbox(hostOrigin: string): Promise<PluginAppSandbox> {
  const normalizedHost = allowedOrigin(hostOrigin);
  if (normalizedHost !== hostOrigin) throw new Error("MCP App host must be an exact origin.");
  const document = proxyDocument(hostOrigin);
  const policies = new Map<string, string>();
  let origin = "";
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", origin); }
    catch { request.resume(); response.writeHead(400).end("Invalid request"); return; }
    const policy = policies.get(url.pathname);
    if (closed || request.headers.host !== new URL(origin).host || !policy || url.search) {
      request.resume();
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      request.resume();
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : document);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("MCP App sandbox could not bind a loopback port."));
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return {
    register(csp) {
      if (closed) throw new Error("MCP App sandbox is closed.");
      const policy = contentSecurityPolicy(csp);
      const pathname = `/apps/${randomUUID()}`;
      policies.set(pathname, policy);
      return { url: `${origin}${pathname}`, dispose: () => { policies.delete(pathname); } };
    },
    close() {
      if (!closing) {
        closed = true;
        policies.clear();
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}

function allowedOrigin(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s;'"\\*]/u.test(value)) {
    throw new Error("MCP App CSP requires exact origins without wildcards.");
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MCP App CSP contains an invalid origin."); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MCP App CSP supports HTTPS and loopback HTTP origins without URL paths.");
  }
  return url.origin;
}

function contentSecurityPolicy(csp?: McpUiResourceCsp): string {
  const domains: Record<(typeof CSP_FIELDS)[number], string[]> = {
    connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [],
  };
  if (csp !== undefined && (csp === null || typeof csp !== "object" || Array.isArray(csp))) {
    throw new Error("MCP App CSP must be an object.");
  }
  for (const field of CSP_FIELDS) {
    const entries = csp?.[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > MAX_DOMAINS_PER_FIELD) {
      throw new Error("MCP App CSP contains too many origins.");
    }
    domains[field] = [...new Set(entries.map(allowedOrigin))];
  }
  const resources = domains.resourceDomains.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `media-src data: blob: ${resources}`,
    `font-src data: blob: ${resources}`,
    `connect-src ${domains.connectDomains.join(" ") || "'none'"}`,
    `frame-src ${domains.frameDomains.join(" ") || "'none'"}`,
    `base-uri ${domains.baseUriDomains.join(" ") || "'none'"}`,
    "object-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
  ].map((directive) => directive.trim()).join("; ");
}

function proxyDocument(hostOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>MCP App sandbox</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}body{overflow:hidden}</style></head><body><script>
(() => {
  if (window.parent === window) return;
  const hostOrigin = ${JSON.stringify(hostOrigin)};
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts");
  inner.setAttribute("referrerpolicy", "no-referrer");
  inner.title = "MCP App";
  document.body.appendChild(inner);
  let loaded = false;
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return;
    const sandboxMessage = typeof message.method === "string" && message.method.startsWith("ui/notifications/sandbox-");
    if (event.source === window.parent && event.origin === hostOrigin) {
      if (message.method === "ui/notifications/sandbox-resource-ready") {
        if (loaded || typeof message.params?.html !== "string") return;
        loaded = true;
        inner.srcdoc = message.params.html;
      } else if (loaded && !sandboxMessage) {
        inner.contentWindow.postMessage(message, "*");
      }
    } else if (loaded && event.source === inner.contentWindow && event.origin === "null" && !sandboxMessage) {
      window.parent.postMessage(message, hostOrigin);
    }
  });
  window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/sandbox-proxy-ready",params:{}}, hostOrigin);
})();
</script></body></html>`;
}
