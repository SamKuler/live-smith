import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import type { ChatSessionEvent, ChatSessionEventPage } from "../../../src/ui/chat-state.js";
import { createDialogHarness, stateFixture, cloneState, pendingImage, jsonCalls, commandCalls, waitForCondition, type DialogHarness } from "../support/chat-dialog.test-harness.js";
import { actionDiffGroups } from "../../../src/ui/action-diff.js";
import type { AgentPlan } from "../../../src/agent/actions.js";
import { installWindowClock } from "../support/window-clock.js";

function event(index: number): ChatSessionEvent {
  return { id: `message-${index}`, kind: index % 2 ? "user" : "assistant", content: `Message **${index}**`, createdAt: "2026-11-01T00:00:00Z" };
}
function page(first: number, last: number, total = 1000): ChatSessionEventPage {
  return { sessionId: "session-1", historyId: "history-1", total, latestSequence: total,
    ...(first > 1 ? { nextBefore: first } : {}), ...(last < total ? { nextAfter: last } : {}),
    events: Array.from({ length: last - first + 1 }, (_, index) => event(first + index)) };
}
function initial() {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const tail = page(901, 1000);
  state.events = tail.events;
  state.eventHistory = { historyId: tail.historyId, total: tail.total, latestSequence: tail.latestSequence, nextBefore: 901 };
  return state;
}
function intercept(h: DialogHarness) {
  const original = h.window.fetch;
  const requests: { body: Record<string, unknown>; signal: AbortSignal | null | undefined; resolve(page: unknown): void }[] = [];
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/send-receipt") {
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ status: "accepted", event: { ...event(2001), content: body.prompt } }) };
    }
    if (new URL(String(input)).pathname !== "/session-events") return original(input, init);
    return new Promise(resolve => requests.push({ body: JSON.parse(String(init?.body)), signal: init?.signal,
      resolve: result => resolve({ ok: true, json: async () => result }) }));
  } });
  return requests;
}
async function refresh(h: DialogHarness, state: ReturnType<typeof initial>) {
  h.setServerState(state);
  h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId });
  await waitForCondition(() => Boolean(h.document.querySelector(`[data-event-id="${state.events.at(-1)?.id}"]`)), "Expected refreshed tail");
  await h.settle();
}
const older = '[data-history-action="older"]';

