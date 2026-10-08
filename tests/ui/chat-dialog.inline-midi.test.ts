import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { captureLiveActionPreflightObservation } from "../../src/live/preflight.js";
import { midiPreviewFixture } from "../live/support/action-preview.test-harness.js";
import type { MidiActionPreview } from "../../src/agent/action-preview.js";
import type { SessionArtifact } from "../../src/app/session/session-artifacts.js";
import type { ChatSessionEvent } from "../../src/ui/chat-state.js";
import { cloneState, createDialogHarness, jsonCalls, stateFixture, waitForCondition, type DialogHarness } from "./support/chat-dialog.test-harness.js";

const preview: MidiActionPreview = { kind: "midi-notes", actionIndex: 0, status: "proposed", targetLabel: "Bass clip",
  range: { coordinate: "clip-beats", start: 0, end: 32 },
  before: { notes: [{ pitch: 48, startTime: 0, duration: 4 }], totalNoteCount: 1, omittedNoteCount: 0 },
  after: { notes: [{ pitch: 50, startTime: 0, duration: 4 }], totalNoteCount: 1, omittedNoteCount: 0 } };
const saved: SessionArtifact = { ref: { kind: "midi", id: "saved-midi" }, label: "低音变奏", sourceLabel: "MIDI generator", createdAt: "2026-10-03T00:00:00Z",
  version: { groupId: "saved-midi", number: 1, groupLabel: "低音变奏" },
  versions: [{ id: "saved-midi", number: 1, label: "低音变奏", createdAt: "2026-10-03T00:00:00Z" }],
  midi: { durationBeats: 32, noteCount: 2, omittedNoteCount: 0,
    parts: [{ id: "part-1", channel: 1, sourceTrackIndex: 0, sourceTrackName: "Bass", noteCount: 1, durationBeats: 32 },
      { id: "part-2", channel: 2, sourceTrackIndex: 1, sourceTrackName: "Lead", noteCount: 1, durationBeats: 32 }],
    notes: [{ pitch: 48, startTime: 0, duration: 4, partId: "part-1" }, { pitch: 72, startTime: 4, duration: 4, partId: "part-2" }] } };
function event(id: string, kind: ChatSessionEvent["kind"], content: string, extra: Partial<ChatSessionEvent> = {}): ChatSessionEvent {
  return { id, kind, content, createdAt: "2026-10-03T00:00:00Z", ...extra };
}
const proposal = () => event("proposal", "apply_requested", "Transpose Bass by two semitones", { applyOperation: { id: "operation-1", status: "proposed", previews: [preview] } });
async function publish(h: DialogHarness, events: ChatSessionEvent[]) {
  const state = { ...cloneState(h.readBootstrappedClientStateReference()), events };
  h.setServerState(state); h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
}
function button(root: ParentNode, text: string): HTMLButtonElement {
  const value = [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text);
  assert.ok(value, `Expected button ${text}`); return value;
}

