import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { ToolOperations } from "../../../src/app/tools/tool-operations.js";
import { createSession } from "../../../src/storage/sessions.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { withStorageDatabase } from "../../../src/storage/sqlite.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { uiMessage } from "../../../src/i18n/ui-message.js";
import { mcpOperationResult, mcpOperationSnapshot } from "../../../src/app/mcp/tool-results.js";
import { isToolOperationSnapshot } from "../../../src/agent/tool-operation.js";

async function fixture(t: import("node:test").TestContext) {
  const storageDirectory = await mkdtemp("/private/tmp/live-smith-operations-");
  t.after(() => rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, { title: "External", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Set" } });
  const operations = new ToolOperations(storageDirectory);
  t.after(() => operations.close());
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Composer" };
  return { storageDirectory, session, operations, actor };
}
test("operation preserves approval, exact proposal, cancellation and durable result", async t => {
  const h = await fixture(t);
  let approveSeen!: () => void;
  const pending = new Promise<void>(resolve => { approveSeen = resolve; });
  const proposal = { kind: "resolve_recovery" as const, message: "Keep completed changes?", groups: [] };
  const operation = await h.operations.start(h.session.id, h.actor, "resolve_live_recovery", async context => {
    const decision = context.requestApproval(proposal);
    approveSeen();
    return { content: await decision ? "kept" : "declined", failed: false };
  });
  await pending;
  assert.deepEqual(h.operations.approvals(h.session.id)[0]?.request, proposal);
  assert.equal((await h.operations.read(h.session.id, operation.id)).status, "awaiting_approval");
  assert.equal(JSON.stringify(await h.operations.read(h.session.id, operation.id)).includes("token"), false);
  h.operations.resolveApproval(h.session.id, operation.id, true);
  await h.operations.wait(operation.id);
  const finished = await h.operations.read(h.session.id, operation.id);
  assert.equal(finished.status, "completed"); assert.equal(finished.result?.content, "kept");
  const reloaded = new ToolOperations(h.storageDirectory);
  assert.deepEqual(await reloaded.read(h.session.id, operation.id), finished);
  assert.equal((await loadSessionEvents(h.storageDirectory, h.session.id)).filter(e => e.operation?.status === "completed").length, 1);
  await assert.rejects(reloaded.read("another-session", operation.id));
});
test("restart marks unfinished work interrupted; cancellation stops pending approval", async t => {
  const h = await fixture(t);
  let seen!: () => void; const pending = new Promise<void>(resolve => { seen = resolve; });
  const operation = await h.operations.start(h.session.id, h.actor, "apply_live_actions", async context => {
    const promise = context.requestApproval({ kind: "apply", message: "Change tempo", groups: [] }); seen(); await promise;
    return { content: "done", failed: false };
  });
  await pending;
  assert.equal((await new ToolOperations(h.storageDirectory).read(h.session.id, operation.id)).status, "interrupted");
  await h.operations.cancel(h.session.id, operation.id);
  await h.operations.wait(operation.id);
  assert.equal((await h.operations.read(h.session.id, operation.id)).status, "cancelled");
  assert.deepEqual(h.operations.approvals(h.session.id), []);
});

test("service shutdown waits for an admission already writing its durable receipt", async t => {
  const h = await fixture(t);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = withStorageTransaction(h.storageDirectory, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await started;
  let calls = 0, closed = false;
  const admitted = h.operations.start(h.session.id, h.actor, "inspect_live_set", async () => { calls++; return { content: "read", failed: false }; });
  const closing = h.operations.close().then(() => { closed = true; });
  await nextTurn();
  try { assert.equal(closed, false); } finally { release(); await held; }
  const operation = await admitted; await closing;
  assert.equal(calls, 0);
  assert.equal((await new ToolOperations(h.storageDirectory).read(h.session.id, operation.id)).status, "cancelled");
});

test("operation progress retains translation descriptors and MCP projects plain text", async t => {
  const h = await fixture(t);
  let seen!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { seen = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const progress = uiMessage("Downloading {name}", { name: "Raw English.wav" });
  const operation = await h.operations.start(h.session.id, h.actor, "listen_to_audio_asset", async context => {
    context.onProgress(progress); seen(); await gate;
    return { content: "Original tool result", failed: false };
  });
  await started;
  try {
    const running = await h.operations.read(h.session.id, operation.id);
    assert.deepEqual(running.progress, progress); assert(isToolOperationSnapshot(running));
    assert.equal(mcpOperationSnapshot(running).progress, "Downloading Raw English.wav");
    assert.equal((mcpOperationResult(running, h.session.id).structuredContent as Record<string, unknown>).progress, "Downloading Raw English.wav");
  } finally { release(); await h.operations.wait(operation.id); }
  const finished = await new ToolOperations(h.storageDirectory).read(h.session.id, operation.id);
  assert.deepEqual(finished.progress, uiMessage("Completed"));
  assert.equal(finished.result!.content, "Original tool result");
});


test("operation recovery reads only indexed operation records and keeps first-appearance ordering", async t => {
  const h = await fixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const active = await h.operations.start(h.session.id, h.actor, "active", async () => { await gate; return { content: "done", failed: false }; });
  try {
    for (let i = 0; i < 25; i++) await appendSessionEvent(h.storageDirectory, h.session.id, { kind: "operation", content: "started", operation: {
      id: `operation-${i}`, actor: h.actor, toolName: "inspect", status: "running", progress: uiMessage("Starting tool") } });
    await appendSessionEvent(h.storageDirectory, h.session.id, { kind: "operation", content: "done", operation: {
      id: "operation-0", actor: h.actor, toolName: "inspect", status: "completed", progress: uiMessage("Completed"), result: { content: "older result", failed: false } } });
    for (let i = 0; i < 120; i++) await appendSessionEvent(h.storageDirectory, h.session.id, { kind: "user", content: `message ${i}` });
    const plan = await withStorageDatabase(h.storageDirectory, db => {
      const detail = db.prepare("EXPLAIN QUERY PLAN SELECT MAX(seq) FROM session_event_records WHERE session_id=? AND kind='operation' AND json_extract(payload,'$.operation.id')=?").all(h.session.id, "operation-0");
      const listPlan = db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(payload,'$.operation.id'), MIN(seq), MAX(seq) FROM session_event_records WHERE session_id=? AND kind='operation' GROUP BY json_extract(payload,'$.operation.id')").all(h.session.id);
      db.prepare("UPDATE session_event_records SET payload='not JSON' WHERE session_id=? AND kind='user'").run(h.session.id);
      return [detail, listPlan].map(rows => rows.map(row => String(row.detail)).join(" "));
    });
    assert.match(plan[0]!, /session_event_operation_order/);
    assert.match(plan[1]!, /session_event_operation_order/);
    const list = await h.operations.list(h.session.id);
    assert.deepEqual(list.map(item => item.id), Array.from({ length: 20 }, (_, i) => `operation-${24 - i}`));
    assert.equal(list[0]!.status, "interrupted");
    const recovered = await new ToolOperations(h.storageDirectory).read(h.session.id, "operation-0");
    assert.equal(recovered.status, "completed"); assert.equal(recovered.result?.content, "older result");
    assert.equal((await h.operations.read(h.session.id, active.id)).status, "running");
  } finally { release(); await h.operations.wait(active.id); }
});
