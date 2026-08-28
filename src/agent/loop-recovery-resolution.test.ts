import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentPartialCompletionError,
  AgentRecoveryResolutionReportingError,
  digestActionIdentity,
  runAgentLoop,
} from "./loop.js";

const initialRecoveryState = {
  completedActionDigests: [digestActionIdentity("completed-before-restart")],
  unresolvedFailure: "Earlier Live work remains unfinished.",
};

test("cross-request recovery requires inspect_live_set before user resolution", async () => {
  let modelCalls = 0;
  let resolutionConfirmations = 0;
  const events: Array<{ kind: string; recovery?: { active: boolean } }> = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    initialRecoveryState,
    askModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "I will inspect a narrow target.",
          toolCalls: [{ id: "narrow", name: "inspect_track", arguments: "{}" }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Trying to close too early.",
          toolCalls: [{ id: "early", name: "resolve_live_recovery", arguments: "{}" }],
        };
      }
      if (modelCalls === 3) {
        return {
          content: "I will inspect the complete Set.",
          toolCalls: [{ id: "full", name: "inspect_live_set", arguments: "{}" }],
        };
      }
      return {
        content: "The user can now decide.",
        toolCalls: [{ id: "resolve", name: "resolve_live_recovery", arguments: "{}" }],
      };
    },
    observe: async (request) => `Observed ${request.type}`,
    confirmActions: async () => {
      throw new Error("Recovery resolution must not use Apply approval.");
    },
    confirmRecoveryResolution: async () => {
      resolutionConfirmations += 1;
      return true;
    },
    executeActions: async () => {
      throw new Error("Recovery resolution must not execute Live actions.");
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(resolutionConfirmations, 1);
  assert.match(result.message, /closed the unfinished operation/i);
  assert.equal(
    events.some((event) =>
      event.kind === "tool_result" &&
      "content" in event &&
      /inspect_live_set/i.test(String(event.content))
    ),
    true,
  );
  assert.equal(events.at(-1)?.recovery?.active, false);
});

test("recovery resolution always uses explicit user confirmation and rejection keeps the ledger", async () => {
  let modelCalls = 0;
  let applyConfirmations = 0;
  const recoveryEvents: Array<{ active: boolean; completedActionDigests: string[] }> = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    initialRecoveryState,
    askModel: async () => ++modelCalls === 1
      ? {
          content: "I will inspect the Set.",
          toolCalls: [{ id: "inspect", name: "inspect_live_set", arguments: "{}" }],
        }
      : {
          content: "Please decide whether to close it.",
          toolCalls: [{ id: "resolve", name: "resolve_live_recovery", arguments: "{}" }],
        },
    observe: async () => "Current Live Set",
    confirmActions: async () => {
      applyConfirmations += 1;
      return { confirmed: true, source: "automatic", mode: "everything" };
    },
    confirmRecoveryResolution: async () => false,
    executeActions: async () => {
      throw new Error("Recovery resolution must not execute Live actions.");
    },
    onEvent: (event) => {
      if (event.kind === "apply_result" && event.recovery) {
        recoveryEvents.push(event.recovery);
      }
    },
  });

  assert.equal(applyConfirmations, 0);
  assert.match(result.message, /kept the unfinished operation active/i);
  assert.deepEqual(recoveryEvents, []);
});

test("a successful automatic post-failure observation permits explicit resolution", async () => {
  let modelCalls = 0;
  let observed = 0;
  const action = { type: "set_tempo" as const, tempo: 128 };
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async () => ++modelCalls === 1
      ? {
          content: "Attempting the repair.",
          toolCalls: [{
            id: "partial",
            name: "apply_live_actions",
            arguments: JSON.stringify({ message: "Repair tempo", actions: [action] }),
          }],
        }
      : {
          content: "The refreshed state is acceptable.",
          toolCalls: [{ id: "resolve", name: "resolve_live_recovery", arguments: "{}" }],
        },
    observe: async () => {
      observed += 1;
      return "Tempo: 128 BPM";
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    confirmRecoveryResolution: async () => true,
    executeActions: async () => {
      throw new AgentPartialCompletionError(
        ["Changed the tempo before the host reported failure."],
        new Error("Host failure"),
        0,
        action,
        undefined,
        [["live-action-step:tempo"]],
        1,
        null,
        0,
      );
    },
  });

  assert.equal(observed, 1);
  assert.match(result.message, /closed the unfinished operation/i);
});

