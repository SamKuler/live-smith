import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";
import { TextDecoder } from "node:util";
import type { SunoSessionIdentity } from "../audio-services/suno/suno-session-contracts.js";
import { normalizeSunoSessionIdentity, normalizeSunoSessionValue } from "../audio-services/suno/suno-session.js";
import { isMissingFileError } from "./errors.js";
import { requireSafeStorageId } from "./id.js";
import { isStorageCommitOutcomeUnknownError, StorageCommitOutcomeUnknownError,
  removeFileDurably, requireActiveStorageTransaction, trackStorageTransactionOperation,
  withStorageTransaction, writeJsonAtomically, type StorageTransactionContext } from "./persistence.js";

const MAX_RECORD_BYTES = 32 * 1024;
export interface StoredSunoSession extends SunoSessionIdentity { clientToken: string }
interface DirectoryIdentity { ino: number; dev: number }
interface RootBinding { directory: string; identity?: DirectoryIdentity }

export class SunoSessionStorageError extends Error {
  constructor() {
    super("Private Suno session storage is unavailable or invalid.");
    this.name = "SunoSessionStorageError";
  }
}

/** Root-level per-service files; no ownership of browser data or directories. */
export class SunoSessions {
  constructor(private readonly storageDirectory: string | undefined) {}

  load(serviceId: string, transaction?: StorageTransactionContext): Promise<StoredSunoSession | undefined> {
    return this.run(serviceId, transaction, (root, target) => this.read(root, target, serviceId));
  }

  save(serviceId: string, value: StoredSunoSession, transaction?: StorageTransactionContext): Promise<void> {
    return this.run(serviceId, transaction, async (root, target) => {
      const record = decode({ schemaVersion: 1, serviceId, ...value }, serviceId);
      await this.read(root, target, serviceId); // A malformed existing file is never silently replaced.
      await checkedRoot(root, true);
      await writeJsonAtomically(target, { schemaVersion: 1, serviceId, ...record });
      await confirmCommittedRoot(root);
    });
  }

  clear(serviceId: string, transaction?: StorageTransactionContext): Promise<boolean> {
    return this.run(serviceId, transaction, async (root, target) => {
      if (!await checkedRoot(root)) return false;
      const before = await fileMetadata(target);
      await checkedRoot(root);
      const current = await fileMetadata(target);
      if (before ? !current || !sameSingleLinkFile(before, current) : current !== undefined) throw new SunoSessionStorageError();
      // A retry after an uncertain unlink must still sync the directory.
      await removeFileDurably(target);
      await confirmCommittedRoot(root);
      return before !== undefined;
    });
  }

  private async run<T>(serviceId: string, transaction: StorageTransactionContext | undefined,
    operation: (root: RootBinding, target: string) => Promise<T>): Promise<T> {
    try {
      if (!this.storageDirectory) throw new SunoSessionStorageError();
      requireSafeStorageId(serviceId, "Suno connection ID");
      const root = { directory: path.resolve(this.storageDirectory) };
      const perform = () => operation(root, path.join(root.directory, `suno-session-${serviceId}.json`));
      if (transaction) {
        requireActiveStorageTransaction(transaction, this.storageDirectory);
        return await trackStorageTransactionOperation(transaction, this.storageDirectory, perform());
      }
      return await withStorageTransaction(this.storageDirectory, perform);
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) throw new StorageCommitOutcomeUnknownError(new SunoSessionStorageError());
      throw new SunoSessionStorageError();
    }
  }

  private async read(root: RootBinding, target: string, serviceId: string): Promise<StoredSunoSession | undefined> {
    if (!await checkedRoot(root)) return undefined;
    const before = await fileMetadata(target);
    if (!before) return undefined;
    if (before.size > MAX_RECORD_BYTES) throw new SunoSessionStorageError();
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!sameSingleLinkFile(before, opened) || !opened.isFile() || opened.size > MAX_RECORD_BYTES) throw new SunoSessionStorageError();
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_RECORD_BYTES || total !== opened.size) throw new SunoSessionStorageError();
      const record = decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))), serviceId);
      let secured = await handle.stat();
      if (!sameSingleLinkFile(opened, secured) || !sameSingleLinkFile(opened, await fs.lstat(target))) throw new SunoSessionStorageError();
      await checkedRoot(root);
      if (platform !== "win32") {
        if (!hasPrivateFileMode(secured)) await handle.chmod(0o600);
        secured = await handle.stat();
        const current = await fs.lstat(target);
        if (!sameSingleLinkFile(opened, secured) || !sameSingleLinkFile(opened, current) ||
          !hasPrivateFileMode(secured) || !hasPrivateFileMode(current)) throw new SunoSessionStorageError();
      }
      return record;
    } finally { await handle.close(); }
  }
}

