import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { freshEmptyAgentSettings } from "../../src/model/profile.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { clearStorageBackups, compactStorage, readStorageUsage, StorageCleanupChangedError } from "../../src/storage/management.js";
import { appendSessionEvent, loadSessionEvents } from "../../src/storage/events.js";
import { createSession } from "../../src/storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";
import { copyStoredReference, initializeSqliteStorage, readStoredBytes, removeStoredEntry, STORAGE_DATABASE_NAME, STORAGE_V1_BACKUP_NAME, withStorageDatabase, writeStoredBytes } from "../../src/storage/sqlite.js";

async function fixture(t: test.TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-storage-manager-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = JSON.stringify(freshEmptyAgentSettings());
  await fs.writeFile(path.join(directory, "live-smith-settings.json"), settings);
  await fs.writeFile(path.join(directory, "live-smith-models-fixture.json"), "[]");
  const media = path.join(directory, "live-smith-attachments", "old");
  await fs.mkdir(media, { recursive: true });
  await fs.writeFile(path.join(media, "original.bin"), "old media");
  await initializeSqliteStorage(directory);
  return { directory, settings };
}

async function usage(directory: string) {
  const result = await readStorageUsage(directory);
  assert.equal(result.available, true);
  if (!result.available) throw new Error("Persistent usage expected");
  return result;
}

test("storage usage counts shared physical media once and reports independent file categories", async t => {
  const { directory, settings } = await fixture(t);
  await writeStoredBytes(directory, "shared-one", Buffer.alloc(1024, 12), { storage: "file" });
  await copyStoredReference(directory, "shared-one", "shared-two");
  for (const [relative, content] of [["live-smith-exports/export-one/clip.wav", "export"],
    ["live-smith-plugins/data/plugin-one/current", "mutable"], ["live-smith-plugins/runtime-cache/plugin-one/main.js", "cache"], ["unmanaged.txt", "other"]]) {
    const file = path.join(directory, relative!); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content!);
  }
  const result = await usage(directory);
  assert.equal(result.mediaBytes, 1024 + Buffer.byteLength("old media"));
  assert.equal(result.backupBytes, Buffer.byteLength(settings) + 2 + Buffer.byteLength("old media"));
  assert.equal(result.backupFileCount, 3);
  assert.equal(result.exportBytes, 6); assert.equal(result.pluginBytes, 12); assert.equal(result.otherBytes, 5);
  assert.equal(result.totalBytes, result.databaseBytes + result.mediaBytes + result.backupBytes + result.exportBytes + result.pluginBytes + result.otherBytes);
  assert.equal(result.databaseBytes, (await fs.stat(path.join(directory, STORAGE_DATABASE_NAME))).size);
  assert.equal(result.sessionCount, 0);
});

test("clearing imported originals preserves current settings, events, media, exports and mutable Plugin data", async t => {
  const { directory } = await fixture(t);
  const session = await createSession(directory, { title: "Keep", projectKey: "project", scope: { kind: "track", identity: "track", label: "Track" } });
  await appendSessionEvent(directory, session.id, { kind: "user", content: "Keep this history" });
  await saveGlobalSettings(directory, { showContextUsage: false });
  const retained = ["live-smith-plugins/data/plugin/current.txt", "live-smith-plugins/runtime-cache/plugin/main.js", "live-smith-exports/export-one/take.wav", "unknown/notes.txt"];
  for (const relative of retained) { const file = path.join(directory, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "keep"); }
  await fs.copyFile(path.join(directory, STORAGE_DATABASE_NAME), path.join(directory, STORAGE_V1_BACKUP_NAME));
  await fs.chmod(path.join(directory, STORAGE_V1_BACKUP_NAME), 0o400);
  const before = await usage(directory);
  await clearStorageBackups(directory, before.backupRevision);
  const after = await usage(directory);
  assert.equal(after.backupFileCount, 0); assert.equal(after.backupBytes, 0); assert.equal(after.sessionCount, 1);
  assert.equal((await loadAgentSettings(directory)).showContextUsage, false);
  assert.equal((await loadSessionEvents(directory, session.id))[0]?.content, "Keep this history");
  assert.equal((await readStoredBytes(directory, "live-smith-attachments/old/original.bin")).toString(), "old media");
  for (const relative of retained) assert.equal(await fs.readFile(path.join(directory, relative), "utf8"), "keep");
  assert.ok((await fs.stat(path.join(directory, STORAGE_V1_BACKUP_NAME))).isFile(), "an untracked database copy is preserved");
  assert.equal(after.mediaBytes, before.mediaBytes); assert.equal(after.pluginBytes, before.pluginBytes); assert.equal(after.exportBytes, before.exportBytes);
  await clearStorageBackups(directory, after.backupRevision);
});

