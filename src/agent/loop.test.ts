import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentPartialCompletionError,
  runAgentLoop,
  type AgentLoopModelInput,
} from "./loop.js";
import type { ModelTurn } from "../model/contracts.js";

test("runAgentLoop observes Live state before applying parameter actions", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const observedRequests: string[] = [];
  const executedPlans: string[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (input.messages.length === 0) {
        return {
          content: "I need the actual Auto Filter parameter names first.",
          toolCalls: [
            {
              id: "call_1",
              name: "inspect_device",
              arguments: JSON.stringify({
                trackName: "Lead",
                deviceName: "Auto Filter",
              }),
            },
          ],
        };
      }

      if (
        input.messages.some(
          (message) => message.role === "tool" && message.content.includes('Set "Env Amount"'),
        )
      ) {
        return { content: "Done.", toolCalls: [] };
      }

      if (
        input.messages.some(
          (message) => message.role === "tool" && message.content.includes("Env Amount"),
        )
      ) {
        return {
          content: "I found the exposed envelope parameter.",
          toolCalls: [
            {
              id: "call_2",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "I found the exposed envelope parameter.",
                actions: [
                  {
                    type: "set_device_parameter",
                    trackName: "Lead",
                    deviceName: "Auto Filter",
                    parameterName: "Env Amount",
                    value: 0.72,
                  },
                ],
              }),
            },
          ],
        };
      }

      return { content: "Done.", toolCalls: [] };
    },
    observe: async (request) => {
      observedRequests.push(
        `${request.type}:${request.type === "inspect_device" ? request.deviceName : ""}`,
      );
      return "Device Auto Filter parameters: Frequency, Resonance, Env Amount, Env Attack, Env Release";
    },
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async (plan) => {
      executedPlans.push(plan.actions[0]?.type ?? "none");
      return ['Set "Env Amount" on "Auto Filter" in track "Lead" to 0.72.'];
    },
  });

  assert.deepEqual(observedRequests, ["inspect_device:Auto Filter"]);
  assert.deepEqual(executedPlans, ["set_device_parameter"]);
  assert.equal(modelInputs.length, 3);
  assert.equal(modelInputs[1]?.messages[1]?.role, "tool");
  assert.match(modelInputs[1]?.messages[1]?.content ?? "", /Env Amount/);
  assert.match(modelInputs[2]?.messages.at(-1)?.content ?? "", /Set "Env Amount"/);
  assert.equal(result.message, "Done.");
});

test("runAgentLoop supports inspect_midi_clip tool calls", async () => {
  const observedRequests: string[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      if (input.messages.length === 0) {
        return {
          content: "I need the actual MIDI notes.",
          toolCalls: [
            {
              id: "call_notes",
              name: "inspect_midi_clip",
              arguments: JSON.stringify({
                clipName: "Fmaj Cmaj Dmin C69",
                noteOffset: 128,
                noteLimit: 128,
              }),
            },
          ],
        };
      }

      return {
        content: "The observed C69 contains C, E, G, A, and D.",
        toolCalls: [],
      };
    },
    observe: async (request) => {
      observedRequests.push(
        request.type === "inspect_midi_clip"
          ? `${request.type}:${request.noteOffset}:${request.noteLimit}`
          : request.type,
      );
      return "notes=5\n1. pitch=60, name=C4\n2. pitch=64, name=E4\n3. pitch=67, name=G4\n4. pitch=69, name=A4\n5. pitch=74, name=D5";
    },
    confirmActions: async () => true,
    executeActions: async () => [],
  });

  assert.deepEqual(observedRequests, ["inspect_midi_clip:128:128"]);
  assert.match(result.message, /C69 contains C, E, G, A, and D/);
});

test("runAgentLoop supports inspect_song_info tool calls", async () => {
  const observedRequests: string[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> =>
      input.messages.length === 0
        ? {
            content: "I will inspect the song settings.",
            toolCalls: [
              { id: "song_info", name: "inspect_song_info", arguments: "{}" },
            ],
          }
        : { content: "The tempo is 120 BPM.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(request.type);
      return "tempo=120";
    },
    confirmActions: async () => true,
    executeActions: async () => [],
  });

  assert.deepEqual(observedRequests, ["inspect_song_info"]);
  assert.equal(result.message, "The tempo is 120 BPM.");
});

test("runAgentLoop emits callbacks for assistant, tool call, and tool result", async () => {
  const eventKinds: string[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      if (input.messages.length === 0) {
        return {
          content: "I will inspect the set first.",
          toolCalls: [
            {
              id: "inspect_set",
              name: "inspect_live_set",
              arguments: "{}",
            },
          ],
        };
      }

      return { content: "The set has one track.", toolCalls: [] };
    },
    observe: async () => "Track 1: Drums",
    confirmActions: async () => true,
    executeActions: async () => [],
    onEvent: async (event) => {
      eventKinds.push(event.kind);
    },
  });

  assert.deepEqual(eventKinds, [
    "assistant",
    "tool_call",
    "tool_result",
    "assistant",
  ]);
});

