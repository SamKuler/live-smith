import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { withStorageTransaction } from "./persistence.js";
import { listSessionsInTransaction } from "./sessions.js";
import { initializeSqliteStorage, listLegacyBackupFiles, STORAGE_DATABASE_NAME, withStorageDatabase } from "./sqlite.js";

export type StorageUsage = { available: false } | {
  available: true;
  totalBytes: number;
  databaseBytes: number;
  databaseFreeBytes: number;
  mediaBytes: number;
  backupBytes: number;
  backupFileCount: number;
  backupRevision: string;
  exportBytes: number;
  pluginBytes: number;
  otherBytes: number;
  sessionCount: number;
};

export class StorageCleanupChangedError extends Error {
  constructor() { super("Stored backup files changed. Refresh storage usage and try again."); this.name = "StorageCleanupChangedError"; }
}

type BackupFile = Awaited<ReturnType<typeof listLegacyBackupFiles>>[number];
type FileSizeCategory = "databaseBytes" | "mediaBytes" | "backupBytes" | "exportBytes" | "pluginBytes" | "otherBytes";

function backupRevision(files: readonly BackupFile[]): string {
  const digest = createHash("sha256");
  for (const { key, stat } of files) digest.update(JSON.stringify([key, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  return digest.digest("hex");
}

function category(key: string, backups: ReadonlySet<string>): FileSizeCategory {
  if (backups.has(key)) return "backupBytes";
  if ([STORAGE_DATABASE_NAME, `${STORAGE_DATABASE_NAME}-journal`, `${STORAGE_DATABASE_NAME}-wal`, `${STORAGE_DATABASE_NAME}-shm`].includes(key)) return "databaseBytes";
  if (key.startsWith("live-smith-media/")) return "mediaBytes";
  if (key.startsWith("live-smith-exports/")) return "exportBytes";
  if (key.startsWith("live-smith-plugins/")) return "pluginBytes";
  return "otherBytes";
}

async function fileSizes(root: string, backups: ReadonlySet<string>, signal?: AbortSignal): Promise<Record<FileSizeCategory, number>> {
  const sizes = { databaseBytes: 0, mediaBytes: 0, backupBytes: 0, exportBytes: 0, pluginBytes: 0, otherBytes: 0 };
  const seen = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      throwIfAborted(signal);
      const target = path.join(directory, entry.name), key = prefix ? `${prefix}/${entry.name}` : entry.name;
      let stat;
      try { stat = await fs.lstat(target, { bigint: true }); } catch (error) { if (isMissingFileError(error)) continue; throw error; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        try { await visit(target, key); } catch (error) { if (!isMissingFileError(error)) throw error; }
      } else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        sizes[category(key, backups)] += Number(stat.size);
      }
    }
  };
  await visit(root, "");
  return sizes;
}

export async function readStorageUsage(directory: string | undefined, signal?: AbortSignal): Promise<StorageUsage> {
  throwIfAborted(signal);
  if (!directory) return { available: false };
  return withStorageTransaction(directory, async transaction => {
    try {
      await initializeSqliteStorage(directory);
      const root = await fs.realpath(directory), backups = await listLegacyBackupFiles(root);
      const sizes = await fileSizes(root, new Set(backups.map(file => file.key)), signal);
      const databaseFreeBytes = await withStorageDatabase(root, db => Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0) * Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 0));
      const sessions = await listSessionsInTransaction(transaction, directory);
      throwIfAborted(signal);
      return { available: true, ...sizes, totalBytes: Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0),
        databaseFreeBytes, backupFileCount: backups.length, backupRevision: backupRevision(backups), sessionCount: sessions.length };
    } catch {
      throwIfAborted(signal);
      throw new Error("Storage usage could not be read. Try again.");
    }
  });
}

async function removeEmptyParents(root: string, file: string): Promise<void> {
  for (let directory = path.dirname(file); directory !== root; directory = path.dirname(directory)) {
    try { await fs.rmdir(directory); }
    catch { break; }
  }
}

export async function clearStorageBackups(directory: string, revision: string, signal?: AbortSignal): Promise<void> {
  await withStorageTransaction(directory, async () => {
    throwIfAborted(signal);
    try {
      const root = await fs.realpath(directory), files = await listLegacyBackupFiles(root);
      if (backupRevision(files) !== revision) throw new StorageCleanupChangedError();
      await withStorageDatabase(root, db => {
        if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Saved data is unavailable.");
      });
      for (const file of files) {
        throwIfAborted(signal);
        if (path.relative(file.file, await fs.realpath(file.file)) !== "") throw new StorageCleanupChangedError();
        const current = await fs.lstat(file.file);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || backupRevision([{ ...file, stat: current }]) !== backupRevision([file])) throw new StorageCleanupChangedError();
        await fs.rm(file.file);
        await removeEmptyParents(root, file.file);
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof StorageCleanupChangedError) throw error;
      throw new Error("Old backup cleanup could not be completed. Refresh storage usage and try again.");
    }
  });
}

export async function compactStorage(directory: string, signal?: AbortSignal): Promise<void> {
  await withStorageTransaction(directory, async () => {
    throwIfAborted(signal);
    try { await withStorageDatabase(directory, db => { throwIfAborted(signal); db.exec("VACUUM"); }); }
    catch { throwIfAborted(signal); throw new Error("Database space could not be reclaimed. Try again."); }
  });
}
