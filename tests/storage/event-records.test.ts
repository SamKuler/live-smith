import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import fsPromises from "node:fs/promises";
import * as fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync, StatementSync } from "node:sqlite";
import test from "node:test";
import { sessionSummaries } from "../../src/app/context/session-context.js";
import { createSessionLifecycle } from "../../src/app/session/session-lifecycle.js";
import { attachmentMutationFence, sessionMutationFence } from "../../src/app/session/session-fences.js";
import { sessionMutationFenceKey } from "../../src/app/session/session-mutation-fence.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { appendSessionEvent, deleteSessionEvents, loadSessionContextEvents, loadSessionEventPage,
  loadSessionEventSummary, loadSessionEvents, searchSessionEvents, SessionEventHistoryChangedError,
  loadLatestSessionEvent, loadSessionRecoveryEvents, loadConsumedAttachmentIds, loadSessionOperationSnapshots, loadSessionOperationSnapshot } from "../../src/storage/events.js";
import { StorageCommitOutcomeUnknownError, withStorageTransaction } from "../../src/storage/persistence.js";
import { listSessions, listSessionsInTransaction } from "../../src/storage/sessions.js";
import { interceptStoredWrites } from "./support/sqlite-fault-test-helpers.js";
import { readStoredText, writeStoredBytes } from "../../src/storage/sqlite.js";

test("legacy history migrates once, retains its original, pages by insertion order, and rejects stale cursors", async t => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-event-records-");
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const session = "history-migration";
  const legacy = [
    {id:"event-a",createdAt:"2026-01-03",kind:"user",content:"  First title  \nbody"},
    {id:"event-b",createdAt:"2026-01-01",kind:"assistant",content:"中文 variation"},
    {id:"event-c",createdAt:"2026-01-02",kind:"compaction",content:"checkpoint"},
  ];
  const raw = JSON.stringify(legacy);
  const key = `live-smith-events/${session}.json`;
  await writeStoredBytes(root,key,Buffer.from(raw));
  assert.deepEqual(await loadSessionEvents(root,session),legacy);
  const appended = await appendSessionEvent(root,session,{kind:"assistant",content:"中文 latest"});
  assert.equal(await readStoredText(root,key),raw);
  const summary = await loadSessionEventSummary(root,session);
  assert.equal(summary.total,4); assert.equal(summary.lastEventId,appended.id);
  const newest = await loadSessionEventPage(root,session,{limit:2});
  assert.deepEqual(newest.events.map(e=>e.id),["event-c",appended.id]);
  const older = await loadSessionEventPage(root,session,{limit:2,before:newest.nextBefore!,historyId:newest.historyId});
  assert.deepEqual(older.events.map(e=>e.id),["event-a","event-b"]);
  assert.equal(older.nextBefore,undefined);
  assert.deepEqual((await loadSessionContextEvents(root,session)).map(e=>e.id),["event-c",appended.id]);
  assert.equal((await searchSessionEvents(root,session,"中文"))?.id,appended.id);
  await deleteSessionEvents(root,session);
  await appendSessionEvent(root,session,{kind:"user",content:"new"});
  await assert.rejects(loadSessionEventPage(root,session,{limit:2,historyId:newest.historyId}),SessionEventHistoryChangedError);
});

test("a pre-window history read cannot restore events after initial summaries and Session deletion", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-event-deletion-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = "legacy-delete";
  const key = `live-smith-events/${sessionId}.json`;
  const legacy = [{ id: "event-old", createdAt: "2026-01-01", kind: "user", content: "Old conversation" }];
  await fs.mkdir(`${root}/live-smith-events`);
  await fs.writeFile(`${root}/${key}`, JSON.stringify(legacy));
  await fs.writeFile(`${root}/live-smith-sessions.json`, JSON.stringify([{
    id: sessionId, title: "Old Session", projectKey: "set-one", scope: { kind: "track", identity: "track-one", label: "Lead" },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  }]));
  await listSessions(root);
  const lifecycle = createSessionLifecycle({ storageDirectory: root, notifySessionStateChanged() {},
    withSessionMutation(id, signal, operation) {
      const fence = sessionMutationFenceKey(root, id);
      return sessionMutationFence.run(fence, signal, () => attachmentMutationFence.run(fence, signal, operation));
    },
  });
  const readContext = new AsyncLocalStorage<{ loaded: boolean; closed: boolean; held: boolean }>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const get = StatementSync.prototype.get;
  const read = t.mock.method(StatementSync.prototype, "get", function(this: StatementSync, ...args: unknown[]) {
    const value = Reflect.apply(get, this, args);
    const state = readContext.getStore();
    if (state && this.sourceSQL.startsWith("SELECT bytes FROM chunks") && args[0] === key) state.loaded = true;
    return value;
  });
  const close = DatabaseSync.prototype.close;
  const closed = t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const value = close.call(this);
    const state = readContext.getStore();
    if (state?.loaded) state.closed = true;
    return value;
  });
  const realpath = fsPromises.realpath;
  const paused = t.mock.method(fsPromises, "realpath", async (...args: Parameters<typeof realpath>) => {
    const state = readContext.getStore();
    if (state?.closed && !state.held) { state.held = true; entered(); await gate; }
    return realpath(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); paused.mock.restore(); closed.mock.restore(); read.mock.restore(); syncBuiltinESMExports(); });

  const pending = readContext.run({ loaded: false, closed: false, held: false }, () => loadSessionEvents(root, sessionId));
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await blocked;
  await lifecycle.reconcileStartupOrphans();
  const initial = await withStorageTransaction(root, async transaction => sessionSummaries(root, await listSessionsInTransaction(transaction, root)));
  assert.deepEqual(initial.map(session => session.id), [sessionId]);
  assert.equal(await lifecycle.remove(sessionId, createHostAbortController().signal, () => {}), true);
  release();
  const result = await outcome;
  assert.ok("error" in result && result.error instanceof SessionEventHistoryChangedError);
  assert.deepEqual(await listSessions(root), []);
  assert.deepEqual(await loadSessionEvents(root, sessionId), []);
  assert.deepEqual(JSON.parse(await fs.readFile(`${root}/${key}`, "utf8")), legacy);
});