test("runAgentLoop emits callbacks for apply and tool errors", async () => {
  const events: { kind: string; content: string; name?: string }[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      if (input.messages.length === 0) {
        return {
          content: "I will try a malformed action first.",
          toolCalls: [
            {
              id: "bad_args",
              name: "apply_live_actions",
              arguments: '{"message":"broken"',
            },
          ],
        };
      }

      if (input.messages.length === 2) {
        return {
          content: "Retrying with a valid action.",
          toolCalls: [
            {
              id: "good_args",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Create the first track.",
                actions: [{ type: "create_midi_track", name: "Bass" }],
              }),
            },
          ],
        };
      }

      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async () => ['Created MIDI track "Bass".'],
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.message, "Done.");
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "assistant",
      "tool_call",
      "error",
      "assistant",
      "tool_call",
      "apply_requested",
      "apply_result",
      "assistant",
    ],
  );
  assert.equal(events.find((event) => event.kind === "tool_call")?.name, "apply_live_actions");
  assert.match(events.find((event) => event.kind === "error")?.content ?? "", /Invalid JSON arguments/);
  assert.match(events.find((event) => event.kind === "apply_result")?.content ?? "", /Created MIDI track/);
});

test("runAgentLoop emits apply result when user cancels actions", async () => {
  const events: string[] = [];
  let revalidationCalls = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (): Promise<ModelTurn> => ({
      content: "I will ask before applying.",
      toolCalls: [
        {
          id: "apply_1",
          name: "apply_live_actions",
          arguments: JSON.stringify({
            message: "Create the track.",
            actions: [{ type: "create_midi_track", name: "Bass" }],
          }),
        },
      ],
    }),
    observe: async () => "",
    preflightActions: async () => async () => {
      revalidationCalls += 1;
    },
    confirmActions: async () => false,
    executeActions: async () => [],
    onEvent: (event) => {
      events.push(`${event.kind}:${event.content}`);
    },
  });

  assert.match(result.message, /not applied/);
  assert(events.some((event) => event.includes("apply_requested")));
  assert(events.some((event) => event.includes("User cancelled")));
  assert.equal(revalidationCalls, 0);
});

test("runAgentLoop treats apply-result reporting failure as fatal after mutations complete", async () => {
  let modelCalls = 0;
  let executeCalls = 0;

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async (): Promise<ModelTurn> => {
        modelCalls += 1;
        return {
          content: "Creating.",
          toolCalls: [{
            id: "apply-reporting-failure",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Create the track.",
              actions: [{ type: "create_midi_track", name: "Bass" }],
            }),
          }],
        };
      },
      observe: async () => "",
      preflightActions: async () => async () => {},
      confirmActions: async () => true,
      executeActions: async () => {
        executeCalls += 1;
        return ['Created MIDI track "Bass".'];
      },
      onEvent: (event) => {
        if (event.kind === "apply_result") {
          throw new Error("event persistence failed");
        }
      },
    }),
    (error: unknown) => {
      assert.equal((error as Error).name, "AgentApplyResultReportingError");
      assert.match(String(error), /Created MIDI track "Bass"/);
      assert.deepEqual(
        (error as { completedResults?: unknown }).completedResults,
        ['Created MIDI track "Bass".'],
      );
      return true;
    },
  );

  assert.equal(modelCalls, 1);
  assert.equal(executeCalls, 1);
});

test("runAgentLoop refuses apply actions when action preflight is not configured", async () => {
  let confirmationCalls = 0;
  let executeCalls = 0;

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async (): Promise<ModelTurn> => ({
        content: "Creating.",
        toolCalls: [{
          id: "apply-without-preflight",
          name: "apply_live_actions",
          arguments: JSON.stringify({
            message: "Create the track.",
            actions: [{ type: "create_midi_track", name: "Bass" }],
          }),
        }],
      }),
      observe: async () => "",
      confirmActions: async () => {
        confirmationCalls += 1;
        return true;
      },
      executeActions: async () => {
        executeCalls += 1;
        return [];
      },
    }),
    (error: unknown) => {
      assert.equal((error as Error).name, "AgentActionPreflightError");
      assert.match(String(error), /preflight is not configured/i);
      return true;
    },
  );

  assert.equal(confirmationCalls, 0);
  assert.equal(executeCalls, 0);
});

