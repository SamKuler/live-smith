import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { commandCalls, createDialogHarness, stateFixture, type DialogHarness } from "../support/chat-dialog.test-harness.js";
import { installWindowClock } from "../support/window-clock.js";

interface SearchReply {
  query: string;
  offset: number;
  total: number;
  unavailableCount: number;
  matches: { sessionId: string; excerpt: string; eventId?: string }[];
}
function reply(query: string, matches: SearchReply["matches"], extra: Partial<SearchReply> = {}): SearchReply {
  return { query, offset: 0, total: matches.length, unavailableCount: 0, matches, ...extra };
}
function rows(h: DialogHarness) {
  return [...h.document.querySelectorAll<HTMLElement>(".session-entry")].map((entry) => entry.dataset.sessionId);
}
function required<T extends Element>(h: DialogHarness, selector: string): T {
  const node = h.document.querySelector<T>(selector);
  assert.ok(node, `Expected ${selector}`);
  return node;
}
async function setup(state = stateFixture()) {
  state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state);
  assert.deepEqual(h.errors, []);
  const clock = installWindowClock(h.window);
  const requests: { query: string; offset: number; signal: AbortSignal | null | undefined; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname !== "/session-search") return originalFetch(input, init);
    assert.equal(init?.method, "POST");
    const body: { query: string; offset: number } = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["offset", "query"]);
    return await new Promise((resolve, reject) => requests.push({ ...body, signal: init?.signal,
      resolve: (value) => resolve({ ok: true, json: async () => value }), reject }));
  } });
  const search = async (value: string) => {
    h.input("#sessionSearch", value);
    clock.advance(180);
    await h.settle();
  };
  return { h, clock, requests, search, close() { clock.restore(); h.close(); } };
}