test("long sessions initially render only the tail and prepend history while retaining focus and message actions", async () => {
  const state = initial(); const h = await createDialogHarness(state); const requests = intercept(h);
  try {
    assert.deepEqual(h.errors, []);
    assert.equal(h.document.querySelectorAll("#timeline article[data-event-id]").length, 100);
    assert.equal(h.document.querySelector('[data-event-id="message-1"]'), null);
    const retained = h.document.querySelector('[data-event-id="message-901"]');
    const copy = h.document.querySelector<HTMLButtonElement>('[data-event-id="message-901"] [data-message-action="copy"]')!;
    h.click(older); copy.focus();
    assert.deepEqual(requests[0]?.body, { sessionId: "session-1", historyId: "history-1", before: 901 });
    requests[0]!.resolve(page(801, 900)); await h.settle();
    assert.equal(h.document.querySelectorAll("#timeline article[data-event-id]").length, 200);
    assert.equal(h.document.querySelector('[data-event-id="message-901"]'), retained);
    assert.equal(h.document.activeElement, copy);
    h.click('[data-event-id="message-801"] [data-message-action="copy"]'); await h.settle();
    assert.deepEqual(h.clipboardWrites, [event(801).content]);
    h.click('[data-event-id="message-801"] [data-message-action="edit"]'); await h.settle();
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")?.value, event(801).content);
    assert.equal(h.readBootstrappedClientStateReference().events.length, 100);
    const next = cloneState(state); next.events = page(902, 1001, 1001).events;
    next.eventHistory = { ...state.eventHistory!, total: 1001, latestSequence: 1001, nextBefore: 902 };
    await refresh(h, next);
    assert.ok(h.document.querySelector('[data-event-id="message-801"]'));
    assert.ok(h.document.querySelector('[data-event-id="message-1001"]'));
    assert.equal(h.document.querySelectorAll('[data-event-id="message-901"]').length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("history requests cannot repopulate a cleared history and failed pages stay retryable", async () => {
  const state = initial(); const h = await createDialogHarness(state); const requests = intercept(h);
  try {
    h.click(older); requests[0]!.resolve({ ...page(801, 900), events: [{ ...event(801), kind: "invented" }] });
    await h.settle();
    assert.equal(h.document.querySelector('[data-event-id="message-801"]'), null);
    assert.equal(h.document.querySelector<HTMLButtonElement>(older)?.disabled, false);
    h.click(older);
    const replacement = cloneState(state); replacement.events = [event(2000)];
    replacement.eventHistory = { historyId: "replacement-history", total: 1, latestSequence: 1 };
    await refresh(h, replacement);
    assert.equal(requests[1]?.signal?.aborted, true);
    requests[1]!.resolve(page(801, 900)); await h.settle();
    assert.equal(h.document.querySelector('[data-event-id="message-801"]'), null);
    assert.ok(h.document.querySelector('[data-event-id="message-2000"]'));
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a tool result at a history boundary joins its earlier call when the preceding page arrives", async () => {
  const state = initial(); state.events[0] = { ...event(901), kind: "tool_result", name: "external", content: "Done", outcome: "success" };
  const h = await createDialogHarness(state); const requests = intercept(h);
  try {
    assert.equal(h.document.querySelector('[data-activity-step-id="message-901"]')?.getAttribute("data-status"), "complete");
    h.click(older);
    const previous = page(801, 900); previous.events[99] = { ...event(900), kind: "tool_call", name: "external", content: "{}" };
    requests[0]!.resolve(previous); await h.settle();
    const step = h.document.querySelector('[data-activity-step-id="message-900"]');
    assert.ok(step); assert.equal(step.getAttribute("data-status"), "complete");
    assert.equal(h.document.querySelector('[data-activity-step-id="message-901"]'), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("search locates an old message with one anchor page, pages forward, and returns to current history", async () => {
  const h = await createDialogHarness(initial()); const requests = intercept(h); const clock = installWindowClock(h.window);
  const historyFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-search") return { ok: true, json: async () => ({ query: "old phrase", offset: 0, total: 1, unavailableCount: 0,
      matches: [{ sessionId: "session-1", eventId: "message-151", excerpt: "old phrase" }] }) };
    return historyFetch(input, init);
  } });
  try {
    h.input("#sessionSearch", "old phrase"); clock.advance(180); await h.settle();
    const row = h.document.querySelector<HTMLButtonElement>('.session-entry[data-session-id="session-1"] .session-row');
    assert.ok(row); row.focus(); row.click(); await h.settle();
    assert.deepEqual(requests[0]?.body, { sessionId: "session-1", historyId: "history-1", anchorEventId: "message-151" });
    requests[0]!.resolve(page(101, 200)); await h.settle();
    assert.equal(h.document.activeElement?.getAttribute("data-event-id"), "message-151");
    assert.equal(h.document.querySelector('[data-event-id="message-1000"]'), null);
    h.click('[data-history-action="newer"]'); requests[1]!.resolve(page(201, 300)); await h.settle();
    assert.equal(requests[1]?.body.after, 200);
    assert.ok(h.document.querySelector('[data-event-id="message-300"]'));
    h.click('[data-history-action="latest"]'); await h.settle();
    assert.ok(h.document.querySelector('[data-event-id="message-1000"]'));
    assert.equal(h.document.querySelector('[data-event-id="message-151"]'), null);
    assert.equal(h.document.querySelectorAll("#timeline article[data-event-id]").length, 100);
    row.focus(); row.click(); await h.settle();
    requests[2]!.resolve(page(101, 200)); await h.settle();
    const plan: AgentPlan = { message: "Change tempo", actions: [{ type: "set_tempo", tempo: 120 }] };
    h.emitServerEvent({ type: "command_activity", command: { id: "history-apply", sessionId: "session-1", stopping: false }, bridgeStateRevision: "100" });
    h.emitServerEvent({ type: "command_confirm_request", commandId: "history-apply", sessionId: "session-1", id: "history-confirm",
      kind: "apply", operationId: "history-operation", message: plan.message, groups: actionDiffGroups(plan.actions), plan });
    await h.settle();
    assert.ok(h.document.querySelector('[data-event-id="message-1000"]'));
    assert.equal(h.document.querySelector('[data-event-id="message-151"]'), null);
    const approval = h.document.querySelector<HTMLElement>('[data-operation-id="history-operation"]'); assert.ok(approval);
    approval.querySelector<HTMLButtonElement>(".confirm-buttons .primary")!.click(); await h.settle();
    assert.deepEqual(jsonCalls(h, "/confirm").at(-1)?.body, { id: "history-confirm", apply: true });
    assert.deepEqual(h.errors, []);
  } finally { clock.restore(); h.close(); }
});


test("the attachment library and creative brief proposal include metadata outside the displayed history", async () => {
  const state = initial();
  state.sessionAttachments = [pendingImage("archived-image", "older.png")];
  state.latestBriefProposal = { id: "old-proposal", kind: "tool_result", name: "propose_creative_brief", createdAt: "2026-11-01T00:00:00Z",
    content: JSON.stringify({ creativeBrief: "A slow piano piece", expectedCreativeBrief: "", saved: false }) };
  state.latestCompactionId = "old-compaction";
  const h = await createDialogHarness(state);
  try {
    assert.match(h.document.querySelector("#contextAttachmentList")?.textContent ?? "", /older.png/);
    assert.equal(h.document.querySelector("#creativeBriefProposalText")?.textContent, "A slow piano piece");
    assert.equal(h.document.querySelector('[data-event-id="old-proposal"]'), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("streamed messages retain the explicitly loaded history prefix", async () => {
  const h = await createDialogHarness(initial()); const requests = intercept(h); h.holdNextSend();
  try {
    h.click(older); requests[0]!.resolve(page(801, 900)); await h.settle();
    h.input("#prompt", "Continue the piece"); h.click("#sendButton");
    await waitForCondition(() => h.sendIds.length === 1, "Expected a running send");
    h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: event(1002) });
    await h.settle();
    assert.ok(h.document.querySelector('[data-event-id="message-801"]'));
    assert.ok(h.document.querySelector('[data-event-id="message-1002"]'));
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});


test("an external approval stays actionable when its proposal precedes the history tail", async () => {
  const state = initial();
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Composer" };
  const plan: AgentPlan = { message: "Change tempo", actions: [{ type: "set_tempo", tempo: 125 }] };
  state.mcpApprovals = [{ actor, operationId: "external-operation", request: { kind: "apply", operationId: "older-apply", message: plan.message, groups: [], plan } }];
  const h = await createDialogHarness(state);
  try {
    const review = h.document.querySelector('[data-operation-id="older-apply"]'); assert.ok(review);
    assert.match(review.textContent ?? "", /125/);
    h.click('[data-operation-id="older-apply"] .primary'); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)?.body, { kind: "resolve_mcp_approval", sessionId: "session-1", operationId: "external-operation", approve: true });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("an older send response cannot restore a replaced history after a newer command snapshot", async () => {
  const state = initial(); const h = await createDialogHarness(state);
  const original = h.window.fetch;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/send-receipt") {
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ status: "accepted", event: { ...event(2001), content: body.prompt } }) };
    }
    const response = await original(input, init);
    if (new URL(String(input)).pathname === "/send") {
      const read = response.json.bind(response);
      response.json = async () => { const value = await read(); waiting = true; await held; return value; };
    }
    return response;
  } });
  try {
    h.input("#prompt", "Inspect the track"); h.click("#sendButton");
    await waitForCondition(() => waiting, "Expected held send response");
    const replaced = cloneState(state);
    replaced.events = [event(2000)]; replaced.eventHistory = { historyId: "new-history", total: 1, latestSequence: 1 };
    h.setServerState(replaced); h.select("#approvalMode", "everything"); await h.settle();
    assert.ok(h.document.querySelector('[data-event-id="message-2000"]'));
    release(); await h.settle();
    assert.ok(h.document.querySelector('[data-event-id="message-2000"]'));
    assert.equal(h.document.querySelector('[data-event-id="message-1000"]'), null);
    assert.deepEqual(h.errors, []);
  } finally { release(); await h.settle(); h.close(); }
});


