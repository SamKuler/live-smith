import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";
import { TextDecoder } from "node:util";

import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_FILE_BYTES,
  isSafeSkillId,
  parseSkillMarkdown,
  type SkillDefinition,
  type SkillSummary,
} from "../skills/format.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId } from "./id.js";
import {
  ensurePrivateDirectoryDurably,
  isStorageCommitOutcomeUnknownError,
  removeDirectoryDurably,
  removeFileDurably,
  requireActiveStorageTransaction,
  trackStorageTransactionOperation,
  withStorageTransaction,
  writeBytesAtomically,
  writeBytesAtomicallyCreateOnly,
  writeJsonAtomically,
  type StorageTransactionContext,
} from "./persistence.js";

export interface InstalledSkill extends SkillSummary {
  sha256: string;
  byteLength: number;
  installedAt: string;
  updatedAt: string;
}

export const MAX_INSTALLED_SKILLS = 32;
export const MAX_INSTALLED_SKILL_BYTES = 1024 * 1024;

export type SkillStorageFaultPoint =
  | "after-catalog-lstat"
  | "after-definition-lstat"
  | "after-definition-fstat"
  | "before-pending-catalog"
  | "after-pending-catalog"
  | "before-definition-replace"
  | "after-definition-replace"
  | "before-definition-delete"
  | "after-definition-delete"
  | "before-final-catalog"
  | "after-final-catalog";

export interface SkillCatalogTransaction {
  installSkill(
    bytes: Uint8Array,
    options?: { replace?: boolean },
  ): Promise<InstalledSkill>;
  listInstalledSkills(): Promise<InstalledSkill[]>;
  readInstalledSkill(skillId: string): Promise<SkillDefinition>;
  deleteInstalledSkill(skillId: string): Promise<void>;
}

interface SkillCatalogTransactionOptions {
  fault?: (point: SkillStorageFaultPoint) => void | Promise<void>;
}

interface StoredSkillCatalog {
  schemaVersion: 1;
  skills: InstalledSkill[];
  pendingMutation?: PendingSkillMutation;
}

interface PendingSkillWrite {
  kind: "install" | "replace";
  skillId: string;
  next: InstalledSkill;
  stagingFile: string;
}

interface PendingSkillDelete {
  kind: "delete";
  skillId: string;
}

type PendingSkillMutation = PendingSkillWrite | PendingSkillDelete;

interface MemorySkill {
  bytes: Uint8Array;
  metadata: InstalledSkill;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

type FaultInjector = NonNullable<SkillCatalogTransactionOptions["fault"]>;

const catalogDirectoryName = "live-smith-skills";
const catalogFileName = "catalog.json";
const definitionFileName = "SKILL.md";
const maximumCatalogBytes = 256 * 1024;
const catalogKeys = new Set(["schemaVersion", "skills", "pendingMutation"]);
const installedSkillKeys = new Set([
  "id",
  "description",
  "sha256",
  "byteLength",
  "installedAt",
  "updatedAt",
]);
const pendingWriteKeys = new Set([
  "kind",
  "skillId",
  "next",
  "stagingFile",
]);
const pendingDeleteKeys = new Set(["kind", "skillId"]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const stagingFilePattern = /^\.SKILL\.md\.skill_[A-Za-z0-9_-]+\.next$/;
const catalogTemporaryPattern = /^\.catalog\.json\.tmp_[A-Za-z0-9_-]+$/;
const supportsPosixPermissions = platform !== "win32";
const memorySkills = new Map<string, MemorySkill>();

export class SkillStorageCorruptionError extends Error {
  constructor(cause?: unknown) {
    super(
      "Installed Skill storage is invalid. No catalog changes were written.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "SkillStorageCorruptionError";
  }
}

export async function installSkill(
  storageDirectory: string | undefined,
  bytes: Uint8Array,
  options?: { replace?: boolean },
): Promise<InstalledSkill> {
  const ownedBytes = snapshotSkillBytes(bytes);
  const ownedOptions = snapshotInstallOptions(options);
  return withStorageTransaction(storageDirectory, (context) =>
    installSkillInTransaction(context, storageDirectory, ownedBytes, ownedOptions)
  );
}

export async function listInstalledSkills(
  storageDirectory: string | undefined,
): Promise<InstalledSkill[]> {
  return withStorageTransaction(storageDirectory, (context) =>
    listInstalledSkillsInTransaction(context, storageDirectory)
  );
}

export async function readInstalledSkill(
  storageDirectory: string | undefined,
  skillId: string,
): Promise<SkillDefinition> {
  return withStorageTransaction(storageDirectory, (context) =>
    readInstalledSkillInTransaction(context, storageDirectory, skillId)
  );
}

export async function deleteInstalledSkill(
  storageDirectory: string | undefined,
  skillId: string,
): Promise<void> {
  return withStorageTransaction(storageDirectory, (context) =>
    deleteInstalledSkillInTransaction(context, storageDirectory, skillId)
  );
}

export function installSkillInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  bytes: Uint8Array,
  options?: { replace?: boolean },
): Promise<InstalledSkill> {
  const ownedBytes = snapshotSkillBytes(bytes);
  const ownedOptions = snapshotInstallOptions(options);
  requireActiveStorageTransaction(context, storageDirectory);
  const operation = (async () => {
    const catalog = await openSkillCatalog(context, storageDirectory);
    return catalog.installSkill(ownedBytes, ownedOptions);
  })();
  return trackStorageTransactionOperation(
    context,
    storageDirectory,
    operation,
  );
}

export function listInstalledSkillsInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
): Promise<InstalledSkill[]> {
  requireActiveStorageTransaction(context, storageDirectory);
  const operation = (async () => {
    const catalog = await openSkillCatalog(context, storageDirectory);
    return catalog.listInstalledSkills();
  })();
  return trackStorageTransactionOperation(context, storageDirectory, operation);
}

export function readInstalledSkillInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  skillId: string,
): Promise<SkillDefinition> {
  requireActiveStorageTransaction(context, storageDirectory);
  const operation = (async () => {
    const catalog = await openSkillCatalog(context, storageDirectory);
    return catalog.readInstalledSkill(skillId);
  })();
  return trackStorageTransactionOperation(context, storageDirectory, operation);
}

