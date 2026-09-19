import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getuid, platform } from "node:process";
import { TextDecoder } from "node:util";

import { openPluginArchive, type OpenPluginArchive } from "../plugins/archive.js";
import { isSafePluginId, type PluginComponents, type PluginSourceFormat } from "../plugins/contracts.js";
import { pluginMcpConfigFromArchive } from "../plugins/mcp/config.js";
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
  version?: string;
  description?: string;
  sourceFormat: PluginSourceFormat;
  components: PluginComponents;
  unsupportedComponents?: string[];
  sha256: string;
  byteLength: number;
  enabled: boolean;
  approvedMcpServerIds: string[];
  installedAt: string;
  updatedAt: string;
}

export interface InstalledPluginPackage {
  plugin: InstalledPlugin;
  bytes: Uint8Array;
}

export interface PreparedPluginRuntime {
  plugin: InstalledPlugin;
  archive: OpenPluginArchive;
  pluginRoot: string;
  pluginData: string;
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
const supportsPosixPermissions = platform !== "win32";
const catalogKeys = new Set(["schemaVersion", "revision", "plugins"]);
const pluginKeys = new Set([
  "id", "version", "description", "sourceFormat", "components", "sha256", "byteLength",
  "unsupportedComponents", "enabled", "approvedMcpServerIds", "installedAt", "updatedAt",
]);
const componentKeys = new Set(["skillsDirectory", "mcpConfigPath", "mcpManifestPath"]);

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
      approvedMcpServerIds: [],
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
    if (previous && previous.sha256 !== digest) {
      await removeFileDurably(archiveTarget(directory, previous.id, previous.sha256));
      await removeDirectoryDurably(materializedTarget(directory, previous.id, previous.sha256));
    }
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
  return readPluginPackagesInTransaction(transaction, storageDirectory, true);
}

export function readInstalledPluginPackagesInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
): Promise<InstalledPluginPackage[]> {
  return readPluginPackagesInTransaction(transaction, storageDirectory, false);
}

function readPluginPackagesInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
  enabledOnly: boolean,
): Promise<InstalledPluginPackage[]> {
  requireActiveStorageTransaction(transaction, storageDirectory);
  const operation = (async () => {
    if (!storageDirectory) return [];
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const result: InstalledPluginPackage[] = [];
    for (const plugin of state.plugins.filter((entry) => !enabledOnly || entry.enabled)) {
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
  return withStorageTransaction(storageDirectory, (transaction) =>
    setPluginEnabledInTransaction(transaction, storageDirectory, pluginId, enabled));
}

export function setPluginEnabledInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
  pluginId: string,
  enabled: boolean,
): Promise<InstalledPlugin> {
  if (typeof enabled !== "boolean") throw new TypeError("Plugin enabled state must be boolean.");
  requireActiveStorageTransaction(transaction, storageDirectory);
  const operation = (async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const index = state.plugins.findIndex((entry) => entry.id === pluginId);
    if (index < 0) throw new Error("This Plugin is not installed.");
    const next = { ...state.plugins[index]!, components: { ...state.plugins[index]!.components }, enabled,
      updatedAt: new Date().toISOString() };
    const plugins = state.plugins.map((entry, entryIndex) => entryIndex === index ? next : entry);
    await saveCatalog(directory, { schemaVersion: 1, revision: incrementRevision(state.revision), plugins });
    return clonePlugin(next);
  })();
  return trackStorageTransactionOperation(transaction, storageDirectory, operation);
}

export async function setPluginMcpServerApproved(
  storageDirectory: string | undefined,
  pluginId: string,
  serverId: string,
  approved: boolean,
): Promise<InstalledPlugin> {
  if (typeof approved !== "boolean" || !/^[A-Za-z0-9_-]{1,64}$/u.test(serverId)) {
    throw new TypeError("Plugin MCP server approval is invalid.");
  }
  return withStorageTransaction(storageDirectory, (transaction) =>
    setPluginMcpServerApprovedInTransaction(transaction, storageDirectory, pluginId, serverId, approved));
}

export function setPluginMcpServerApprovedInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
  pluginId: string,
  serverId: string,
  approved: boolean,
): Promise<InstalledPlugin> {
  if (typeof approved !== "boolean" || !/^[A-Za-z0-9_-]{1,64}$/u.test(serverId)) {
    throw new TypeError("Plugin MCP server approval is invalid.");
  }
  requireActiveStorageTransaction(transaction, storageDirectory);
  const operation = (async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const state = await loadCatalog(directory);
    const index = state.plugins.findIndex((entry) => entry.id === pluginId);
    if (index < 0) throw new Error("This Plugin is not installed.");
    const current = state.plugins[index]!;
    const archive = await openPluginArchive(await readVerifiedArchive(directory, current));
    const config = pluginMcpConfigFromArchive(archive);
    if (!config?.servers.some((server) => server.id === serverId)) {
      throw new Error("This Plugin does not expose a supported MCP server with that name.");
    }
    const approvedIds = new Set(current.approvedMcpServerIds);
    if (approved) approvedIds.add(serverId);
    else approvedIds.delete(serverId);
    const next: InstalledPlugin = {
      ...current,
      components: { ...current.components },
      approvedMcpServerIds: [...approvedIds].sort(),
      updatedAt: new Date().toISOString(),
    };
    const plugins = state.plugins.map((entry, entryIndex) => entryIndex === index ? next : entry);
    await saveCatalog(directory, { schemaVersion: 1, revision: incrementRevision(state.revision), plugins });
    return clonePlugin(next);
  })();
  return trackStorageTransactionOperation(transaction, storageDirectory, operation);
}

