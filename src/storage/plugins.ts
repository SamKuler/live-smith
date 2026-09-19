import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getuid, platform } from "node:process";

import { openPluginArchive } from "../plugins/archive.js";
import type { PluginComponents, PluginSourceFormat } from "../plugins/contracts.js";
import { isMissingFileError } from "./errors.js";
import {
  removeDirectoryDurably,
  removeFileDurably,
  requireActiveStorageTransaction,
  trackStorageTransactionOperation,
  withStorageTransaction,
  writeBytesAtomicallyCreateOnly,
  writeJsonAtomically,
  type StorageTransactionContext,
} from "./persistence.js";

export interface InstalledPlugin {
  id: string;
  version: string;
  description: string;
  sourceFormat: PluginSourceFormat;
  components: PluginComponents;
  sha256: string;
  byteLength: number;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface InstalledPluginPackage {
  plugin: InstalledPlugin;
  bytes: Uint8Array;
}

interface StoredPluginCatalog {
  schemaVersion: 1;
  revision: string;
  plugins: InstalledPlugin[];
}

const rootName = "live-smith-plugins";
const catalogName = "catalog.json";
const packagesName = "packages";
const maximumCatalogBytes = 256 * 1024;
const maximumPlugins = 32;
const maximumStoredBytes = 256 * 1024 * 1024;
const shaPattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^(?:0|[1-9]\d*)$/u;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const supportsPosixPermissions = platform !== "win32";
const catalogKeys = new Set(["schemaVersion", "revision", "plugins"]);
const pluginKeys = new Set([
  "id", "version", "description", "sourceFormat", "components", "sha256", "byteLength",
  "enabled", "installedAt", "updatedAt",
]);
const componentKeys = new Set(["skillsDirectory", "mcpConfigPath"]);

export class PluginStorageCorruptionError extends Error {
  constructor(cause?: unknown) {
    super("Installed Plugin storage is invalid. No catalog changes were written.",
      cause === undefined ? undefined : { cause });
    this.name = "PluginStorageCorruptionError";
  }
}

export async function installPlugin(
  storageDirectory: string | undefined,
  bytes: Uint8Array,
  options: { replace?: boolean } = {},
): Promise<InstalledPlugin> {
  const owned = new Uint8Array(bytes);
  const opened = await openPluginArchive(owned);
  const digest = createHash("sha256").update(owned).digest("hex");
  return withStorageTransaction(storageDirectory, async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const index = state.plugins.findIndex((entry) => entry.id === opened.manifest.id);
    const previous = state.plugins[index];
    if (previous && !options.replace) throw new Error("This Plugin is already installed. Replace it explicitly.");
    if (!previous && options.replace) throw new Error("This Plugin is not installed and cannot be replaced.");
    if (!previous && state.plugins.length >= maximumPlugins) throw new Error("Installed Plugin limit reached.");
    const total = state.plugins.reduce((sum, entry) => sum + entry.byteLength, 0) - (previous?.byteLength ?? 0) + owned.byteLength;
    if (total > maximumStoredBytes) throw new Error("Installed Plugin storage limit reached.");
    const now = new Date().toISOString();
    const next: InstalledPlugin = {
      ...opened.manifest,
      components: { ...opened.manifest.components },
      sha256: digest,
      byteLength: owned.byteLength,
      enabled: false,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
    await ensureCatalogDirectories(directory, next.id);
    const target = archiveTarget(directory, next.id, digest);
    try {
      await writeBytesAtomicallyCreateOnly(target, owned);
    } catch (error) {
      if (!isAlreadyExistsError(error) || !equalBytes(await readPrivateFile(target, owned.byteLength), owned)) throw error;
    }
    const plugins = [...state.plugins];
    if (index < 0) plugins.push(next);
    else plugins[index] = next;
    plugins.sort((left, right) => left.id.localeCompare(right.id));
    await saveCatalog(directory, { schemaVersion: 1, revision: incrementRevision(state.revision), plugins });
    if (previous && previous.sha256 !== digest) await removeFileDurably(archiveTarget(directory, previous.id, previous.sha256));
    return clonePlugin(next);
  });
}

export async function listInstalledPlugins(storageDirectory: string | undefined): Promise<InstalledPlugin[]> {
  return withStorageTransaction(storageDirectory, (transaction) =>
    listInstalledPluginsInTransaction(transaction, storageDirectory));
}

export function listInstalledPluginsInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
): Promise<InstalledPlugin[]> {
  requireActiveStorageTransaction(transaction, storageDirectory);
  const operation = (async () => {
    if (!storageDirectory) return [];
    const directory = requireStorageDirectory(storageDirectory);
    return (await loadCatalog(directory)).plugins.map(clonePlugin);
  })();
  return trackStorageTransactionOperation(transaction, storageDirectory, operation);
}