export function deleteInstalledSkillInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  skillId: string,
): Promise<void> {
  requireActiveStorageTransaction(context, storageDirectory);
  const operation = (async () => {
    const catalog = await openSkillCatalog(context, storageDirectory);
    return catalog.deleteInstalledSkill(skillId);
  })();
  return trackStorageTransactionOperation(context, storageDirectory, operation);
}

export async function withSkillCatalogTransaction<T>(
  storageDirectory: string | undefined,
  operation: (catalog: SkillCatalogTransaction) => Promise<T>,
  options: SkillCatalogTransactionOptions = {},
): Promise<T> {
  return withStorageTransaction(storageDirectory, async (context) => {
    const catalog = await openSkillCatalog(
      context,
      storageDirectory,
      options.fault,
    );
    const catalogOperations: Promise<unknown>[] = [];
    let acceptingCatalogOperations = true;
    let result: T | undefined;
    let callbackError: unknown;
    let callbackFailed = false;
    const trackedCatalog = trackedSkillCatalog(
      catalog,
      context,
      storageDirectory,
      catalogOperations,
      () => acceptingCatalogOperations,
    );
    try {
      result = await operation(trackedCatalog);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    } finally {
      acceptingCatalogOperations = false;
    }
    const settlements = await Promise.allSettled(catalogOperations);
    if (callbackFailed) throw callbackError;
    const rejected = settlements.find(
      (settlement): settlement is PromiseRejectedResult =>
        settlement.status === "rejected",
    );
    if (rejected !== undefined) throw rejected.reason;
    return result as T;
  });
}

