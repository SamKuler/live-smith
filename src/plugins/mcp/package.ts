import { McpAuthorizationRequiredError } from "./oauth-contract.js";
import type { Tool } from "@modelcontextprotocol/client";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { cloneJsonValue } from "../../model/json-clone.js";
import { throwIfAborted } from "../../runtime/host.js";
import type { PreparedPluginRuntime } from "../../storage/plugins.js";
import type {
  McpToolSource,
  PluginPackage,
  PluginToolContext,
  PluginToolDefinition,
  PluginToolIssue,
  PluginToolResult,
  PluginToolsResult,
} from "../contracts.js";
import type { StandaloneMcpConnection } from "../integration-connections.js";
import {
  assertPluginResultHasNoPrivatePaths,
  modelSchemaForArtifactTool,
  pluginArtifactContract,
} from "../artifacts.js";
import {
  connectPluginMcpServer,
  type ConnectedPluginMcpServer,
  type ConnectPluginMcpServerOptions,
  type PluginMcpRuntimePaths,
} from "./client.js";
import {
  pluginMcpConfigFromArchive,
  PluginMcpConfigError,
  type ParsedPluginMcpConfig,
  type PluginMcpServer,
} from "./config.js";
import { emptyPluginConfig } from "../user-config.js";
import { pluginAppMetadata } from "./apps.js";

const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 4 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 4 * 1024 * 1024;

export type PluginMcpConnector = (
  server: PluginMcpServer,
  paths: PluginMcpRuntimePaths | undefined,
  signal: AbortSignal,
  options?: ConnectPluginMcpServerOptions,
) => Promise<ConnectedPluginMcpServer>;

export interface McpSourceOptions extends ConnectPluginMcpServerOptions {
  connector?: PluginMcpConnector;
}

export interface McpPluginPackageOptions extends McpSourceOptions {
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
  return Object.assign(new McpToolRuntime(prepared, options), {
    manifest: cloneJsonValue(prepared.archive.manifest),
  });
}

export function createStandaloneMcpConnection(
  connection: StandaloneMcpConnection,
  options: McpSourceOptions = {},
): McpToolSource {
  return new McpToolRuntime(connection, options);
}

