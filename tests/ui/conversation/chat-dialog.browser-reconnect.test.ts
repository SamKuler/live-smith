import assert from "node:assert/strict";
import test from "node:test";
import { createChatBridge } from "../../../src/app/chat/chat-bridge.js";

import { cloneState, createDialogHarness, jsonCalls, stateFixture } from "../support/chat-dialog.test-harness.js";

const sendId = "retained-browser-send";

function runningState() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.sessionActivities = [{ sessionId: "session-1", sendId, status: "running", message: "Working in background", unread: false }];
  return state;
}

function modelState(overrides: Record<string, unknown> = {}) {
  return { type: "model_turn_state", sendId, sessionId: "session-1", modelTurnEpoch: 0,
    assistantDraft: "Recovered response", reasoningDraft: null, webSearchUpdates: [],
    progress: "Working in background", resolvedConfirmationGeneration: 0, ...overrides };
}

test("a fresh page recovers an admitted background send and Stops its original correlation ID", async () => {
  const state = runningState();
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    harness.input("#prompt", "My new unsent draft");
    harness.emitServerEvent(modelState());
    harness.flushAnimationFrames();
    assert.match(harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "", /Recovered response/);
    assert.deepEqual(harness.sendIds, []);

    const stopped = cloneState(state);
    stopped.sessionActivities![0]!.status = "stopped";
    stopped.sessionActivities![0]!.message = "Stopped";
    harness.setServerState(stopped);
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(harness.stopIds, [sendId]);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "My new unsent draft");
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.deepEqual(harness.sendIds, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a fresh page recovers pending approval and rejects unrelated send replay", async () => {
  const state = runningState();
  state.sessionActivities![0]!.status = "waiting_confirmation";
  state.sessionActivities![0]!.message = "Waiting for confirmation";
  const harness = await createDialogHarness(state);
  try {
    harness.emitServerEvent(modelState());
    harness.emitServerEvent({ type: "confirm_request", sendId, sessionId: "session-1", modelTurnEpoch: 0,
      id: "retained-confirmation", confirmationGeneration: 1, kind: "apply", message: "Apply the plan?",
      groups: [{ title: "Tracks", rows: ["Create track"] }] });
    await harness.settle();
    assert.match(harness.document.querySelector(".confirm-card")?.textContent ?? "", /Apply the plan/);
    harness.emitRawServerEvent(modelState({ sendId: "unrelated-send", assistantDraft: "Unrelated response" }));
    harness.emitRawServerEvent(modelState({ modelTurnEpoch: -1, assistantDraft: "Malformed response" }));
    harness.flushAnimationFrames();
    assert.match(harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "", /Recovered response/);
    harness.click(".confirm-card button.primary");
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/confirm").map(({ body }) => body), [{ id: "retained-confirmation", apply: true }]);
    assert.deepEqual(harness.sendIds, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a refreshed authoritative snapshot adopts background work without consuming the page's composer draft", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Keep this local draft");
    harness.setServerState(runningState());
    harness.emitServerEventError();
    harness.emitServerEventOpen();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    harness.emitServerEvent(modelState());
    harness.flushAnimationFrames();
    assert.match(harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "", /Recovered response/);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Keep this local draft");
    assert.deepEqual(harness.sendIds, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("reconnecting to a failed background request releases its controls and keeps its saved error", async () => {
  const state = runningState();
  const harness = await createDialogHarness(state);
  try {
    const failed = cloneState(state);
    failed.sessionActivities![0]!.status = "failed";
    failed.sessionActivities![0]!.message = "The provider request failed";
    harness.setServerState(failed);
    harness.emitServerEventError();
    harness.emitServerEventOpen();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /provider request failed/);
    harness.emitRawServerEvent(modelState());
    harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector(".timeline-item.assistant.streaming"), null);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a page does not adopt send replay without authoritative active ownership", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.emitRawServerEvent(modelState());
    harness.emitServerEvent({ type: "confirm_request", sendId, sessionId: "session-1", modelTurnEpoch: 0,
      id: "unowned-confirmation", confirmationGeneration: 1, kind: "apply", message: "Unexpected plan",
      groups: [{ title: "Tracks", rows: ["Create track"] }] });
    await harness.settle();
    harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector(".timeline-item.assistant.streaming"), null);
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.deepEqual(harness.sendIds, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a newer authoritative active send replaces a retained request that ended while disconnected", async () => {
  const harness = await createDialogHarness(runningState());
  try {
    harness.emitServerEvent(modelState());
    const newer = runningState();
    newer.sessionActivities![0]!.sendId = "new-retained-send";
    harness.setServerState(newer);
    harness.emitServerEventError();
    harness.emitServerEventOpen();
    await harness.settle();
    harness.emitServerEvent(modelState({ sendId: "new-retained-send", assistantDraft: "New active response" }));
    harness.flushAnimationFrames();
    assert.match(harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "", /New active response/);
    harness.emitRawServerEvent(modelState({ assistantDraft: "Late old response" }));
    harness.flushAnimationFrames();
    assert.doesNotMatch(harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "", /Late old response/);
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(harness.stopIds, ["new-retained-send"]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("retired send ownership stays terminal across reconnect while a newer owner can be adopted", async () => {
  const state = runningState();
  const harness = await createDialogHarness(state);
  try {
    const completed = cloneState(state);
    completed.sessionActivities![0]!.status = "completed";
    completed.sessionActivities![0]!.message = "Completed";
    harness.emitServerEvent({ type: "done", sendId, sessionId: "session-1", state: completed });
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");

    harness.setServerState(state);
    harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    harness.emitRawServerEvent(modelState()); harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.assistant.streaming"), null);

    const next = cloneState(state);
    next.sessionActivities![0]!.sendId = "new-retained-send";
    harness.setServerState(next);
    harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    harness.emitServerEvent(modelState({ sendId: "new-retained-send", assistantDraft: "New background response" }));
    harness.flushAnimationFrames();
    assert.match(harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "", /New background response/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const connection of ['live', 'replay'] as const) test(`a peer Send owns Stop and approval through ${connection} SSE`, async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const ready = Promise.withResolvers<void>();
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => '', handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.progress('Peer is working');
      await stream.assistantDelta('Peer output');
      const decision = stream.requestConfirmation({ kind: 'apply', message: 'Apply peer plan?', groups: [{ title: 'Track', rows: ['Create clip'] }] });
      ready.resolve();
      await decision;
      return state;
    },
  });
  const url = new URL(bridge.url);
  const endpoint = (path: string) => `${url.origin}${path}${url.search}`;
  const initial = await (await fetch(endpoint('/state'))).json();
  const h = await createDialogHarness(initial);
  const source = connection === 'live' ? await fetch(endpoint('/events')) : null;
  const send = fetch(endpoint('/send'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Smith-Send-Id': 'peer-send' }, body: JSON.stringify({ prompt: 'Peer request', sessionId: 'session-1' }) });
  const sendResult = send.then(response => response.json(), () => null);
  await ready.promise;
  const reader = (source ?? await fetch(endpoint('/events'))).body!.getReader();
  const publications: string[] = [];
  try {
    const decoder = new TextDecoder(); let pending = ''; let confirmed = false;
    while (!confirmed) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) { const payload = JSON.parse(data.slice(6)); publications.push(payload.type); h.emitRawServerEvent(payload); confirmed ||= payload.type === 'confirm_request'; }
      }
    }
    await h.settle(); h.flushAnimationFrames();
    assert.ok(publications.indexOf('send_activity') < publications.indexOf('confirm_request'));
    if (connection === 'replay') assert.ok(publications.indexOf('send_activity') < publications.indexOf('model_turn_state'));
    assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Stop');
    assert.match(h.document.querySelector('.confirm-card')?.textContent ?? '', /Apply peer plan/);
  } finally { h.close(); await reader.cancel(); await bridge.close(); await sendResult; }
});


test("send admission rejects obsolete or unavailable owners while preserving a newer owner", async () => {
  const h = await createDialogHarness(stateFixture());
  const publication = (id: string, revision: string, sessionId = "session-1") => ({
    type: "send_activity", sendId: id, sessionId, activity: { status: "running", message: "Working" }, bridgeStateRevision: revision,
  });
  try {
    h.emitServerEvent(publication("old-owner", "100")); await h.settle();
    assert.equal(h.document.querySelector("#sendButton")?.textContent, "Stop");
    const completed = stateFixture();
    completed.sessionActivities = [{ sessionId: "session-1", sendId: "old-owner", status: "completed", message: "Completed", unread: false }];
    h.emitServerEvent({ type: "done", sendId: "old-owner", sessionId: "session-1", state: completed }); await h.settle();
    h.emitServerEvent(publication("old-owner", "200"));
    h.emitServerEvent(publication("unknown-owner", "201", "missing-session"));
    h.emitRawServerEvent(publication("stale-owner", "99")); await h.settle();
    assert.equal(h.document.querySelector("#sendButton")?.textContent, "Send");
    h.emitServerEvent(publication("new-owner", "202")); await h.settle();
    h.click("#sendButton"); await h.settle();
    assert.deepEqual(h.stopIds, ["new-owner"]);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a competing peer Send is replayed after the rejected local Send restores its draft", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state);
  let released = false;
  const owner = { type: "send_activity", sendId: "peer-send", sessionId: "session-1", activity: { status: "running", message: "Peer work" } };
  try {
    h.holdNextSend(); h.failNextSend("This Session already has an active agent request.", "not_persisted");
    h.input("#prompt", "Preserve rejected local prompt"); h.click("#sendButton"); await h.settle();
    h.emitServerEvent({ ...owner, bridgeStateRevision: "100" });
    assert.equal(h.eventSourceUrls.length, 1, "Pending local outcome must retain its own attempt");
    const running = stateFixture(); running.openSettingsOnLoad = false;
    running.sessionActivities = [{ sessionId: "session-1", sendId: "peer-send", status: "running", message: "Peer work", unread: false }];
    h.setServerState(running);
    h.releaseHeldSend(); released = true; await h.settle();
    assert.equal(h.eventSourceUrls.length, 2);
    h.emitServerEventOpen();
    h.emitServerEvent({ ...owner, bridgeStateRevision: "200" });
    h.emitServerEvent(modelState({ sendId: "peer-send", assistantDraft: "Peer response" }));
    h.emitServerEvent({ type: "confirm_request", sendId: "peer-send", sessionId: "session-1", modelTurnEpoch: 0,
      id: "peer-confirmation", confirmationGeneration: 1, kind: "apply", message: "Apply peer plan?", groups: [{ title: "Track", rows: ["Create clip"] }] });
    await h.settle(); h.flushAnimationFrames();
    assert.equal(h.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Preserve rejected local prompt");
    assert.match(h.document.querySelector(".confirm-card")?.textContent ?? "", /Apply peer plan/);
    assert.equal(h.sendIds.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { if (!released) h.releaseHeldSend(); h.close(); }
});
