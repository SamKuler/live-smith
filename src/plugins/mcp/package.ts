import type { Tool } from "@modelcontextprotocol/client";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { cloneJsonValue } from "../../model/json-clone.js";
import { throwIfAborted } from "../../runtime/host.js";
import type { PreparedPluginRuntime } from "../../storage/plugins.js";
import type {
  PluginPackage,
  PluginToolContext,
  PluginToolDefinition,
  PluginToolIssue,
  PluginToolResult,
  PluginToolsResult,
} from "../contracts.js";
import {
  assertPluginResultHasNoPrivatePaths,
  modelSchemaForArtifactTool,
  pluginArtifactContract,
} from "../artifacts.js";
import {
  connectPluginMcpServer,
  type ConnectedPluginMcpServer,
  type ConnectPluginMcpServerOptions,
} from "./client.js";
import {
  pluginMcpConfigFromArchive,
  PluginMcpConfigError,
  type ParsedPluginMcpConfig,
  type PluginMcpServer,
} from "./config.js";
import { bindMcpServerCredentials } from "./credentials.js";

const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 4 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 4 * 1024 * 1024;

export type PluginMcpConnector = (
  server: PluginMcpServer,
  paths: { pluginRoot: string; pluginData: string },
  signal: AbortSignal,
  options?: ConnectPluginMcpServerOptions,
) => Promise<ConnectedPluginMcpServer>;

export interface McpPluginPackageOptions extends ConnectPluginMcpServerOptions {
  connector?: PluginMcpConnector;
  connection?: { id: string; name: string; serverId: string; secrets: Readonly<Record<string, string>> };
  serverIds?: readonly string[];
}

export class PluginToolRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginToolRuntimeError";
  }
}

export function createMcpPluginPackage(
  prepared: PreparedPluginRuntime,
  options: McpPluginPackageOptions = {},
): PluginPackage {
  return new McpPluginPackage(prepared, options);
}

class McpPluginPackage implements PluginPackage {
  readonly manifest;
  private readonly config: ParsedPluginMcpConfig | undefined;
  private readonly configError: PluginMcpConfigError | undefined;
  private readonly connector: PluginMcpConnector;
  private readonly connectionOptions: ConnectPluginMcpServerOptions;
  private readonly boundConnection: McpPluginPackageOptions["connection"];
  private readonly serverIds: ReadonlySet<string> | undefined;
  private readonly connections = new Map<string, Promise<ConnectedPluginMcpServer>>();
  private readonly toolCache = new Map<string, readonly Tool[]>();
  private closed = false;

  constructor(
    private readonly prepared: PreparedPluginRuntime,
    options: McpPluginPackageOptions,
  ) {
    this.manifest = cloneJsonValue(prepared.archive.manifest);
    this.connector = options.connector ?? connectPluginMcpServer;
    this.boundConnection = options.connection;
    this.serverIds = options.serverIds === undefined ? undefined : new Set(options.serverIds);
    this.connectionOptions = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
    try {
      this.config = pluginMcpConfigFromArchive(prepared.archive);
      this.configError = undefined;
    } catch (error) {
      if (!(error instanceof PluginMcpConfigError)) throw error;
      this.config = undefined;
      this.configError = error;
    }
  }

  async tools(context: PluginToolContext): Promise<PluginToolsResult> {
    const issues = this.configurationIssues();
    const definitions: PluginToolDefinition[] = [];
    for (const server of this.config?.servers ?? []) {
      if (this.serverIds && !this.serverIds.has(server.id) ||
          this.boundConnection && server.id !== this.boundConnection.serverId) continue;
      if (!this.prepared.plugin.approvedMcpServerIds.includes(server.id)) {
        issues.push(issue(this.manifest.id, server.id, "approval_required", "MCP server requires user approval."));
        continue;
      }
      let tools: readonly Tool[];
      try {
        tools = await this.serverTools(server, context.signal);
      } catch {
        throwIfAborted(context.signal);
        issues.push(issue(this.manifest.id, server.id, "connection_failed", "MCP server could not be reached."));
        continue;
      }
      if (tools.length > MAX_TOOLS_PER_SERVER) {
        issues.push(issue(this.manifest.id, server.id, "invalid_tool", "MCP server exposes too many tools."));
        tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
      }
      const names = new Set<string>();
      for (const tool of tools) {
        try {
          if (names.has(tool.name)) throw new Error("MCP server exposes a duplicate tool name.");
          names.add(tool.name);
          definitions.push(toolDefinition(this.manifest.id, server, tool, this.boundConnection));
        } catch {
          issues.push(issue(this.manifest.id, server.id, "invalid_tool", "MCP server exposes an invalid tool definition."));
        }
      }
    }
    return { tools: definitions, issues };
  }