async function checkedRoot(binding: RootBinding, create = false): Promise<boolean> {
  const root = binding.directory;
  let metadata;
  try { metadata = await fs.lstat(root); }
  catch (error) {
    if (!isMissingFileError(error)) throw error;
    if (binding.identity) throw new SunoSessionStorageError();
    if (!create) return false;
    if (await fs.realpath(path.dirname(root)) !== path.dirname(root)) throw new SunoSessionStorageError();
    await fs.mkdir(root, { mode: 0o700 });
    metadata = await fs.lstat(root);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(root) !== root ||
    binding.identity && !sameDirectory(binding.identity, metadata)) throw new SunoSessionStorageError();
  binding.identity ??= { ino: metadata.ino, dev: metadata.dev };
  if (platform !== "win32") {
    const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!sameDirectory(binding.identity, opened)) throw new SunoSessionStorageError();
      if (!hasPrivateDirectoryMode(opened)) await handle.chmod(0o700);
      const secured = await handle.stat();
      if (!sameDirectory(opened, secured) || !hasPrivateDirectoryMode(secured)) throw new SunoSessionStorageError();
    } finally { await handle.close(); }
  }
  const current = await fs.lstat(root);
  if (!sameDirectory(binding.identity, current) || platform !== "win32" && !hasPrivateDirectoryMode(current)) {
    throw new SunoSessionStorageError();
  }
  return true;
}

async function confirmCommittedRoot(root: RootBinding): Promise<void> {
  try { await checkedRoot(root); }
  catch { throw new StorageCommitOutcomeUnknownError(new SunoSessionStorageError()); }
}

async function fileMetadata(target: string) {
  let metadata;
  try { metadata = await fs.lstat(target); }
  catch (error) { if (isMissingFileError(error)) return undefined; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new SunoSessionStorageError();
  return metadata;
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}

function sameSingleLinkFile(left: { ino: number; dev: number; size: number; mtimeMs: number; nlink: number },
  right: { ino: number; dev: number; size: number; mtimeMs: number; nlink: number }): boolean {
  return left.nlink === 1 && right.nlink === 1 && left.ino === right.ino && left.dev === right.dev &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function hasPrivateDirectoryMode(metadata: { mode: number }): boolean {
  return (metadata.mode & 0o777) === 0o700;
}

function hasPrivateFileMode(metadata: { mode: number }): boolean {
  return (metadata.mode & 0o777) === 0o600;
}

function decode(value: unknown, serviceId: string): StoredSunoSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SunoSessionStorageError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "serviceId", "clientToken", "accountId", "accountName"].includes(key)) ||
    record.schemaVersion !== 1 || record.serviceId !== serviceId) throw new SunoSessionStorageError();
  const clientToken = normalizeSunoSessionValue(record.clientToken);
  const identity = normalizeSunoSessionIdentity(record, clientToken);
  const legacyRawClient = typeof record.clientToken === "string" && !record.clientToken.includes("=") &&
    clientToken === `__client=${record.clientToken}`;
  if ((record.clientToken !== clientToken && !legacyRawClient) || record.accountName !== identity.accountName) {
    throw new SunoSessionStorageError();
  }
  return { clientToken, ...identity };
}