for (const outcome of ["accepted", "accepted-newer-draft", "absent", "unavailable"] as const) {
  test(`paged terminal state reconciles an out-of-window steering receipt: ${outcome}`, async () => {
    const state = initial(); state.settings.defaultFollowUpBehavior = "steer";
    const h = await createDialogHarness(state); h.holdNextSend();
    const original = h.window.fetch;
    const reads: Record<string, unknown>[] = [];
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
      if (new URL(String(input)).pathname !== "/send-receipt") return original(input, init);
      const body = JSON.parse(String(init?.body)); reads.push(body);
      if (body.steerId) {
        await hold;
        if (outcome === "unavailable") return { ok: false, json: async () => ({ error: "Still running" }) };
        return { ok: true, json: async () => outcome === "absent" ? { status: "absent" } : {
          status: "accepted", event: { ...event(2001), content: body.prompt, steeringAck: { sendId: body.sendId, steerId: body.steerId } },
        } };
      }
      return { ok: true, json: async () => ({ status: "accepted", event: { ...event(2003), content: body.prompt } }) };
    } });
    try {
      h.input("#prompt", "Start the mix"); h.click("#sendButton"); await h.settle();
      h.rejectNextSteerResponseAfterCommit("response lost");
      h.input("#prompt", "Keep more headroom");
      h.document.querySelector("#prompt")!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      await h.settle();
      const steerCall = h.calls.find(call => call.path === "/steer")!;
      const steerId = new Headers(steerCall.headers).get("X-Live-Smith-Steer-Id");
      h.emitServerEvent({ type: "done", sessionId: "session-1", sendId: h.sendIds[0], state });
      h.emitServerEvent({ type: "done", sessionId: "session-1", sendId: h.sendIds[0], state });
      await h.settle();
      assert.equal(reads.filter(read => read.steerId).length, 1);
      assert.deepEqual(reads.find(read => read.steerId), { sessionId: "session-1", sendId: h.sendIds[0], steerId, prompt: "Keep more headroom", attachmentIds: [] });
      assert.equal(h.document.querySelector("#sendButton")?.textContent, "Stop");
      if (outcome === "accepted-newer-draft") h.input("#prompt", "A newer unsent idea");
      release(); await h.settle();
      assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        outcome === "accepted" ? "" : outcome === "accepted-newer-draft" ? "A newer unsent idea" : "Keep more headroom");
      assert.equal(h.document.querySelector("#sendButton")?.textContent, outcome === "unavailable" ? "Stop" : "Send");
      assert.equal(h.document.querySelector('[data-event-id="message-2001"]'), null);
      assert.deepEqual(h.errors, []);
    } finally { release(); h.releaseHeldSend(); await h.settle(); h.close(); }
  });
}