export async function readEnabledPluginPackages(
  storageDirectory: string | undefined,
): Promise<InstalledPluginPackage[]> {
  return withStorageTransaction(storageDirectory, (transaction) =>
    readEnabledPluginPackagesInTransaction(transaction, storageDirectory));
}

export function readEnabledPluginPackagesInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
): Promise<InstalledPluginPackage[]> {
  requireActiveStorageTransaction(transaction, storageDirectory);
  const operation = (async () => {
    if (!storageDirectory) return [];
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const result: InstalledPluginPackage[] = [];
    for (const plugin of state.plugins.filter((entry) => entry.enabled)) {
      result.push({ plugin: clonePlugin(plugin), bytes: await readVerifiedArchive(directory, plugin) });
    }
    return result;
  })();
  return trackStorageTransactionOperation(transaction, storageDirectory, operation);
}

export async function readInstalledPluginArchive(
  storageDirectory: string | undefined,
  pluginId: string,
): Promise<Uint8Array> {
  return withStorageTransaction(storageDirectory, async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const plugin = (await loadCatalog(directory)).plugins.find((entry) => entry.id === pluginId);
    if (!plugin) throw new Error("This Plugin is not installed.");
    return readVerifiedArchive(directory, plugin);
  });
}

async function readVerifiedArchive(storageDirectory: string, plugin: InstalledPlugin): Promise<Uint8Array> {
  const bytes = await readPrivateFile(archiveTarget(storageDirectory, plugin.id, plugin.sha256), plugin.byteLength);
  if (createHash("sha256").update(bytes).digest("hex") !== plugin.sha256) throw new PluginStorageCorruptionError();
  const opened = await openPluginArchive(bytes);
  if (opened.manifest.id !== plugin.id || opened.manifest.version !== plugin.version) throw new PluginStorageCorruptionError();
  return new Uint8Array(bytes);
}

export async function setPluginEnabled(
  storageDirectory: string | undefined,
  pluginId: string,
  enabled: boolean,
): Promise<InstalledPlugin> {
  if (typeof enabled !== "boolean") throw new TypeError("Plugin enabled state must be boolean.");
  return withStorageTransaction(storageDirectory, async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const index = state.plugins.findIndex((entry) => entry.id === pluginId);
    if (index < 0) throw new Error("This Plugin is not installed.");
    const next = { ...state.plugins[index]!, components: { ...state.plugins[index]!.components }, enabled,
      updatedAt: new Date().toISOString() };
    const plugins = state.plugins.map((entry, entryIndex) => entryIndex === index ? next : entry);
    await saveCatalog(directory, { schemaVersion: 1, revision: incrementRevision(state.revision), plugins });
    return clonePlugin(next);
  });
}

export async function deletePlugin(storageDirectory: string | undefined, pluginId: string): Promise<void> {
  await withStorageTransaction(storageDirectory, async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const plugin = state.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) return;
    await saveCatalog(directory, {
      schemaVersion: 1,
      revision: incrementRevision(state.revision),
      plugins: state.plugins.filter((entry) => entry.id !== pluginId),
    });
    await removeDirectoryDurably(pluginDirectory(directory, pluginId));
  });
}

async function loadCatalog(storageDirectory: string): Promise<StoredPluginCatalog> {
  const root = catalogRoot(storageDirectory);
  try {
    await requirePrivateDirectory(root);
  } catch (error) {
    if (isMissingFileError(error)) return { schemaVersion: 1, revision: "0", plugins: [] };
    throw new PluginStorageCorruptionError(error);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readPrivateFile(catalogTarget(storageDirectory), maximumCatalogBytes);
  } catch (error) {
    if (isMissingFileError(error)) return { schemaVersion: 1, revision: "0", plugins: [] };
    throw new PluginStorageCorruptionError(error);
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return decodeCatalog(value);
  } catch (error) {
    if (error instanceof PluginStorageCorruptionError) throw error;
    throw new PluginStorageCorruptionError(error);
  }
}

function decodeCatalog(value: unknown): StoredPluginCatalog {
  if (!recordWithKeys(value, catalogKeys) || value.schemaVersion !== 1 ||
      typeof value.revision !== "string" || !revisionPattern.test(value.revision) || !Array.isArray(value.plugins)) {
    throw new PluginStorageCorruptionError();
  }
  const plugins = value.plugins.map(decodePlugin);
  if (plugins.length > maximumPlugins || plugins.some((entry, index) => index > 0 && plugins[index - 1]!.id >= entry.id) ||
      plugins.reduce((sum, entry) => sum + entry.byteLength, 0) > maximumStoredBytes) {
    throw new PluginStorageCorruptionError();
  }
  return { schemaVersion: 1, revision: value.revision, plugins };
}