test("changed backup inventory rejects stale confirmation before deleting any files", async t => {
  const { directory, settings } = await fixture(t);
  const before = await usage(directory);
  await fs.writeFile(path.join(directory, "live-smith-models-fixture.json"), "[1]");
  await assert.rejects(clearStorageBackups(directory, before.backupRevision), StorageCleanupChangedError);
  assert.equal(await fs.readFile(path.join(directory, "live-smith-settings.json"), "utf8"), settings);
  assert.equal(await fs.readFile(path.join(directory, "live-smith-models-fixture.json"), "utf8"), "[1]");
});

test("partial cleanup reports failure and a refreshed inventory can finish without affecting active data", async t => {
  const { directory } = await fixture(t);
  const before = await usage(directory);
  const original = fs.rm;
  fs.rm = async (file, options) => {
    if (file === path.join(directory, "live-smith-settings.json")) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return original(file, options);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(clearStorageBackups(directory, before.backupRevision), /could not be completed/); }
  finally { fs.rm = original; syncBuiltinESMExports(); }
  const after = await usage(directory);
  assert.ok(after.backupFileCount > 0 && after.backupFileCount < before.backupFileCount);
  assert.equal((await readStoredBytes(directory, "live-smith-attachments/old/original.bin")).toString(), "old media");
  await clearStorageBackups(directory, after.backupRevision);
  assert.equal((await usage(directory)).backupFileCount, 0);
});

test("backup cleanup rejects a redirected legacy directory and preserves the external target", { skip: os.platform() === "win32" }, async t => {
  const { directory } = await fixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-storage-external-"));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, "keep.json"), "external");
  const before = await usage(directory);
  await fs.symlink(external, path.join(directory, "live-smith-events"));
  await assert.rejects(clearStorageBackups(directory, before.backupRevision));
  assert.equal(await fs.readFile(path.join(external, "keep.json"), "utf8"), "external");
  assert.equal((await fs.lstat(path.join(directory, "live-smith-settings.json"))).isFile(), true);
});

test("database compaction returns free pages while preserving records and external media", async t => {
  const { directory } = await fixture(t);
  await writeStoredBytes(directory, "discardable", Buffer.alloc(2 * 1024 * 1024));
  await removeStoredEntry(directory, "discardable");
  const before = await usage(directory);
  assert.ok(before.databaseFreeBytes > 1024 * 1024);
  await compactStorage(directory);
  const after = await usage(directory);
  assert.equal(after.databaseFreeBytes, 0); assert.ok(after.databaseBytes < before.databaseBytes);
  assert.equal((await readStoredBytes(directory, "live-smith-attachments/old/original.bin")).toString(), "old media");
  assert.equal(await withStorageDatabase(directory, db => db.prepare("PRAGMA integrity_check").get()?.integrity_check), "ok");
});