function trackedSkillCatalog(
  catalog: SkillCatalogTransaction,
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  operations: Promise<unknown>[],
  accepting: () => boolean,
): SkillCatalogTransaction {
  const track = <T>(start: () => Promise<T>): Promise<T> => {
    try {
      if (!accepting()) {
        throw new Error("Skill catalog transaction is no longer accepting operations.");
      }
      requireActiveStorageTransaction(context, storageDirectory);
      const tracked = trackStorageTransactionOperation(
        context,
        storageDirectory,
        start(),
      );
      operations.push(tracked);
      return tracked;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return Object.freeze({
    installSkill: (
      bytes: Uint8Array,
      options?: { replace?: boolean },
    ) => track(() => catalog.installSkill(bytes, options)),
    listInstalledSkills: () => track(() => catalog.listInstalledSkills()),
    readInstalledSkill: (skillId: string) =>
      track(() => catalog.readInstalledSkill(skillId)),
    deleteInstalledSkill: (skillId: string) =>
      track(() => catalog.deleteInstalledSkill(skillId)),
  });
}

async function openSkillCatalog(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  fault?: FaultInjector,
): Promise<SkillCatalog> {
  requireActiveStorageTransaction(context, storageDirectory);
  const catalog = new SkillCatalog(context, storageDirectory, fault);
  await catalog.open();
  return catalog;
}

class SkillCatalog implements SkillCatalogTransaction {
  private state: StoredSkillCatalog = emptyCatalog();
  private catalogExists = false;

  constructor(
    private readonly context: StorageTransactionContext,
    private readonly storageDirectory: string | undefined,
    private readonly fault?: FaultInjector,
  ) {}

  async open(): Promise<void> {
    this.requireActiveTransaction();
    if (this.storageDirectory === undefined) {
      this.state = memoryCatalogState();
      return;
    }
    const loaded = await loadDiskCatalog(this.storageDirectory, this.fault);
    this.state = loaded.state;
    this.catalogExists = loaded.exists;
    while (this.state.pendingMutation !== undefined) {
      await this.recoverPendingMutation();
    }
    if (this.catalogExists) {
      await validateStableDiskState(this.storageDirectory, this.state, this.fault);
    }
  }

  async installSkill(
    inputBytes: Uint8Array,
    options?: { replace?: boolean },
  ): Promise<InstalledSkill> {
    this.requireActiveTransaction();
    if (!(inputBytes instanceof Uint8Array)) {
      throw new TypeError("Skill upload must contain bytes.");
    }
    validateInstallOptions(options);
    const bytes = Uint8Array.from(inputBytes);
    const definition = parseSkillMarkdown(bytes);
    const existing = this.metadata(definition.id);
    const inputHash = sha256(bytes);
    if (existing !== undefined && options?.replace !== true) {
      throw new Error(`Skill ${definition.id} is already installed.`);
    }
    if (
      existing !== undefined &&
      options?.replace === true &&
      existing.byteLength === bytes.byteLength &&
      existing.sha256 === inputHash &&
      existing.description === definition.description
    ) {
      if (this.storageDirectory === undefined) {
        const stored = memorySkills.get(definition.id);
        if (stored === undefined) throw new SkillStorageCorruptionError();
        parseAndMatchDefinition(stored.bytes, existing);
      } else {
        await verifyDefinition(
          definitionTarget(this.storageDirectory, definition.id),
          existing,
          this.fault,
        );
      }
      return cloneInstalledSkill(existing);
    }
    if (existing === undefined && this.state.skills.length >= MAX_INSTALLED_SKILLS) {
      throw new Error("The installed Skill limit has been reached.");
    }

    const prospectiveBytes = totalCatalogBytes(this.state.skills) -
      (existing?.byteLength ?? 0) + bytes.byteLength;
    if (prospectiveBytes > MAX_INSTALLED_SKILL_BYTES) {
      throw new Error("The installed Skill byte limit would be exceeded.");
    }

    const now = new Date().toISOString();
    const metadata: InstalledSkill = {
      id: definition.id,
      description: definition.description,
      sha256: inputHash,
      byteLength: bytes.byteLength,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };

    if (this.storageDirectory === undefined) {
      memorySkills.set(definition.id, {
        bytes,
        metadata: cloneInstalledSkill(metadata),
      });
      this.state = memoryCatalogState();
      return cloneInstalledSkill(metadata);
    }

    await this.ensureCatalogExists();
    const root = catalogRoot(this.storageDirectory);
    const skillDirectory = path.join(root, definition.id);
    if (existing === undefined) {
      await ensureSkillDirectoryForInstall(skillDirectory);
    }
    const stagingFile = `.SKILL.md.${createStorageId("skill")}.next`;
    const stagingTarget = path.join(skillDirectory, stagingFile);
    const rootIdentity = await captureDirectoryIdentity(root);
    const skillDirectoryIdentity = await captureDirectoryIdentity(skillDirectory);
    await writeDefinitionBound(
      stagingTarget,
      bytes,
      root,
      rootIdentity,
      skillDirectory,
      skillDirectoryIdentity,
      true,
    );
    await verifyDefinition(stagingTarget, metadata, this.fault);

    const pending: PendingSkillWrite = {
      kind: existing === undefined ? "install" : "replace",
      skillId: definition.id,
      next: cloneInstalledSkill(metadata),
      stagingFile,
    };
    const pendingState: StoredSkillCatalog = {
      ...this.state,
      pendingMutation: pending,
    };
    let pendingCommitted = false;
    try {
      const pendingRootIdentity = await captureDirectoryIdentity(root);
      await injectFault(this.fault, "before-pending-catalog");
      await assertDirectoryIdentity(root, pendingRootIdentity);
      await writeCatalogBound(this.storageDirectory, pendingState, pendingRootIdentity);
      pendingCommitted = true;
      this.state = pendingState;
      await injectFault(this.fault, "after-pending-catalog");
    } catch (error) {
      if (!pendingCommitted && !isStorageCommitOutcomeUnknownError(error)) {
        await cleanupUncommittedStaging(stagingTarget, skillDirectory, existing === undefined);
      }
      throw error;
    }

    await this.recoverPendingMutation();
    await validateStableDiskState(this.storageDirectory, this.state, this.fault);
    const installed = this.metadata(definition.id);
    if (installed === undefined) throw new SkillStorageCorruptionError();
    return cloneInstalledSkill(installed);
  }

  async listInstalledSkills(): Promise<InstalledSkill[]> {
    this.requireActiveTransaction();
    return this.state.skills.map(cloneInstalledSkill);
  }

  async readInstalledSkill(skillId: string): Promise<SkillDefinition> {
    this.requireActiveTransaction();
    requireSafeSkillId(skillId);
    const metadata = this.metadata(skillId);
    if (metadata === undefined) throw new Error(`Skill ${skillId} does not exist.`);
    if (this.storageDirectory === undefined) {
      const stored = memorySkills.get(skillId);
      if (stored === undefined) throw new SkillStorageCorruptionError();
      return parseAndMatchDefinition(stored.bytes, metadata);
    }
    return (await verifyDefinition(
      definitionTarget(this.storageDirectory, skillId),
      metadata,
      this.fault,
    )).definition;
  }

  async deleteInstalledSkill(skillId: string): Promise<void> {
    this.requireActiveTransaction();
    requireSafeSkillId(skillId);
    if (this.metadata(skillId) === undefined) {
      throw new Error(`Skill ${skillId} does not exist.`);
    }
    if (this.storageDirectory === undefined) {
      memorySkills.delete(skillId);
      this.state = memoryCatalogState();
      return;
    }

    const pendingState: StoredSkillCatalog = {
      ...this.state,
      pendingMutation: { kind: "delete", skillId },
    };
    const root = catalogRoot(this.storageDirectory);
    const rootIdentity = await captureDirectoryIdentity(root);
    await injectFault(this.fault, "before-pending-catalog");
    await assertDirectoryIdentity(root, rootIdentity);
    await writeCatalogBound(this.storageDirectory, pendingState, rootIdentity);
    this.state = pendingState;
    await injectFault(this.fault, "after-pending-catalog");
    await this.recoverPendingMutation();
    await validateStableDiskState(this.storageDirectory, this.state, this.fault);
  }

  private metadata(skillId: string): InstalledSkill | undefined {
    return this.state.skills.find((entry) => entry.id === skillId);
  }

  private requireActiveTransaction(): void {
    requireActiveStorageTransaction(this.context, this.storageDirectory);
  }

  private async ensureCatalogExists(): Promise<void> {
    if (this.storageDirectory === undefined || this.catalogExists) return;
    const root = catalogRoot(this.storageDirectory);
    await ensureCatalogRootForWrite(root);
    const rootIdentity = await captureDirectoryIdentity(root);
    await writeCatalogBound(this.storageDirectory, this.state, rootIdentity);
    this.catalogExists = true;
  }

  private async recoverPendingMutation(): Promise<void> {
    if (this.storageDirectory === undefined) throw new SkillStorageCorruptionError();
    const pending = this.state.pendingMutation;
    if (pending === undefined) return;

    if (pending.kind === "delete") {
      const root = catalogRoot(this.storageDirectory);
      const directory = path.join(root, pending.skillId);
      if (await pathExists(directory)) {
        const rootIdentity = await captureDirectoryIdentity(root);
        const directoryIdentity = await captureDirectoryIdentity(directory);
        await injectFault(this.fault, "before-definition-delete");
        await assertDirectoryIdentity(root, rootIdentity);
        await assertDirectoryIdentity(directory, directoryIdentity);
        await removeDirectoryBound(
          directory,
          root,
          rootIdentity,
          directoryIdentity,
        );
        await injectFault(this.fault, "after-definition-delete");
      }
      const finalState: StoredSkillCatalog = {
        schemaVersion: 1,
        skills: this.state.skills.filter((entry) => entry.id !== pending.skillId),
      };
      await this.commitFinalState(finalState);
      return;
    }

    const skillDirectory = path.join(
      catalogRoot(this.storageDirectory),
      pending.skillId,
    );
    await ensureExistingPrivateDirectory(skillDirectory);
    const currentTarget = path.join(skillDirectory, definitionFileName);
    const previous = this.metadata(pending.skillId);
    const currentDisposition = await definitionDisposition(
      currentTarget,
      pending.next,
      previous,
      this.fault,
    );
    if (currentDisposition !== "next") {
      if (pending.kind === "replace" && currentDisposition !== "previous") {
        throw new SkillStorageCorruptionError();
      }
      if (pending.kind === "install" && currentDisposition !== "missing") {
        throw new SkillStorageCorruptionError();
      }
      const stagingTarget = path.join(skillDirectory, pending.stagingFile);
      const staged = await verifyDefinition(stagingTarget, pending.next, this.fault);
      const root = catalogRoot(this.storageDirectory);
      const rootIdentity = await captureDirectoryIdentity(root);
      const skillDirectoryIdentity = await captureDirectoryIdentity(skillDirectory);
      await injectFault(this.fault, "before-definition-replace");
      await assertDirectoryIdentity(root, rootIdentity);
      await assertDirectoryIdentity(skillDirectory, skillDirectoryIdentity);
      await writeDefinitionBound(
        currentTarget,
        staged.bytes,
        root,
        rootIdentity,
        skillDirectory,
        skillDirectoryIdentity,
        false,
      );
      await injectFault(this.fault, "after-definition-replace");
      await verifyDefinition(currentTarget, pending.next, this.fault);
    }

    const nextSkills = this.state.skills.filter((entry) => entry.id !== pending.skillId);
    nextSkills.push(cloneInstalledSkill(pending.next));
    nextSkills.sort((left, right) => compareSkillIds(left.id, right.id));
    const finalState: StoredSkillCatalog = {
      schemaVersion: 1,
      skills: nextSkills,
    };
    await this.commitFinalState(finalState);
    await removePrivateFileBound(
      path.join(skillDirectory, pending.stagingFile),
      catalogRoot(this.storageDirectory),
      await captureDirectoryIdentity(catalogRoot(this.storageDirectory)),
      skillDirectory,
      await captureDirectoryIdentity(skillDirectory),
    );
  }

  private async commitFinalState(finalState: StoredSkillCatalog): Promise<void> {
    if (this.storageDirectory === undefined) throw new SkillStorageCorruptionError();
    const root = catalogRoot(this.storageDirectory);
    const rootIdentity = await captureDirectoryIdentity(root);
    await injectFault(this.fault, "before-final-catalog");
    await assertDirectoryIdentity(root, rootIdentity);
    await writeCatalogBound(this.storageDirectory, finalState, rootIdentity);
    this.state = finalState;
    await injectFault(this.fault, "after-final-catalog");
  }
}

async function loadDiskCatalog(
  storageDirectory: string,
  fault?: FaultInjector,
): Promise<{ exists: boolean; state: StoredSkillCatalog }> {
  const root = catalogRoot(storageDirectory);
  try {
    await ensureExistingPrivateDirectory(root);
  } catch (error) {
    if (isMissingFileError(error)) return { exists: false, state: emptyCatalog() };
    throw asCorruption(error);
  }

  const target = catalogTarget(storageDirectory);
  let bytes: Uint8Array;
  try {
    bytes = await readPrivateFile(target, maximumCatalogBytes, undefined, fault, "catalog");
  } catch (error) {
    if (isMissingFileError(error)) {
      const entries = await fs.readdir(root, { withFileTypes: true });
      if (entries.length === 0) return { exists: false, state: emptyCatalog() };
      if (
        entries.every((entry) =>
          entry.isFile() && catalogTemporaryPattern.test(entry.name)
        )
      ) {
        for (const entry of entries) {
          const staleTarget = path.join(root, entry.name);
          await statPrivateFile(staleTarget, undefined, fault, "catalog");
          await removeRootFileBound(
            staleTarget,
            root,
            await captureDirectoryIdentity(root),
          );
        }
        return { exists: false, state: emptyCatalog() };
      }
    }
    throw asCorruption(error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw asCorruption(error);
  }
  const state = decodeCatalog(parsed);
  await validateDiskStructure(storageDirectory, state, fault);
  return { exists: true, state };
}

async function validateStableDiskState(
  storageDirectory: string,
  state: StoredSkillCatalog,
  fault?: FaultInjector,
): Promise<void> {
  if (state.pendingMutation !== undefined) throw new SkillStorageCorruptionError();
  await validateDiskStructure(storageDirectory, state, fault);
}

async function validateDiskStructure(
  storageDirectory: string,
  state: StoredSkillCatalog,
  fault?: FaultInjector,
): Promise<void> {
  const root = catalogRoot(storageDirectory);
  try {
    await ensureExistingPrivateDirectory(root);
    const allowedDirectories = new Set(state.skills.map((entry) => entry.id));
    if (state.pendingMutation !== undefined) {
      allowedDirectories.add(state.pendingMutation.skillId);
    }
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.name === catalogFileName) {
        if (!entry.isFile()) throw new SkillStorageCorruptionError();
        continue;
      }
      if (catalogTemporaryPattern.test(entry.name)) {
        if (!entry.isFile()) throw new SkillStorageCorruptionError();
        const target = path.join(root, entry.name);
        await statPrivateFile(target, undefined, undefined, "catalog");
        await removeRootFileBound(
          target,
          root,
          await captureDirectoryIdentity(root),
        );
        continue;
      }
      if (!isSafeSkillId(entry.name) || !entry.isDirectory()) {
        throw new SkillStorageCorruptionError();
      }
      if (!allowedDirectories.has(entry.name)) {
        await cleanupOrphanStagingDirectory(path.join(root, entry.name));
      }
    }

    const pendingId = state.pendingMutation?.skillId;
    for (const metadata of state.skills) {
      if (metadata.id === pendingId) continue;
      await validateStableDefinitionStat(storageDirectory, metadata, fault);
    }
  } catch (error) {
    if (isStorageCommitOutcomeUnknownError(error)) throw error;
    throw asCorruption(error);
  }
}

async function validateStableDefinitionStat(
  storageDirectory: string,
  metadata: InstalledSkill,
  fault?: FaultInjector,
): Promise<void> {
  const directory = path.dirname(definitionTarget(storageDirectory, metadata.id));
  await ensureExistingPrivateDirectory(directory);
  await validateSkillDirectoryEntries(directory, true);
  await statPrivateFile(
    definitionTarget(storageDirectory, metadata.id),
    metadata.byteLength,
    fault,
    "definition",
  );
}

async function validateSkillDirectoryEntries(
  directory: string,
  cleanupStaging: boolean,
): Promise<void> {
  const stagingTargets: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === definitionFileName && entry.isFile()) continue;
    if (stagingFilePattern.test(entry.name) && entry.isFile()) {
      stagingTargets.push(path.join(directory, entry.name));
      continue;
    }
    throw new SkillStorageCorruptionError();
  }
  if (cleanupStaging) {
    const root = path.dirname(directory);
    const rootIdentity = await captureDirectoryIdentity(root);
    const directoryIdentity = await captureDirectoryIdentity(directory);
    for (const target of stagingTargets) {
      await removePrivateFileBound(
        target,
        root,
        rootIdentity,
        directory,
        directoryIdentity,
      );
    }
  }
}

