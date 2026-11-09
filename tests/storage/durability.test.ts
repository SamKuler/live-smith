import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:process";
import test from "node:test";

import { appendSessionEvent, loadSessionEvents } from "../../src/storage/events.js";
import { createSession, listSessions } from "../../src/storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";
import { MEDIA_DIRECTORY_NAME } from "../../src/storage/media-files.js";
import { STORAGE_DATABASE_NAME } from "../../src/storage/sqlite.js";

test("new persistent storage keeps its database private and writes no legacy files", { skip: platform === "win32" }, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durability-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "new-storage");
  await saveGlobalSettings(directory, { showContextUsage: false });
  const session = await createSession(directory, {
    title: "Private session", projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  await appendSessionEvent(directory, session.id, { kind: "user", content: "Private event" });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, STORAGE_DATABASE_NAME))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(directory)).sort(), [MEDIA_DIRECTORY_NAME, STORAGE_DATABASE_NAME].sort());
  assert.deepEqual(await fs.readdir(path.join(directory, MEDIA_DIRECTORY_NAME)), []);
  assert.equal((await fs.stat(path.join(directory, MEDIA_DIRECTORY_NAME))).mode & 0o777, 0o700);
  assert.equal((await loadSessionEvents(directory, session.id))[0]?.content, "Private event");
});

for (const write of [false, true]) test(`startup protects the storage root and database while preserving legacy bytes and permissions; write=${write}`, { skip: platform === "win32" }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durability-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const eventsDirectory = path.join(directory, "live-smith-events");
  await fs.mkdir(eventsDirectory, { mode: 0o755 });
  const originals = new Map([
    ["live-smith-settings.json", JSON.stringify({ schemaVersion: 1, activeProfileId: null, profiles: [], autoApprove: false })],
    ["live-smith-sessions.json", "[]"],
    ["live-smith-events/session-1.json", "[]"],
  ]);
  for (const [key, content] of originals) {
    await fs.writeFile(path.join(directory, key), content, { mode: 0o444 });
  }
  await fs.chmod(directory, 0o755);
  await loadAgentSettings(directory);
  await listSessions(directory);
  await loadSessionEvents(directory, "session-1");
  const database = path.join(directory, STORAGE_DATABASE_NAME);
  await fs.chmod(database, 0o644);
  if (write) await appendSessionEvent(directory, "session-1", { kind: "user", content: "New database event" });
  else await loadAgentSettings(directory);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(database)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(eventsDirectory)).mode & 0o777, 0o755);
  for (const [key, content] of originals) {
    assert.equal(await fs.readFile(path.join(directory, key), "utf8"), content);
    assert.equal((await fs.stat(path.join(directory, key))).mode & 0o777, 0o444);
  }
});
