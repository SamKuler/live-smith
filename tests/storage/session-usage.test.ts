import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSessionLifecycle } from "../../src/app/session/session-lifecycle.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { appendSessionEvent } from "../../src/storage/events.js";
import { withStorageTransaction } from "../../src/storage/persistence.js";
import { readSessionStorageUsage } from "../../src/storage/session-usage.js";
import { createSession, type AgentSession } from "../../src/storage/sessions.js";
import { copyStoredReference, storedEntry, withStorageDatabase, writeStoredBytes } from "../../src/storage/sqlite.js";

async function fixture(t: test.TestContext): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-session-usage-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function session(directory: string, title = "Session", transient = false) {
  return createSession(directory, { title, projectKey: "project", scope: { kind: "track", identity: "track", label: "音轨" } }, { transient });
}

async function usage(directory: string) {
  const result = await readSessionStorageUsage(directory);
  assert.equal(result.available, true);
  if (!result.available) throw new Error("Persistent usage expected");
  return result;
}

function metadataBytes(value: AgentSession): number { return Buffer.byteLength(JSON.stringify(value)); }

function lifecycle(directory: string) {
  return createSessionLifecycle({ storageDirectory: directory,
    withSessionMutation: async (_id, _signal, operation) => operation(), notifySessionStateChanged() {} });
}

function reclaimable(result: Awaited<ReturnType<typeof usage>>, selected: string[]): number {
  return result.media.filter(group => !group.retained && group.sessionIds.every(id => selected.includes(id)))
    .reduce((sum, group) => sum + group.bytes, 0);
}

test("shared media is unique within each session and estimates match lifecycle file deletion", async t => {
  const directory = await fixture(t), first = await session(directory, "一号 🎵"), second = await session(directory, "二号");
  const original = `live-smith-attachments/${first.id}/source.bin`;
  await writeStoredBytes(directory, original, Buffer.alloc(64, 11), { storage: "file" });
  const roots = ["live-smith-attachments", "live-smith-audio", "live-smith-audio-artifacts", "live-smith-midi", "live-smith-device-parameters"];
  const inline = Buffer.from('{"label":"音乐 🎶"}');
  for (const root of roots) {
    await copyStoredReference(directory, original, `${root}/${first.id}/shared.bin`);
    await writeStoredBytes(directory, `${root}/${first.id}/private.json`, inline);
  }
  await copyStoredReference(directory, original, `live-smith-midi/${second.id}/shared.mid`);
  await writeStoredBytes(directory, `live-smith-midi/${first.id}/own.mid`, Buffer.alloc(32, 12), { storage: "file" });
  const event = await appendSessionEvent(directory, first.id, { kind: "user", content: "你好 🎵" });
  const updatedAt = "2099-01-02T03:04:05.000Z";
  await withStorageDatabase(directory, db => db.prepare("UPDATE session_event_logs SET last_message_at=? WHERE session_id=?").run(updatedAt, first.id));
  const before = await usage(directory), firstUsage = before.sessions.find(row => row.id === first.id)!;
  assert.deepEqual(firstUsage, { id: first.id, title: first.title, updatedAt,
    contentBytes: metadataBytes(first) + Buffer.byteLength(JSON.stringify(event)) + inline.length * roots.length + 96, mediaBytes: 96 });
  assert.equal(before.sessions.find(row => row.id === second.id)?.contentBytes, metadataBytes(second) + 64);
  assert.equal(before.media.length, 2);
  assert.equal(reclaimable(before, [first.id]), 32);
  assert.equal(reclaimable(before, [second.id]), 0);
  assert.equal(reclaimable(before, [first.id, second.id]), 96);
  const remove = lifecycle(directory), signal = createHostAbortController().signal;
  await remove.remove(first.id, signal, () => {});
  const afterFirst = await usage(directory);
  assert.deepEqual(afterFirst.media, [{ bytes: 64, sessionIds: [second.id], retained: false }]);
  assert.equal((await fs.readdir(path.join(directory, "live-smith-media"))).length, 1);
  await remove.remove(second.id, signal, () => {});
  assert.deepEqual(await usage(directory), { available: true, sessions: [], media: [] });
  assert.deepEqual(await fs.readdir(path.join(directory, "live-smith-media")), []);
});

test("unmatched, orphan and preserved references retain objects after their current session is deleted", async t => {
  const directory = await fixture(t), owner = await session(directory);
  const retainedPaths = ["custom/retained.bin", `live-smith-midi/${owner.id}-other/file.mid`,
    `live-smith-events/${owner.id}.json/child`, `live-smith-attachments/${owner.id}/preserved.bin`];
  for (const [index, retainedPath] of retainedPaths.entries()) {
    const source = `live-smith-audio/${owner.id}/source-${index}.audio`;
    await writeStoredBytes(directory, source, Buffer.alloc(index + 1, index), { storage: "file" });
    await copyStoredReference(directory, source, retainedPath);
    if (retainedPath.endsWith("preserved.bin")) {
      await withStorageDatabase(directory, db => db.prepare("UPDATE entries SET preserved=1 WHERE path=?").run(retainedPath));
    }
  }
  await writeStoredBytes(directory, "unrelated/file", Buffer.alloc(32, 65), { storage: "file" });
  const before = await usage(directory);
  assert.equal(before.media.length, retainedPaths.length);
  assert.ok(before.media.every(group => group.retained && group.sessionIds.length === 1 && group.sessionIds[0] === owner.id));
  assert.equal(before.sessions[0]?.mediaBytes, 10);
  assert.equal(reclaimable(before, [owner.id]), 0);
  await lifecycle(directory).remove(owner.id, createHostAbortController().signal, () => {});
  assert.equal((await fs.readdir(path.join(directory, "live-smith-media"))).length, 5);
  assert.deepEqual(await usage(directory), { available: true, sessions: [], media: [] });
});