async function cleanupOrphanStagingDirectory(directory: string): Promise<void> {
  await ensureExistingPrivateDirectory(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry.isFile() || !stagingFilePattern.test(entry.name))
  ) {
    throw new SkillStorageCorruptionError();
  }
  for (const entry of entries) {
    await statPrivateFile(path.join(directory, entry.name), undefined, undefined, "definition");
  }
  const root = path.dirname(directory);
  await removeDirectoryBound(
    directory,
    root,
    await captureDirectoryIdentity(root),
    await captureDirectoryIdentity(directory),
  );
}

async function definitionDisposition(
  target: string,
  next: InstalledSkill,
  previous: InstalledSkill | undefined,
  fault?: FaultInjector,
): Promise<"missing" | "previous" | "next"> {
  let bytes: Uint8Array;
  try {
    bytes = await readPrivateFile(target, MAX_SKILL_FILE_BYTES, undefined, fault, "definition");
  } catch (error) {
    if (isMissingFileError(error)) return "missing";
    throw asCorruption(error);
  }
  const hash = sha256(bytes);
  if (bytes.byteLength === next.byteLength && hash === next.sha256) {
    parseAndMatchDefinition(bytes, next);
    return "next";
  }
  if (
    previous !== undefined &&
    bytes.byteLength === previous.byteLength &&
    hash === previous.sha256
  ) {
    parseAndMatchDefinition(bytes, previous);
    return "previous";
  }
  throw new SkillStorageCorruptionError();
}

