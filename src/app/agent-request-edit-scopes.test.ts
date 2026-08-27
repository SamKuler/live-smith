import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentPlan } from "../agent/actions.js";
import type { EditScope } from "../agent/edit-scopes.js";
import type { ModelTurn } from "../model/contracts.js";
import type { ApprovalMode, SavedProfile } from "../model/profile.js";
import { loadSessionEvents } from "../storage/events.js";
import { createSession, updateSession } from "../storage/sessions.js";
import { decidePlanApproval } from "./agent-flow.js";
import { handleAgentRequest, preflightAgentPlan, type AgentModelTurnRequester } from "./agent-request.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";
import {
  invalidateSessionEditScopes,
  publishSessionEditScopesChange,
} from "./session-edit-scope-events.js";
import { withStorageTransaction } from "../storage/persistence.js";
import { updateSessionInTransaction } from "../storage/sessions.js";

const profile: SavedProfile = {
  id: "scope-profile",
  name: "Provider",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
  },
  defaultModel: "scope-test-model",
  models: [{
    model: "scope-test-model",
    parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } },
    advanced: {},
  }],
};

async function setup(t: TestContext, scopes: EditScope[], mode: ApprovalMode = "everything") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-edit-scope-request-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Scoped work",
    projectKey: "project-scopes",
    scope: { kind: "selection", identity: "set", label: "Live Set" },
    approvalMode: mode,
    editScopes: scopes,
  });
  const mutations: number[] = [];
  let tempo = 120;
  let createdTracks = 0;
  let afterCreate: (() => Promise<void>) | undefined;
  const song = {
    handle: { id: 1n },
    tracks: [],
    scenes: [],
    cuePoints: [],
    gridQuantization: 0,
    gridIsTriplet: false,
    scaleMode: false,
    scaleName: "",
    rootNote: 0,
    scaleIntervals: [],
    get tempo() { return tempo; },
    set tempo(value: number) {
      tempo = value;
      mutations.push(value);
    },
    createMidiTrack: async () => {
      createdTracks += 1;
      await afterCreate?.();
      return { handle: { id: 2n }, name: "MIDI 1" };
    },
  };
  const modelScopes: (readonly EditScope[] | undefined)[] = [];
  let confirmations = 0;
  const run = async (
    plan: AgentPlan,
    options: {
      confirm?: () => Promise<boolean>;
      lock?: Parameters<typeof handleAgentRequest>[7]["withActionExecutionLock"];
      model?: (input: Parameters<AgentModelTurnRequester>[0], turn: number) => Promise<ModelTurn>;
    } = {},
  ) => {
    let turn = 0;
    return handleAgentRequest(
      { application: { song }, environment: { storageDirectory: directory } } as never,
      directory,
      { summary: "Live Set", target: {}, scope: session.scope },
      "Apply the requested changes.",
      runtimeProfileForSavedProfile(profile),
      session.projectKey,
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onProgress: () => {},
        onSessionEvent: () => {},
        confirmActions: (requestedPlan) => decidePlanApproval(
          directory,
          session.id,
          requestedPlan,
          async () => {
            confirmations += 1;
            return options.confirm ? options.confirm() : true;
          },
        ),
        ...(options.lock ? { withActionExecutionLock: options.lock } : {}),
      },
      async (input) => {
        turn += 1;
        modelScopes.push(input.editScopes);
        if (options.model) return options.model(input, turn);
        return turn === 1
          ? {
              content: "Proposing changes.",
              toolCalls: [{
                id: "scoped-plan",
                name: "apply_live_actions",
                arguments: JSON.stringify(plan),
              }],
            }
          : { content: "Finished.", toolCalls: [] };
      },
    );
  };
  return {
    session, directory, mutations, modelScopes, run,
    get confirmations() { return confirmations; },
    get createdTracks() { return createdTracks; },
    afterCreate(callback: () => Promise<void>) { afterCreate = callback; },
    commitScopes: (editScopes: EditScope[]) => withStorageTransaction(directory, async (transaction) => {
      const current = await updateSessionInTransaction(transaction, directory, session.id, { editScopes });
      publishSessionEditScopesChange(directory, { sessionId: session.id, editScopes, updatedAt: current.updatedAt });
    }),
    events: () => loadSessionEvents(directory, session.id),
  };
}

const tempoPlan: AgentPlan = {
  message: "Change the tempo",
  actions: [{ type: "set_tempo", tempo: 128 }],
};

test("out-of-scope writes are denied before confirmation under every approval mode", async (t) => {
  for (const mode of ["manual", "low-risk", "everything"] as const) {
    await t.test(mode, async (t) => {
      const h = await setup(t, ["midi"], mode);
      assert.equal(await h.run(tempoPlan), "Finished.");
      assert.deepEqual(h.mutations, []);
      assert.equal(h.confirmations, 0);
      const events = await h.events();
      assert.ok(events.some((event) => event.kind === "tool_result" && /edit scope/i.test(event.content)));
      assert.equal(events.some((event) => event.kind === "apply_auto_approved"), false);
      assert.equal(events.some((event) => event.recovery?.active), false);
    });
  }
});