test("Session search debounces trimmed title queries, renders literal excerpts, and clears instantly", async () => {
  const s = await setup(); const { h, clock, requests } = s;
  try {
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus();
    h.input("#sessionSearch", "  LE"); clock.advance(100);
    h.input("#sessionSearch", "  LEAD  "); clock.advance(179);
    assert.equal(requests.length, 0);
    clock.advance(1); await h.settle();
    assert.equal(requests[0]?.query, "LEAD");
    requests[0]!.resolve(reply("LEAD", [{ sessionId: "session-2", excerpt: "Lead <img src=x onerror=alert(1)>" }]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-2"]);
    assert.equal(required(h, ".session-search-excerpt").textContent, "Lead <img src=x onerror=alert(1)>");
    assert.equal(h.document.querySelector(".session-search-excerpt img"), null);
    assert.equal(h.document.activeElement, input);
    h.input("#sessionSearch", "");
    assert.deepEqual(rows(h), ["session-1", "session-2"]);
    assert.equal(required<HTMLElement>(h, "#sessionSearchStatus").hidden, true);
    assert.deepEqual(commandCalls(h), []);
    assert.equal(h.calls.some((call) => call.path === "/send"), false);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search waits for Chinese composition and Escape cancels a pending read", async () => {
  const s = await setup(); const { h, clock, requests } = s;
  try {
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus();
    input.dispatchEvent(new h.window.CompositionEvent("compositionstart", { bubbles: true }));
    h.input("#sessionSearch", "钢琴"); clock.advance(500); await h.settle();
    assert.equal(requests.length, 0);
    input.dispatchEvent(new h.window.CompositionEvent("compositionend", { bubbles: true }));
    clock.advance(180); await h.settle();
    assert.equal(requests[0]?.query, "钢琴");
    input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(input.value, "");
    assert.equal(requests[0]?.signal?.aborted, true);
    requests[0]!.resolve(reply("钢琴", [{ sessionId: "session-2", excerpt: "钢琴消息", eventId: "message-1" }]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-1", "session-2"]);
    assert.equal(h.document.activeElement, input);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search renders the returned activity order and clearing restores ordinary navigation order", async () => {
  const s = await setup();
  const { h, requests } = s;
  try {
    await s.search("phrase");
    requests[0]!.resolve(reply("phrase", [
      { sessionId: "session-2", excerpt: "Newer phrase" },
      { sessionId: "session-1", excerpt: "Older phrase" },
    ]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-2", "session-1"]);
    h.input("#sessionSearch", "");
    assert.deepEqual(rows(h), ["session-1", "session-2"]);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("range selection follows the visible search order", async () => {
  const state = stateFixture();
  state.sessions.push({ ...state.sessions[0]!, id: "session-3", title: "Third phrase" });
  const s = await setup(state);
  const { h, requests } = s;
  try {
    await s.search("phrase");
    requests[0]!.resolve(reply("phrase", ["session-3", "session-1", "session-2"].map((sessionId) => ({ sessionId, excerpt: "Phrase" }))));
    await h.settle();
    required(h, '[data-session-id="session-3"] .session-row').dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, metaKey: true }));
    required(h, '[data-session-id="session-1"] .session-row').dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, shiftKey: true }));
    assert.deepEqual([...h.document.querySelectorAll<HTMLElement>(".session-entry[data-selected]")].map((entry) => entry.dataset.sessionId), ["session-3", "session-1"]);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search ignores late successes and failures after a newer query", async () => {
  const s = await setup(); const { h, requests } = s;
  try {
    await s.search("bass"); await s.search("lead"); await s.search("钢琴");
    requests[2]!.resolve(reply("钢琴", [{ sessionId: "session-1", excerpt: "钢琴录音" }])); await h.settle();
    requests[0]!.resolve(reply("bass", [{ sessionId: "session-2", excerpt: "wrong old result" }]));
    requests[1]!.reject(new Error("old read failed")); await h.settle();
    assert.deepEqual(rows(h), ["session-1"]);
    assert.equal(required(h, ".session-search-excerpt").textContent, "钢琴录音");
    assert.equal(required<HTMLElement>(h, "#sessionSearchRetry").hidden, true);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search filters current, History and Archived rows and confines bulk selection", async () => {
  const state = stateFixture();
  state.previousSessions = [{ ...state.sessions[0]!, id: "session-history", title: "Old piano", projectKey: "previous" }];
  state.archivedSessions = [{ ...state.sessions[0]!, id: "session-archived", title: "Archived piano", archivedAt: "2026-10-01T00:00:00Z" }];
  const s = await setup(state); const { h, requests } = s;
  try {
    required(h, '[data-session-id="session-2"] .session-row').dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await s.search("piano");
    assert.equal(required<HTMLElement>(h, "#sessionSelectionCount").hidden, true);
    requests[0]!.resolve(reply("piano", [
      { sessionId: "session-1", excerpt: "piano in message", eventId: "event-piano" },
      { sessionId: "session-history", excerpt: "Old piano" },
      { sessionId: "session-archived", excerpt: "Archived piano" },
    ])); await h.settle();
    assert.deepEqual(rows(h), ["session-1", "session-history", "session-archived"]);
    assert.ok(h.document.querySelector('[data-continue-session-id="session-history"]'));
    assert.equal(h.document.querySelector('[data-continue-session-id="session-archived"]'), null);
    required(h, '[data-session-id="session-archived"] .session-row').dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, shiftKey: true }));
    assert.equal(required(h, "#sessionSelectionCount").textContent, "3 selected");
    h.click('[data-session-menu-button="session-archived"]');
    assert.match(required(h, '[data-session-id="session-archived"] [data-session-action="delete"]').textContent || "", /3/);
    assert.deepEqual(commandCalls(h), []);
    h.input("#sessionSearch", "other");
    assert.equal(required<HTMLElement>(h, "#sessionSelectionCount").hidden, true);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search rejects malformed receipts and retry recovers with partial unreadable results", async () => {
  const s = await setup(); const { h, requests } = s;
  try {
    await s.search("lead");
    requests[0]!.resolve(reply("wrong", [{ sessionId: "session-2", excerpt: "Lead" }])); await h.settle();
    assert.deepEqual(rows(h), []);
    assert.equal(required<HTMLElement>(h, "#sessionSearchRetry").hidden, false);
    h.click("#sessionSearchRetry"); await h.settle();
    assert.equal(requests[1]?.query, "lead");
    requests[1]!.resolve(reply("lead", [{ sessionId: "session-2", excerpt: "Lead" }], { unavailableCount: 2 })); await h.settle();
    assert.deepEqual(rows(h), ["session-2"]);
    assert.match(required(h, "#sessionSearchStatus").textContent || "", /2.*could not be searched/);
    assert.equal(required<HTMLElement>(h, "#sessionSearchRetry").hidden, true);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search pages bounded results without selecting hidden matches", async () => {
  const state = stateFixture();
  state.sessions = Array.from({ length: 51 }, (_, index) => ({ ...state.sessions[0]!, id: `session-${index + 1}`, title: `Piano ${index + 1}` }));
  const s = await setup(state); const { h, requests } = s;
  try {
    await s.search("piano");
    requests[0]!.resolve(reply("piano", state.sessions.slice(0, 50).map((session) => ({ sessionId: session.id, excerpt: session.title })), { total: 51 }));
    await h.settle();
    assert.equal(rows(h).length, 50);
    assert.equal(required<HTMLButtonElement>(h, "#sessionSearchPrevious").disabled, true);
    assert.equal(required<HTMLButtonElement>(h, "#sessionSearchNext").disabled, false);
    h.click("#sessionSearchNext"); await h.settle();
    assert.equal(requests[1]?.offset, 50);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-51", excerpt: "Piano 51" }], { total: 51, offset: 50 }));
    await h.settle();
    assert.deepEqual(rows(h), ["session-51"]);
    assert.equal(required<HTMLButtonElement>(h, "#sessionSearchNext").disabled, true);
    required(h, '[data-session-id="session-51"] .session-row').dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, shiftKey: true }));
    assert.equal(required(h, "#sessionSelectionCount").textContent, "1 selected");
    h.click("#sessionSearchPrevious"); await h.settle();
    assert.equal(requests[2]?.offset, 0);
    assert.equal(required<HTMLElement>(h, "#sessionSelectionCount").hidden, true);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search keeps its query and focus through locale changes without another request", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  try {
    await s.search("钢琴");
    requests[0]!.resolve(reply("钢琴", [{ sessionId: "session-1", excerpt: "钢琴 <assistant>" }])); await h.settle();
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus(); input.setSelectionRange(1, 2);
    const { settings } = stateFixture();
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision, showContextUsage: settings.showContextUsage,
      contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision, networkProxy: settings.networkProxy,
      networkProxyRevision: settings.networkProxyRevision, uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "language-change" });
    await h.settle(); clock.advance(500); await h.settle();
    assert.equal(h.document.documentElement.lang, "zh-CN");
    assert.equal(h.document.activeElement, input);
    assert.equal(input.value, "钢琴");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2]);
    assert.equal(requests.length, 1);
    assert.equal(required(h, ".session-search-excerpt").textContent, "钢琴 <assistant>");
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search refreshes on persisted active messages but ignores drafts, reasoning and tool activity", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  h.holdNextSend();
  try {
    h.input("#prompt", "Make a piano"); h.click("#sendButton"); await h.settle();
    await s.search("piano");
    requests[0]!.resolve(reply("piano", [])); await h.settle();
    const sendId = h.sendIds[0]; assert.ok(sendId);
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus();
    h.emitServerEvent({ type: "assistant_delta", sendId, sessionId: "session-1", modelTurnEpoch: 0, delta: "piano draft" });
    h.flushAnimationFrames(); clock.advance(200); await h.settle();
    assert.equal(requests.length, 1);
    for (const kind of ["reasoning", "tool_call"] as const) {
      h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0,
        event: { id: `piano-${kind}`, createdAt: "2026-10-09T00:00:00.000Z", kind, content: "Inspect the piano." } });
      clock.advance(180); await h.settle();
      assert.equal(requests.length, 1);
    }
    h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0,
      event: { id: "persisted-piano", createdAt: "2026-10-08T00:00:00.000Z", kind: "assistant", content: "The piano is ready." } });
    clock.advance(180); await h.settle();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-1", excerpt: "The piano is ready.", eventId: "persisted-piano" }])); await h.settle();
    assert.deepEqual(rows(h), ["session-1"]);
    assert.equal(h.document.activeElement, input);
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); s.close(); }
});

