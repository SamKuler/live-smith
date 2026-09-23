import { isIP } from "node:net";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import type { OpenPluginArchive } from "../archive.js";
import type { PluginSourceFormat } from "../contracts.js";
import { isMcpCredentialFieldName, MAX_MCP_CREDENTIAL_FIELDS, mcpCredentialFields } from "./credentials.js";

export const PORTABLE_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVERS = 32;
const MAX_ARGUMENTS = 128;
const MAX_MAP_ENTRIES = 64;
const MAX_STRING_LENGTH = 8 * 1024;
const serverIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const portableTopLevelKeys = new Set(["$schema", "mcpServers"]);
const portableStdioKeys = new Set(["type", "command", "args", "env", "cwd"]);
const portableRemoteKeys = new Set(["type", "url", "headers"]);

export interface PluginMcpConfigIssue {
  code: "invalid_server" | "unsupported_transport";
  serverId: string;
  message: string;
}

export interface PluginMcpStdioServer {
  id: string;
  type: "stdio";
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface PluginMcpRemoteServer {
  id: string;
  type: "streamable-http";
  url: string;
  headers: Readonly<Record<string, string>>;
}

export type PluginMcpServer = PluginMcpStdioServer | PluginMcpRemoteServer;

export interface ParsedPluginMcpConfig {
  servers: readonly PluginMcpServer[];
  issues: readonly PluginMcpConfigIssue[];
}

export interface PluginMcpConfigOptions {
  sourceFormat: PluginSourceFormat;
  inline?: boolean;
}

export class PluginMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginMcpConfigError";
  }
}

export function pluginMcpConfigFromArchive(
  archive: OpenPluginArchive,
): ParsedPluginMcpConfig | undefined {
  const { mcpConfigPath, mcpManifestPath } = archive.manifest.components;
  const configPath = mcpConfigPath ?? mcpManifestPath;
  if (!configPath) return undefined;
  const bytes = archive.files.get(configPath);
  if (!bytes) throw invalidConfig("Plugin MCP configuration file is missing.");
  return parsePluginMcpConfig(bytes, {
    sourceFormat: archive.manifest.sourceFormat,
    ...(mcpManifestPath === undefined ? {} : { inline: true }),
  });
}

export function parsePluginMcpConfig(
  bytes: Uint8Array,
  options: PluginMcpConfigOptions,
): ParsedPluginMcpConfig {
  const document = decodeDocument(bytes);
  const portable = options.sourceFormat === "agent-plugins-1.0";
  if (portable) validatePortableDocument(document, options.inline === true);
  const rawServers = document.mcpServers;
  if (!plainRecord(rawServers)) throw invalidConfig("Plugin MCP configuration must contain an mcpServers object.");
  const entries = Object.entries(rawServers);
  if (entries.length > MAX_SERVERS) throw invalidConfig("Plugin MCP configuration contains too many servers.");

  const servers: PluginMcpServer[] = [];
  const issues: PluginMcpConfigIssue[] = [];
  for (const [serverId, value] of entries) {
    try {
      if (!serverIdPattern.test(serverId)) throw new Error("Server name is invalid.");
      const server = parseServer(serverId, value, portable);
      if (server === undefined) {
        issues.push({ code: "unsupported_transport", serverId, message: "Legacy SSE and WebSocket MCP transports are not supported." });
      } else {
        const fields = mcpCredentialFields(server);
        if (fields.length > MAX_MCP_CREDENTIAL_FIELDS ||
            fields.some((field) => !isMcpCredentialFieldName(field.name))) {
          throw new Error(`MCP server credentials require at most ${MAX_MCP_CREDENTIAL_FIELDS} names of up to 64 characters.`);
        }
        servers.push(server);
      }
    } catch (error) {
      issues.push({
        code: "invalid_server",
        serverId,
        message: error instanceof Error ? error.message : "Server configuration is invalid.",
      });
    }
  }
  return { servers, issues };
}

function decodeDocument(bytes: Uint8Array): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_CONFIG_BYTES) {
    throw invalidConfig("Plugin MCP configuration size is invalid.");
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!plainRecord(value)) throw new Error();
    return value;
  } catch {
    throw invalidConfig("Plugin MCP configuration is not valid UTF-8 JSON.");
  }
}

function validatePortableDocument(document: Record<string, unknown>, inline: boolean): void {
  if (inline) throw invalidConfig("Portable Agent Plugins cannot declare MCP servers inline.");
  if (document.$schema !== PORTABLE_MCP_SCHEMA) throw invalidConfig("Plugin MCP schema is unsupported.");
  if (Object.keys(document).some((key) => !portableTopLevelKeys.has(key))) {
    throw invalidConfig("Portable Plugin MCP configuration contains an unknown top-level field.");
  }
}