test("runAgentLoop completes action preflight before confirmation and execution", async () => {
  const order: string[] = [];
  let modelCalls = 0;

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            content: "Creating.",
            toolCalls: [{
              id: "apply-with-preflight",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Create the track.",
                actions: [{ type: "create_midi_track", name: "Bass" }],
              }),
            }],
          }
        : { content: "Done.", toolCalls: [] };
    },
    observe: async () => "",
    preflightActions: async () => {
      order.push("preflight");
      return async () => {
        order.push("revalidate");
        return { track: "bound-handle" };
      };
    },
    confirmActions: async () => {
      order.push("confirm");
      return true;
    },
    executeActions: async (_plan, bindings) => {
      assert.deepEqual(bindings, { track: "bound-handle" });
      order.push("execute");
      return ['Created MIDI track "Bass".'];
    },
  });

  assert.deepEqual(order, ["preflight", "confirm", "revalidate", "execute"]);
});

test("runAgentLoop returns post-confirmation target changes to the model without executing", async () => {
  const order: string[] = [];
  let executeCalls = 0;
  let modelCalls = 0;

  const result = await runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async (): Promise<ModelTurn> => {
        modelCalls += 1;
        return modelCalls === 1
          ? {
              content: "Deleting.",
              toolCalls: [{
                id: "delete-after-change",
                name: "apply_live_actions",
                arguments: JSON.stringify({
                  message: "Delete Scratch.",
                  actions: [{ type: "delete_track", trackName: "Scratch" }],
                }),
              }],
            }
          : {
              content: "The target changed, so I will inspect it again before proposing another edit.",
              toolCalls: [],
            };
      },
      observe: async () => "",
      preflightActions: async () => {
        order.push("preflight");
        return async () => {
          order.push("revalidate");
          throw new Error("Live target identity changed.");
        };
      },
      confirmActions: async () => {
        order.push("confirm");
        return true;
      },
      executeActions: async () => {
        executeCalls += 1;
        return [];
      },
    });

  assert.match(result.message, /inspect it again/i);
  assert.equal(modelCalls, 2);
  assert.deepEqual(order, ["preflight", "confirm", "revalidate"]);
  assert.equal(executeCalls, 0);
});

test("runAgentLoop returns malformed tool arguments to the model instead of throwing", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const executedPlans: string[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (input.messages.length === 0) {
        return {
          content: "I will apply a large plan.",
          toolCalls: [
            {
              id: "bad_args",
              name: "apply_live_actions",
              arguments: '{"message":"too long","actions":[{"type":"create_midi_track"',
            },
          ],
        };
      }

      if (
        input.messages.some(
          (message) =>
            message.role === "tool" && message.content.includes("Created MIDI track"),
        )
      ) {
        return { content: "Done.", toolCalls: [] };
      }

      return {
        content: "Retrying with a smaller valid plan.",
        toolCalls: [
          {
            id: "good_args",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Create the track first.",
              actions: [{ type: "create_midi_track", name: "Future Bass" }],
            }),
          },
        ],
      };
    },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async (plan) => {
      executedPlans.push(plan.actions[0]?.type ?? "none");
      return ['Created MIDI track "Future Bass".'];
    },
  });

  assert.equal(modelInputs.length, 3);
  assert.equal(modelInputs[1]?.messages[1]?.role, "tool");
  assert.match(modelInputs[1]?.messages[1]?.content ?? "", /Invalid JSON arguments/);
  assert.deepEqual(executedPlans, ["create_midi_track"]);
  assert.match(modelInputs[2]?.messages.at(-1)?.content ?? "", /Created MIDI track/);
});

test("runAgentLoop stops successful loops at the configured iteration limit", async () => {
  const observedRequests: string[] = [];
  const modelInputs: AgentLoopModelInput[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 4,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      return {
        content: `Inspecting step ${input.iteration}.`,
        toolCalls: [
          {
            id: `inspect_${input.iteration}`,
            name: "inspect_live_set",
            arguments: "{}",
          },
        ],
      };
    },
    observe: async (request) => {
      observedRequests.push(request.type);
      return "ok";
    },
    confirmActions: async () => true,
    executeActions: async () => [],
  });

  assert.equal(observedRequests.length, 4);
  assert.equal(modelInputs.length, 4);
  assert.match(result.message, /safety limit of 4 planning steps/);
});

test("runAgentLoop stops before exceeding the configured tool call limit", async () => {
  let observed = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxToolCalls: 2,
    askModel: async (): Promise<ModelTurn> => ({
      content: "Inspecting.",
      toolCalls: [1, 2, 3].map((number) => ({
        id: `inspect_${number}`,
        name: "inspect_live_set",
        arguments: "{}",
      })),
    }),
    observe: async () => {
      observed += 1;
      return "ok";
    },
    confirmActions: async () => true,
    executeActions: async () => [],
  });

  assert.equal(observed, 2);
  assert.match(result.message, /safety limit of 2 tool calls/);
});

test("runAgentLoop aborts before executing tools after a stopped model request", async () => {
  const controller = new AbortController();
  let observed = false;

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 2,
      signal: controller.signal,
      askModel: async (): Promise<ModelTurn> => {
        controller.abort(new Error("Stopped by user"));
        return {
          content: "Inspecting.",
          toolCalls: [
            { id: "inspect", name: "inspect_live_set", arguments: "{}" },
          ],
        };
      },
      observe: async () => {
        observed = true;
        return "ok";
      },
      confirmActions: async () => true,
      executeActions: async () => [],
    }),
    /Stopped by user/,
  );
  assert.equal(observed, false);
});