test("in-memory pagination and search preserve ordering and reset history identity", async () => {
  const session = `memory-page-${Date.now()}`;
  const first = await appendSessionEvent(undefined,session,{kind:"user",content:"a"});
  await appendSessionEvent(undefined,session,{kind:"assistant",content:"A"});
  const page = await loadSessionEventPage(undefined,session,{limit:1});
  assert.equal((await loadSessionEventPage(undefined,session,{limit:1,before:page.nextBefore!})).events[0]?.id,first.id);
  assert.equal((await searchSessionEvents(undefined,session,"a"))?.content,"A");
  await deleteSessionEvents(undefined,session);
  await assert.rejects(loadSessionEventPage(undefined,session,{limit:1,historyId:page.historyId}),SessionEventHistoryChangedError);
});

 test("an event commit with an unknown outcome reports uncertainty and preserves the committed event", async t => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-event-commit-");
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await loadSessionEventSummary(root,"commit-history");
  const restore = interceptStoredWrites(t,{afterCommit(_writes,db) {
    if (db.prepare("SELECT 1 FROM session_event_records WHERE session_id=?").get("commit-history")) throw new Error("lost commit acknowledgement");
  }});
  await assert.rejects(appendSessionEvent(root,"commit-history",{kind:"user",content:"committed"}),StorageCommitOutcomeUnknownError);
  restore();
  assert.deepEqual((await loadSessionEvents(root,"commit-history")).map(e => e.content),["committed"]);
});

test("targeted queries retain recovery facts across compaction and find the latest named event", async t => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-event-query-");
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const session = "targeted-query";
  const error = await appendSessionEvent(root,session,{kind:"error",content:"earlier failure"});
  await appendSessionEvent(root,session,{kind:"assistant",name:"advice",content:"older"});
  await appendSessionEvent(root,session,{kind:"compaction",content:"checkpoint"});
  const latest = await appendSessionEvent(root,session,{kind:"assistant",name:"advice",content:"newer"});
  const tool = await appendSessionEvent(root,session,{kind:"tool_result",content:"Tool call x has invalid arguments: bad"});
  await appendSessionEvent(root,session,{kind:"tool_result",content:"Large successful tool output ".repeat(1000)});
  await appendSessionEvent(root,session,{kind:"tool_result",content:"Tool call x\nnot a rejection has invalid arguments: quoted text"});
  assert.equal((await loadLatestSessionEvent(root,session,{kind:"assistant",name:"advice"}))?.id,latest.id);
  assert.equal(await loadLatestSessionEvent(root,session,{kind:"assistant",name:"absent"}),undefined);
  assert.deepEqual((await loadSessionRecoveryEvents(root,session)).map(e=>e.id),[error.id,tool.id]);
  assert.deepEqual(await loadConsumedAttachmentIds(root,session),[]);
});

test("bounded anchored pages traverse both directions with interleaved Sessions and reject missing targets", async t => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-history-anchor-");
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const events = [];
  for (let index=0; index<9; index++) {
    events.push(await appendSessionEvent(root,"anchor",{kind:"assistant",content:String(index)}));
    await appendSessionEvent(root,"other",{kind:"assistant",content:"other"});
  }
  const page = await loadSessionEventPage(root,"anchor",{limit:3,anchorEventId:events[4]!.id});
  assert.deepEqual(page.events.map(event => event.content),["3","4","5"]);
  const older = await loadSessionEventPage(root,"anchor",{limit:3,before:page.nextBefore!,historyId:page.historyId});
  const newer = await loadSessionEventPage(root,"anchor",{limit:3,after:page.nextAfter!,historyId:page.historyId});
  assert.deepEqual(older.events.map(event => event.content),["0","1","2"]);
  assert.deepEqual(newer.events.map(event => event.content),["6","7","8"]);
  assert.equal(older.nextBefore,undefined); assert.equal(newer.nextAfter,undefined);
  await assert.rejects(loadSessionEventPage(root,"anchor",{limit:3,anchorEventId:"missing"}),/unavailable/);
  await assert.rejects(loadSessionEventPage(root,"anchor",{limit:101}),/Invalid event page/);
  await assert.rejects(loadSessionEventPage(root,"anchor",{limit:3,before:2,after:1}),/Invalid event page/);
});