test("memory-only mode and pre-cancelled maintenance perform no persistent deletion", async t => {
  assert.deepEqual(await readStorageUsage(undefined), { available: false });
  const { directory } = await fixture(t); const before = await usage(directory);
  const controller = createHostAbortController(); controller.abort(new Error("Stopped"));
  await assert.rejects(clearStorageBackups(directory, before.backupRevision, controller.signal), /Stopped/);
  await assert.rejects(compactStorage(directory, controller.signal), /Stopped/);
  assert.equal((await usage(directory)).backupFileCount, before.backupFileCount);
});

test("legacy-shaped files created after migration are preserved as other files", async t => {
  const { directory } = await fixture(t);
  const restored = path.join(directory, "live-smith-events", "restored.json");
  await fs.mkdir(path.dirname(restored), { recursive: true }); await fs.writeFile(restored, "Unique restored history");
  await fs.appendFile(path.join(directory, "live-smith-settings.json"), "\n");
  const before = await usage(directory);
  assert.equal(before.backupFileCount, 2);
  assert.ok(before.otherBytes >= Buffer.byteLength("Unique restored history"));
  await clearStorageBackups(directory, before.backupRevision);
  assert.equal(await fs.readFile(restored, "utf8"), "Unique restored history");
  assert.ok((await fs.readFile(path.join(directory, "live-smith-settings.json"), "utf8")).endsWith("\n"));
});

test("older SQLite databases backfill cleanup proof only for content represented in current records", async t => {
  const { directory } = await fixture(t);
  await withStorageDatabase(directory, db => db.exec("DROP TABLE legacy_sources"));
  await fs.appendFile(path.join(directory, "live-smith-settings.json"), "\n");
  const restored = path.join(directory, "live-smith-models-restored.json"); await fs.writeFile(restored, "new data");
  const before = await usage(directory); assert.equal(before.backupFileCount, 2);
  await clearStorageBackups(directory, before.backupRevision);
  assert.equal(await fs.readFile(restored, "utf8"), "new data");
  assert.ok((await fs.readFile(path.join(directory, "live-smith-settings.json"), "utf8")).endsWith("\n"));
  assert.equal((await loadAgentSettings(directory)).showContextUsage, true);
});

test("SQLite v1 upgrade records its own backup before later settings changes", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-v1-manager-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify(freshEmptyAgentSettings()));
  await fs.writeFile(path.join(directory, "live-smith-settings.json"), bytes);
  const db = new DatabaseSync(path.join(directory, STORAGE_DATABASE_NAME));
  try {
    db.exec(`CREATE TABLE storage_state(id INTEGER PRIMARY KEY,migrated INTEGER,revision INTEGER,imported_files INTEGER,imported_bytes INTEGER,preserved_plugin_files INTEGER);
      INSERT INTO storage_state VALUES(1,1,1,1,${bytes.length},0);
      CREATE TABLE entries(path TEXT PRIMARY KEY,byte_length INTEGER,sha256 TEXT,revision INTEGER,preserved INTEGER);
      CREATE TABLE chunks(path TEXT REFERENCES entries(path) ON DELETE CASCADE,chunk_index INTEGER,bytes BLOB,PRIMARY KEY(path,chunk_index));
      PRAGMA application_id=1280527700;PRAGMA user_version=1;`);
    db.prepare("INSERT INTO entries VALUES(?,?,?,?,?)").run("live-smith-settings.json", bytes.length, createHash("sha256").update(bytes).digest("hex"), 1, 0);
    db.prepare("INSERT INTO chunks VALUES(?,?,?)").run("live-smith-settings.json", 0, bytes);
  } finally { db.close(); }
  await initializeSqliteStorage(directory);
  await saveGlobalSettings(directory, { showContextUsage: false });
  const before = await usage(directory); assert.equal(before.backupFileCount, 2);
  await clearStorageBackups(directory, before.backupRevision);
  assert.equal((await usage(directory)).backupFileCount, 0);
  await assert.rejects(fs.stat(path.join(directory, STORAGE_V1_BACKUP_NAME)), { code: "ENOENT" });
  assert.equal((await loadAgentSettings(directory)).showContextUsage, false);
});
