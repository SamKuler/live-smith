import { types } from "node:util";

import { AttachmentProcessingError } from "../attachments/contracts.js";
import { openBoundedOoxmlZip } from "../attachments/ooxml-zip.js";
import { parsePluginPackageManifest, type PluginPackageFile } from "./manifest.js";
import type { PluginManifest } from "./contracts.js";

export type PluginArchiveErrorCode = "invalid_archive" | "archive_limit";

export class PluginArchiveError extends Error {
  constructor(public readonly code: PluginArchiveErrorCode, message: string) {
    super(message);
    this.name = "PluginArchiveError";
  }
}

export interface OpenPluginArchive {
  manifest: PluginManifest;
  files: ReadonlyMap<string, Uint8Array>;
}

export async function openPluginArchive(bytes: Uint8Array, signal?: AbortSignal): Promise<OpenPluginArchive> {
  if (!types.isUint8Array(bytes)) throw invalid("Plugin archive bytes are invalid.");
  try {
    const archive = await openBoundedOoxmlZip(bytes, () => true, signal);
    const retained = new Map([...archive.retainedEntries].filter(([name]) => !archive.directoryNames.has(name)));
    const root = packageRoot([...retained.keys()]);
    const files = new Map<string, Uint8Array>();
    for (const [path, value] of retained) {
      const relative = root ? path.slice(root.length + 1) : path;
      if (!relative || files.has(relative)) throw invalid("Plugin archive contains duplicate package paths.");
      files.set(relative, new Uint8Array(value));
    }
    const ordered = new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
    const manifest = parsePluginPackageManifest([...ordered].map(([path, value]): PluginPackageFile => ({
      path, bytes: new Uint8Array(value),
    })));
    return { manifest, files: ordered };
  } catch (error) {
    if (error instanceof PluginArchiveError) throw error;
    if (error instanceof AttachmentProcessingError) {
      throw new PluginArchiveError(error.code === "archive_limit" ? "archive_limit" : "invalid_archive",
        error.code === "archive_limit" ? "Plugin archive exceeds a safe extraction limit." : "Plugin archive structure is invalid.");
    }
    if (error instanceof Error && error.message.startsWith("Plugin ")) throw invalid(error.message);
    throw invalid("Plugin archive could not be opened.");
  }
}

function packageRoot(paths: readonly string[]): string | undefined {
  if (!paths.length) throw invalid("Plugin archive is empty.");
  if (paths.some(isManifestPath)) return undefined;
  const roots = new Set(paths.map((path) => path.split("/", 1)[0]!));
  if (roots.size !== 1) throw invalid("Plugin archive must contain a single package root.");
  const root = [...roots][0]!;
  if (!paths.some((path) => isManifestPath(path.slice(root.length + 1)))) {
    throw invalid("Plugin archive manifest is missing.");
  }
  return root;
}

function isManifestPath(path: string): boolean {
  return path === "plugin.json" || path === ".codex-plugin/plugin.json" || path === ".claude-plugin/plugin.json";
}

function invalid(message: string): PluginArchiveError {
  return new PluginArchiveError("invalid_archive", message);
}
