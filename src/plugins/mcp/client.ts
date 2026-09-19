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
import { URL } from "node:url";

import { resolveFetchImplementation, throwIfAborted } from "../../runtime/host.js";
import type { PluginMcpServer, PluginMcpStdioServer } from "./config.js";

const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_STDIO_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface PluginMcpRuntimePaths {
  pluginRoot: string;
  pluginData: string;
}

export interface ConnectedPluginMcpServer {
  listTools(signal: AbortSignal): Promise<readonly Tool[]>;
  callTool(name: string, argumentsValue: unknown, signal: AbortSignal): Promise<CallToolResult>;
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
  paths: PluginMcpRuntimePaths,
  signal: AbortSignal,
  options: ConnectPluginMcpServerOptions = {},
): Promise<ConnectedPluginMcpServer> {
  throwIfAborted(signal);
  const client = new Client({ name: "live-smith", version: "0.2.2" }, {
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
    const fetchImpl = redirectRejectingFetch(resolveFetchImplementation(options.fetchImpl));
    remoteTransport = new StreamableHTTPClientTransport(new URL(server.url), {
      fetch: fetchImpl,
      requestInit: { headers: { ...server.headers }, redirect: "manual" },
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
      if (remoteTransport) await remoteTransport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

function resolveStdioServer(
  server: PluginMcpStdioServer,
  paths: PluginMcpRuntimePaths,
): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  const replacements = new Map([
    ["${PLUGIN_ROOT}", paths.pluginRoot],
    ["${PLUGIN_DATA}", paths.pluginData],
    ["${CLAUDE_PLUGIN_ROOT}", paths.pluginRoot],
    ["${CLAUDE_PLUGIN_DATA}", paths.pluginData],
  ]);
  const expand = (value: string): string => {
    let expanded = value;
    for (const [placeholder, replacement] of replacements) expanded = expanded.replaceAll(placeholder, replacement);
    return expanded;
  };
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
    ...Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expand(value)])),
    PLUGIN_ROOT: paths.pluginRoot,
    PLUGIN_DATA: paths.pluginData,
    CLAUDE_PLUGIN_ROOT: paths.pluginRoot,
    CLAUDE_PLUGIN_DATA: paths.pluginData,
  };
  return { command, args: server.args.map(expand), env, cwd };
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
    return response;
  };
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Plugin tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
