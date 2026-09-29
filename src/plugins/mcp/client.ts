import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { TransformStream } from "node:stream/web";
import { URL } from "node:url";
import { TextDecoder } from "node:util";
import { Buffer } from "node:buffer";

import { resolveFetchImplementation, throwIfAborted } from "../../runtime/host.js";
import { validateRemoteUrl, type PluginMcpServer, type PluginMcpStdioServer } from "./config.js";
import { emptyPluginConfig, resolvePluginConfigReference, type PluginConfigField, type StoredPluginConfig } from "../user-config.js";

const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_STDIO_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 4 * 1024 * 1024;
const TERMINATE_TIMEOUT_MS = 1_000;

export interface PluginMcpRuntimePaths {
  pluginRoot: string;
  pluginData: string;
  userConfig?: { fields: readonly PluginConfigField[]; stored: StoredPluginConfig };
  secrets?: Readonly<Record<string, string>>;
}

export interface ConnectedPluginMcpServer {
  listTools(signal: AbortSignal): Promise<readonly Tool[]>;
  callTool(name: string, argumentsValue: unknown, signal: AbortSignal): Promise<CallToolResult>;
  readResource?(uri: string, signal: AbortSignal): Promise<unknown>;
  listResources?(templates: boolean, cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectPluginMcpServerOptions {
  fetchImpl?: typeof fetch;
}

export class PluginMcpConnectionError extends Error {
  constructor(operation: "connect" | "list" | "call", serverId: string) {
    super(`Plugin MCP ${operation} failed for server ${serverId}.`);
    this.name = "PluginMcpConnectionError";
  }
}

export async function connectPluginMcpServer(
  server: PluginMcpServer,
  paths: PluginMcpRuntimePaths | undefined,
  signal: AbortSignal,
  options: ConnectPluginMcpServerOptions = {},
): Promise<ConnectedPluginMcpServer> {
  throwIfAborted(signal);
  const client = new Client({ name: "live-smith", version: "0.2.2" }, {
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    listMaxPages: 16,
    defaultCacheTtlMs: 0,
    versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000, maxRetries: 0 } },
  });
  let transport: Transport;
  let remoteTransport: StreamableHTTPClientTransport | undefined;
  if (server.type === "stdio") {
    const resolved = resolveStdioServer(server, paths);
    const stdio = new StdioClientTransport({
      ...resolved,
      stderr: "pipe",
      maxBufferSize: MAX_STDIO_MESSAGE_BYTES,
    });
    stdio.stderr?.on("data", () => undefined);
    transport = stdio;
  } else {
    const url = expandPluginMcpTemplate(server.url, paths);
    validateRemoteUrl(url);
    const headers = Object.fromEntries(Object.entries(server.headers).map(([name, value]) =>
      [name, expandPluginMcpTemplate(value, paths, "credentials")]));
    if (Object.values(headers).some((value) => /[\u0000\r\n]/u.test(value))) throw new PluginMcpConnectionError("connect", server.id);
    const fetchImpl = redirectRejectingFetch(resolveFetchImplementation(options.fetchImpl));
    remoteTransport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: fetchImpl,
      requestInit: { headers, redirect: "manual" },
      onInsufficientScope: "throw",
      maxStepUpRetries: 0,
    });
    transport = remoteTransport;
  }
  try {
    await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
  } catch {
    await client.close().catch(() => undefined);
    throw new PluginMcpConnectionError("connect", server.id);
  }
  return {
    async listResources(templates, cursor, requestSignal) {
      try {
        const params = cursor === undefined ? {} : { cursor };
        const options = { signal: requestSignal, timeout: LIST_TIMEOUT_MS };
        const result = templates ? await client.listResourceTemplates(params, options) : await client.listResources(params, options);
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_REMOTE_RESPONSE_BYTES) throw new Error("Oversized resources.");
        return result;
      } catch { throwIfAborted(requestSignal); throw new PluginMcpConnectionError("list", server.id); }
    },
    async readResource(uri, requestSignal) {
      try {
        const result = await client.readResource({ uri }, { signal: requestSignal, timeout: LIST_TIMEOUT_MS });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_REMOTE_RESPONSE_BYTES) throw new Error("Oversized resource.");
        return result;
      } catch { throwIfAborted(requestSignal); throw new PluginMcpConnectionError("call", server.id); }
    },
    async listTools(requestSignal) {
      try {
        const result = await client.listTools(undefined, {
          signal: requestSignal,
          timeout: LIST_TIMEOUT_MS,
          maxTotalTimeout: LIST_TIMEOUT_MS,
          cacheMode: "refresh",
        });
        return result.tools;
      } catch {
        throw new PluginMcpConnectionError("list", server.id);
      }
    },
    async callTool(name, argumentsValue, requestSignal) {
      try {
        return await client.callTool({ name, arguments: toolArguments(argumentsValue) }, {
          signal: requestSignal,
          timeout: CALL_TIMEOUT_MS,
          maxTotalTimeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        });
      } catch {
        throw new PluginMcpConnectionError("call", server.id);
      }
    },
    async close() {
      try {
        if (remoteTransport) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              remoteTransport.terminateSession(),
              new Promise<void>((resolve) => { timeout = setTimeout(resolve, TERMINATE_TIMEOUT_MS); }),
            ]);
          } catch { /* Session termination is best effort. */ }
          finally { if (timeout) clearTimeout(timeout); }
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

