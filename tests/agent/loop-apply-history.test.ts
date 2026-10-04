import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop, AgentPartialCompletionError, type AgentLoopTraceEvent, type AgentLoopOptions } from "../../src/agent/loop.js";
import type { AgentActionPreview } from "../../src/agent/action-preview.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { EditScopeDeniedError } from "../../src/agent/edit-scopes.js";
import { modelMessageText } from "../model/support/model-message-test-helpers.js";

const preview: AgentActionPreview = { kind: "parameter-value", actionIndex: 0, status: "proposed", targetLabel: "Tempo", parameterName: "Tempo", before: 120, after: 125, minimum: 20, maximum: 999 };
async function run(overrides: Partial<AgentLoopOptions> = {}) {
  const events: AgentLoopTraceEvent[] = [];
  let turn = 0;
  let operationId: string | undefined;
  const promise = runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ++turn === 1 ? { content: null, toolCalls: [{ id: "apply-1", name: "apply_live_actions", arguments: JSON.stringify({ message: "Tempo", actions: [{ type: "set_tempo", tempo: 125 }] }) }] } : { content: "Finished", toolCalls: [] },
    observe: async () => "Current tempo: 125",
    preflightActions: async () => Object.assign(async () => undefined, { previews: [preview] }),
    confirmActions: async (_plan, _guard, id) => { operationId = id; return true; },
    executeActions: async () => ({ results: ["Tempo set to 125"], mutationCount: 1 }),
    onEvent: (event) => { events.push(event); },
    ...overrides,
  });
  await promise;
  return { events, operationId };
}

test("manual approval preserves proposal and links the confirmed operation to its result", async () => {
  const { events, operationId } = await run();
  const proposal = events.find((event) => event.kind === "apply_requested")!;
  const result = events.find((event) => event.kind === "apply_result")!;
  assert.ok("applyOperation" in proposal && proposal.applyOperation);
  assert.equal(proposal.applyOperation.id, operationId);
  assert.deepEqual(proposal.applyOperation.previews, [preview]);
  assert.ok("applyOperation" in result && result.applyOperation);
  assert.deepEqual(result.applyOperation, { id: operationId, status: "applied" });
  assert.equal(preview.status, "proposed");
});

test("automatic approval, refusal, failures and partial mutations retain distinct structured states", async () => {
  for (const mode of ["automatic", "cancel", "failed", "partial", "drift"] as const) {
    const { events } = await run({
      confirmActions: async () => mode === "automatic" ? { confirmed: true, source: "automatic", mode: "everything" } : mode !== "cancel",
      ...(mode === "drift" ? { preflightActions: async () => async () => { throw new Error("Changed target"); } } : {}),
      executeActions: async () => {
        if (mode === "failed" || mode === "partial") throw new AgentPartialCompletionError(mode === "partial" ? ["Created object"] : [], new Error("Host failure"), undefined, undefined, undefined, [], mode === "partial" ? 1 : 0);
        return { results: ["Applied"], mutationCount: 1 };
      },
    });
    const operations = events.flatMap((event) => "applyOperation" in event && event.applyOperation ? [event.applyOperation] : []);
    assert.equal(operations[0]?.status, "proposed", mode);
    assert.equal(new Set(operations.map((operation) => operation.id)).size, 1, mode);
    assert.equal(operations.at(-1)?.status, mode === "automatic" ? "applied" : mode === "cancel" ? "cancelled" : mode === "partial" ? "partial" : "failed", mode);
    assert.equal(operations.some((operation) => operation.status === "approved"), mode === "automatic");
  }
});

test("stop while confirmation is open records cancellation before propagating abort", async () => {
  const controller = createHostAbortController();
  const events: AgentLoopTraceEvent[] = [];
  await assert.rejects(run({ signal: controller.signal, onEvent: (event) => { events.push(event); }, confirmActions: async () => { controller.abort(); return false; } }));
  const results = events.filter((event) => event.kind === "apply_result");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.applyOperation?.status, "cancelled");
});

for (const failure of ["scope-before-proposal", "scope-after-approval", "target-drift", "confirmation-error"] as const) {
  test(`${failure} records one terminal event and preserves the model tool result`, async () => {
    let turn = 0;
    let modelResult = "";
    const { events } = await run({
      askModel: async ({ messages }) => {
        if (++turn === 1) return { content: null, toolCalls: [{ id: "apply-failure", name: "apply_live_actions",
          arguments: JSON.stringify({ message: "Tempo", actions: [{ type: "set_tempo", tempo: 125 }] }) }] };
        modelResult = modelMessageText(messages.at(-1));
        return { content: "The changes were not applied.", toolCalls: [] };
      },
      preflightActions: async () => {
        if (failure === "scope-before-proposal") throw new EditScopeDeniedError(["structure"]);
        return async () => {
          if (failure === "scope-after-approval") throw new EditScopeDeniedError(["structure"]);
          if (failure === "target-drift") throw new Error("Changed target");
        };
      },
      confirmActions: async () => {
        if (failure === "confirmation-error") throw new Error("Confirmation unavailable");
        return true;
      },
      executeActions: async () => assert.fail("A rejected plan must not execute"),
    });
    const terminal = events.filter((event) => ["apply_result", "tool_result", "error"].includes(event.kind));
    assert.equal(terminal.length, 1);
    if (failure === "scope-before-proposal") {
      assert.equal(terminal[0]!.kind, "tool_result");
      assert.equal(events.some((event) => event.kind === "apply_requested"), false);
    } else {
      assert.equal(terminal[0]!.kind, "apply_result");
      assert.equal(terminal[0]!.kind === "apply_result" && terminal[0]!.applyOperation?.status, "failed");
    }
    assert.match(modelResult, failure.startsWith("scope-") ? /No Live changes from this plan were applied/
      : failure === "target-drift" ? /Changed target/ : /Confirmation unavailable/);
  });
}

test("registered external tools forward saved artifact references without inspecting result prose", async () => {
  const artifacts = [{ kind: "midi" as const, id: "midi-saved" }];
  const events: AgentLoopTraceEvent[] = [];
  let turn = 0;
  await run({
    askModel: async () => ++turn === 1 ? { content: null, toolCalls: [{ id: "save-1", name: "save_midi_artifact", arguments: "{}" }] } : { content: "Saved", toolCalls: [] },
    externalTools: { names: ["save_midi_artifact"], execute: async () => ({ content: "Saved notes", artifacts }) },
    onEvent: (event) => { events.push(event); },
  });
  assert.deepEqual(events.find((event) => event.kind === "tool_result")?.artifacts, artifacts);
});
