import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";

import { createStorageId } from "./id.js";
import { isMissingFileError } from "./errors.js";

const memoryStorageKey = Symbol("memory-storage");
const transactionTails = new Map<string | symbol, Promise<void>>();
const supportsPosixPermissions = platform !== "win32";
declare const storageTransactionContextBrand: unique symbol;

export interface StorageTransactionContext {
  readonly [storageTransactionContextBrand]: true;
}

interface ActiveStorageTransaction {
  active: boolean;
  acceptingOperations: boolean;
  key: string | symbol;
  operations: Promise<unknown>[];
}

const activeStorageTransactions = new WeakMap<
  StorageTransactionContext,
  ActiveStorageTransaction
>();

export class StorageCommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      "Storage mutation completed, but its durable commit could not be confirmed.",
      { cause },
    );
    this.name = "StorageCommitOutcomeUnknownError";
  }
}

export function isStorageCommitOutcomeUnknownError(
  error: unknown,
): error is StorageCommitOutcomeUnknownError {
  return error instanceof StorageCommitOutcomeUnknownError;
}

export async function withStorageTransaction<T>(
  storageDirectory: string | undefined,
  operation: (context: StorageTransactionContext) => Promise<T>,
): Promise<T> {
  const key = storageTransactionKey(storageDirectory);
  const previous = transactionTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  transactionTails.set(key, current);

  await previous;
  const context = Object.freeze({}) as StorageTransactionContext;
  const activeTransaction: ActiveStorageTransaction = {
    active: true,
    acceptingOperations: true,
    key,
    operations: [],
  };
  activeStorageTransactions.set(context, activeTransaction);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    try {
      result = await operation(context);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    activeTransaction.acceptingOperations = false;
    await Promise.allSettled(activeTransaction.operations);
    if (operationFailed) throw operationError;
    return result as T;
  } finally {
    activeTransaction.acceptingOperations = false;
    activeTransaction.active = false;
    activeStorageTransactions.delete(context);
    release();
    if (transactionTails.get(key) === current) {
      transactionTails.delete(key);
    }
  }
}

export function requireActiveStorageTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
): void {
  const transaction = activeStorageTransactions.get(context);
  if (
    transaction === undefined ||
    !transaction.active ||
    !transaction.acceptingOperations ||
    transaction.key !== storageTransactionKey(storageDirectory)
  ) {
    throw new Error("Storage transaction context is invalid or no longer active.");
  }
}

export function trackStorageTransactionOperation<T>(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  operation: Promise<T>,
): Promise<T> {
  requireActiveStorageTransaction(context, storageDirectory);
  const transaction = activeStorageTransactions.get(context)!;
  transaction.operations.push(operation);
  void operation.catch(() => undefined);
  return operation;
}

function storageTransactionKey(
  storageDirectory: string | undefined,
): string | symbol {
  return storageDirectory === undefined
    ? memoryStorageKey
    : path.resolve(storageDirectory);
}

export async function writeJsonAtomically(
  target: string,
  value: unknown,
  options: {
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Storage value is not JSON serializable.");
  }

  return writeAtomically(
    target,
    (handle) => handle.writeFile(serialized, "utf8"),
    options,
    "replace",
  );
}

export async function writeBytesAtomically(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  return writeAtomically(
    target,
    (handle) => handle.writeFile(bytes),
    {},
    "replace",
  );
}

export async function writeJsonAtomicallyCreateOnly(
  target: string,
  value: unknown,
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Storage value is not JSON serializable.");
  }
  return writeAtomically(
    target,
    (handle) => handle.writeFile(serialized, "utf8"),
    {},
    "create",
  );
}

export async function writeBytesAtomicallyCreateOnly(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  return writeAtomically(
    target,
    (handle) => handle.writeFile(bytes),
    {},
    "create",
  );
}

async function writeAtomically(
  target: string,
  write: (handle: fs.FileHandle) => Promise<void>,
  options: {
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
  mode: "replace" | "create",
): Promise<void> {

  const directory = path.dirname(target);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${createStorageId("tmp")}`,
  );
  let temporaryCreated = false;

  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await write(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode === "create") {
      await fs.link(temporary, target);
      try {
        await fs.unlink(temporary);
      } catch (cause) {
        throw new StorageCommitOutcomeUnknownError(cause);
      }
      temporaryCreated = false;
    } else {
      await fs.rename(temporary, target);
      temporaryCreated = false;
    }
    try {
      await (options.syncDirectory ?? syncDirectory)(directory);
    } catch (cause) {
      throw new StorageCommitOutcomeUnknownError(cause);
    }
  } finally {
    if (temporaryCreated) {
      try {
        await fs.unlink(temporary);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (supportsPosixPermissions) {
    await fs.chmod(directory, 0o700);
  }
}

export async function ensurePrivateDirectoryDurably(
  directory: string,
  options: {
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
): Promise<void> {
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  if (supportsPosixPermissions) await fs.chmod(directory, 0o700);
  if (!created) return;
  try {
    await (options.syncDirectory ?? syncDirectory)(path.dirname(directory));
  } catch (cause) {
    throw new StorageCommitOutcomeUnknownError(cause);
  }
}

export async function ensurePrivateFile(target: string): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  if (supportsPosixPermissions) {
    await fs.chmod(target, 0o600);
  }
}

export async function removeFileDurably(
  target: string,
  options: {
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
): Promise<void> {
  const directory = path.dirname(target);
  let targetWasMissing = false;
  try {
    await fs.unlink(target);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    targetWasMissing = true;
  }

  try {
    await (options.syncDirectory ?? syncDirectory)(directory);
  } catch (cause) {
    if (targetWasMissing && isMissingFileError(cause)) return;
    throw new StorageCommitOutcomeUnknownError(cause);
  }
}

export async function removeDirectoryDurably(
  target: string,
  options: {
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
): Promise<void> {
  const parent = path.dirname(target);
  let targetWasMissing = false;
  try {
    await fs.rm(target, { recursive: true, force: false });
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    targetWasMissing = true;
  }

  try {
    await (options.syncDirectory ?? syncDirectory)(parent);
  } catch (cause) {
    if (targetWasMissing && isMissingFileError(cause)) return;
    throw new StorageCommitOutcomeUnknownError(cause);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (!supportsPosixPermissions) return;

  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) return;
    throw error;
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "EBADF" || code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}