async function verifyDefinition(
  target: string,
  metadata: InstalledSkill,
  fault?: FaultInjector,
): Promise<{ bytes: Uint8Array; definition: SkillDefinition }> {
  try {
    const bytes = await readPrivateFile(
      target,
      MAX_SKILL_FILE_BYTES,
      metadata.byteLength,
      fault,
      "definition",
    );
    if (sha256(bytes) !== metadata.sha256) throw new SkillStorageCorruptionError();
    return { bytes, definition: parseAndMatchDefinition(bytes, metadata) };
  } catch (error) {
    throw asCorruption(error);
  }
}

function parseAndMatchDefinition(
  bytes: Uint8Array,
  metadata: InstalledSkill,
): SkillDefinition {
  const definition = parseSkillMarkdown(bytes);
  if (
    definition.id !== metadata.id ||
    definition.description !== metadata.description
  ) {
    throw new SkillStorageCorruptionError();
  }
  return definition;
}

async function ensureCatalogRootForWrite(root: string): Promise<void> {
  try {
    await ensureExistingPrivateDirectory(root);
  } catch (error) {
    if (!isMissingFileError(error)) throw asCorruption(error);
    await ensurePrivateDirectoryDurably(root);
    await ensureExistingPrivateDirectory(root);
  }
}