function parseServer(serverId: string, value: unknown, portable: boolean): PluginMcpServer | undefined {
  if (!plainRecord(value)) throw new Error("Server configuration must be an object.");
  const declaredType = value.type;
  const type = declaredType === undefined && !portable && typeof value.command === "string"
    ? "stdio"
    : declaredType === "http" && !portable ? "streamable-http" : declaredType;
  if (type === "sse" || type === "ws") return undefined;
  if (type === "stdio") return parseStdioServer(serverId, value, portable);
  if (type === "streamable-http") return parseRemoteServer(serverId, value, portable);
  throw new Error("Server transport is invalid.");
}

function parseStdioServer(
  id: string,
  value: Record<string, unknown>,
  portable: boolean,
): PluginMcpStdioServer {
  if (portable && Object.keys(value).some((key) => !portableStdioKeys.has(key))) {
    throw new Error("stdio server contains an unknown field.");
  }
  const command = boundedString(value.command, "stdio command");
  if (portable && !portableCommand(command)) throw new Error("stdio command is not a portable executable token.");
  const args = value.args === undefined ? [] : boundedStringArray(value.args, "stdio args", MAX_ARGUMENTS);
  const env = value.env === undefined ? {} : stringMap(value.env, "stdio env", true);
  const cwd = value.cwd === undefined ? undefined : boundedString(value.cwd, "stdio cwd");
  if (portable && cwd !== undefined && !portableWorkingDirectory(cwd)) {
    throw new Error("stdio cwd is not contained in PLUGIN_ROOT or PLUGIN_DATA.");
  }
  return { id, type: "stdio", command, args, env, ...(cwd === undefined ? {} : { cwd }) };
}

function parseRemoteServer(
  id: string,
  value: Record<string, unknown>,
  portable: boolean,
): PluginMcpRemoteServer {
  if (portable && Object.keys(value).some((key) => !portableRemoteKeys.has(key))) {
    throw new Error("Streamable HTTP server contains an unknown field.");
  }
  const url = boundedString(value.url, "MCP URL");
  validateRemoteUrl(url);
  const headers = value.headers === undefined ? {} : stringMap(value.headers, "MCP headers", false);
  validateHeaders(headers);
  return { id, type: "streamable-http", url, headers };
}

function portableCommand(value: string): boolean {
  if (value.startsWith("./")) return containedRelativePath(value.slice(2));
  return !value.includes("/") && !value.includes("\\") && !/\s/u.test(value);
}

function portableWorkingDirectory(value: string): boolean {
  if (value.startsWith("./")) return containedRelativePath(value.slice(2));
  for (const root of ["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]) {
    if (value === root) return true;
    if (value.startsWith(`${root}/`)) return containedRelativePath(value.slice(root.length + 1));
  }
  return false;
}

function containedRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  let depth = 0;
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (depth === 0) return false;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return true;
}

function validateRemoteUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MCP URL is invalid."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("MCP URL must be an absolute HTTP URL without credentials or a fragment.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Non-loopback MCP URLs must use HTTPS.");
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host.toLowerCase() === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  const first = Number(host.split(".", 1)[0]);
  return first === 127;
}

function validateHeaders(headers: Readonly<Record<string, string>>): void {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const folded = name.toLowerCase();
    if (!headerNamePattern.test(name) || names.has(folded) || /[\u0000\r\n]/u.test(value)) {
      throw new Error("MCP headers contain an invalid or duplicate field.");
    }
    names.add(folded);
  }
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > MAX_STRING_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedStringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid.`);
  return value.map((entry) => boundedOpaqueString(entry, label));
}

function stringMap(value: unknown, label: string, environment: boolean): Record<string, string> {
  if (!plainRecord(value) || Object.keys(value).length > MAX_MAP_ENTRIES) throw new Error(`${label} is invalid.`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 256 || key.includes("\0") || (environment && key.includes("=")) ||
        (environment && ["PLUGIN_ROOT", "PLUGIN_DATA"].includes(key.toUpperCase()))) {
      throw new Error(`${label} contains an invalid name.`);
    }
    Object.defineProperty(result, key, {
      value: boundedOpaqueString(entry, label), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function boundedOpaqueString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_STRING_LENGTH || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function invalidConfig(message: string): PluginMcpConfigError {
  return new PluginMcpConfigError(message);
}
