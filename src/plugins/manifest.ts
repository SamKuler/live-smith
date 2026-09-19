import { TextDecoder } from "node:util";

import type { PluginComponents, PluginManifest, PluginSourceFormat } from "./contracts.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const portableManifestSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const portableKeys = new Set([
  "$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions",
]);
const authorKeys = new Set(["name", "email", "url"]);
const idPattern = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;

export interface PluginPackageFile {
  path: string;
  bytes: Uint8Array;
}

export function parsePluginPackageManifest(input: readonly PluginPackageFile[]): PluginManifest {
  const files = normalizedFiles(input);
  const portable = decodeOptional(files, "plugin.json");
  const codex = decodeOptional(files, ".codex-plugin/plugin.json");
  const claude = decodeOptional(files, ".claude-plugin/plugin.json");
  if (!portable && codex && claude) throw new Error("Plugin package has ambiguous compatibility manifests.");
  const selected = portable ?? codex ?? claude;
  if (!selected) throw new Error("Plugin package manifest is missing.");
  const sourceFormat: PluginSourceFormat = portable ? "agent-plugins-1.0" : codex ? "codex" : "claude";
  const selectedPath = portable ? "plugin.json" : codex ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
  const identity = portable ? readPortableIdentity(selected) : readIdentity(selected);
  for (const overlay of [codex, claude]) {
    if (!portable || !overlay) continue;
    const candidate = readIdentity(overlay);
    if (candidate.id !== identity.id ||
        (candidate.version !== undefined && identity.version !== undefined && candidate.version !== identity.version)) {
      throw new Error("Plugin compatibility manifest identity does not match the portable manifest.");
    }
  }
  const components: PluginComponents = portable
    ? {
        ...(hasDirectory(files, "skills") ? { skillsDirectory: "skills" } : {}),
        ...(files.has("mcp.json") ? { mcpConfigPath: "mcp.json" } : {}),
      }
    : compatibilityComponents(selected, files, selectedPath);
  return { ...identity, sourceFormat, components };
}

function normalizedFiles(input: readonly PluginPackageFile[]): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  for (const entry of input) {
    const path = packagePath(entry.path, true);
    if (result.has(path)) throw new Error("Plugin package contains a duplicate normalized path.");
    result.set(path, entry.bytes);
  }
  return result;
}

function decodeOptional(files: ReadonlyMap<string, Uint8Array>, path: string): Record<string, unknown> | undefined {
  const bytes = files.get(path);
  if (!bytes) return undefined;
  if (!bytes.byteLength || bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Plugin manifest size is invalid.");
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Plugin manifest is not valid UTF-8 JSON.");
  }
}

function readPortableIdentity(value: Record<string, unknown>): Pick<PluginManifest, "id" | "version" | "description"> {
  if (value.$schema !== portableManifestSchema) throw new Error("Plugin manifest schema is unsupported.");
  for (const key of Object.keys(value)) {
    if (portableKeys.has(key)) validatePortableMetadata(key, value[key]);
  }
  return readIdentity(value);
}

function readIdentity(value: Record<string, unknown>): Pick<PluginManifest, "id" | "version" | "description"> {
  const name = value.name;
  const version = value.version;
  const description = value.description;
  if (typeof name !== "string" || name.length > 64 || !idPattern.test(name)) {
    throw new Error("Plugin manifest name is invalid.");
  }
  if (version !== undefined && (typeof version !== "string" || !safeMetadataString(version, 128))) {
    throw new Error("Plugin manifest version is invalid.");
  }
  if (description !== undefined && (typeof description !== "string" || !safeMetadataString(description, 1024))) {
    throw new Error("Plugin manifest description is invalid.");
  }
  return {
    id: name,
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
  };
}

function validatePortableMetadata(key: string, value: unknown): void {
  if (key === "$schema" || key === "name" || key === "version" || key === "description") return;
  if (["homepage", "repository", "license"].includes(key)) {
    if (typeof value !== "string" || !safeMetadataString(value, 2_048)) throw new Error(`Plugin manifest ${key} is invalid.`);
    return;
  }
  if (key === "keywords") {
    if (!Array.isArray(value) || value.length > 64 ||
        value.some((entry) => typeof entry !== "string" || !safeMetadataString(entry, 128))) {
      throw new Error("Plugin manifest keywords are invalid.");
    }
    return;
  }
  if (key === "author") {
    if (!plainRecord(value) || Object.keys(value).some((field) => !authorKeys.has(field)) ||
        Object.values(value).some((entry) => typeof entry !== "string" || !safeMetadataString(entry, 2_048))) {
      throw new Error("Plugin manifest author is invalid.");
    }
    return;
  }
  // Agent Plugins explicitly treats a non-object extensions field as ignorable.
}

function safeMetadataString(value: string, maximumLength: number): boolean {
  return value.length <= maximumLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function compatibilityComponents(
  value: Record<string, unknown>,
  files: ReadonlyMap<string, Uint8Array>,
  manifestPath: string,
): PluginComponents {
  return {
    ...(value.skills === undefined
      ? hasDirectory(files, "skills") ? { skillsDirectory: "skills" } : {}
      : { skillsDirectory: componentPath(value.skills, "skills") }),
    ...compatibilityMcpComponent(value.mcpServers, files, manifestPath),
  };
}

function compatibilityMcpComponent(
  declaration: unknown,
  files: ReadonlyMap<string, Uint8Array>,
  manifestPath: string,
): Pick<PluginComponents, "mcpConfigPath" | "mcpManifestPath"> {
  if (declaration === undefined) return files.has(".mcp.json") ? { mcpConfigPath: ".mcp.json" } : {};
  if (typeof declaration === "string") {
    const mcpConfigPath = componentPath(declaration, "MCP");
    if (!files.has(mcpConfigPath)) throw new Error("Plugin MCP configuration file is missing.");
    return { mcpConfigPath };
  }
  if (plainRecord(declaration)) return { mcpManifestPath: manifestPath };
  throw new Error("Plugin MCP declaration is invalid.");
}

function componentPath(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Plugin ${label} path is invalid.`);
  return packagePath(value.endsWith("/") ? value.slice(0, -1) : value, false);
}

function packagePath(value: string, file: boolean): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error("Plugin package path is invalid.");
  }
  const trimmed = value.startsWith("./") ? value.slice(2) : value;
  const segments = trimmed.split("/");
  if (!trimmed || segments.some((segment) => !segment || segment === "." || segment === "..") || (file && trimmed.endsWith("/"))) {
    throw new Error("Plugin package path is invalid.");
  }
  return trimmed;
}

function hasDirectory(files: ReadonlyMap<string, Uint8Array>, directory: string): boolean {
  const prefix = `${directory}/`;
  return [...files.keys()].some((path) => path.startsWith(prefix));
}