async function ensureSkillDirectoryForInstall(directory: string): Promise<void> {
  try {
    await ensureExistingPrivateDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (
      entries.some((entry) => !entry.isFile() || !stagingFilePattern.test(entry.name))
    ) {
      throw new SkillStorageCorruptionError();
    }
    const root = path.dirname(directory);
    const rootIdentity = await captureDirectoryIdentity(root);
    const directoryIdentity = await captureDirectoryIdentity(directory);
    for (const entry of entries) {
      await removePrivateFileBound(
        path.join(directory, entry.name),
        root,
        rootIdentity,
        directory,
        directoryIdentity,
      );
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw asCorruption(error);
    await ensurePrivateDirectoryDurably(directory);
    await ensureExistingPrivateDirectory(directory);
  }
}

async function writeCatalogBound(
  storageDirectory: string,
  state: StoredSkillCatalog,
  rootIdentity: DirectoryIdentity,
): Promise<void> {
  const root = catalogRoot(storageDirectory);
  await assertDirectoryIdentity(root, rootIdentity);
  await writeJsonAtomically(catalogTarget(storageDirectory), state);
  await assertDirectoryIdentity(root, rootIdentity);
}

async function writeDefinitionBound(
  target: string,
  bytes: Uint8Array,
  root: string,
  rootIdentity: DirectoryIdentity,
  skillDirectory: string,
  skillDirectoryIdentity: DirectoryIdentity,
  createOnly: boolean,
): Promise<void> {
  await assertDirectoryIdentity(root, rootIdentity);
  await assertDirectoryIdentity(skillDirectory, skillDirectoryIdentity);
  if (createOnly) await writeBytesAtomicallyCreateOnly(target, bytes);
  else await writeBytesAtomically(target, bytes);
  await assertDirectoryIdentity(root, rootIdentity);
  await assertDirectoryIdentity(skillDirectory, skillDirectoryIdentity);
}

async function removePrivateFileBound(
  target: string,
  root: string,
  rootIdentity: DirectoryIdentity,
  skillDirectory: string,
  skillDirectoryIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(root, rootIdentity);
  await assertDirectoryIdentity(skillDirectory, skillDirectoryIdentity);
  await removeFileDurably(target);
  await assertDirectoryIdentity(root, rootIdentity);
  await assertDirectoryIdentity(skillDirectory, skillDirectoryIdentity);
}

async function removeRootFileBound(
  target: string,
  root: string,
  rootIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(root, rootIdentity);
  await removeFileDurably(target);
  await assertDirectoryIdentity(root, rootIdentity);
}

async function removeDirectoryBound(
  target: string,
  root: string,
  rootIdentity: DirectoryIdentity,
  targetIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(root, rootIdentity);
  await assertDirectoryIdentity(target, targetIdentity);
  await removeDirectoryDurably(target);
  await assertDirectoryIdentity(root, rootIdentity);
  if (await pathExists(target)) throw new SkillStorageCorruptionError();
}

async function captureDirectoryIdentity(
  directory: string,
): Promise<DirectoryIdentity> {
  await ensureExistingPrivateDirectory(directory);
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SkillStorageCorruptionError();
  }
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const actual = await fs.lstat(directory);
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new SkillStorageCorruptionError();
  }
}

