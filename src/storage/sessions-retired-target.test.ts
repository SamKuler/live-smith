import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { EDIT_SCOPES, resolveEditScopes } from "../agent/edit-scopes.js";
import { isReusableEmptySessionMetadata } from "../app/session-context.js";
import { loadSessionEvents } from "./events.js";
import { withStorageTransaction } from "./persistence.js";
import {
  createSession,
  listSessions,
  listSessionsInTransaction,
  SessionStorageCorruptionError,
  updateSession,
  type AgentSession,
} from "./sessions.js";

const scope = { kind: "clip" as const, identity: "12", label: "Phrase" };
const timestamp = "2026-08-26T00:00:00.000Z";
const identity = { projectKey: "activation", trackIdentity: "10", clipIdentity: "12", label: "Phrase" };
const retiredTargets = [
  { ...identity, kind: "midi-clip-range", startBeat: 2, endBeat: 6 },
  { ...identity, kind: "midi-candidate", slotIdentity: "20", slotIndex: 0 },
  null,
];

async function savedRecords(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-retired-target-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "live-smith-sessions.json");
  const sessions: AgentSession[] = [
    {
      id: "session-range", title: "Original phrase", projectKey: "activation", scope,
      activeSkillIds: ["arrange-song"], approvalMode: "manual", editScopes: ["midi"],
      modelSelection: { profileId: "profile-test", model: "test-model", reasoningEffort: "low" },
      createdAt: timestamp, updatedAt: timestamp,
    },
    {
      id: "session-candidate", title: "Earlier idea", projectKey: "previous-activation", scope,
      originScope: { kind: "track", identity: "8", label: "Source" },
      archivedAt: timestamp, approvalMode: "low-risk", editScopes: ["audio", "mixer"],
      createdAt: timestamp, updatedAt: timestamp,
    },
    {
      id: "session-cleared", title: "Review", projectKey: "activation", scope,
      approvalMode: "everything", editScopes: [], createdAt: timestamp, updatedAt: timestamp,
    },
  ];
  const records = sessions.map((session, index) => ({ ...session, writeBoundary: retiredTargets[index] }));
  const raw = `${JSON.stringify(records, null, 2)}\n`;
  await fs.writeFile(file, raw);
  await fs.mkdir(path.join(directory, "live-smith-events"));
  const histories = await Promise.all(sessions.map(async (session) => {
    const events = [{ id: `event-${session.id}`, kind: "user", content: session.title, createdAt: timestamp }];
    const eventFile = path.join(directory, "live-smith-events", `${session.id}.json`);
    const bytes = `${JSON.stringify(events, null, 2)}\n`;
    await fs.writeFile(eventFile, bytes);
    return { events, file: eventFile, bytes };
  }));
  return { directory, file, sessions, records, raw, histories };
}

test("saved range, candidate and cleared targets retire on read without changing Session or history ownership", async (t) => {
  const h = await savedRecords(t);
  const loaded = await listSessions(h.directory);
  assert.deepEqual(loaded, h.sessions);
  assert.ok(loaded.every((session) => !Object.hasOwn(session, "writeBoundary")));
  assert.deepEqual(await listSessions(h.directory, "activation"), [h.sessions[0], h.sessions[2]]);
  await withStorageTransaction(h.directory, async (transaction) => {
    assert.deepEqual(await listSessionsInTransaction(transaction, h.directory), h.sessions);
  });
  for (const [index, session] of loaded.entries()) {
    const history = h.histories[index]!;
    assert.deepEqual(await loadSessionEvents(h.directory, session.id), history.events);
    assert.equal(await fs.readFile(history.file, "utf8"), history.bytes);
  }
  loaded[0]!.scope.label = "Caller changed the clone";
  loaded[0]!.editScopes!.splice(0);
  assert.deepEqual(await listSessions(h.directory), h.sessions);
  assert.equal(await fs.readFile(h.file, "utf8"), h.raw);
});

test("an explicit title update saves canonical records and preserves all other metadata and history", async (t) => {
  const h = await savedRecords(t);
  await updateSession(h.directory, h.sessions[0]!.id, { title: "Renamed phrase" });
  const saved = JSON.parse(await fs.readFile(h.file, "utf8")) as AgentSession[];
  assert.notEqual(saved[0]!.updatedAt, timestamp);
  assert.deepEqual(saved, h.sessions.map((session, index) => index === 0
    ? { ...session, title: "Renamed phrase", updatedAt: saved[0]!.updatedAt }
    : session));
  assert.ok(saved.every((session) => !Object.hasOwn(session, "writeBoundary")));
  for (const history of h.histories) {
    assert.equal(await fs.readFile(history.file, "utf8"), history.bytes);
  }
});

test("retired metadata does not prevent default empty Session reuse or change missing Scope defaults", async (t) => {
  const h = await savedRecords(t);
  for (const writeBoundary of retiredTargets) {
    const record = {
      id: "session-empty", title: "", projectKey: "activation", scope,
      createdAt: timestamp, updatedAt: timestamp, writeBoundary,
    };
    const raw = JSON.stringify([record]);
    await fs.writeFile(h.file, raw);
    const [session] = await listSessions(h.directory);
    assert.ok(session);
    assert.equal(isReusableEmptySessionMetadata(session, "activation", scope), true);
    assert.deepEqual(resolveEditScopes(session.editScopes), EDIT_SCOPES);
    assert.equal(Object.hasOwn(session, "writeBoundary"), false);
    assert.equal(await fs.readFile(h.file, "utf8"), raw);
  }
});

test("retired-target compatibility still rejects unknown saved fields and invalid Scope", async (t) => {
  const h = await savedRecords(t);
  for (const extra of [
    { unknown: true },
    { scope: { ...scope, unknown: true } },
    { scope: { ...scope, kind: "invalidScope" } },
    ...[null, "midi", ["invalidScope"], ["midi", "midi"]].map((editScopes) => ({ editScopes })),
  ]) {
    const raw = JSON.stringify([{ ...h.records[0], ...extra }, ...h.records.slice(1)]);
    await fs.writeFile(h.file, raw);
    await assert.rejects(listSessions(h.directory), SessionStorageCorruptionError);
    await assert.rejects(updateSession(h.directory, h.sessions[0]!.id, { title: "Rejected" }), SessionStorageCorruptionError);
    assert.equal(await fs.readFile(h.file, "utf8"), raw);
  }
});

test("Session updates reject retired targets, unknown fields and invalid Scope without writing", async (t) => {
  const h = await savedRecords(t);
  for (const update of [
    ...[...retiredTargets, undefined].map((writeBoundary) => ({ writeBoundary })),
    { unknown: true },
    { editScopes: ["invalidScope"] },
  ]) {
    await assert.rejects(
      updateSession(h.directory, h.sessions[0]!.id, update as never),
      Object.hasOwn(update, "editScopes")
        ? /Edit scopes must be a list of distinct supported scopes/
        : /Session update is invalid/,
    );
    assert.equal(await fs.readFile(h.file, "utf8"), h.raw);
  }
});

test("new Sessions cannot persist obsolete target metadata", async (t) => {
  const h = await savedRecords(t);
  for (const writeBoundary of retiredTargets) {
    const created = await createSession(h.directory, {
      title: "New conversation", projectKey: "activation", scope, writeBoundary,
    } as never);
    assert.equal(Object.hasOwn(created, "writeBoundary"), false);
  }
  const saved = JSON.parse(await fs.readFile(h.file, "utf8")) as AgentSession[];
  assert.ok(saved.every((session) => !Object.hasOwn(session, "writeBoundary")));
});