test("history projections retain all consumed sources and exact receipts outside the display tail", async t => {
  const { loadSessionAttachmentRefs,loadSessionSendReceiptEvent,sessionSteeringContentSha256 } = await import("../../src/storage/events.js");
  const { uiMessage } = await import("../../src/i18n/ui-message.js");
  const root = await fs.mkdtemp("/private/tmp/live-smith-history-facts-");
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const attachment = {id:"selected-image",kind:"image" as const,fileName:"ref.png",mediaType:"image/png" as const,byteLength:1024,sha256:"a".repeat(64),provenance:{sourceId:"source-image",replacedIds:["source-image"]}};
  const primary = await appendSessionEvent(root,"facts",{kind:"user",content:"initial",attachments:[attachment],sendReceipt:{sendId:"send-facts"}});
  const steering = await appendSessionEvent(root,"facts",{kind:"user",content:"follow up",steeringReceipt:{sendId:"send-facts",id:"steer-facts",sha256:sessionSteeringContentSha256("follow up")}});
  await appendSessionEvent(root,"facts",{kind:"operation",content:"completed",operation:{id:"operation-facts",actor:{kind:"mcp",clientId:"client-facts",clientName:"Test"},toolName:"audio",status:"completed",progress:uiMessage("Done"),result:{content:"done",failed:false,audioAttachmentId:"output-audio",inputAttachmentIds:["input-audio"]}}});
  for(let index=0;index<105;index++) await appendSessionEvent(root,"facts",{kind:"assistant",content:String(index)});
  assert.equal((await loadSessionEventPage(root,"facts",{limit:100})).events.some(event => event.id === primary.id),false);
  assert.deepEqual(await loadSessionAttachmentRefs(root,"facts"),[attachment]);
  assert.deepEqual(new Set(await loadConsumedAttachmentIds(root,"facts")),new Set(["selected-image","source-image","input-audio","output-audio"]));
  assert.equal((await loadSessionSendReceiptEvent(root,"facts","send-facts"))?.id,primary.id);
  assert.equal((await loadSessionSendReceiptEvent(root,"facts","send-facts","steer-facts"))?.id,steering.id);
  assert.equal(await loadSessionSendReceiptEvent(root,"facts","unknown"),undefined);
  assert.equal((await appendSessionEvent(root,"facts",{kind:"user",content:"initial",attachments:[attachment],sendReceipt:{sendId:"send-facts"}})).id,primary.id);
  await assert.rejects(appendSessionEvent(root,"facts",{kind:"user",content:"changed",sendReceipt:{sendId:"send-facts"}}),/conflicts/);
  assert.equal((await loadSessionEventSummary(root,"facts")).total,108);
});

test("history advances from an exact event after interleaved Sessions and streamed appends", async t => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-event-cursor-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++) await appendSessionEvent(root, "other-history", { kind: "assistant", content: `Other ${i}` });
  const first = await appendSessionEvent(root, "target-history", { kind: "user", content: "First" });
  await appendSessionEvent(root, "other-history", { kind: "assistant", content: "Between" });
  const streamed = await appendSessionEvent(root, "target-history", { kind: "assistant", content: "Streamed" });
  const next = await appendSessionEvent(root, "target-history", { kind: "assistant", content: "Next" });
  const page = await loadSessionEventPage(root, "target-history", { limit: 1, afterEventId: streamed.id });
  assert.deepEqual(page.events.map(event => event.id), [next.id]);
  assert.equal(page.nextAfter, undefined);
  await assert.rejects(loadSessionEventPage(root, "other-history", { limit: 1, afterEventId: first.id }));
  await assert.rejects(loadSessionEventPage(root, "target-history", { limit: 1, after: 1, afterEventId: first.id }));
});


test("memory operation snapshots preserve first occurrence while selecting latest state", async () => {
  const session = `memory-operations-${Date.now()}`;
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Client" };
  const append = (id: string, status: "running" | "completed") => appendSessionEvent(undefined, session, {
    kind: "operation", content: status, operation: { id, actor, toolName: "inspect", status, progress: status } });
  try {
    await append("first", "running"); await append("second", "running"); await append("third", "running"); await append("first", "completed");
    const recent = await loadSessionOperationSnapshots(undefined, session, 2, ["first"]);
    assert.deepEqual(recent.map(item => [item.id, item.status]), [["first", "completed"], ["second", "running"], ["third", "running"]]);
    assert.equal((await loadSessionOperationSnapshot(undefined, session, "first"))?.status, "completed");
    assert.equal(await loadSessionOperationSnapshot(undefined, session, "missing"), undefined);
  } finally { await deleteSessionEvents(undefined, session); }
});
