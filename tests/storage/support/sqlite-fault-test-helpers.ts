import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MEDIA_DIRECTORY_NAME } from "../../../src/storage/media-files.js";
import { DatabaseSync, StatementSync } from "node:sqlite";
import type { TestContext } from "node:test";

export interface StoredWrite { key: string; bytes: Buffer }

/** Intercept inline chunk writes, file-reference registration and completed SQLite commits without changing production storage APIs. */
export function interceptStoredWrites(t: TestContext, hooks: {
  beforeWrite?(write: StoredWrite): void;
  beforeDelete?(key: string): void;
  afterCommit?(writes: readonly StoredWrite[], database: DatabaseSync): void;
}): () => void {
  const owners = new WeakMap<StatementSync, DatabaseSync>();
  const pending = new WeakMap<DatabaseSync, StoredWrite[]>();
  const prepare = DatabaseSync.prototype.prepare;
  const run = StatementSync.prototype.run;
  const exec = DatabaseSync.prototype.exec;
  const prepared = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql); owners.set(statement, this); return statement;
  });
  const written = t.mock.method(StatementSync.prototype, "run", function(this: StatementSync, ...args: unknown[]) {
    if (/^DELETE FROM entries\b/u.test(this.sourceSQL)) hooks.beforeDelete?.(String(args[0]));
    const database = owners.get(this)!;
    let write: StoredWrite | undefined;
    if (/^INSERT INTO chunks\b/u.test(this.sourceSQL)) {
      write = { key: String(args[0]), bytes: Buffer.from(args[2] as Uint8Array) };
    } else if (/^INSERT INTO entries\(/u.test(this.sourceSQL) && this.sourceSQL.includes("media_object")) {
      const file = String(database.prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file);
      const object = path.join(path.dirname(file), MEDIA_DIRECTORY_NAME, String(args[4]));
      write = { key: String(args[0]), get bytes() { return readFileSync(object); } };
    }
    if (write) {
      hooks.beforeWrite?.(write);
      const writes = pending.get(database) ?? [];
      writes.push(write); pending.set(database, writes);
    }
    return Reflect.apply(run, this, args);
  });
  const committed = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (/^BEGIN\b/u.test(sql)) pending.set(this, []);
    if (sql === "COMMIT") {
      const writes = pending.get(this) ?? []; pending.delete(this);
      hooks.afterCommit?.(writes, this);
    }
    if (sql === "ROLLBACK") pending.delete(this);
    return result;
  });
  return () => { committed.mock.restore(); written.mock.restore(); prepared.mock.restore(); };
}