export async function preparePluginRuntime(
  storageDirectory: string | undefined,
  pluginId: string,
): Promise<PreparedPluginRuntime> {
  return withStorageTransaction(storageDirectory, async () => {
    const directory = requireStorageDirectory(storageDirectory);
    const plugin = (await loadCatalog(directory)).plugins.find((entry) => entry.id === pluginId);
    if (!plugin) throw new Error("This Plugin is not installed.");
    if (!plugin.enabled) throw new Error("This Plugin is disabled.");
    const archive = await openPluginArchive(await readVerifiedArchive(directory, plugin));
    await ensureRuntimeDirectories(directory, plugin.id);
    const pluginRoot = materializedTarget(directory, plugin.id, plugin.sha256);
    await ensureMaterializedPackage(pluginRoot, archive.files);
    const pluginData = pluginDataDirectory(directory, plugin.id);
    return {
      plugin: clonePlugin(plugin),
      archive,
      pluginRoot: await fs.realpath(pluginRoot),
      pluginData: await fs.realpath(pluginData),
    };
  });
}

export async function deletePlugin(storageDirectory: string | undefined, pluginId: string): Promise<void> {
  await withStorageTransaction(storageDirectory, (transaction) =>
    deletePluginInTransaction(transaction, storageDirectory, pluginId));
}

export function deletePluginInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string | undefined,
  pluginId: string,
): Promise<void> {
  requireActiveStorageTransaction(transaction, storageDirectory);
  const operation = (async () => {
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
    await removeDirectoryDurably(materializedPluginDirectory(directory, pluginId));
    await removeDirectoryDurably(pluginDataDirectory(directory, pluginId));
  })();
  return trackStorageTransactionOperation(transaction, storageDirectory, operation);
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
  if (!recordWithKeys(value, pluginKeys) || !isSafePluginId(value.id) ||
      (value.version !== undefined && (typeof value.version !== "string" || !safeMetadataString(value.version, 128))) ||
      (value.description !== undefined && (typeof value.description !== "string" || !safeMetadataString(value.description, 1024))) ||
      !["agent-plugins-1.0", "codex", "claude"].includes(String(value.sourceFormat)) ||
      !recordWithKeys(value.components, componentKeys) || typeof value.sha256 !== "string" || !shaPattern.test(value.sha256) ||
      !Number.isInteger(value.byteLength) || (value.byteLength as number) <= 0 || (value.byteLength as number) > 20 * 1024 * 1024 ||
      typeof value.enabled !== "boolean" || !validTimestamp(value.installedAt) || !validTimestamp(value.updatedAt)) {
    throw new PluginStorageCorruptionError();
  }
  const components = value.components as Record<string, unknown>;
  if ((components.skillsDirectory !== undefined && typeof components.skillsDirectory !== "string") ||
      (components.mcpConfigPath !== undefined && typeof components.mcpConfigPath !== "string") ||
      (components.mcpManifestPath !== undefined && typeof components.mcpManifestPath !== "string") ||
      Object.values(components).some((component) => typeof component === "string" && !safePackagePath(component))) {
    throw new PluginStorageCorruptionError();
  }
  const approvedMcpServerIds = value.approvedMcpServerIds === undefined ? [] : value.approvedMcpServerIds;
  if (!Array.isArray(approvedMcpServerIds) || approvedMcpServerIds.length > 32 ||
      approvedMcpServerIds.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(entry)) ||
      approvedMcpServerIds.some((entry, index) => index > 0 && approvedMcpServerIds[index - 1] >= entry)) {
    throw new PluginStorageCorruptionError();
  }
  const unsupportedComponents = value.unsupportedComponents === undefined
    ? []
    : value.unsupportedComponents;
  if (!Array.isArray(unsupportedComponents) || unsupportedComponents.length > 32 ||
      unsupportedComponents.some((entry) => typeof entry !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/u.test(entry)) ||
      unsupportedComponents.some((entry, index) => index > 0 && unsupportedComponents[index - 1] >= entry)) {
    throw new PluginStorageCorruptionError();
  }
  return clonePlugin({
    ...(value as unknown as InstalledPlugin),
    approvedMcpServerIds,
    ...(unsupportedComponents.length ? { unsupportedComponents } : {}),
  });
}

