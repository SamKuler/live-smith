import { emptyPluginConfig, resolvePluginConfigReference } from "../user-config.js";
import type { PluginMcpRuntimePaths } from "./client.js";

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