for (const kind of ["user", "assistant"] as const) test(`Session search refreshes on a persisted background ${kind} message`, async () => {
  const s = await setup(); const { h, requests, clock } = s;
  h.holdNextSend();
  try {
    h.input("#prompt", "Make a tune"); h.click("#sendButton"); await h.settle();
    const sendId = h.sendIds[0]; assert.ok(sendId);
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    assert.equal(required(h, '[data-session-id="session-2"] .session-row').getAttribute("aria-pressed"), "true");
    await s.search("piano");
    requests[0]!.resolve(reply("piano", [])); await h.settle();
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus();
    h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0,
      event: { id: "background-piano", createdAt: "2026-10-09T00:00:00.000Z", kind, content: "The piano is ready." } });
    clock.advance(180); await h.settle();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-1", excerpt: "The piano is ready.", eventId: "background-piano" }]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-1"]);
    assert.equal(required(h, '[data-session-id="session-1"] .session-row').getAttribute("aria-pressed"), "false");
    assert.equal(h.document.activeElement, input);
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); s.close(); }
});

test("Session search refreshes for an inactive Session invalidated by another window", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  try {
    await s.search("piano");
    const stateReads = h.calls.filter((call) => new URL(call.url).pathname === "/state").length;
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-2" });
    clock.advance(180); await h.settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.signal?.aborted, true);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-2", excerpt: "A piano from another window.", eventId: "peer-piano" }]));
    await h.settle();
    requests[0]!.resolve(reply("piano", [])); await h.settle();
    assert.deepEqual(rows(h), ["session-2"]);
    assert.equal(h.calls.filter((call) => new URL(call.url).pathname === "/state").length, stateReads,
      "inactive Session details retain their deferred refresh");
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search refreshes a delayed inactive invalidation even after full state covers its revision", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  try {
    await s.search("piano");
    requests[0]!.resolve(reply("piano", [])); await h.settle();
    const delayed = h.deferServerEvent({ type: "session_state_invalidated", sessionId: "session-2" });
    const stateReads = h.calls.filter((call) => new URL(call.url).pathname === "/state").length;
    h.emitServerEvent({ type: "profile_settings_changed", commandId: "peer-profile-refresh" });
    await h.settle(); clock.advance(180); await h.settle();
    assert.equal(h.calls.filter((call) => new URL(call.url).pathname === "/state").length, stateReads + 1);
    assert.equal(requests.length, 1, "unchanged active history does not invalidate search on an unrelated full state");
    h.emitRawServerEvent(delayed); clock.advance(180); await h.settle();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-2", excerpt: "A piano from another window.", eventId: "covered-peer-piano" }]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-2"]);
    assert.equal(h.calls.filter((call) => new URL(call.url).pathname === "/state").length, stateReads + 1);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search retains a persisted message refresh while unchanged IME input finishes", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  h.holdNextSend();
  try {
    h.input("#prompt", "Make a tune"); h.click("#sendButton"); await h.settle();
    const sendId = h.sendIds[0]; assert.ok(sendId);
    await s.search("piano");
    requests[0]!.resolve(reply("piano", [])); await h.settle();
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus();
    input.dispatchEvent(new h.window.CompositionEvent("compositionstart", { bubbles: true }));
    h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0,
      event: { id: "ime-piano", createdAt: "2026-10-09T00:00:00.000Z", kind: "assistant", content: "The piano is ready." } });
    clock.advance(500); await h.settle();
    assert.equal(requests.length, 1);
    input.dispatchEvent(new h.window.CompositionEvent("compositionend", { bubbles: true }));
    clock.advance(180); await h.settle();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-1", excerpt: "The piano is ready.", eventId: "ime-piano" }]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-1"]);
    assert.equal(h.document.activeElement, input);
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); s.close(); }
});