async function ensureExistingPrivateDirectory(directory: string): Promise<void> {
  const before = await fs.lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new SkillStorageCorruptionError();
  }
  if (platform === "win32") {
    const after = await fs.lstat(directory);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameIdentity(before, after)
    ) {
      throw new SkillStorageCorruptionError();
    }
    return;
  }
  const noFollow = requireNoFollowFlag();
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | noFollow | fsConstants.O_DIRECTORY | fsConstants.O_NONBLOCK,
  );
  try {
    if (supportsPosixPermissions) await handle.chmod(0o700);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      throw new SkillStorageCorruptionError();
    }
  } finally {
    await handle.close();
  }
  const after = await fs.lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    throw new SkillStorageCorruptionError();
  }
}

async function statPrivateFile(
  target: string,
  expectedLength: number | undefined,
  fault: FaultInjector | undefined,
  kind: "catalog" | "definition",
): Promise<void> {
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new SkillStorageCorruptionError();
  await injectFault(fault, kind === "catalog" ? "after-catalog-lstat" : "after-definition-lstat");
  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | requireNoFollowFlag() | fsConstants.O_NONBLOCK,
  );
  try {
    if (supportsPosixPermissions) await handle.chmod(0o600);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameIdentity(before, opened) ||
      (expectedLength !== undefined && opened.size !== expectedLength)
    ) {
      throw new SkillStorageCorruptionError();
    }
  } finally {
    await handle.close();
  }
  const after = await fs.lstat(target);
  if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    throw new SkillStorageCorruptionError();
  }
}

async function readPrivateFile(
  target: string,
  maximumBytes: number,
  expectedLength: number | undefined,
  fault: FaultInjector | undefined,
  kind: "catalog" | "definition",
): Promise<Uint8Array> {
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new SkillStorageCorruptionError();
  await injectFault(fault, kind === "catalog" ? "after-catalog-lstat" : "after-definition-lstat");
  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | requireNoFollowFlag() | fsConstants.O_NONBLOCK,
  );
  try {
    if (supportsPosixPermissions) await handle.chmod(0o600);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameIdentity(before, opened) ||
      opened.size > maximumBytes ||
      (expectedLength !== undefined && opened.size !== expectedLength)
    ) {
      throw new SkillStorageCorruptionError();
    }
    if (kind === "definition") {
      await injectFault(fault, "after-definition-fstat");
    }

    const buffer = Buffer.alloc(maximumBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        total,
      );
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (
      total > maximumBytes ||
      (expectedLength !== undefined && total !== expectedLength)
    ) {
      throw new SkillStorageCorruptionError();
    }
    const afterRead = await handle.stat();
    if (
      !sameIdentity(opened, afterRead) ||
      afterRead.size !== total ||
      afterRead.mtimeMs !== opened.mtimeMs ||
      afterRead.ctimeMs !== opened.ctimeMs
    ) {
      throw new SkillStorageCorruptionError();
    }
    const finalPath = await fs.lstat(target);
    if (
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      !sameIdentity(opened, finalPath) ||
      finalPath.size !== total
    ) {
      throw new SkillStorageCorruptionError();
    }
    return Uint8Array.from(buffer.subarray(0, total));
  } finally {
    await handle.close();
  }
}

function decodeCatalog(value: unknown): StoredSkillCatalog {
  if (!isRecordWithOnlyKeys(value, catalogKeys) || value.schemaVersion !== 1) {
    throw new SkillStorageCorruptionError();
  }
  if (!Array.isArray(value.skills) || value.skills.length > MAX_INSTALLED_SKILLS) {
    throw new SkillStorageCorruptionError();
  }
  const skills = value.skills.map(decodeInstalledSkill);
  const sortedIds = skills.map((entry) => entry.id).sort(compareSkillIds);
  if (
    new Set(skills.map((entry) => entry.id)).size !== skills.length ||
    skills.some((entry, index) => entry.id !== sortedIds[index]) ||
    totalCatalogBytes(skills) > MAX_INSTALLED_SKILL_BYTES
  ) {
    throw new SkillStorageCorruptionError();
  }

  const pendingMutation = value.pendingMutation === undefined
    ? undefined
    : decodePendingMutation(value.pendingMutation, skills);
  const catalog: StoredSkillCatalog = { schemaVersion: 1, skills };
  if (pendingMutation !== undefined) catalog.pendingMutation = pendingMutation;
  return catalog;
}

