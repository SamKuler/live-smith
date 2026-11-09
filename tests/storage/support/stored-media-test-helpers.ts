import { Buffer } from "node:buffer";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storedEntry, writeStoredBytes, STORAGE_DATABASE_NAME } from "../../../src/storage/sqlite.js";

export async function writeStoredTestFile(storage: string, key: string, bytes: string | Uint8Array, options?: { flag?: string; mode?: number }): Promise<void> {
  await writeStoredBytes(storage, key, typeof bytes === "string" ? Buffer.from(bytes) : bytes, options?.flag === "wx" ? { createOnly: true } : undefined);
}

/** Metadata-only fixture for quota and size-rejection tests; its blob is intentionally incomplete. */
export async function setStoredTestLength(storage: string, key: string, byteLength: number): Promise<void> {
  if (!await storedEntry(storage, key)) await writeStoredBytes(storage, key, new Uint8Array());
  const db = new DatabaseSync(path.join(storage, STORAGE_DATABASE_NAME));
  try {
    db.prepare("UPDATE entries SET byte_length=? WHERE path=?").run(byteLength, path.relative(storage, key).split(path.sep).join("/"));
  } finally { db.close(); }
}

/** Seed empty historical remnants together so directory-limit tests avoid thousands of durability commits. */
export function seedEmptyStoredTestEntries(storage: string, keys: string[]): void {
  const db = new DatabaseSync(path.join(storage, STORAGE_DATABASE_NAME));
  try {
    db.exec("BEGIN IMMEDIATE");
    const revision = db.prepare("UPDATE storage_state SET revision=revision+1 WHERE id=1 RETURNING revision");
    const insert = db.prepare("INSERT INTO entries(path,byte_length,sha256,revision,preserved) VALUES(?,0,?,?,0)");
    for (const key of keys) insert.run(path.relative(storage, key).split(path.sep).join("/"),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", revision.get()!.revision!);
    db.exec("COMMIT");
  } finally { db.close(); }
}