test("Session search refreshes after event-stream recovery even when visible Session metadata is unchanged", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  try {
    await s.search("piano");
    requests[0]!.resolve(reply("piano", [])); await h.settle();
    const input = required<HTMLInputElement>(h, "#sessionSearch"); input.focus();
    const stateReads = h.calls.filter((call) => new URL(call.url).pathname === "/state").length;
    h.emitServerEventError(); h.emitServerEventOpen(); await h.settle();
    clock.advance(180); await h.settle();
    assert.equal(h.calls.filter((call) => new URL(call.url).pathname === "/state").length, stateReads + 1);
    assert.equal(requests.length, 2);
    requests[1]!.resolve(reply("piano", [{ sessionId: "session-2", excerpt: "A piano saved during disconnect.", eventId: "offline-piano" }]));
    await h.settle();
    assert.deepEqual(rows(h), ["session-2"]);
    assert.equal(h.document.activeElement, input);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("selecting a current Session message match locates the persisted message", async () => {
  const state = stateFixture();
  state.events = [{ id: "piano-message", createdAt: "2026-10-08T00:00:00.000Z", kind: "assistant", content: "Piano melody" }];
  const s = await setup(state); const { h, requests } = s;
  try {
    await s.search("piano");
    requests[0]!.resolve(reply("piano", [{ sessionId: "session-1", excerpt: "Piano melody", eventId: "piano-message" }])); await h.settle();
    required<HTMLElement>(h, '[data-session-id="session-1"] .session-row').focus();
    h.click('[data-session-id="session-1"] .session-row'); await h.settle();
    assert.equal(h.document.activeElement?.getAttribute("data-event-id"), "piano-message");
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("Session search validates result IDs, duplicate matches, offsets, and bounds before rendering", async () => {
  const s = await setup(); const { h, requests } = s;
  const malformed: unknown[] = [
    reply("piano", [{ sessionId: "../session", excerpt: "Piano" }]),
    reply("piano", [{ sessionId: "session-1", excerpt: "Piano", eventId: "../event" }]),
    reply("piano", [{ sessionId: "session-1", excerpt: "Piano" }, { sessionId: "session-1", excerpt: "Duplicate" }]),
    reply("piano", [{ sessionId: "session-1", excerpt: "x".repeat(241) }]),
    reply("piano", [], { offset: 50 }),
    reply("piano", [], { total: -1 }),
    reply("piano", [], { unavailableCount: 0.5 }),
    { ...reply("piano", []), unknown: true },
  ];
  try {
    await s.search("piano");
    for (const [index, value] of malformed.entries()) {
      requests[index]!.resolve(value); await h.settle();
      assert.deepEqual(rows(h), []);
      assert.equal(required<HTMLElement>(h, "#sessionSearchRetry").hidden, false);
      h.click("#sessionSearchRetry"); await h.settle();
    }
    requests.at(-1)!.reject(new Error("offline")); await h.settle();
    assert.equal(required<HTMLElement>(h, "#sessionSearchRetry").hidden, false);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("renaming a Session search result refreshes the active query", async () => {
  const s = await setup(); const { h, requests, clock } = s;
  try {
    await s.search("bass");
    requests[0]!.resolve(reply("bass", [{ sessionId: "session-1", excerpt: "Bass session" }])); await h.settle();
    h.click('[data-session-menu-button="session-1"]');
    h.click('[data-session-action="rename"]');
    h.input(".session-rename-input", "Piano session");
    required(h, ".session-rename-input").dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await h.settle(); clock.advance(180); await h.settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.query, "bass");
    requests[1]!.resolve(reply("bass", [])); await h.settle();
    assert.deepEqual(rows(h), []);
    assert.equal(required<HTMLElement>(h, "#sessionSearchRetry").hidden, true);
    assert.deepEqual(commandCalls(h).map((call) => call.body), [{ kind: "rename_session", sessionId: "session-1", title: "Piano session" }]);
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});

test("completing Session navigation leaves a newly focused search input intact", async () => {
  const s = await setup(); const { h, requests } = s;
  let held = false;
  try {
    await s.search("lead");
    requests[0]!.resolve(reply("lead", [{ sessionId: "session-2", excerpt: "Lead" }])); await h.settle();
    h.holdNextCommandResponse(); held = true;
    required<HTMLElement>(h, '[data-session-id="session-2"] .session-row').focus();
    h.click('[data-session-id="session-2"] .session-row');
    const input = required<HTMLInputElement>(h, "#sessionSearch");
    assert.equal(input.disabled, false);
    input.focus(); input.setSelectionRange(1, 3);
    h.releaseHeldCommandResponse(); held = false; await h.settle();
    assert.equal(h.document.activeElement, input);
    assert.equal(input.value, "lead");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 3]);
    assert.equal(required(h, '[data-session-id="session-2"] .session-row').getAttribute("aria-pressed"), "true");
    assert.equal(required<HTMLButtonElement>(h, "#sessionSearchPrevious").disabled, true);
    assert.equal(required<HTMLButtonElement>(h, "#sessionSearchNext").disabled, true);
    assert.deepEqual(h.errors, []);
  } finally { if (held) { h.releaseHeldCommandResponse(); await h.settle(); } s.close(); }
});

test("Session search omits an excerpt identical to the displayed title and retains message excerpts", async () => {
  const s = await setup(); const { h, requests } = s;
  try {
    await s.search("lead");
    requests[0]!.resolve(reply("lead", [{ sessionId: "session-2", excerpt: "Lead session" }])); await h.settle();
    assert.equal(required(h, '[data-session-id="session-2"] .session-title').textContent, "Lead session");
    assert.equal(h.document.querySelector(".session-search-excerpt"), null);
    await s.search("melody");
    requests[1]!.resolve(reply("melody", [{ sessionId: "session-2", excerpt: "Keep the lead melody.", eventId: "lead-message" }])); await h.settle();
    assert.equal(required(h, ".session-search-excerpt").textContent, "Keep the lead melody.");
    assert.deepEqual(h.errors, []);
  } finally { s.close(); }
});