class McpToolRuntime implements McpToolSource {
  private readonly prepared: PreparedPluginRuntime | undefined;
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
    source: PreparedPluginRuntime | StandaloneMcpConnection,
    options: McpPluginPackageOptions,
  ) {
    this.connector = options.connector ?? connectPluginMcpServer;
    this.serverIds = options.serverIds === undefined ? undefined : new Set(options.serverIds);
    this.connectionOptions = { ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.authProvider === undefined ? {} : { authProvider: options.authProvider }) };
    if ("mcp" in source) {
      this.boundConnection = { id: source.id, name: source.name, serverId: "server", secrets: {} };
      this.config = { issues: [], servers: [source.mcp.type === "stdio"
        ? { id: "server", ...cloneJsonValue(source.mcp), env: { ...source.secrets } }
        : { id: "server", ...cloneJsonValue(source.mcp), headers: { ...source.secrets } }],
      };
      return;
    }
    this.prepared = source;
    this.boundConnection = options.connection;
    try {
      this.config = pluginMcpConfigFromArchive(source.archive);
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
      if (this.prepared && !this.prepared.plugin.approvedMcpServerIds.includes(server.id)) {
        issues.push(this.issue(server.id, "approval_required", "MCP server requires user approval."));
        continue;
      }
      let tools: readonly Tool[];
      try {
        tools = await this.serverTools(server, context.signal);
      } catch (error) {
        throwIfAborted(context.signal);
        issues.push(this.issue(server.id, error instanceof McpAuthorizationRequiredError ? "authorization_required" : "connection_failed",
          error instanceof McpAuthorizationRequiredError ? error.message : "MCP server could not be reached."));
        continue;
      }
      if (tools.length > MAX_TOOLS_PER_SERVER) {
        issues.push(this.issue(server.id, "invalid_tool", "MCP server exposes too many tools."));
        tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
      }
      const names = new Set<string>();
      for (const tool of tools) {
        try {
          if (names.has(tool.name)) throw new Error("MCP server exposes a duplicate tool name.");
          names.add(tool.name);
          definitions.push(toolDefinition(this.prepared?.plugin.id, server, tool, this.boundConnection));
        } catch {
          issues.push(this.issue(server.id, "invalid_tool", "MCP server exposes an invalid tool definition."));
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
    if (this.prepared && !this.prepared.plugin.approvedMcpServerIds.includes(serverId)) {
      throw new PluginToolRuntimeError("Plugin MCP server is not approved.");
    }
    let tools: readonly Tool[];
    let connection: ConnectedPluginMcpServer;
    try {
      connection = await this.connection(server, context.signal);
      tools = await this.serverTools(server, context.signal);
    } catch (error) {
      throwIfAborted(context.signal);
      if (error instanceof McpAuthorizationRequiredError) throw error;
      throw new PluginToolRuntimeError("Plugin MCP server could not be reached.");
    }
    if (!tools.some((tool) => tool.name === name)) throw new PluginToolRuntimeError("Plugin MCP tool is unavailable.");
    const result = await connection.callTool(name, argumentsValue, context.signal);
    return boundedToolResult(result, this.prepared ? [this.prepared.pluginRoot, this.prepared.pluginData] : []);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.connections.values()];
    this.connections.clear();
    this.toolCache.clear();
    await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
  }

  async readResource(serverId: string, uri: string, context: PluginToolContext): Promise<unknown> {
    const connection = await this.resourceConnection(serverId, context.signal);
    if (!connection.readResource) throw new PluginToolRuntimeError("Plugin MCP resources are unavailable.");
    const result = await connection.readResource(uri, context.signal);
    if (jsonBytes(result) > MAX_TOOL_RESULT_BYTES) throw new PluginToolRuntimeError("Plugin MCP resource is too large.");
    return cloneJsonValue(result);
  }

  async listResources(serverId: string, templates: boolean, cursor: string | undefined, context: PluginToolContext): Promise<unknown> {
    const connection = await this.resourceConnection(serverId, context.signal);
    if (!connection.listResources) throw new PluginToolRuntimeError("Plugin MCP resources are unavailable.");
    const result = await connection.listResources(templates, cursor, context.signal);
    if (jsonBytes(result) > MAX_TOOL_RESULT_BYTES) throw new PluginToolRuntimeError("Plugin MCP resource list is too large.");
    return cloneJsonValue(result);
  }

  private resourceConnection(serverId: string, signal: AbortSignal): Promise<ConnectedPluginMcpServer> {
    const server = this.config?.servers.find((candidate) => candidate.id === serverId);
    if (this.closed || !server || this.serverIds && !this.serverIds.has(serverId) ||
        this.boundConnection && this.boundConnection.serverId !== serverId ||
        this.prepared && !this.prepared.plugin.approvedMcpServerIds.includes(serverId)) {
      throw new PluginToolRuntimeError("Plugin MCP resource route is unavailable.");
    }
    return this.connection(server, signal);
  }

  private configurationIssues(): PluginToolIssue[] {
    if (this.configError) {
      return [this.issue(undefined, "invalid_configuration", "Plugin MCP configuration is invalid.")];
    }
    return (this.config?.issues ?? []).map((entry) => this.issue(
      entry.serverId,
      entry.code === "unsupported_transport" ? "unsupported_transport" : "invalid_configuration",
      entry.message,
    ));
  }

  private async serverTools(server: PluginMcpServer, signal: AbortSignal): Promise<readonly Tool[]> {
    if (this.closed) throw new PluginToolRuntimeError("MCP connection has been closed.");
    const cached = this.toolCache.get(server.id);
    if (cached) return cached;
    const tools = cloneJsonValue(await (await this.connection(server, signal)).listTools(signal));
    if (this.closed) throw new PluginToolRuntimeError("MCP connection has been closed.");
    this.toolCache.set(server.id, tools);
    return tools;
  }

  private connection(server: PluginMcpServer, signal: AbortSignal): Promise<ConnectedPluginMcpServer> {
    if (this.closed) throw new PluginToolRuntimeError("Plugin MCP connection has been closed.");
    const existing = this.connections.get(server.id);
    if (existing) return existing;
    const pending = this.connector(server, this.prepared ? {
      pluginRoot: this.prepared.pluginRoot,
      pluginData: this.prepared.pluginData,
      secrets: this.boundConnection?.secrets ?? {},
      userConfig: { fields: this.prepared.archive.manifest.userConfig ?? [], stored: this.prepared.userConfig ?? emptyPluginConfig() },
    } : undefined, signal, this.connectionOptions);
    this.connections.set(server.id, pending);
    void pending.catch(() => {
      if (this.connections.get(server.id) === pending) this.connections.delete(server.id);
    });
    return pending;
  }

  private issue(serverId: string | undefined, code: PluginToolIssue["code"], message: string): PluginToolIssue {
    return {
      ...(this.prepared ? { pluginId: this.prepared.plugin.id } : {}),
      ...(this.boundConnection ? { connectionId: this.boundConnection.id } : {}),
      ...(serverId === undefined ? {} : { serverId }),
      code, message,
    };
  }
}

function toolDefinition(
  pluginId: string | undefined,
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
  const app = pluginAppMetadata(tool._meta);
  if (artifactContract && server.type !== "stdio") {
    throw new Error("Plugin artifact tools require a local MCP server.");
  }
  const parameters = modelSchemaForArtifactTool(tool.inputSchema, artifactContract);
  if (!plainRecord(parameters) || jsonBytes(parameters) > MAX_TOOL_SCHEMA_BYTES) throw new Error("Invalid tool schema.");
  return {
    ...(pluginId === undefined ? {} : { pluginId }),
    serverId: server.id,
    ...(connection ? { connectionId: connection.id } : {}),
    name: tool.name,
    description,
    ...(artifactContract ? { artifactContract } : {}),
    ...(app ? { app } : {}),
    tool: {
      type: "function",
      function: {
        name: pluginId === undefined
          ? standaloneMcpToolCallName(connection!.id, tool.name)
          : pluginToolCallName(pluginId, server.id, tool.name, connection?.id),
        description: `${connection ? `Named connection: ${connection.name}. ` : ""}${artifactContract
          ? `${description} Live Smith stages declared Session artifact inputs and saves one validated ${artifactContract.outputs[0]!.kind === "midi" ? "MIDI" : "audio"} output; arguments never contain user filesystem paths. Do not retry an unknown outcome automatically; use list_session_artifacts to check saved results first.`
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

export function standaloneMcpToolCallName(connectionId: string, toolName: string): string {
  const digest = createHash("sha256").update(`${connectionId}\0${toolName}`).digest("hex").slice(0, 16);
  return `mcp_${slug(connectionId, 16)}_${slug(toolName, 20)}_${digest}`;
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