test("saved MIDI renders inline, preserves its part and viewport on refresh, and opens its exact artifact", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); let reads = 0;
  const original = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/session-artifact") { reads++; return { ok: true, json: async () => ({ sessionId: "session-1", artifact: saved }) }; }
    if (path === "/session-artifacts") return { ok: true, json: async () => ({ sessionId: "session-1", artifacts: [], offset: 0, total: 0, unavailableCount: 0 }) };
    return original(input, init);
  } });
  try {
    const output = event("saved-result", "tool_result", "Saved", { name: "save_midi_artifact", outcome: "success", artifacts: [saved.ref] });
    await publish(h, [output]);
    await waitForCondition(() => Boolean(h.document.querySelector(".chat-midi-preview .piano-roll-note")), "Expected inline saved notes");
    const card = h.document.querySelector<HTMLElement>(".chat-midi-preview")!;
    const step = card.closest<HTMLDetailsElement>(".timeline-activity-step")!;
    assert.equal(step.open, false);
    step.querySelector<HTMLElement>(":scope > summary")!.click();
    assert.equal(step.open, true);
    for (let details = card.closest("details"); details; details = details.parentElement?.closest("details") ?? null) assert.equal(details.open, true);
    assert.match(card.textContent!, /低音变奏 · v1/);
    h.select(".chat-artifact-part select", "part-2");
    h.click(".chat-midi-preview .piano-roll-zoom-in");
    const svg = card.querySelector("svg"); const span = card.querySelector(".piano-roll-span")!.textContent;
    assert.deepEqual([...card.querySelectorAll(".piano-roll-note")].map((note) => note.getAttribute("data-pitch")), ["72"]);
    const focus = card.querySelector<HTMLButtonElement>(".piano-roll-zoom-in")!; focus.focus();
    const next = event("next-inspection", "tool_call", "Inspect the destination", { name: "inspect_track" });
    await publish(h, [output, next]);
    const group = card.closest<HTMLDetailsElement>(".timeline-activity-group");
    assert.ok(group);
    assert.equal(group.open, true);
    assert.equal(card.closest(".timeline-activity-step"), step);
    assert.equal(step.open, true);
    assert.equal(h.document.activeElement, focus);
    assert.equal(card.querySelector<HTMLSelectElement>(".chat-artifact-part select")!.value, "part-2");
    assert.equal(card.querySelector(".piano-roll-span")!.textContent, span);
    await publish(h, [output, next, event("assistant", "assistant", "Here is the new version.")]);
    assert.equal(h.document.querySelector(".chat-midi-preview"), card);
    assert.equal(card.querySelector("svg"), svg); assert.equal(card.querySelector(".piano-roll-span")!.textContent, span);
    assert.equal(reads, 1);
    button(card, "Open artifact").click(); await h.settle();
    assert.equal(h.document.getElementById("artifactsPanel")!.hidden, false);
    assert.equal(h.document.querySelector("#artifact-preview-midi-saved-midi")?.getAttribute("id"), "artifact-preview-midi-saved-midi");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("artifact-looking tool text cannot create a chat preview without a host-owned reference; failed reads can retry", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); let reads = 0;
  const original = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-artifact") {
      reads++; return reads === 1 ? { ok: false, json: async () => ({ error: "Missing" }) } : { ok: true, json: async () => ({ sessionId: "session-1", artifact: saved }) };
    }
    return original(input, init);
  } });
  try {
    await publish(h, [event("untrusted", "tool_result", JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: saved.ref.id }] }))]);
    assert.equal(h.document.querySelector(".chat-midi-preview"), null); assert.equal(reads, 0);
    await publish(h, [event("owned", "tool_result", "Saved", { artifacts: [saved.ref] })]);
    await waitForCondition(() => h.document.querySelector<HTMLButtonElement>(".chat-midi-preview > button")?.hidden === false, "Expected retry");
    h.click(".chat-midi-preview > button");
    await waitForCondition(() => Boolean(h.document.querySelector(".chat-midi-preview .piano-roll-note")), "Expected retry result");
    assert.equal(reads, 2); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const status of ["applied", "partial", "cancelled", "failed"] as const) test(`durable ${status} Live edits retain a proposed preview and separate actual outcome`, async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.events = [proposal(), event("approved", "apply_auto_approved", "Automatic approval", { applyOperation: { id: "operation-1", status: "approved" } }),
    event("outcome", "apply_result", `Host outcome: ${status}`, { applyOperation: { id: "operation-1", status } })];
  const h = await createDialogHarness(state);
  try {
    const card = h.document.querySelector<HTMLElement>('[data-operation-id="operation-1"]')!;
    assert.ok(card); assert.equal(h.document.querySelectorAll("[data-operation-id]").length, 1);
    assert.equal(h.document.querySelector("[data-pending-confirmation]"), null); assert.equal(card.closest<HTMLElement>(".timeline-activity-step")!.dataset.status, status === "applied" ? "complete" : status === "cancelled" ? "stopped" : status);
    assert.match(card.querySelector(".timeline-activity-detail-content[role=\"status\"]")!.textContent!, new RegExp(`Host outcome: ${status}`));
    const step = card.closest<HTMLDetailsElement>(".timeline-activity-step")!;
    if (!step.open) step.querySelector<HTMLElement>(":scope > summary")!.click();
    for (let details = card.closest("details"); details; details = details.parentElement?.closest("details") ?? null) assert.equal(details.open, true);
    const title = step.querySelector("summary .timeline-activity-title")!.textContent;
    assert.equal([...h.document.querySelectorAll("summary .timeline-activity-title")].filter((node) => node.textContent === title).length, 1);
    button(card, "Before · 1 notes").click();
    const svg = card.querySelector("svg"); h.click("[data-operation-id] .piano-roll-zoom-in");
    const focus = card.querySelector<HTMLButtonElement>(".piano-roll-zoom-in")!; focus.focus();
    const span = card.querySelector(".piano-roll-span")!.textContent;
    await publish(h, [...state.events!, event("assistant", "assistant", "Review complete")]);
    assert.equal(h.document.querySelector("[data-operation-id]"), card); assert.equal(card.querySelector("svg"), svg);
    assert.equal(card.querySelector(".piano-roll-span")!.textContent, span);
    assert.equal(h.document.activeElement, focus);
    assert.equal(card.querySelector('.midi-preview-switch [aria-pressed="true"]')?.getAttribute("data-side"), "before");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Manual review sends only the decision, reuses its card, and never labels approval as successful execution", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); h.holdNextSend();
  try {
    h.input("#prompt", "Transpose bass"); h.click("#sendButton");
    await waitForCondition(() => h.sendIds.length === 1, "Expected send");
    h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: proposal() });
    h.emitServerEvent({ type: "confirm_request", sendId: h.sendIds[0], sessionId: "session-1", modelTurnEpoch: 0,
      id: "confirmation-1", operationId: "operation-1", confirmationGeneration: 1, kind: "apply", message: "Transpose Bass",
      groups: [{ title: "Write MIDI", rows: ["Transpose notes"] }], previews: [preview] });
    await h.settle();
    const card = h.document.querySelector<HTMLElement>("[data-pending-confirmation]")!; assert.ok(card);
    assert.equal(card.closest("[inert]"), null);
    assert.equal(card.closest<HTMLDetailsElement>(".timeline-activity-step")!.open, true);
    const svg = card.querySelector("svg"); h.click("[data-pending-confirmation] .piano-roll-zoom-in");
    const span = card.querySelector(".piano-roll-span")!.textContent;
    h.holdNextConfirmation();
    h.click(".confirm-buttons .primary"); await h.settle();
    assert.equal(card.querySelector<HTMLButtonElement>(".piano-roll-zoom-in")!.disabled, false);
    h.releaseHeldConfirmation(); await h.settle();
    assert.deepEqual(jsonCalls(h, "/confirm"), [{ path: "/confirm", body: { id: "confirmation-1", apply: true } }]);
    assert.equal(h.document.querySelector("[data-pending-confirmation]"), null);
    assert.equal(h.document.querySelector("[data-operation-id]"), card);
    assert.notEqual(card.closest<HTMLElement>(".timeline-activity-step")!.dataset.status, "complete"); assert.equal(card.querySelector(".timeline-activity-detail-content[role=\"status\"]")!.textContent, "");
    h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1",
      event: event("outcome", "apply_result", "Notes written", { applyOperation: { id: "operation-1", status: "applied" } }) });
    await h.settle();
    assert.equal(card.closest<HTMLElement>(".timeline-activity-step")!.dataset.status, "complete"); assert.equal(card.querySelector("svg"), svg);
    assert.equal(card.hasAttribute("aria-busy"), false);
    assert.equal(card.querySelector<HTMLButtonElement>(".piano-roll-zoom-in")!.disabled, false);
    assert.equal(card.querySelector(".piano-roll-span")!.textContent, span);
    assert.match(card.textContent!, /Notes written/); assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});


