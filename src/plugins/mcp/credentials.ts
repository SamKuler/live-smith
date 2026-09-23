import type { PluginMcpServer } from "./config.js";

export const MAX_MCP_CREDENTIAL_FIELDS = 8;
const placeholder = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;
const pathVariables = new Set(["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"]);

export function isMcpCredentialFieldName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(value);
}

export interface McpCredentialField {
  name: string;
  required: boolean;
}

function templates(server: PluginMcpServer): readonly string[] {
  return Object.values(server.type === "stdio" ? server.env : server.headers);
}

export function mcpCredentialFields(server: PluginMcpServer): McpCredentialField[] {
  const fields = new Map<string, boolean>();
  for (const value of templates(server)) {
    for (const match of value.matchAll(placeholder)) {
      const name = match[1]!;
      if (server.type === "stdio" && pathVariables.has(name)) continue;
      fields.set(name, fields.get(name) === true || match[2] === undefined);
    }
  }
  return [...fields].map(([name, required]) => ({ name, required }));
}

export function bindMcpServerCredentials(
  server: PluginMcpServer,
  secrets: Readonly<Record<string, string>>,
): PluginMcpServer {
  const bind = (value: string): string => value.replace(placeholder, (whole, name: string, fallback: string | undefined) => {
    if (server.type === "stdio" && pathVariables.has(name)) return whole;
    const secret = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
    if (secret) return secret;
    if (fallback !== undefined) return fallback;
    throw new Error(`MCP credential ${name} is not configured.`);
  });
  if (server.type === "stdio") {
    return { ...server, env: Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, bind(value)])) };
  }
  const headers = Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, bind(value)]));
  if (Object.values(headers).some((value) => /[\u0000\r\n]/u.test(value))) {
    throw new Error("MCP credential produces an invalid HTTP header.");
  }
  return { ...server, headers };
}
