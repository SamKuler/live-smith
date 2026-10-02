import { createHash } from "node:crypto";
import { URL } from "node:url";
import { loadAgentSettings } from "../../storage/settings.js";
import { readInstalledPluginPackageInTransaction, pluginRuntimePaths } from "../../storage/plugins.js";
import { requireActiveStorageTransaction, type StorageTransactionContext } from "../../storage/persistence.js";
import { openPluginArchive } from "../../plugins/archive.js";
import { isStandaloneMcpConnection, mcpOAuthConnectionIdentity } from "../../plugins/integration-connections.js";
import { pluginMcpConfigFromArchive, validateRemoteUrl } from "../../plugins/mcp/config.js";
import { expandPluginMcpTemplate } from "../../plugins/mcp/templates.js";
import { emptyPluginConfig } from "../../plugins/user-config.js";
import { hasAuthorizationHeader, McpOAuthError, type McpOAuthConfiguration } from "../../plugins/mcp/oauth-contract.js";

export interface McpOAuthOwner {
  connectionId: string;
  fingerprint: string;
  serverUrl: string;
  /** Private resource headers; never forwarded to authorization-server endpoints or browser state. */
  headers: Record<string, string>;
  oauth: McpOAuthConfiguration;
  pluginId?: string;
  serverId?: string;
}

/** Canonical credential ownership, shared by interactive login, runtime reads, and public status. */
export async function resolveMcpOAuthOwnerInTransaction(
  transaction: StorageTransactionContext, directory: string, connectionId: string,
): Promise<McpOAuthOwner> {
  requireActiveStorageTransaction(transaction, directory);
  const connection = (await loadAgentSettings(directory)).integrationConnections?.connections.find((entry) => entry.id === connectionId);
  if (!connection?.oauth || !connection.enabled) throw new McpOAuthError("Save and enable this remote MCP OAuth connection before signing in.");
  let url: string;
  let resolvedHeaders: Record<string, string>;
  let pluginId: string | undefined;
  let serverId: string | undefined;
  if (isStandaloneMcpConnection(connection)) {
    if (connection.mcp.type !== "streamable-http" || hasAuthorizationHeader(connection.secrets)) throw new McpOAuthError("MCP OAuth cannot be combined with a manual Authorization header or a local process.");
    url = connection.mcp.url;
    resolvedHeaders = connection.secrets;
  } else {
    const installed = await readInstalledPluginPackageInTransaction(transaction, directory, connection.pluginId);
    if (!installed || !installed.plugin.enabled || installed.plugin.sha256 !== connection.configuration.pluginDigest ||
      !installed.plugin.approvedMcpServerIds.includes(connection.configuration.serverId!)) {
      throw new McpOAuthError("Enable this Plugin and approve its current MCP server before signing in.");
    }
    const archive = await openPluginArchive(installed.bytes);
    const server = pluginMcpConfigFromArchive(archive)?.servers.find((entry) => entry.id === connection.configuration.serverId);
    if (server?.type !== "streamable-http" || hasAuthorizationHeader(server.headers)) throw new McpOAuthError("MCP OAuth requires a remote server without a declared Authorization header.");
    const userConfig = installed.userConfig ?? emptyPluginConfig();
    const paths = { ...await pluginRuntimePaths(directory, installed.plugin), secrets: connection.secrets,
      userConfig: { fields: archive.manifest.userConfig ?? [], stored: userConfig } };
    url = expandPluginMcpTemplate(server.url, paths);
    resolvedHeaders = Object.fromEntries(Object.entries(server.headers).map(([name, value]) =>
      [name.toLowerCase(), expandPluginMcpTemplate(value, paths, "credentials")]));
    pluginId = connection.pluginId;
    serverId = server.id;
  }
  validateRemoteUrl(url);
  const serverUrl = new URL(url).href;
  if (Object.values(resolvedHeaders).some((value) => /[\u0000\r\n]/u.test(value))) throw new McpOAuthError("MCP resource headers contain invalid characters.");
  return { connectionId, serverUrl, headers: resolvedHeaders, oauth: { ...connection.oauth },
    fingerprint: createHash("sha256").update(JSON.stringify([connectionId, mcpOAuthConnectionIdentity(connection), serverUrl, Object.entries(resolvedHeaders).sort(([a], [b]) => a.localeCompare(b))])).digest("hex"),
    ...(pluginId === undefined ? {} : { pluginId }), ...(serverId === undefined ? {} : { serverId }) };
}
