import { storageScopeKey } from "./scope.js";

const transactionTails = new Map<string | symbol, Promise<void>>();
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
  return storageScopeKey(storageDirectory);
}
