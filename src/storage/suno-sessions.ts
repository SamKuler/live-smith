import { createHash } from "node:crypto";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type { SunoSessionIdentity } from "../audio-services/suno/suno-session-contracts.js";
import { normalizeSunoSessionIdentity, normalizeSunoSessionValue } from "../audio-services/suno/suno-session.js";
import { isMissingFileError } from "./errors.js";
import { requireSafeStorageId } from "./id.js";
import { isStorageCommitOutcomeUnknownError, StorageCommitOutcomeUnknownError,
  requireActiveStorageTransaction, trackStorageTransactionOperation,
  withStorageTransaction, type StorageTransactionContext } from "./persistence.js";
import { openStoredReader, removeStoredEntry, writeStoredJson } from "./sqlite.js";

const MAX_RECORD_BYTES = 32 * 1024;
export interface StoredSunoSession extends SunoSessionIdentity { clientToken: string }

export class SunoSessionStorageError extends Error {
  constructor() {
    super("Private Suno session storage is unavailable or invalid.");
    this.name = "SunoSessionStorageError";
  }
}

/** Per-connection records; no ownership of browser data or directories. */
export class SunoSessions {
  constructor(private readonly storageDirectory: string | undefined) {}

  load(serviceId: string, transaction?: StorageTransactionContext): Promise<StoredSunoSession | undefined> {
    return this.run(serviceId, transaction, (directory, target) => this.read(directory, target, serviceId));
  }

  save(serviceId: string, value: StoredSunoSession, transaction?: StorageTransactionContext): Promise<void> {
    return this.run(serviceId, transaction, async (directory, target) => {
      const record = decode({ schemaVersion: 1, serviceId, ...value }, serviceId);
      await this.read(directory, target, serviceId);
      await writeStoredJson(directory, target, { schemaVersion: 1, serviceId, ...record });
    });
  }

  clear(serviceId: string, transaction?: StorageTransactionContext): Promise<boolean> {
    return this.run(serviceId, transaction, (directory, target) => removeStoredEntry(directory, target));
  }

  private async run<T>(serviceId: string, transaction: StorageTransactionContext | undefined,
    operation: (directory: string, target: string) => Promise<T>): Promise<T> {
    try {
      if (!this.storageDirectory) throw new SunoSessionStorageError();
      requireSafeStorageId(serviceId, "Suno connection ID");
      const directory = this.storageDirectory;
      const perform = () => operation(directory, path.resolve(directory, `suno-session-${serviceId}.json`));
      if (transaction) {
        requireActiveStorageTransaction(transaction, directory);
        return await trackStorageTransactionOperation(transaction, directory, perform());
      }
      return await withStorageTransaction(directory, perform);
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) throw new StorageCommitOutcomeUnknownError(new SunoSessionStorageError());
      throw new SunoSessionStorageError();
    }
  }

  private async read(directory: string, target: string, serviceId: string): Promise<StoredSunoSession | undefined> {
    let reader;
    try { reader = await openStoredReader(directory, target); }
    catch (error) { if (isMissingFileError(error)) return undefined; throw error; }
    try {
      if (reader.entry.byteLength > MAX_RECORD_BYTES) throw new SunoSessionStorageError();
      const bytes = reader.readChunk(0);
      if (createHash("sha256").update(bytes).digest("hex") !== reader.entry.sha256) throw new SunoSessionStorageError();
      return decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), serviceId);
    } finally { reader.close(); }
  }
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