test("runAgentLoop rechecks cancellation before opening confirmation", async () => {
  const controller = new AbortController();
  let confirmationOpened = false;

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 2,
      signal: controller.signal,
      askModel: async (): Promise<ModelTurn> => ({
        content: "Creating.",
        toolCalls: [
          {
            id: "apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Create track",
              actions: [{ type: "create_midi_track", name: "Bass" }],
            }),
          },
        ],
      }),
      observe: async () => "",
      preflightActions: async () => async () => {},
      confirmActions: async () => {
        confirmationOpened = true;
        return true;
      },
      executeActions: async () => [],
      onEvent: (event) => {
        if (event.kind === "apply_requested") {
          controller.abort(new Error("Stopped before confirmation"));
        }
      },
    }),
    /Stopped before confirmation/,
  );
  assert.equal(confirmationOpened, false);
});

test("runAgentLoop answers every tool call in a turn even when one fails", async () => {
  const modelInputs: AgentLoopModelInput[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (input.messages.length === 0) {
        return {
          content: "Inspecting both devices.",
          toolCalls: [
            {
              id: "bad_call",
              name: "inspect_device",
              arguments: '{"deviceName":',
            },
            {
              id: "never_ran",
              name: "inspect_device",
              arguments: JSON.stringify({ deviceName: "Auto Filter" }),
            },
          ],
        };
      }

      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => "ok",
    confirmActions: async () => true,
    executeActions: async () => [],
  });

  assert.equal(result.message, "Done.");
  const secondInput = modelInputs[1];
  const toolMessages = (secondInput?.messages ?? []).filter(
    (message) => message.role === "tool",
  );
  assert.deepEqual(
    toolMessages.map((message) => message.role === "tool" && message.toolCallId),
    ["bad_call", "never_ran"],
  );
  assert.match(
    toolMessages[1]?.content ?? "",
    /was not executed because an earlier tool call/,
  );
});

test("runAgentLoop stops after consecutive failed tool calls", async () => {
  let calls = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (): Promise<ModelTurn> => {
      calls += 1;
      return {
        content: "Trying a malformed tool call.",
        toolCalls: [
          {
            id: `bad_${calls}`,
            name: "apply_live_actions",
            arguments: '{"message":"broken"',
          },
        ],
      };
    },
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => [],
  });

  assert.match(result.message, /Stopped after 2 consecutive failed tool calls/);
});

test("one referenced full-track plan uses one confirmation", async () => {
  let modelCalls = 0;
  let confirmations = 0;
  let executions = 0;
  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            content: "Building the complete track.",
            toolCalls: [{
              id: "full-track",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Build Dream Pads",
                targets: { pads: { trackName: "1-MIDI" } },
                actions: [
                  { type: "rename_track", trackRef: "pads", newName: "Dream Pads" },
                  {
                    type: "create_midi_clip",
                    trackRef: "pads",
                    startBeat: 0,
                    durationBeats: 128,
                    notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 88 }],
                  },
                  { type: "insert_device", trackRef: "pads", deviceName: "Auto Filter" },
                ],
              }),
            }],
          }
        : { content: "Done.", toolCalls: [] };
    },
    observe: async () => "",
    preflightActions: async () => async () => ({ pads: "bound" }),
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan, bindings) => {
      executions += 1;
      assert.equal(plan.actions.length, 3);
      assert.deepEqual(bindings, { pads: "bound" });
      return ["Renamed", "Created clip", "Inserted device"];
    },
  });

  assert.equal(confirmations, 1);
  assert.equal(executions, 1);
});

test("staged apply inspect apply work uses separate confirmations in one loop", async () => {
  let modelCalls = 0;
  let confirmations = 0;
  const executedMessages: string[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Creating the device first.",
          toolCalls: [{
            id: "stage-create",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Insert the filter",
              actions: [{
                type: "insert_device",
                trackName: "Lead",
                deviceName: "Auto Filter",
              }],
            }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Inspecting the returned parameters.",
          toolCalls: [{
            id: "stage-inspect",
            name: "inspect_device",
            arguments: JSON.stringify({
              trackName: "Lead",
              deviceName: "Auto Filter",
            }),
          }],
        };
      }
      if (modelCalls === 3) {
        return {
          content: "Applying the observed parameter.",
          toolCalls: [{
            id: "stage-parameter",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Set the observed filter frequency",
              actions: [{
                type: "set_device_parameter",
                trackName: "Lead",
                deviceName: "Auto Filter",
                parameterName: "Frequency",
                value: 0.5,
              }],
            }),
          }],
        };
      }
      return { content: "Finished both stages.", toolCalls: [] };
    },
    observe: async () => "Frequency: 0-1",
    preflightActions: async () => async () => undefined,
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan) => {
      executedMessages.push(plan.message);
      return [plan.message];
    },
  });

  assert.equal(result.message, "Finished both stages.");
  assert.equal(confirmations, 2);
  assert.deepEqual(executedMessages, [
    "Insert the filter",
    "Set the observed filter frequency",
  ]);
});