async function ensureCatalogDirectories(storageDirectory: string, pluginId: string): Promise<void> {
  await ensurePrivateDirectorySafe(catalogRoot(storageDirectory));
  await ensurePrivateDirectorySafe(packagesRoot(storageDirectory));
  await ensurePrivateDirectorySafe(pluginDirectory(storageDirectory, pluginId));
}

async function ensureRuntimeDirectories(storageDirectory: string, pluginId: string): Promise<void> {
  await ensurePrivateDirectorySafe(materializedRoot(storageDirectory));
  await ensurePrivateDirectorySafe(materializedPluginDirectory(storageDirectory, pluginId));
  await ensurePrivateDirectorySafe(pluginDataRoot(storageDirectory));
  await ensurePrivateDirectorySafe(pluginDataDirectory(storageDirectory, pluginId));
}

async function ensureMaterializedPackage(
  target: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  try {
    await verifyMaterializedPackage(target, files);
    return;
  } catch (error) {
    if (!isMissingFileError(error)) await removeDirectoryDurably(target);
  }
  const parent = path.dirname(target);
  const staging = await fs.mkdtemp(path.join(parent, ".staging-"));
  try {
    for (const [relative, bytes] of files) {
      const destination = path.join(staging, ...relative.split("/"));
      if (!isContainedPath(staging, destination)) throw new PluginStorageCorruptionError();
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o500 });
    }
    await fs.rename(staging, target);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  await verifyMaterializedPackage(target, files);
}

async function verifyMaterializedPackage(
  target: string,
  expected: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const root = await fs.lstat(target);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new PluginStorageCorruptionError();
  if (supportsPosixPermissions) await fs.chmod(target, 0o700);
  const actual = new Map<string, Uint8Array>();
  await collectMaterializedFiles(target, "", actual);
  if (actual.size !== expected.size) throw new PluginStorageCorruptionError();
  for (const [relative, bytes] of expected) {
    const materialized = actual.get(relative);
    if (!materialized || !equalBytes(materialized, bytes)) throw new PluginStorageCorruptionError();
  }
}

async function collectMaterializedFiles(
  root: string,
  relative: string,
  output: Map<string, Uint8Array>,
): Promise<void> {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const target = path.join(root, ...childRelative.split("/"));
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new PluginStorageCorruptionError();
    if (stat.isDirectory()) {
      if (supportsPosixPermissions) await fs.chmod(target, 0o700);
      await collectMaterializedFiles(root, childRelative, output);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new PluginStorageCorruptionError();
    if (supportsPosixPermissions) await fs.chmod(target, 0o500);
    output.set(childRelative, new Uint8Array(await fs.readFile(target)));
  }
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
  return {
    ...value,
    components: { ...value.components },
    approvedMcpServerIds: [...value.approvedMcpServerIds],
    ...(value.unsupportedComponents === undefined
      ? {}
      : { unsupportedComponents: [...value.unsupportedComponents] }),
  };
}

function recordWithKeys(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((key) => allowed.has(key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function safeMetadataString(value: string, maximumLength: number): boolean {
  return value.length <= maximumLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
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
function materializedRoot(storageDirectory: string): string { return path.join(catalogRoot(storageDirectory), "runtime"); }
function materializedPluginDirectory(storageDirectory: string, pluginId: string): string {
  return path.join(materializedRoot(storageDirectory), pluginId);
}
function materializedTarget(storageDirectory: string, pluginId: string, sha256: string): string {
  return path.join(materializedPluginDirectory(storageDirectory, pluginId), sha256);
}
function pluginDataRoot(storageDirectory: string): string { return path.join(catalogRoot(storageDirectory), "data"); }
function pluginDataDirectory(storageDirectory: string, pluginId: string): string {
  return path.join(pluginDataRoot(storageDirectory), pluginId);
}
function isContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
