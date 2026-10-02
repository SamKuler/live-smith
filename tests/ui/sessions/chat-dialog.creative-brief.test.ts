import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../../src/agent/creative-brief.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

test("Session brief drafts survive navigation; only Save submits the exact Session and base", async (t) => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Keep the bass motif";
  state.sessions[1]!.creativeBrief = "Lead: legato";
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  const brief = () => harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value;
  harness.click("#creativeBriefButton");
  assert.equal(harness.document.querySelector<HTMLElement>("#contextPanel")!.hidden, false);
  assert.equal(brief(), "Keep the bass motif");
  harness.input("#creativeBrief", "Keep bass; sparse percussion");
  assert.equal(commandCalls(harness).length, 0);
  harness.click('[data-session-id="session-2"] .session-row');
  await harness.settle();
  assert.equal(brief(), "Lead: legato");
  harness.input("#creativeBrief", "Lead: monophonic");
  harness.click('[data-session-id="session-1"] .session-row');
  await harness.settle();
  assert.equal(brief(), "Keep bass; sparse percussion");
  harness.click("#saveCreativeBriefButton");
  await harness.settle();
  assert.deepEqual(commandCalls(harness).map((entry) => entry.body as Record<string, unknown>).filter((entry) => entry.kind === "set_session_creative_brief"), [{
    kind: "set_session_creative_brief", sessionId: "session-1",
    creativeBrief: "Keep bass; sparse percussion", expectedCreativeBrief: "Keep the bass motif",
  }]);
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, true);
  harness.click('[data-session-id="session-2"] .session-row');
  await harness.settle();
  assert.equal(brief(), "Lead: monophonic");
  harness.click("#resetCreativeBriefButton");
  assert.equal(brief(), "Lead: legato");
  assert.deepEqual(harness.errors, []);
});

test("peer changes and a lost save response retain a draft until explicit conflict review", async (t) => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Original";
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  harness.input("#creativeBrief", "Local changes");
  const peer = cloneState(state);
  peer.sessions[0]!.creativeBrief = "Peer changes";
  harness.setServerState(peer);
  harness.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
  await waitForCondition(() => !harness.document.querySelector<HTMLElement>("#creativeBriefConflict")!.hidden, "brief conflict");
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Local changes");
  assert.equal(harness.document.querySelector("#creativeBriefSavedText")!.textContent, "Peer changes");
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, true);
  harness.click("#rebaseCreativeBriefButton");
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, false);
  harness.rejectNextCommandResponse("Lost response");
  harness.click("#saveCreativeBriefButton");
  await harness.settle();
  assert.deepEqual(commandCalls(harness).at(-1)?.body, {
    kind: "set_session_creative_brief", sessionId: "session-1", creativeBrief: "Local changes", expectedCreativeBrief: "Peer changes",
  });
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Local changes");
  assert.deepEqual(harness.errors, []);
});

test("model suggestion only becomes a draft on explicit review and metadata on explicit Save", async (t) => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Keep bass";
  state.events = [{ id: "event-brief-proposal", kind: "tool_result", name: "propose_creative_brief",
    content: JSON.stringify({ creativeBrief: "Keep bass; add contrasting bridge", expectedCreativeBrief: "Keep bass", saved: false }),
    createdAt: "2026-08-01T00:00:00.000Z" }];
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Keep bass");
  assert.equal(commandCalls(harness).length, 0);
  harness.click("#useCreativeBriefProposalButton");
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Keep bass; add contrasting bridge");
  assert.equal(commandCalls(harness).length, 0);
  harness.click("#saveCreativeBriefButton");
  await harness.settle();
  assert.equal(commandCalls(harness).map((entry) => entry.body as Record<string, unknown>).filter((entry) => entry.kind === "set_session_creative_brief").length, 1);
  assert.equal(harness.document.querySelector<HTMLElement>("#creativeBriefProposal")!.hidden, true);
});

test("compaction and model updates preserve the brief draft, and over-limit input cannot be saved", async (t) => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Saved structure";
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  harness.input("#creativeBrief", "Draft structure");
  const compacted = cloneState(state);
  compacted.events = [{ id: "event-checkpoint", kind: "compaction", content: "Checkpoint without preferences", createdAt: "2026-08-01T00:00:00.000Z" }];
  compacted.sessions[0]!.modelSelection = { profileId: "profile-1", model: "other-model" };
  harness.setServerState(compacted);
  harness.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
  await harness.settle();
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Draft structure");
  harness.input("#creativeBrief", "🎵".repeat(MAX_CREATIVE_BRIEF_CODE_POINTS));
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, false);
  harness.input("#creativeBrief", "🎵".repeat(MAX_CREATIVE_BRIEF_CODE_POINTS + 1));
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, true);
  harness.click("#saveCreativeBriefButton");
  assert.equal(commandCalls(harness).length, 0);
});


test("stale model suggestions need explicit conflict review before Save", async (t) => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Current saved brief";
  state.events = [{ id: "event-old-brief", kind: "tool_result", name: "propose_creative_brief",
    content: JSON.stringify({ creativeBrief: "Old suggestion", expectedCreativeBrief: "Older saved brief", saved: false }),
    createdAt: "2026-08-01T00:00:00.000Z" }];
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  harness.click("#useCreativeBriefProposalButton");
  assert.equal(harness.document.querySelector<HTMLElement>("#creativeBriefConflict")!.hidden, false);
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, true);
  harness.click("#saveCreativeBriefButton");
  assert.equal(commandCalls(harness).length, 0);
  harness.click("#rebaseCreativeBriefButton");
  harness.click("#saveCreativeBriefButton");
  await harness.settle();
  assert.equal((commandCalls(harness)[0]?.body as Record<string, unknown>).expectedCreativeBrief, "Current saved brief");
});

test("brief drafts remain editable during a send and can be saved only after it finishes", async (t) => {
  const harness = await createDialogHarness(stateFixture());
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "Inspect only");
  harness.click("#sendButton");
  await harness.settle();
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.disabled, false);
  harness.input("#creativeBrief", "Keep lead motif");
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, true);
  harness.releaseHeldSend();
  await harness.settle();
  assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Keep lead motif");
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, false);
});