test("long MIDI can be created empty and filled by separately confirmed segments", async () => {
  let modelCalls = 0;
  let confirmations = 0;
  const executedActionTypes: string[][] = [];
  const inspectedOffsets: number[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Creating the full-duration Clip first.",
          toolCalls: [{
            id: "create-empty-clip",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Create an empty 64-bar MIDI clip",
              actions: [{
                type: "create_midi_clip",
                trackName: "Lead",
                name: "Full arrangement",
                startBeat: 0,
                durationBeats: 256,
                notes: [],
              }],
            }),
          }],
        };
      }
      if (modelCalls === 2 || modelCalls === 4) {
        return {
          content: "Checking the current Clip before the next segment.",
          toolCalls: [{
            id: `inspect-long-clip-${modelCalls}`,
            name: "inspect_midi_clip",
            arguments: JSON.stringify({
              trackName: "Lead",
              clipName: "Full arrangement",
              startBeat: 0,
              noteOffset: modelCalls === 2 ? 0 : 128,
              noteLimit: 128,
            }),
          }],
        };
      }
      if (modelCalls === 3 || modelCalls === 5) {
        const segmentStartTime = modelCalls === 3 ? 0 : 16;
        return {
          content: "Writing the next non-overlapping segment.",
          toolCalls: [{
            id: `write-segment-${segmentStartTime}`,
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: `Write relative beats ${segmentStartTime}-${segmentStartTime + 16}`,
              actions: [{
                type: "replace_midi_clip_segment",
                trackName: "Lead",
                clipName: "Full arrangement",
                startBeat: 0,
                segmentStartTime,
                segmentDurationBeats: 16,
                notes: [{
                  pitch: modelCalls === 3 ? 60 : 67,
                  startTime: segmentStartTime,
                  duration: 4,
                  velocity: 96,
                }],
              }],
            }),
          }],
        };
      }
      return { content: "The long Clip now contains both segments.", toolCalls: [] };
    },
    observe: async (request) => {
      assert.equal(request.type, "inspect_midi_clip");
      if (request.type === "inspect_midi_clip") {
        inspectedOffsets.push(request.noteOffset ?? 0);
      }
      return "Current MIDI notes";
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan) => {
      executedActionTypes.push(plan.actions.map((action) => action.type));
      return [plan.message];
    },
  });

  assert.equal(result.message, "The long Clip now contains both segments.");
  assert.equal(confirmations, 3);
  assert.deepEqual(inspectedOffsets, [0, 128]);
  assert.deepEqual(executedActionTypes, [
    ["create_midi_clip"],
    ["replace_midi_clip_segment"],
    ["replace_midi_clip_segment"],
  ]);
});

test("a partial apply failure returns to the model for inspect and repair", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const executedMessages: string[] = [];
  const eventKinds: string[] = [];
  let confirmations = 0;
  let modelCalls = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Building the requested chain.",
          toolCalls: [{
            id: "partial-apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Build the chain",
              actions: [
                { type: "insert_device", trackName: "Lead", deviceName: "Auto Filter" },
                { type: "insert_device", trackName: "Lead", deviceName: "Ping Pong Delay" },
              ],
            }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "The first device was applied, so I will inspect before repairing.",
          toolCalls: [{
            id: "inspect-after-partial",
            name: "inspect_track",
            arguments: JSON.stringify({ trackName: "Lead" }),
          }],
        };
      }
      if (modelCalls === 3) {
        return {
          content: "Only the current Delay device is still missing.",
          toolCalls: [{
            id: "repair-apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Insert only the missing Delay",
              actions: [
                { type: "insert_device", trackName: "Lead", deviceName: "Delay" },
              ],
            }),
          }],
        };
      }
      return { content: "The chain is repaired.", toolCalls: [] };
    },
    observe: async () => "devices=0: Auto Filter",
    preflightActions: async () => async () => undefined,
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan) => {
      executedMessages.push(plan.message);
      if (plan.message === "Build the chain") {
        throw new AgentPartialCompletionError(
          ['Inserted "Auto Filter" on track "Lead".'],
          new Error("Failed to insert device"),
        );
      }
      return ['Inserted "Delay" on track "Lead".'];
    },
    onEvent: (event) => {
      eventKinds.push(event.kind);
    },
  });

  assert.equal(result.message, "The chain is repaired.");
  assert.equal(confirmations, 2);
  assert.deepEqual(executedMessages, [
    "Build the chain",
    "Insert only the missing Delay",
  ]);
  assert.match(
    modelInputs[1]?.messages.at(-1)?.content ?? "",
    /Auto Filter.*will not be retried|will not be retried.*Auto Filter/is,
  );
  assert.equal(eventKinds.filter((kind) => kind === "apply_result").length, 2);
  assert.equal(eventKinds.includes("error"), false);
});

