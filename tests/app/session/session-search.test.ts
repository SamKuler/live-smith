import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { searchSessions } from "../../../src/app/session/session-search.js";
import { createSession, listSessions, setSessionArchived, updateSession } from "../../../src/storage/sessions.js";
import { appendSessionEvent } from "../../../src/storage/events.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { sessionSummaries } from "../../../src/app/context/session-context.js";

async function setup(t: TestContext) {
  const storageDirectory = await fs.mkdtemp("/private/tmp/live-smith-search-");
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const controller = createHostAbortController();
  const create = (title: string, projectKey = "project") => createSession(storageDirectory,
    { title, projectKey, scope: { kind: "track", identity: "track", label: "Track" } });
  return { storageDirectory, controller, create, search: (query: string, offset = 0) =>
    searchSessions({ storageDirectory, query, offset, signal: controller.signal }) };
}

test("search reads current, historical and archived titles and user/assistant messages with literal case folding", async (t) => {
  const h = await setup(t);
  const current = await h.create("Bass arrangement");
  const history = await h.create("Earlier project", "previous-project");
  const archived = await h.create("Archived idea");
  await setSessionArchived(h.storageDirectory, archived.id, true);
  const first = await appendSessionEvent(h.storageDirectory, history.id, { kind: "user", content: "Create a BASS melody" });
  const latest = await appendSessionEvent(h.storageDirectory, history.id, { kind: "assistant", content: "BASS variation 完成" });
  await appendSessionEvent(h.storageDirectory, archived.id, { kind: "user", content: "低音旋律" });
  await appendSessionEvent(h.storageDirectory, archived.id, { kind: "reasoning", content: "Private internal BASS analysis" });
  const result = await h.search(" bass ");
  assert.equal(result.query, "bass"); assert.equal(result.total, 2);
  assert.deepEqual(new Set(result.matches.map(match => match.sessionId)), new Set([current.id, history.id]));
  const message = result.matches.find(match => match.sessionId === history.id)!;
  assert.equal(message.eventId, latest.id); assert.notEqual(message.eventId, first.id);
  assert.match(message.excerpt, /variation/);
  assert.equal(result.matches.find(match => match.sessionId === current.id)?.eventId, undefined);
  assert.deepEqual((await h.search("旋律")).matches.map(match => match.sessionId), [archived.id]);
  assert.equal((await h.search(".*")).total, 0, "search text is not a regular expression");
});

test("search spans all sessions before paging and never returns message bodies as an index", async (t) => {
  const h = await setup(t);
  for (let i = 0; i < 53; i++) await h.create(`Needle ${i}`);
  const a = await h.search("NEEDLE"); const b = await h.search("NEEDLE", 50);
  assert.equal(a.total, 53); assert.equal(a.matches.length, 50); assert.equal(b.matches.length, 3);
  assert.equal(new Set([...a.matches, ...b.matches].map(match => match.sessionId)).size, 53);
  assert.deepEqual(Object.keys(a.matches[0]!).sort(), ["excerpt", "sessionId"]);
});

test("message excerpts include a late match and remain bounded with safe literal content", async (t) => {
  const h = await setup(t); const session = await h.create("Long conversation");
  await appendSessionEvent(h.storageDirectory, session.id, { kind: "user", content: "Before ".repeat(100) + "<b>needle</b>" + " after".repeat(100) });
  const match = (await h.search("needle")).matches[0]!;
  assert.match(match.excerpt, /<b>needle<\/b>/); assert.ok(match.excerpt.length <= 240);
});

test("blank queries do not scan history; invalid bounds and cancellation fail explicitly", async (t) => {
  const h = await setup(t);
  assert.deepEqual(await h.search("   "), { query: "", offset: 0, total: 0, matches: [], unavailableCount: 0 });
  await assert.rejects(h.search("x".repeat(201)), /search/i);
  await assert.rejects(h.search("needle", -1), /search/i);
  h.controller.abort(); await assert.rejects(h.search("needle"), { name: "AbortError" });
});