function decodePlugin(value: unknown): InstalledPlugin {
  if (!recordWithKeys(value, pluginKeys) || typeof value.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
      value.id.length > 64 || typeof value.version !== "string" || !versionPattern.test(value.version) ||
      typeof value.description !== "string" || !value.description.trim() || value.description.length > 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.description) ||
      !["agent-plugins-1.0", "codex", "claude"].includes(String(value.sourceFormat)) ||
      !recordWithKeys(value.components, componentKeys) || typeof value.sha256 !== "string" || !shaPattern.test(value.sha256) ||
      !Number.isInteger(value.byteLength) || (value.byteLength as number) <= 0 || (value.byteLength as number) > 20 * 1024 * 1024 ||
      typeof value.enabled !== "boolean" || !validTimestamp(value.installedAt) || !validTimestamp(value.updatedAt)) {
    throw new PluginStorageCorruptionError();
  }
  const components = value.components as Record<string, unknown>;
  if ((components.skillsDirectory !== undefined && typeof components.skillsDirectory !== "string") ||
      (components.mcpConfigPath !== undefined && typeof components.mcpConfigPath !== "string") ||
      Object.values(components).some((component) => typeof component === "string" && !safePackagePath(component))) {
    throw new PluginStorageCorruptionError();
  }
  return clonePlugin(value as unknown as InstalledPlugin);
}

async function ensureCatalogDirectories(storageDirectory: string, pluginId: string): Promise<void> {
  await ensurePrivateDirectorySafe(catalogRoot(storageDirectory));
  await ensurePrivateDirectorySafe(packagesRoot(storageDirectory));
  await ensurePrivateDirectorySafe(pluginDirectory(storageDirectory, pluginId));
}

async function saveCatalog(storageDirectory: string, state: StoredPluginCatalog): Promise<void> {
  await writeJsonAtomically(catalogTarget(storageDirectory), state);
}

async function requirePrivateDirectory(target: string): Promise<void> {
  const before = await fs.lstat(target);
  if (!before.isDirectory() || before.isSymbolicLink() || (supportsPosixPermissions && getuid && before.uid !== getuid())) {
    throw new PluginStorageCorruptionError();
  }
  if (supportsPosixPermissions) await fs.chmod(target, 0o700);
  const after = await fs.lstat(target);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new PluginStorageCorruptionError();
  }
}

async function ensurePrivateDirectorySafe(target: string): Promise<void> {
  try {
    await fs.mkdir(target, { mode: 0o700 });
    if (supportsPosixPermissions) {
      const parent = await fs.open(path.dirname(target), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  await requirePrivateDirectory(target);
}

async function readPrivateFile(target: string, maximumBytes: number): Promise<Uint8Array> {
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes ||
      (supportsPosixPermissions && getuid && before.uid !== getuid())) throw new PluginStorageCorruptionError();
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    if (supportsPosixPermissions) await handle.chmod(0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new PluginStorageCorruptionError();
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.byteLength !== opened.size) {
      throw new PluginStorageCorruptionError();
    }
    return bytes;
  } finally { await handle.close(); }
}

function requireStorageDirectory(value: string | undefined): string {
  if (!value) throw new Error("Plugin installation requires private persistent storage.");
  return value;
}

function clonePlugin(value: InstalledPlugin): InstalledPlugin {
  return { ...value, components: { ...value.components } };
}

function recordWithKeys(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((key) => allowed.has(key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function safePackagePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function incrementRevision(value: string): string { return (BigInt(value) + 1n).toString(); }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean { return Buffer.compare(left, right) === 0; }
function isAlreadyExistsError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}
function catalogRoot(storageDirectory: string): string { return path.join(storageDirectory, rootName); }
function catalogTarget(storageDirectory: string): string { return path.join(catalogRoot(storageDirectory), catalogName); }
function packagesRoot(storageDirectory: string): string { return path.join(catalogRoot(storageDirectory), packagesName); }
function pluginDirectory(storageDirectory: string, pluginId: string): string { return path.join(packagesRoot(storageDirectory), pluginId); }
function archiveTarget(storageDirectory: string, pluginId: string, sha256: string): string {
  return path.join(pluginDirectory(storageDirectory, pluginId), `${sha256}.zip`);
}