test("a directly created MIDI Clip exposes its captured score through one disclosure", async () => {
  const fixture = midiPreviewFixture(); fixture.track.arrangementClips.length = 0;
  const notes = Array.from({ length: 42 }, (_, index) => ({ pitch: 55 + index % 12, startTime: Math.floor(index / 3) * 2, duration: 2, velocity: 96 }));
  const observation = await captureLiveActionPreflightObservation(fixture.context, {
    type: "create_midi_clip", name: "G Major Pop Progression", startBeat: 0, durationBeats: 32, notes,
  }, { track: fixture.track });
  assert.equal(observation.preview?.kind, "midi-notes");
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.events = [event("create-request", "apply_requested", "Create a 32-beat Clip with 42 notes", {
    applyOperation: { id: "create-operation", status: "proposed", previews: [observation.preview!] },
  }), event("create-result", "apply_result", "Created G Major Pop Progression with 42 notes", {
    applyOperation: { id: "create-operation", status: "applied" },
  })];
  const h = await createDialogHarness(state);
  try {
    const step = h.document.querySelector<HTMLDetailsElement>('[data-activity-step-id="create-operation"]')!;
    assert.equal(step.open, false);
    step.querySelector<HTMLElement>(":scope > summary")!.click();
    const review = step.querySelector<HTMLElement>('[data-operation-id="create-operation"]')!;
    assert.equal(review.closest("details:not([open])"), null);
    button(review, "Full view").click();
    assert.equal(review.querySelectorAll(".piano-roll-note").length, 42);
    assert.equal(review.querySelector(".piano-roll-span")!.textContent, "32 beats");
    button(review, "Before · 0 notes").click();
    assert.equal(review.querySelectorAll(".piano-roll-note").length, 0);
    assert.match(review.textContent!, /No notes/);
    step.querySelector<HTMLElement>(":scope > summary")!.click(); assert.equal(step.open, false);
    assert.equal(fixture.writes, 0); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