test("a first-action Live rejection returns current state to the model for repair", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const observedRequests: string[] = [];
  const executedDevices: string[] = [];
  const eventKinds: string[] = [];
  let modelCalls = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Adding the requested delay.",
          toolCalls: [{
            id: "unavailable-delay",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Add Ping Pong Delay",
              targets: { lead: { trackName: "Lead" } },
              actions: [{
                type: "insert_device",
                trackRef: "lead",
                deviceName: "Ping Pong Delay",
              }],
            }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Live rejected the legacy name; I will add only the current alternative.",
          toolCalls: [{
            id: "current-delay",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Add current Delay",
              actions: [{
                type: "insert_device",
                trackName: "Lead",
                deviceName: "Delay",
              }],
            }),
          }],
        };
      }
      return { content: "The current Delay device is in place.", toolCalls: [] };
    },
    observe: async (request) => {
      observedRequests.push(request.type);
      return 'Live set has 1 track.\nTrack 1: MIDI "Lead"\n  devices=Auto Filter';
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      const action = plan.actions[0];
      assert.equal(action?.type, "insert_device");
      executedDevices.push(action.deviceName);
      if (action.deviceName === "Ping Pong Delay") {
        throw new AgentPartialCompletionError(
          [],
          new Error("Failed to insert device"),
          0,
          action,
          "Lead",
        );
      }
      return ['Inserted "Delay" on track "Lead".'];
    },
    onEvent: (event) => {
      eventKinds.push(event.kind);
    },
  });

  assert.equal(result.message, "The current Delay device is in place.");
  assert.deepEqual(executedDevices, ["Ping Pong Delay", "Delay"]);
  assert.deepEqual(observedRequests, ["inspect_track"]);
  assert.match(
    modelInputs[1]?.messages.at(-1)?.content ?? "",
    /could not complete its first action.*Current Live state after the failure:.*devices=Auto Filter/is,
  );
  assert.equal(eventKinds.includes("error"), false);
});

test("completed actions cannot be resubmitted during partial-plan repair", async () => {
  const executedMessages: string[] = [];
  const modelInputs: AgentLoopModelInput[] = [];
  let modelCalls = 0;
  let confirmations = 0;

  const originalPlan = {
    message: "Build the chain",
    actions: [
      { type: "insert_device", trackName: "Lead", deviceName: "Auto Filter" },
      { type: "insert_device", trackName: "Lead", deviceName: "Ping Pong Delay" },
    ],
  };
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      modelCalls += 1;
      if (modelCalls === 1 || modelCalls === 2) {
        return {
          content: modelCalls === 1
            ? "Building the chain."
            : "Retrying the original plan.",
          toolCalls: [{
            id: `original-plan-${modelCalls}`,
            name: "apply_live_actions",
            arguments: JSON.stringify(originalPlan),
          }],
        };
      }
      if (modelCalls === 3) {
        return {
          content: "Applying only the missing current Delay.",
          toolCalls: [{
            id: "missing-delay",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Add only Delay",
              actions: [{
                type: "insert_device",
                trackName: "Lead",
                deviceName: "Delay",
              }],
            }),
          }],
        };
      }
      return { content: "The chain is complete.", toolCalls: [] };
    },
    observe: async () => 'Track "Lead" devices=Auto Filter',
    preflightActions: async () => async () => undefined,
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan) => {
      executedMessages.push(plan.message);
      if (plan.message === "Build the chain") {
        throw new AgentPartialCompletionError(
          ['Inserted "Auto Filter" on track "Lead".'],
          new Error("Failed to insert device"),
          1,
          plan.actions[1],
          "Lead",
        );
      }
      return ['Inserted "Delay" on track "Lead".'];
    },
  });

  assert.equal(result.message, "The chain is complete.");
  assert.deepEqual(executedMessages, ["Build the chain", "Add only Delay"]);
  assert.equal(confirmations, 2);
  assert.match(
    modelInputs[2]?.messages.at(-1)?.content ?? "",
    /repeats work already completed.*Auto Filter/is,
  );
});