test("a mutating intermediate repair requires a new Live Set observation before resolution", async () => {
  let modelCalls = 0;
  let resolutionConfirmations = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    initialRecoveryState,
    askModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1 || modelCalls === 4) {
        return {
          content: "Inspecting the current Set.",
          toolCalls: [{
            id: `inspect-${modelCalls}`,
            name: "inspect_live_set",
            arguments: "{}",
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Applying one intermediate repair.",
          toolCalls: [{
            id: "intermediate",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Intermediate repair",
              actions: [{ type: "set_tempo", tempo: 128 }],
            }),
          }],
        };
      }
      return {
        content: "Asking the user to close the remainder.",
        toolCalls: [{
          id: `resolve-${modelCalls}`,
          name: "resolve_live_recovery",
          arguments: "{}",
        }],
      };
    },
    observe: async () => "Current Live Set",
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    confirmRecoveryResolution: async () => {
      resolutionConfirmations += 1;
      return true;
    },
    executeActions: async () => ({
      results: ["Set tempo to 128 BPM."],
      mutationCount: 1,
    }),
  });

  assert.equal(resolutionConfirmations, 1);
  assert.match(result.message, /closed the unfinished operation/i);
});

test("steering supersedes recovery resolution without recording a false Apply result", async () => {
  let modelCalls = 0;
  let steeringPending = false;
  const events: Array<{ kind: string; name?: string; content: string }> = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    initialRecoveryState,
    askModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Inspecting the current Set.",
          toolCalls: [{ id: "inspect", name: "inspect_live_set", arguments: "{}" }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Asking whether to close the recovery.",
          toolCalls: [{ id: "resolve", name: "resolve_live_recovery", arguments: "{}" }],
        };
      }
      return { content: "I will follow the newer guidance.", toolCalls: [] };
    },
    observe: async () => "Current Live Set",
    confirmActions: async () => {
      throw new Error("Recovery resolution must not use Apply approval.");
    },
    confirmRecoveryResolution: async () => {
      steeringPending = true;
      return true;
    },
    hasPendingSteering: () => steeringPending,
    consumeSteering: async () => {
      if (!steeringPending) return [];
      steeringPending = false;
      return ["Keep the recovery active and reconsider it."];
    },
    executeActions: async () => {
      throw new Error("Recovery resolution must not execute Live actions.");
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.match(result.message, /unfinished Live work/i);
  assert.equal(
    events.some((event) =>
      event.kind === "tool_result" &&
      event.name === "resolve_live_recovery" &&
      /newer user guidance/i.test(event.content)
    ),
    true,
  );
  assert.equal(
    events.some((event) =>
      event.kind === "apply_result" &&
      /recovery resolution/i.test(event.content)
    ),
    false,
  );
});

test("recovery resolution reporting failure keeps its cause and outcome unconfirmed", async () => {
  let modelCalls = 0;
  let inactiveEventReachedOwner = false;
  const notificationFailure = new Error("Injected Session notification failure");
  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 3,
      initialRecoveryState,
      askModel: async () => ++modelCalls === 1
        ? {
            content: "Inspecting the current Set.",
            toolCalls: [{ id: "inspect", name: "inspect_live_set", arguments: "{}" }],
          }
        : {
            content: "Asking the user to close the recovery.",
            toolCalls: [{ id: "resolve", name: "resolve_live_recovery", arguments: "{}" }],
          },
      observe: async () => "Current Live Set",
      confirmActions: async () => {
        throw new Error("Recovery resolution must not use Apply approval.");
      },
      confirmRecoveryResolution: async () => true,
      executeActions: async () => {
        throw new Error("Recovery resolution must not execute Live actions.");
      },
      onEvent: (event) => {
        if (event.kind !== "apply_result" || event.recovery?.active !== false) return;
        inactiveEventReachedOwner = true;
        throw notificationFailure;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentRecoveryResolutionReportingError);
      assert.equal(error.cause, notificationFailure);
      assert.match(error.message, /outcome could not be confirmed/i);
      assert.doesNotMatch(error.message, /remains active/i);
      return true;
    },
  );
  assert.equal(inactiveEventReachedOwner, true);
});