function decodeInstalledSkill(value: unknown): InstalledSkill {
  if (!isRecordWithOnlyKeys(value, installedSkillKeys)) {
    throw new SkillStorageCorruptionError();
  }
  if (
    !isSafeSkillId(value.id) ||
    !isSafeDescription(value.description) ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    typeof value.byteLength !== "number" ||
    value.byteLength <= 0 ||
    value.byteLength > MAX_SKILL_FILE_BYTES ||
    !isIsoTimestamp(value.installedAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    value.updatedAt < value.installedAt
  ) {
    throw new SkillStorageCorruptionError();
  }
  return {
    id: value.id,
    description: value.description,
    sha256: value.sha256,
    byteLength: value.byteLength,
    installedAt: value.installedAt,
    updatedAt: value.updatedAt,
  };
}

function decodePendingMutation(
  value: unknown,
  skills: readonly InstalledSkill[],
): PendingSkillMutation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new SkillStorageCorruptionError();
  }
  if (value.kind === "delete") {
    if (
      !isRecordWithOnlyKeys(value, pendingDeleteKeys) ||
      !isSafeSkillId(value.skillId) ||
      !skills.some((entry) => entry.id === value.skillId)
    ) {
      throw new SkillStorageCorruptionError();
    }
    return { kind: "delete", skillId: value.skillId };
  }
  if (value.kind !== "install" && value.kind !== "replace") {
    throw new SkillStorageCorruptionError();
  }
  if (
    !isRecordWithOnlyKeys(value, pendingWriteKeys) ||
    !isSafeSkillId(value.skillId) ||
    !stagingFilePattern.test(String(value.stagingFile))
  ) {
    throw new SkillStorageCorruptionError();
  }
  const next = decodeInstalledSkill(value.next);
  const existing = skills.find((entry) => entry.id === value.skillId);
  if (
    next.id !== value.skillId ||
    (value.kind === "install" && existing !== undefined) ||
    (value.kind === "replace" && existing === undefined)
  ) {
    throw new SkillStorageCorruptionError();
  }
  const prospective = totalCatalogBytes(skills) - (existing?.byteLength ?? 0) +
    next.byteLength;
  if (
    prospective > MAX_INSTALLED_SKILL_BYTES ||
    (value.kind === "install" && skills.length >= MAX_INSTALLED_SKILLS)
  ) {
    throw new SkillStorageCorruptionError();
  }
  return {
    kind: value.kind,
    skillId: value.skillId,
    next,
    stagingFile: String(value.stagingFile),
  };
}

function isSafeDescription(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= MAX_SKILL_DESCRIPTION_LENGTH &&
    !/[\u0000-\u0008\u000a-\u001f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateInstallOptions(options: { replace?: boolean } | undefined): void {
  if (options === undefined) return;
  if (
    typeof options !== "object" ||
    options === null ||
    Object.keys(options).some((key) => key !== "replace") ||
    (options.replace !== undefined && typeof options.replace !== "boolean")
  ) {
    throw new TypeError("Skill install options are invalid.");
  }
}

function snapshotSkillBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Skill upload must contain bytes.");
  }
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    parseSkillMarkdown(bytes);
  }
  return Uint8Array.from(bytes);
}

function snapshotInstallOptions(
  options: { replace?: boolean } | undefined,
): { replace?: boolean } | undefined {
  validateInstallOptions(options);
  if (options === undefined) return undefined;
  return options.replace === undefined ? {} : { replace: options.replace };
}

function requireSafeSkillId(skillId: string): void {
  if (!isSafeSkillId(skillId)) throw new Error("Skill ID is invalid.");
}

function emptyCatalog(): StoredSkillCatalog {
  return { schemaVersion: 1, skills: [] };
}

function memoryCatalogState(): StoredSkillCatalog {
  return {
    schemaVersion: 1,
    skills: [...memorySkills.values()]
      .map((entry) => cloneInstalledSkill(entry.metadata))
      .sort((left, right) => compareSkillIds(left.id, right.id)),
  };
}

function cloneInstalledSkill(skill: InstalledSkill): InstalledSkill {
  return { ...skill };
}

function totalCatalogBytes(skills: readonly InstalledSkill[]): number {
  return skills.reduce((total, entry) => total + entry.byteLength, 0);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareSkillIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function catalogRoot(storageDirectory: string): string {
  return path.join(storageDirectory, catalogDirectoryName);
}

function catalogTarget(storageDirectory: string): string {
  return path.join(catalogRoot(storageDirectory), catalogFileName);
}

function definitionTarget(storageDirectory: string, skillId: string): string {
  return path.join(catalogRoot(storageDirectory), skillId, definitionFileName);
}

function requireNoFollowFlag(): number {
  if (platform === "win32") return 0;
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw new SkillStorageCorruptionError();
  }
  return fsConstants.O_NOFOLLOW;
}

function sameIdentity(
  left: Pick<Awaited<ReturnType<typeof fs.stat>>, "dev" | "ino">,
  right: Pick<Awaited<ReturnType<typeof fs.stat>>, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function cleanupUncommittedStaging(
  stagingTarget: string,
  skillDirectory: string,
  removeEmptyDirectory: boolean,
): Promise<void> {
  const root = path.dirname(skillDirectory);
  const rootIdentity = await captureDirectoryIdentity(root);
  const skillDirectoryIdentity = await captureDirectoryIdentity(skillDirectory);
  await removePrivateFileBound(
    stagingTarget,
    root,
    rootIdentity,
    skillDirectory,
    skillDirectoryIdentity,
  );
  if (!removeEmptyDirectory) return;
  const entries = await fs.readdir(skillDirectory);
  if (entries.length === 0) {
    await removeDirectoryBound(
      skillDirectory,
      root,
      rootIdentity,
      skillDirectoryIdentity,
    );
  }
}

async function injectFault(
  fault: FaultInjector | undefined,
  point: SkillStorageFaultPoint,
): Promise<void> {
  await fault?.(point);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithOnlyKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function asCorruption(error: unknown): SkillStorageCorruptionError {
  return error instanceof SkillStorageCorruptionError
    ? error
    : new SkillStorageCorruptionError(error);
}