function resolveStdioServer(
  server: PluginMcpStdioServer,
  paths: PluginMcpRuntimePaths | undefined,
): { command: string; args: string[]; env: Record<string, string>; cwd?: string } {
  if (!paths) return {
    command: server.command,
    args: [...server.args],
    env: { ...getDefaultEnvironment(), ...server.env },
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
  };
  const expand = (value: string): string => expandPluginMcpTemplate(value, paths);
  const expandedCommand = expand(server.command);
  const command = expandedCommand.startsWith("./")
    ? containedPath(paths.pluginRoot, path.resolve(paths.pluginRoot, expandedCommand))
    : expandedCommand;
  const cwdValue = expand(server.cwd ?? paths.pluginRoot);
  const cwd = path.isAbsolute(cwdValue)
    ? cwdValue
    : containedPath(paths.pluginRoot, path.resolve(paths.pluginRoot, cwdValue));
  const env = {
    ...getDefaultEnvironment(),
    ...Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expandPluginMcpTemplate(value, paths, "credentials")])),
    PLUGIN_ROOT: paths.pluginRoot,
    PLUGIN_DATA: paths.pluginData,
    CLAUDE_PLUGIN_ROOT: paths.pluginRoot,
    CLAUDE_PLUGIN_DATA: paths.pluginData,
  };
  return { command, args: server.args.map(expand), env, cwd };
}

/** Resolves original placeholders once; configured strings are never templates. */
export function expandPluginMcpTemplate(
  value: string, paths: PluginMcpRuntimePaths | undefined, mode: "literal" | "credentials" = "literal",
): string {
  if (!paths) return value;
  const variables = new Map([
    ["PLUGIN_ROOT", paths.pluginRoot], ["PLUGIN_DATA", paths.pluginData],
    ["CLAUDE_PLUGIN_ROOT", paths.pluginRoot], ["CLAUDE_PLUGIN_DATA", paths.pluginData],
  ]);
  return value.replace(/\$\{(?:user_config\.([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?)\}/gu,
    (whole, configName: string | undefined, name: string | undefined, fallback: string | undefined) => {
      if (configName) return resolvePluginConfigReference(configName, paths.userConfig?.fields ?? [],
        paths.userConfig?.stored ?? emptyPluginConfig(), "mcp");
      if (variables.has(name!)) return variables.get(name!)!;
      if (mode === "literal") return whole;
      const secret = paths.secrets && Object.hasOwn(paths.secrets, name!) ? paths.secrets[name!] : undefined;
      if (secret) return secret;
      if (fallback !== undefined) return fallback;
      throw new Error(`MCP credential ${name} is not configured.`);
    });
}

function containedPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Plugin MCP path escapes the Plugin root.");
  }
  return target;
}

function redirectRejectingFetch(fetchImpl: typeof fetch): FetchLike {
  return async (input, init = {}) => {
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("Plugin MCP redirect was rejected.");
    }
    return boundedRemoteResponse(response);
  };
}

function boundedRemoteResponse(response: Response): Response {
  const sse = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
  let bytes = 0;
  let lineHasContent = false;
  let afterCarriageReturn = false;
  let blankCarriageReturn = false;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (sse) {
        for (const byte of chunk) {
          bytes += 1;
          if (byte === 13) {
            blankCarriageReturn = !lineHasContent;
            if (blankCarriageReturn) bytes = 0;
            lineHasContent = false;
            afterCarriageReturn = true;
          } else if (byte === 10) {
            if (afterCarriageReturn) {
              if (blankCarriageReturn) bytes = 0;
              afterCarriageReturn = false;
              blankCarriageReturn = false;
            }
            else {
              if (!lineHasContent) bytes = 0;
              lineHasContent = false;
            }
          } else {
            lineHasContent = true;
            afterCarriageReturn = false;
            blankCarriageReturn = false;
          }
          if (bytes > MAX_REMOTE_RESPONSE_BYTES) break;
        }
      } else bytes += chunk.byteLength;
      if (bytes > MAX_REMOTE_RESPONSE_BYTES) {
        throw new Error("Plugin MCP response exceeded the byte limit.");
      }
      controller.enqueue(chunk);
    },
  });
  // Node's Web Stream declarations differ from Fetch's DOM stream declarations.
  const body = response.body?.pipeThrough(limiter as never) as ReadableStream<Uint8Array> | undefined;
  const readText = async (): Promise<string> => {
    if (!body) return "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let readBytes = 0;
    let completed = false;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) { completed = true; break; }
        if (sse) {
          readBytes += result.value.byteLength;
          if (readBytes > MAX_REMOTE_RESPONSE_BYTES) {
            throw new Error("Plugin MCP response exceeded the byte limit.");
          }
        }
        parts.push(decoder.decode(result.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } finally {
      if (!completed) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  return new Proxy(response, {
    get(target, property) {
      if (property === "body") return body ?? null;
      if (property === "text") return readText;
      if (property === "json") return async () => JSON.parse(await readText()) as unknown;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Plugin tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
