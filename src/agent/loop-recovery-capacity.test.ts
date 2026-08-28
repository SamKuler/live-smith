import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentPartialCompletionError,
  digestActionIdentity,
  runAgentLoop,
} from "./loop.js";
import {
  LEGACY_MAX_RECOVERY_ACTION_DIGESTS,
  MAX_RECOVERY_ACTION_DIGESTS,
  MAX_RECOVERY_PLAN_IDENTITY_DIGESTS,
} from "./recovery-contract.js";

function mutationOutcome(results: string[]) {
  return { results, mutationCount: results.length };
}

test("the recovery ledger reserves durable capacity before more Live work", async (t) => {
  const initialDigests = Array.from(
    {
      length: LEGACY_MAX_RECOVERY_ACTION_DIGESTS,
    },
    (_value, index) => digestActionIdentity(`existing-recovery-${index}`),
  );

  await t.test("non-final work is rejected before confirmation", async () => {
    let modelCalls = 0;
    let confirmations = 0;
    let executions = 0;
    const result = await runAgentLoop({
      maxConsecutiveFailures: 3,
      initialRecoveryState: {
        completedActionDigests: initialDigests,
        unresolvedFailure: "Earlier Live work remains unfinished.",
      },
      askModel: async () => ++modelCalls === 1
        ? {
            content: "Starting unrelated work.",
            toolCalls: [{
              id: "overfill-recovery",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Start another change",
                actions: [{ type: "set_tempo", tempo: 128 }],
              }),
            }],
          }
        : { content: "I must finish the existing recovery first.", toolCalls: [] },
      observe: async () => "Tempo: 120 BPM",
      preflightActions: async () => Object.assign(
        async () => undefined,
        { actionKeys: [["new-semantic-action"]] },
      ),
      confirmActions: async () => {
        confirmations += 1;
        return true;
      },
      executeActions: async () => {
        executions += 1;
        return mutationOutcome(["Set tempo."]);
      },
    });
    assert.equal(confirmations, 0);
    assert.equal(executions, 0);
    assert.match(result.message, /unfinished Live work/i);
  });

  await t.test("an exact legacy-limit ledger may still clear through a final repair", async () => {
    let modelCalls = 0;
    let executions = 0;
    const result = await runAgentLoop({
      maxConsecutiveFailures: 3,
      initialRecoveryState: {
        completedActionDigests: initialDigests,
        unresolvedFailure: "Earlier Live work remains unfinished.",
      },
      askModel: async () => ++modelCalls === 1
        ? {
            content: "Finishing the remaining repair.",
            toolCalls: [{
              id: "finish-bounded-recovery",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Finish the tempo repair",
                resolvesPriorFailure: true,
                actions: [{ type: "set_tempo", tempo: 128 }],
              }),
            }],
          }
        : { content: "The recovery is complete.", toolCalls: [] },
      observe: async () => "Tempo: 120 BPM",
      preflightActions: async () => Object.assign(
        async () => undefined,
        { actionKeys: [["final-semantic-action"]] },
      ),
      confirmActions: async () => true,
      executeActions: async () => {
        executions += 1;
        return mutationOutcome(["Set tempo to 128 BPM."]);
      },
    });
    assert.equal(executions, 1);
    assert.equal(result.message, "The recovery is complete.");
  });

  await t.test("a legacy-limit final repair can persist its full partial-execution reserve", async () => {
    let modelCalls = 0;
    const recoveryUpdates: Array<{
      active: boolean;
      completedActionDigests: string[];
    }> = [];
    const actions = [
      { type: "set_tempo" as const, tempo: 128 },
      { type: "set_tempo" as const, tempo: 129 },
    ];
    const knownSemanticKeys = Array.from(
      { length: MAX_RECOVERY_PLAN_IDENTITY_DIGESTS - actions.length },
      (_value, index) => `legacy-final-known-${index}`,
    );
    const partialExecutionKeys = Array.from(
      { length: MAX_RECOVERY_PLAN_IDENTITY_DIGESTS },
      (_value, index) => `legacy-final-partial-${index}`,
    );
    const result = await runAgentLoop({
      maxConsecutiveFailures: 3,
      initialRecoveryState: {
        completedActionDigests: initialDigests,
        unresolvedFailure: "Earlier Live work remains unfinished.",
      },
      askModel: async () => ++modelCalls === 1
        ? {
            content: "Finishing the legacy recovery.",
            toolCalls: [{
              id: "finish-legacy-recovery-partially",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Finish the legacy repair",
                resolvesPriorFailure: true,
                actions,
              }),
            }],
          }
        : { content: "The final repair still needs attention.", toolCalls: [] },
      observe: async () => "Tempo: 128 BPM",
      preflightActions: async () => Object.assign(
        async () => undefined,
        {
          actionKeys: [
            knownSemanticKeys.slice(0, knownSemanticKeys.length / 2),
            knownSemanticKeys.slice(knownSemanticKeys.length / 2),
          ],
        },
      ),
      confirmActions: async () => true,
      executeActions: async () => {
        throw new AgentPartialCompletionError(
          ["Set tempo to 128 BPM."],
          new Error("The second action failed."),
          1,
          actions[1],
          undefined,
          [[...knownSemanticKeys, ...partialExecutionKeys]],
          1,
          undefined,
          1,
        );
      },
      onEvent: (event) => {
        if (event.kind === "apply_result" && event.recovery) {
          recoveryUpdates.push(event.recovery);
        }
      },
    });

    assert.match(result.message, /unfinished Live work/i);
    const update = recoveryUpdates.at(-1);
    assert.equal(update?.active, true);
    assert.equal(
      update?.completedActionDigests.length,
      MAX_RECOVERY_ACTION_DIGESTS - 1,
    );
  });

  await t.test("a near-full ledger can be inspected, closed by the user, and followed by new work", async () => {
    let modelCalls = 0;
    let confirmations = 0;
    let executions = 0;
    let recoveryFailure = "";
    const recoveryUpdates: Array<{
      active: boolean;
      completedActionDigests: string[];
    }> = [];
    const result = await runAgentLoop({
      maxConsecutiveFailures: 3,
      initialRecoveryState: {
        completedActionDigests: Array.from(
          { length: MAX_RECOVERY_ACTION_DIGESTS - 3 },
          (_value, index) => digestActionIdentity(`near-full-recovery-${index}`),
        ),
        unresolvedFailure: "Earlier Live work remains unfinished.",
      },
      askModel: async (input) => {
        modelCalls += 1;
        if (modelCalls === 2) {
          recoveryFailure = input.messages.at(-1)?.content ?? "";
          return {
            content: "I will inspect before asking what to keep.",
            toolCalls: [{
              id: "inspect-near-full-recovery",
              name: "inspect_live_set",
              arguments: "{}",
            }],
          };
        }
        if (modelCalls === 3) {
          return {
            content: "The current state is ready for the user's decision.",
            toolCalls: [{
              id: "resolve-near-full-recovery",
              name: "resolve_live_recovery",
              arguments: "{}",
            }],
          };
        }
        return {
            content: "Finishing the remaining repair.",
            toolCalls: [{
              id: "finish-near-full-recovery",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Finish the repair",
                resolvesPriorFailure: true,
                actions: [{ type: "set_tempo", tempo: 128 }],
              }),
            }],
          };
      },
      observe: async () => "Tempo: 120 BPM",
      preflightActions: async () => Object.assign(
        async () => undefined,
        { actionKeys: [["near-full-final-semantic-action"]] },
      ),
      confirmActions: async () => {
        confirmations += 1;
        return true;
      },
      confirmRecoveryResolution: async (message) => {
        confirmations += 1;
        assert.match(message, /keep the Live changes already completed/i);
        assert.match(message, /does not undo|does not perform a Live mutation/i);
        return true;
      },
      executeActions: async () => {
        executions += 1;
        return mutationOutcome(["Set tempo to 128 BPM."]);
      },
      onEvent: (event) => {
        if (event.kind === "apply_result" && event.recovery) {
          recoveryUpdates.push(event.recovery);
        }
      },
    });
    assert.equal(confirmations, 1);
    assert.equal(executions, 0);
    assert.match(result.message, /closed the unfinished operation/i);
    assert.match(recoveryFailure, /bounded replay ledger/i);
    assert.deepEqual(recoveryUpdates.at(-1), {
      active: false,
      completedActionDigests: [],
    });

    let nextModelCalls = 0;
    const next = await runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async () => ++nextModelCalls === 1
        ? {
            content: "Starting newly requested work.",
            toolCalls: [{
              id: "new-work-after-recovery-close",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Set a new tempo",
                actions: [{ type: "set_tempo", tempo: 130 }],
              }),
            }],
          }
        : { content: "The new work is complete.", toolCalls: [] },
      observe: async () => "Tempo: 128 BPM",
      preflightActions: async () => async () => undefined,
      confirmActions: async () => true,
      executeActions: async () => mutationOutcome(["Set tempo to 130 BPM."]),
    });
    assert.equal(next.message, "The new work is complete.");
  });
});