test("a failed automatic refresh gates mutations until an explicit inspection succeeds", async () => {
  const executedDevices: string[] = [];
  let modelCalls = 0;
  let observationCalls = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (
        modelCalls === 1 ||
        modelCalls === 2 ||
        modelCalls === 4 ||
        modelCalls === 6
      ) {
        const deviceName = modelCalls === 1 ? "Ping Pong Delay" : "Delay";
        return {
          content: `Adding ${deviceName}.`,
          toolCalls: [{
            id: `apply-${modelCalls}`,
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: `Add ${deviceName}`,
              actions: [{ type: "insert_device", trackName: "Lead", deviceName }],
            }),
          }],
        };
      }
      if (modelCalls === 3) {
        return {
          content: "Checking unrelated song information.",
          toolCalls: [{
            id: "unrelated-refresh",
            name: "inspect_song_info",
            arguments: "{}",
          }],
        };
      }
      if (modelCalls === 5) {
        return {
          content: "Now refreshing the affected track.",
          toolCalls: [{
            id: "affected-refresh",
            name: "inspect_track",
            arguments: JSON.stringify({ trackName: "Lead" }),
          }],
        };
      }
      return { content: "Delay is in place.", toolCalls: [] };
    },
    observe: async () => {
      observationCalls += 1;
      if (observationCalls === 1) throw new Error("Live state unavailable");
      return 'Track "Lead" devices=none';
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      const action = plan.actions[0];
      assert.equal(action?.type, "insert_device");
      executedDevices.push(action.deviceName);
      if (action.deviceName === "Ping Pong Delay") {
        throw new AgentPartialCompletionError(
          [],
          new Error("Failed to insert device"),
          0,
          action,
          "Lead",
        );
      }
      return ['Inserted "Delay" on track "Lead".'];
    },
  });

  assert.equal(result.message, "Delay is in place.");
  assert.deepEqual(executedDevices, ["Ping Pong Delay", "Delay"]);
  assert.equal(observationCalls, 3);
});

test("parameter failure recovery refreshes the exact affected device", async () => {
  const observations: unknown[] = [];
  let modelCalls = 0;

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Setting the filter.",
          toolCalls: [{
            id: "set-filter",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Set the filter",
              targets: { lead: { trackName: "FB Lead" } },
              actions: [{
                type: "set_device_parameter",
                trackRef: "lead",
                deviceName: "Auto Filter",
                deviceIndex: 1,
                parameterName: "Frequency",
                value: 0.5,
              }],
            }),
          }],
        };
      }
      return { content: "I refreshed the exact device before deciding what to do next.", toolCalls: [] };
    },
    observe: async (request) => {
      observations.push(request);
      return "Device parameters refreshed.";
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Parameter rejected"),
        0,
        plan.actions[0],
        "FB Lead",
      );
    },
  });

  assert.deepEqual(observations, [{
    type: "inspect_device",
    trackName: "FB Lead",
    deviceName: "Auto Filter",
    deviceIndex: 1,
  }]);
});

test("segment failure recovery refreshes the exact affected MIDI clip", async () => {
  const observations: unknown[] = [];
  let modelCalls = 0;

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Writing the segment.",
          toolCalls: [{
            id: "write-segment",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Write relative beats 16-32",
              targets: { lead: { trackName: "FB Lead" } },
              actions: [{
                type: "replace_midi_clip_segment",
                trackRef: "lead",
                clipName: "Full arrangement",
                startBeat: 0,
                segmentStartTime: 16,
                segmentDurationBeats: 16,
                notes: [],
              }],
            }),
          }],
        };
      }
      return { content: "I refreshed the exact Clip before continuing.", toolCalls: [] };
    },
    observe: async (request) => {
      observations.push(request);
      return "MIDI Clip refreshed.";
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Clip changed"),
        0,
        plan.actions[0],
        "FB Lead",
      );
    },
  });

  assert.deepEqual(observations, [{
    type: "inspect_midi_clip",
    trackName: "FB Lead",
    clipName: "Full arrangement",
    startBeat: 0,
  }]);
});

test("extended action failures refresh the narrow affected Live object", async (t) => {
  const scenarios = [
    {
      name: "nested Drum Rack",
      action: {
        type: "configure_drum_pad",
        trackName: "Drums",
        rackName: "Drum Rack",
        rackPath: { deviceIndex: 0 },
        receivingNote: 36,
        source: { kind: "selected" },
      },
      trackName: "Drums",
      expected: {
        type: "inspect_device_tree",
        trackName: "Drums",
        deviceName: "Drum Rack",
        devicePath: { deviceIndex: 0 },
      },
    },
    {
      name: "track mixer",
      action: {
        type: "set_track_mixer_parameter",
        trackName: "Lead",
        parameter: "send",
        sendIndex: 0,
        value: 0.5,
      },
      trackName: "Lead",
      expected: { type: "inspect_mixer", trackName: "Lead" },
    },
    {
      name: "Session Clip slot",
      action: {
        type: "create_session_audio_clip",
        trackName: "Audio",
        source: { kind: "selected" },
        slotIndex: 2,
      },
      trackName: "Audio",
      expected: { type: "inspect_clip", trackName: "Audio", slotIndex: 2 },
    },
    {
      name: "Scene",
      action: {
        type: "rename_scene",
        sceneIndex: 0,
        sceneName: "Intro",
        newName: "Verse",
      },
      trackName: undefined,
      expected: { type: "inspect_song_info" },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const observations: unknown[] = [];
      let modelCalls = 0;

      await runAgentLoop({
        maxConsecutiveFailures: 3,
        askModel: async (): Promise<ModelTurn> => {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              content: "Applying the edit.",
              toolCalls: [{
                id: `apply-${scenario.name}`,
                name: "apply_live_actions",
                arguments: JSON.stringify({
                  message: "Apply the edit",
                  actions: [scenario.action],
                }),
              }],
            };
          }
          return { content: "I refreshed the affected Live object.", toolCalls: [] };
        },
        observe: async (request) => {
          observations.push(request);
          return "Affected Live object refreshed.";
        },
        preflightActions: async () => async () => undefined,
        confirmActions: async () => true,
        executeActions: async (plan) => {
          throw new AgentPartialCompletionError(
            [],
            new Error("Host mutation failed"),
            0,
            plan.actions[0],
            scenario.trackName,
          );
        },
      });

      assert.deepEqual(observations, [scenario.expected]);
    });
  }
});

