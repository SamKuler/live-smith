import { createHash } from "node:crypto";
import * as path from "node:path";
import { URL } from "node:url";

import { pluginSkillsFromArchive } from "../skills/plugin-package.js";
import type { InstalledPluginPackage } from "../storage/plugins.js";
import { openPluginArchive, type OpenPluginArchive } from "./archive.js";
import type { PluginManifest, PluginSourceFormat } from "./contracts.js";
import { pluginMcpConfigFromArchive, PluginMcpConfigError } from "./mcp/config.js";

export type PluginViewIssue =
  | "invalid_skill"
  | "invalid_mcp_configuration"
  | "invalid_mcp_server"
  | "unsupported_mcp_transport";

export interface PluginMcpServerView {
  id: string;
  type: "stdio" | "streamable-http";
  approved: boolean;
  artifactInputApproved: boolean;
  artifactOutputApproved: boolean;
  target: string;
}

export interface InstalledPluginView {
  id: string;
  version?: string;
  description?: string;
  sourceFormat: PluginSourceFormat;
  enabled: boolean;
  skillCount: number;
  mcpServers: PluginMcpServerView[];
  unsupportedComponents: string[];
  issues: PluginViewIssue[];
}

export interface PluginInstallPreview extends InstalledPluginView {
  sha256: string;
  byteLength: number;
}

export async function installedPluginViews(
  packages: readonly InstalledPluginPackage[],
): Promise<InstalledPluginView[]> {
  const views = await Promise.all(packages.map(installedPluginView));
  return views.sort((left, right) => left.id.localeCompare(right.id));
}

async function installedPluginView(entry: InstalledPluginPackage): Promise<InstalledPluginView> {
  const archive = await openPluginArchive(entry.bytes);
  return pluginView(
    archive,
    entry.bytes,
    entry.plugin,
    entry.plugin.enabled,
    entry.plugin.approvedMcpServerIds,
    entry.plugin.approvedArtifactInputServerIds,
    entry.plugin.approvedArtifactOutputServerIds,
  );
}

export async function previewPluginArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PluginInstallPreview> {
  const owned = Uint8Array.from(bytes);
  const archive = await openPluginArchive(owned, signal);
  const view = await pluginView(archive, owned, archive.manifest, false, [], [], []);
  return {
    ...view,
    sha256: createHash("sha256").update(owned).digest("hex"),
    byteLength: owned.byteLength,
  };
}

async function pluginView(
  archive: OpenPluginArchive,
  bytes: Uint8Array,
  manifest: PluginManifest,
  enabled: boolean,
  approvedMcpServerIds: readonly string[],
  approvedArtifactInputServerIds: readonly string[],
  approvedArtifactOutputServerIds: readonly string[],
): Promise<InstalledPluginView> {
  const skills = await pluginSkillsFromArchive(manifest.id, bytes);
  const skillDirectory = archive.manifest.components.skillsDirectory;
  const skillCandidates = skillDirectory === undefined ? 0 : [...archive.files.keys()].filter((file) => {
    const relative = file.startsWith(`${skillDirectory}/`) ? file.slice(skillDirectory.length + 1) : "";
    const segments = relative.split("/");
    return segments.length === 2 && segments[1] === "SKILL.md";
  }).length;
  const issues: PluginViewIssue[] = skillCandidates === skills.length ? [] : ["invalid_skill"];
  let mcpServers: PluginMcpServerView[] = [];
  try {
    const config = pluginMcpConfigFromArchive(archive);
    if (config) {
      mcpServers = config.servers.map((server) => ({
        id: server.id,
        type: server.type,
        approved: approvedMcpServerIds.includes(server.id),
        artifactInputApproved: approvedArtifactInputServerIds.includes(server.id),
        artifactOutputApproved: approvedArtifactOutputServerIds.includes(server.id),
        target: server.type === "stdio" ? commandLabel(server.command) : new URL(server.url).origin,
      }));
      if (config.issues.some((issue) => issue.code === "invalid_server")) issues.push("invalid_mcp_server");
      if (config.issues.some((issue) => issue.code === "unsupported_transport")) issues.push("unsupported_mcp_transport");
    }
  } catch (error) {
    if (!(error instanceof PluginMcpConfigError)) throw error;
    issues.push("invalid_mcp_configuration");
  }
  return {
    id: manifest.id,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    sourceFormat: manifest.sourceFormat,
    enabled,
    skillCount: skills.length,
    mcpServers,
    unsupportedComponents: [...(manifest.unsupportedComponents ?? [])],
    issues: [...new Set(issues)],
  };
}

function commandLabel(command: string): string {
  if (command.startsWith("./") || !command.includes("/") && !command.includes("\\")) return command;
  return path.basename(command) || "local process";
}
