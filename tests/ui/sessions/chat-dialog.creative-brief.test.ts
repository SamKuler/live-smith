import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../../src/agent/creative-brief.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

test("Session brief drafts survive navigation; only Save submits the exact Session and base", async (t) => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Keep the bass motif";
  state.sessions[1]!.creativeBrief = "Lead: legato";
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  const brief = () => harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value;
  harness.click("#contextTab");
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

for (const peerBrief of ["Newer peer brief", "Original"]) {
  test(`a delayed brief Save cannot replace a peer snapshot containing ${peerBrief}`, async () => {
    const state = stateFixture();
    state.sessions[0]!.creativeBrief = "Original";
    const harness = await createDialogHarness(state);
    const fetch = harness.window.fetch;
    let release!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { release = resolve; });
    let savedResponse: typeof state | undefined;
    let peerResponse: typeof state | undefined;
    Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/command" && JSON.parse(String(init?.body)).kind === "set_session_creative_brief") {
        const readJson = response.json.bind(response);
        response.json = async () => {
          const body = await readJson();
          savedResponse = body;
          await delayedResponse;
          return body;
        };
      }
      if (new URL(String(input)).pathname === "/state") {
        const readJson = response.json.bind(response);
        response.json = async () => {
          const body = await readJson();
          peerResponse = body;
          return body;
        };
      }
      return response;
    } });
    try {
      harness.input("#creativeBrief", "Local brief");
      harness.click("#saveCreativeBriefButton");
      await waitForCondition(() => savedResponse !== undefined, "Expected the saved brief response to be held");
      const peer = cloneState(savedResponse!);
      peer.sessions[0]!.creativeBrief = peerBrief;
      harness.setServerState(peer);
      harness.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
      await waitForCondition(() => peerResponse !== undefined && harness.document.querySelector("#creativeBriefSavedText")!.textContent === peerBrief &&
        harness.document.querySelector<HTMLElement>("#creativeBriefConflict")!.hidden === (peerBrief === "Original"),
      "Expected the peer brief to be observed before the old Save response");
      assert.ok(BigInt(peerResponse!.bridgeStateCoveredThroughRevision) >= BigInt(savedResponse!.bridgeStateRevision));
      release();
      await harness.settle();
      assert.equal(harness.document.querySelector("#creativeBriefSavedText")!.textContent, peerBrief);
      assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Local brief");
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveCreativeBriefButton")!.disabled, peerBrief !== "Original");
      assert.equal(commandCalls(harness).length, 1);
      assert.deepEqual(harness.errors, []);
    } finally {
      release();
      await harness.settle();
      harness.close();
    }
  });
}

test("a later approval patch preserves both the committed brief and its own Session field", async () => {
  const state = stateFixture();
  state.sessions[0]!.creativeBrief = "Original";
  const harness = await createDialogHarness(state);
  const fetch = harness.window.fetch;
  let release!: () => void;
  const delayedResponse = new Promise<void>((resolve) => { release = resolve; });
  let savedResponse: typeof state | undefined;
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname === "/command") {
      const readJson = response.json.bind(response);
      response.json = async () => {
        const body = await readJson(); savedResponse = body;
        await delayedResponse; return body;
      };
    }
    return response;
  } });
  try {
    harness.input("#creativeBrief", "Local brief"); harness.click("#saveCreativeBriefButton");
    await waitForCondition(() => savedResponse !== undefined, "Expected the saved brief response to be held");
    harness.emitServerEvent({ type: "approval_mode_changed", sessionId: "session-1", approvalMode: "everything" });
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#approvalMode")!.value, "everything");
    release(); await harness.settle();
    assert.equal(harness.document.querySelector("#creativeBriefSavedText")!.textContent, "Local brief");
    assert.equal(harness.document.querySelector("#creativeBriefStatus")!.textContent, "Saved for this Session");
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#approvalMode")!.value, "everything");
    assert.deepEqual(harness.errors, []);
  } finally { release(); await harness.settle(); harness.close(); }
});