test("a granular composite failure can retry its idempotent action without repeating the whole mutation", async () => {
  let modelCalls = 0;
  let executions = 0;
  let confirmations = 0;
  const action = {
    type: "configure_drum_pad",
    trackName: "Drums",
    rackName: "Drum Rack",
    rackPath: { deviceIndex: 0 },
    receivingNote: 36,
    source: { kind: "selected" },
  } as const;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls <= 2) {
        return {
          content: modelCalls === 1 ? "Configuring the pad." : "Continuing the missing pad steps.",
          toolCalls: [{
            id: `configure-pad-${modelCalls}`,
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Configure the pad",
              actions: [action],
            }),
          }],
        };
      }
      return { content: "The pad is configured.", toolCalls: [] };
    },
    observe: async () => "Drum Rack refreshed with the created chain.",
    preflightActions: async () => async () => undefined,
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan) => {
      executions += 1;
      if (executions === 1) {
        throw new AgentPartialCompletionError(
          ["Created the Drum Chain for MIDI note 36."],
          new Error("Simpler insertion failed"),
          0,
          plan.actions[0],
          "Drums",
          [["live-action-step:drum-pad:track-1:36:create-chain"]],
        );
      }
      return ["Configured MIDI note 36 in Drum Rack."];
    },
  });

  assert.equal(result.message, "The pad is configured.");
  assert.equal(executions, 2);
  assert.equal(confirmations, 2);
});

test("a partial apply remains fatal when its completed work cannot be recorded", async () => {
  let modelCalls = 0;

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async (): Promise<ModelTurn> => {
        modelCalls += 1;
        return {
          content: "Applying the chain.",
          toolCalls: [{
            id: "partial-reporting-failure",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Build the chain",
              actions: [
                { type: "insert_device", trackName: "Lead", deviceName: "Auto Filter" },
                { type: "insert_device", trackName: "Lead", deviceName: "Unavailable Device" },
              ],
            }),
          }],
        };
      },
      observe: async () => "",
      preflightActions: async () => async () => undefined,
      confirmActions: async () => true,
      executeActions: async () => {
        throw new AgentPartialCompletionError(
          ['Inserted "Auto Filter" on track "Lead".'],
          new Error("Failed to insert device"),
        );
      },
      onEvent: (event) => {
        if (event.kind === "apply_result") {
          throw new Error("partial result persistence failed");
        }
      },
    }),
    (error: unknown) => {
      assert.equal((error as Error).name, "AgentApplyResultReportingError");
      assert.deepEqual(
        (error as { completedResults?: unknown }).completedResults,
        ['Inserted "Auto Filter" on track "Lead".'],
      );
      return true;
    },
  );

  assert.equal(modelCalls, 1);
});

test("a partial apply result is recorded before cancellation stops recovery", async () => {
  const controller = new AbortController();
  const eventKinds: string[] = [];

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 3,
      signal: controller.signal,
      askModel: async (): Promise<ModelTurn> => ({
        content: "Applying the chain.",
        toolCalls: [{
          id: "partial-before-cancel",
          name: "apply_live_actions",
          arguments: JSON.stringify({
            message: "Build the chain",
            actions: [
              { type: "insert_device", trackName: "Lead", deviceName: "Auto Filter" },
              { type: "insert_device", trackName: "Lead", deviceName: "Unavailable Device" },
            ],
          }),
        }],
      }),
      observe: async () => assert.fail("recovery observation must stop after cancellation"),
      preflightActions: async () => async () => undefined,
      confirmActions: async () => true,
      executeActions: async () => {
        controller.abort();
        throw new AgentPartialCompletionError(
          ['Inserted "Auto Filter" on track "Lead".'],
          new Error("Failed to insert device"),
        );
      },
      onEvent: (event) => {
        eventKinds.push(event.kind);
      },
    }),
    /abort/i,
  );

  assert.equal(eventKinds.filter((kind) => kind === "apply_result").length, 1);
});