test("unreadable histories are reported without hiding healthy matches or reading orphan files", async (t) => {
  const h = await setup(t);
  const healthy = await h.create("Conversation"); const broken = await h.create("Damaged conversation");
  await appendSessionEvent(h.storageDirectory, healthy.id, { kind: "assistant", content: "Needle is here" });
  await appendSessionEvent(h.storageDirectory, broken.id, { kind: "user", content: "Needle was here" });
  await fs.writeFile(`${h.storageDirectory}/live-smith-events/${broken.id}.json`, "{");
  await fs.writeFile(`${h.storageDirectory}/live-smith-events/orphan.json`, JSON.stringify([
    { id: "orphan-event", kind: "user", content: "needle", createdAt: new Date().toISOString() },
  ]), { mode: 0o600 });
  const result = await h.search("needle");
  assert.equal(result.unavailableCount, 1); assert.equal(result.total, 1);
  assert.equal(result.matches[0]?.sessionId, healthy.id);
  assert.equal((await h.search(" ")).unavailableCount, 0, "cleared search does not read corrupt history");
});

test("untitled Sessions are searchable by their displayed Live context label", async (t) => {
  const h = await setup(t);
  const session = await createSession(h.storageDirectory, { title: "", projectKey: "project",
    scope: { kind: "track", identity: "piano", label: "Piano melody" } });
  await appendSessionEvent(h.storageDirectory, session.id, { kind: "assistant", content: "Saved this idea" });
  const result = await h.search("piano");
  assert.deepEqual(result.matches, [{ sessionId: session.id, excerpt: "Piano melody" }]);
});

test("continued named Sessions use saved chat activity for display and search without rewriting metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  const h = await setup(t);
  const older = await h.create("Needle older");
  t.mock.timers.tick(86_400_000);
  const newer = await h.create("Needle newer");
  t.mock.timers.tick(86_400_000);
  await appendSessionEvent(h.storageDirectory, older.id, { kind: "user", content: "Continue this arrangement" });
  t.mock.timers.tick(86_400_000);
  const reply = await appendSessionEvent(h.storageDirectory, older.id, { kind: "assistant", content: "New variation" });
  t.mock.timers.tick(86_400_000);
  await appendSessionEvent(h.storageDirectory, newer.id, { kind: "reasoning", content: "An internal update" });

  assert.deepEqual((await h.search("needle")).matches.map((match) => match.sessionId), [older.id, newer.id]);
  const records = await listSessions(h.storageDirectory);
  const summaries = await sessionSummaries(h.storageDirectory, records);
  const continued = summaries.find((session) => session.id === older.id)!;
  assert.equal(continued.lastMessageAt, reply.createdAt);
  assert.equal(continued.updatedAt, older.updatedAt, "activity does not change the metadata ordering clock");
  assert.equal(summaries.find((session) => session.id === newer.id)?.lastMessageAt, undefined);
  assert.deepEqual(await listSessions(h.storageDirectory), records, "activity projection is read-only");

  await updateSession(h.storageDirectory, newer.id, { title: "Needle renamed" });
  assert.deepEqual((await h.search("needle")).matches.map((match) => match.sessionId), [newer.id, older.id]);
});

test("a matching name remains searchable when its activity history is unreadable", async (t) => {
  const h = await setup(t);
  const session = await h.create("Needle named conversation");
  await appendSessionEvent(h.storageDirectory, session.id, { kind: "assistant", content: "Saved message" });
  await fs.writeFile(`${h.storageDirectory}/live-smith-events/${session.id}.json`, "{");
  const result = await h.search("needle");
  assert.equal(result.unavailableCount, 1);
  assert.equal(result.matches[0]?.sessionId, session.id);
  const summary = (await sessionSummaries(h.storageDirectory, await listSessions(h.storageDirectory)))[0]!;
  assert.equal(summary.hasContent, true);
  assert.equal(summary.updatedAt, session.updatedAt);
});