test("legacy event entries count once before normalization and remain counted alongside stored event rows", async t => {
  const directory = await fixture(t), owner = await session(directory);
  const legacyEvent = { id: "event_legacy", kind: "user", content: "旧日志 🎷", createdAt: "2025-01-01T00:00:00.000Z" };
  const legacyBytes = Buffer.from(JSON.stringify([legacyEvent], null, 2));
  const key = `live-smith-events/${owner.id}.json`;
  await writeStoredBytes(directory, key, legacyBytes);
  const backup = path.join(directory, key);
  await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.writeFile(backup, legacyBytes);
  assert.equal((await usage(directory)).sessions[0]?.contentBytes, metadataBytes(owner) + legacyBytes.length);
  assert.equal(await withStorageDatabase(directory, db => db.prepare("SELECT name FROM sqlite_master WHERE name='session_event_records'").get()), undefined);
  const added = await appendSessionEvent(directory, owner.id, { kind: "assistant", content: "追加的回复" });
  assert.equal((await usage(directory)).sessions[0]?.contentBytes,
    metadataBytes(owner) + legacyBytes.length + Buffer.byteLength(JSON.stringify(legacyEvent)) + Buffer.byteLength(JSON.stringify(added)));
  await lifecycle(directory).remove(owner.id, createHostAbortController().signal, () => {});
  assert.deepEqual(await fs.readFile(backup), legacyBytes);
});

test("inventory reads lengths without loading event history, private content or media bytes", async t => {
  const directory = await fixture(t), owner = await session(directory);
  const event = await appendSessionEvent(directory, owner.id, { kind: "user", content: "long history ".repeat(50_000) });
  const source = `live-smith-midi/${owner.id}/source.mid`;
  await writeStoredBytes(directory, source, Buffer.alloc(128 * 1024, 7), { storage: "file" });
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (/\bFROM\s+session_event_records\b/iu.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = Reflect.apply(all, undefined, args) as ReturnType<typeof all>;
        assert.ok(rows.every(row => !Object.hasOwn(row, "payload")), "event payloads must remain in SQLite");
        return rows;
      };
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...args) {
        for (const row of Reflect.apply(iterate, undefined, args) as ReturnType<typeof iterate>) {
          assert.equal(Object.hasOwn(row, "payload"), false, "event payloads must remain in SQLite");
          yield row;
        }
        return undefined;
      };
    }
    if (/\bFROM\s+chunks\b/iu.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        assert.equal(args[0], "live-smith-sessions.json", "private content must remain unread");
        return Reflect.apply(get, undefined, args) as ReturnType<typeof get>;
      };
    }
    return statement;
  });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    assert.equal(String(args[0]).includes("live-smith-media"), false, "media files must remain unopened");
    return open(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await usage(directory)).sessions[0]?.contentBytes,
    metadataBytes(owner) + Buffer.byteLength(JSON.stringify(event)) + 128 * 1024);
});

test("empty storage and transient drafts report persisted bytes, and missing media contributes zero", async t => {
  assert.deepEqual(await readSessionStorageUsage(undefined), { available: false });
  const directory = await fixture(t);
  assert.deepEqual(await usage(directory), { available: true, sessions: [], media: [] });
  const draft = await session(directory, "Draft", true);
  assert.deepEqual((await usage(directory)).sessions, [{ id: draft.id, title: draft.title, updatedAt: draft.updatedAt, contentBytes: 0, mediaBytes: 0 }]);
  const saved = await session(directory, "Saved"), source = `live-smith-attachments/${saved.id}/missing.bin`;
  await writeStoredBytes(directory, source, Buffer.alloc(16), { storage: "file" });
  const entry = await storedEntry(directory, source);
  await fs.unlink(path.join(directory, "live-smith-media", entry!.sha256));
  const result = await usage(directory);
  assert.equal(result.sessions.find(row => row.id === saved.id)?.contentBytes, metadataBytes(saved));
  assert.equal(result.sessions.find(row => row.id === saved.id)?.mediaBytes, 0);
  assert.equal(reclaimable(result, [saved.id]), 0);
});

test("cancellation is observed before and after waiting for the storage transaction", async t => {
  const directory = await fixture(t), cancelled = createHostAbortController();
  cancelled.abort(new Error("Stopped"));
  await assert.rejects(readSessionStorageUsage(directory, cancelled.signal), /Stopped/);
  assert.deepEqual(await fs.readdir(directory), []);
  const pending = createHostAbortController();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = withStorageTransaction(directory, async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
  });
  await started;
  const reading = readSessionStorageUsage(directory, pending.signal);
  pending.abort(new Error("Cancelled while waiting")); release();
  await hold; await assert.rejects(reading, /Cancelled while waiting/);
  assert.deepEqual(await fs.readdir(directory), []);
});