test("authorized writes retain the Session's independent approval policy", async (t) => {
  const h = await setup(t, ["structure"], "manual");
  await h.run(tempoPlan);
  assert.deepEqual(h.mutations, [128]);
  assert.equal(h.confirmations, 1);
  assert.deepEqual(h.modelScopes, [["structure"], ["structure"]]);
});

test("a mixed plan is rejected as a whole before any allowed action runs", async (t) => {
  const h = await setup(t, ["structure"]);
  await h.run({
    message: "Create MIDI track and add an instrument",
    actions: [
      { type: "create_midi_track", ref: "new-track", name: "Lead" },
      { type: "insert_device", trackRef: "new-track", deviceName: "Simpler" },
    ],
  });
  const events = await h.events();
  assert.ok(events.some((event) => event.kind === "tool_result" && /Devices/.test(event.content)));
  assert.equal(events.some((event) => event.kind === "apply_requested"), false);
  assert.equal(events.some((event) => event.recovery?.active), false);
  assert.equal(h.createdTracks, 0);
});

test("revocation during confirmation blocks the previously approved plan", async (t) => {
  const h = await setup(t, ["structure"], "manual");
  await h.run(tempoPlan, {
    confirm: async () => {
      await updateSession(h.directory, h.session.id, { editScopes: [] });
      return true;
    },
  });
  assert.deepEqual(h.mutations, []);
  assert.equal(h.confirmations, 1);
  assert.ok((await h.events()).some((event) => event.kind === "tool_result" && /edit scope/i.test(event.content)));
});

test("queued execution rechecks saved permissions after taking the mutation lock", async (t) => {
  const h = await setup(t, ["structure"]);
  let queued = false;
  await h.run(tempoPlan, {
    lock: async (operation) => {
      queued = true;
      await updateSession(h.directory, h.session.id, { editScopes: [] });
      return operation();
    },
  });
  assert.equal(queued, true);
  assert.deepEqual(h.mutations, []);
  const events = await h.events();
  assert.equal(events.some((event) => event.recovery?.active), false);
  assert.ok(events.some((event) => event.kind === "tool_result" && /edit scope/i.test(event.content)));
});

test("revocation after an action stops the next write and preserves partial recovery", async (t) => {
  const h = await setup(t, ["structure"]);
  h.afterCreate(() => h.commitScopes([]));
  const result = await h.run({
    message: "Create track and change tempo",
    actions: [
      { type: "create_midi_track" },
      { type: "set_tempo", tempo: 130 },
    ],
  });
  assert.equal(h.createdTracks, 1);
  assert.deepEqual(h.mutations, []);
  assert.match(result, /unfinished Live work/i);
  const partial = (await h.events()).find((event) => event.recovery?.active);
  assert.ok(partial);
  assert.match(partial.content, /edit scope/i);
});

test("unverifiable permissions stop a running plan at the next action", async (t) => {
  const h = await setup(t, ["structure"]);
  h.afterCreate(async () => { invalidateSessionEditScopes(h.directory, h.session.id); });
  await h.run({
    message: "Create track and change tempo",
    actions: [{ type: "create_midi_track" }, { type: "set_tempo", tempo: 130 }],
  });
  assert.equal(h.createdTracks, 1);
  assert.deepEqual(h.mutations, []);
  assert.ok((await h.events()).some((event) => /edit scope could not be verified/.test(event.content)));
});

test("permission refresh completes before the final Live state drift comparison", async () => {
  let tempo = 120;
  let refreshes = 0;
  const guard = await preflightAgentPlan(
    { application: { song: { tracks: [] } } } as never,
    { target: {} } as never,
    tempoPlan,
    new AbortController().signal,
    async () => "Observed tempo",
    () => String(tempo),
    {
      refresh: async () => { if (++refreshes === 2) tempo = 130; },
      assert: () => {},
    },
  );
  await assert.rejects(guard, /Live target or relevant state changed/);
  assert.equal(refreshes, 2);
});

test("read-only Sessions can observe and model turns receive refreshed saved scopes", async (t) => {
  const h = await setup(t, []);
  await h.run(tempoPlan, {
    model: async (_input, turn) => {
      if (turn > 1) return { content: "Observed without editing.", toolCalls: [] };
      await updateSession(h.directory, h.session.id, { editScopes: ["midi"] });
      return { content: "Inspecting.", toolCalls: [{ id: "observe", name: "inspect_song_info", arguments: "{}" }] };
    },
  });
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.modelScopes, [[], ["midi"]]);
  assert.ok((await h.events()).some((event) => event.kind === "tool_result" && event.name === "inspect_song_info"));
});