  async callTool(
    serverId: string,
    name: string,
    argumentsValue: unknown,
    context: PluginToolContext,
  ): Promise<PluginToolResult> {
    const server = this.config?.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new PluginToolRuntimeError("Plugin MCP server is unavailable.");
    if (this.serverIds && !this.serverIds.has(serverId)) {
      throw new PluginToolRuntimeError("Plugin MCP server is not exposed by this package route.");
    }
    if (this.boundConnection && this.boundConnection.serverId !== serverId) {
      throw new PluginToolRuntimeError("Plugin MCP server is not bound to this connection.");
    }
    if (!this.prepared.plugin.approvedMcpServerIds.includes(serverId)) {
      throw new PluginToolRuntimeError("Plugin MCP server is not approved.");
    }
    let tools: readonly Tool[];
    let connection: ConnectedPluginMcpServer;
    try {
      connection = await this.connection(server, context.signal);
      tools = await this.serverTools(server, context.signal);
    } catch {
      throwIfAborted(context.signal);
      throw new PluginToolRuntimeError("Plugin MCP server could not be reached.");
    }
    if (!tools.some((tool) => tool.name === name)) throw new PluginToolRuntimeError("Plugin MCP tool is unavailable.");
    const result = await connection.callTool(name, argumentsValue, context.signal);
    return boundedToolResult(result, [this.prepared.pluginRoot, this.prepared.pluginData]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.connections.values()];
    this.connections.clear();
    this.toolCache.clear();
    await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
  }

  private configurationIssues(): PluginToolIssue[] {
    if (this.configError) {
      return [issue(this.manifest.id, undefined, "invalid_configuration", "Plugin MCP configuration is invalid.")];
    }
    return (this.config?.issues ?? []).map((entry) => issue(
      this.manifest.id,
      entry.serverId,
      entry.code === "unsupported_transport" ? "unsupported_transport" : "invalid_configuration",
      entry.message,
    ));
  }

  private async serverTools(server: PluginMcpServer, signal: AbortSignal): Promise<readonly Tool[]> {
    const cached = this.toolCache.get(server.id);
    if (cached) return cached;
    const tools = cloneJsonValue(await (await this.connection(server, signal)).listTools(signal));
    this.toolCache.set(server.id, tools);
    return tools;
  }

  private connection(server: PluginMcpServer, signal: AbortSignal): Promise<ConnectedPluginMcpServer> {
    if (this.closed) throw new PluginToolRuntimeError("Plugin MCP connection has been closed.");
    const existing = this.connections.get(server.id);
    if (existing) return existing;
    const bound = bindMcpServerCredentials(server, this.boundConnection?.secrets ?? {});
    const pending = this.connector(bound, {
      pluginRoot: this.prepared.pluginRoot,
      pluginData: this.prepared.pluginData,
    }, signal, this.connectionOptions);
    this.connections.set(server.id, pending);
    void pending.catch(() => {
      if (this.connections.get(server.id) === pending) this.connections.delete(server.id);
    });
    return pending;
  }
}

function toolDefinition(
  pluginId: string,
  server: PluginMcpServer,
  tool: Tool,
  connection?: McpPluginPackageOptions["connection"],
): PluginToolDefinition {
  if (typeof tool.name !== "string" || !tool.name || tool.name.length > MAX_TOOL_NAME_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(tool.name)) throw new Error("Invalid tool name.");
  const description = tool.description ?? tool.title ?? `Tool ${tool.name}`;
  if (typeof description !== "string" || !description || description.length > MAX_TOOL_DESCRIPTION_LENGTH ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(description)) throw new Error("Invalid tool description.");
  const artifactContract = pluginArtifactContract(tool);
  if (artifactContract && server.type !== "stdio") {
    throw new Error("Plugin artifact tools require a local MCP server.");
  }
  const parameters = modelSchemaForArtifactTool(tool.inputSchema, artifactContract);
  if (!plainRecord(parameters) || jsonBytes(parameters) > MAX_TOOL_SCHEMA_BYTES) throw new Error("Invalid tool schema.");
  return {
    pluginId,
    serverId: server.id,
    ...(connection ? { connectionId: connection.id } : {}),
    name: tool.name,
    ...(artifactContract ? { artifactContract } : {}),
    tool: {
      type: "function",
      function: {
        name: pluginToolCallName(pluginId, server.id, tool.name, connection?.id),
        description: `${connection ? `Named connection: ${connection.name}. ` : ""}${artifactContract
          ? `${description} Live Smith stages declared Session audio inputs and saves one validated MIDI output; arguments never contain user filesystem paths. Do not retry an unknown outcome automatically; use list_session_artifacts to check saved results first.`
          : description}`,
        parameters,
      },
    },
  };
}

export function pluginToolCallName(pluginId: string, serverId: string, toolName: string, connectionId?: string): string {
  const identity = `${pluginId}\0${serverId}\0${toolName}${connectionId === undefined ? "" : `\0${connectionId}`}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `plg_${slug(pluginId, 8)}_${slug(serverId, 8)}_${slug(toolName, 20)}_${digest}`;
}

function slug(value: string, maximum: number): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, maximum);
  return normalized || "tool";
}

function boundedToolResult(value: unknown, forbiddenPaths: readonly string[]): PluginToolResult {
  const cloned = cloneJsonValue(value) as PluginToolResult;
  if (!plainRecord(cloned) || !Array.isArray(cloned.content) || jsonBytes(cloned) > MAX_TOOL_RESULT_BYTES) {
    throw new PluginToolRuntimeError("Plugin MCP tool returned an invalid or oversized result.");
  }
  assertPluginResultHasNoPrivatePaths(cloned, forbiddenPaths);
  return cloned;
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Plugin MCP value is not JSON serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function issue(
  pluginId: string,
  serverId: string | undefined,
  code: PluginToolIssue["code"],
  message: string,
): PluginToolIssue {
  return { pluginId, ...(serverId === undefined ? {} : { serverId }), code, message };
}
