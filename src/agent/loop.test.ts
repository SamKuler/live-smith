import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentPartialCompletionError,
  digestActionIdentity,
  runAgentLoop,
  type AgentActionExecutionOutcome,
  type AgentLoopTraceEvent,
  type AgentLoopModelInput,
  type AgentRecoveryLedgerUpdate,
} from "./loop.js";
import type { ModelTurn } from "../model/contracts.js";
import { EditScopeDeniedError } from "./edit-scopes.js";

function mutationOutcome(
  results: string[],
  mutationCount = 1,
): AgentActionExecutionOutcome {
  return { results, mutationCount };
}

test("runAgentLoop rejects an empty model turn instead of inventing a reply", async () => {
  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async () => ({ content: null, toolCalls: [] }),
      observe: async () => assert.fail("an empty turn must not run tools"),
      confirmActions: async () => assert.fail("an empty turn must not request approval"),
      executeActions: async () => assert.fail("an empty turn must not execute actions"),
    }),
    /empty response/i,
  );
});

test("a scope denial after only no-ops does not create unfinished Live work", async () => {
  const events: AgentLoopTraceEvent[] = [];
  let turn = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async () => ++turn === 1
      ? {
          content: "Apply two changes",
          toolCalls: [{
            id: "scope-no-op",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Adjust tempo",
              actions: [{ type: "set_tempo", tempo: 120 }, { type: "set_tempo", tempo: 128 }],
            }),
          }],
        }
      : { content: "No changes were needed or permitted.", toolCalls: [] },
    observe: async () => assert.fail("permission-only denial needs no recovery observation"),
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async () => {
      throw new AgentPartialCompletionError(
        ["Kept tempo at 120 BPM because it already matches."],
        new EditScopeDeniedError(["structure"]),
        1,
        { type: "set_tempo", tempo: 128 },
        undefined,
        [],
        0,
        undefined,
        1,
      );
    },
    onEvent: (event) => { events.push(event); },
  });
  assert.equal(result.message, "No changes were needed or permitted.");
  assert.equal(events.some((event) => event.kind === "apply_result"), false);
  assert.ok(events.some((event) => event.kind === "tool_result" && /edit scope/.test(event.content)));
});

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
      return mutationOutcome(['Set "Env Amount" on "Auto Filter" in track "Lead" to 0.72.']);
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

test("runAgentLoop preserves normalized citations on assistant trace events", async () => {
  const events: Array<{ kind: string; citations?: unknown }> = [];
  const citations = [{
    url: "https://example.test/source",
    title: "Official source",
  }];

  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      content: "A cited answer.",
      toolCalls: [],
      citations,
    }),
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events, [{
    kind: "assistant",
    content: "A cited answer.",
    citations,
  }]);
});

test("runAgentLoop replays an output-limited turn without executing its partial tool call", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const executedToolCallIds: string[] = [];
  const events: AgentLoopTraceEvent[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxModelContinuations: 2,
    askModel: async (input) => {
      modelInputs.push(input);
      if (input.messages.length === 0) {
        return {
          content: "I will inspect the selected track. ",
          toolCalls: [],
          continuation: { reason: "output_limit" },
          citations: [{
            url: "https://example.test/partial-source",
            title: "Partial source",
          }],
          providerState: {
            kind: "openai-responses",
            output: [{
              type: "function_call",
              call_id: "partial-call",
              name: "inspect_track",
              arguments: "{\"trackName\":\"Le",
              status: "incomplete",
            }],
          },
        };
      }
      if (input.messages.length === 1) {
        return {
          content: "Continuing now.",
          citations: [{
            url: "https://example.test/complete-source",
            title: "Complete source",
          }],
          toolCalls: [{
            id: "complete-call",
            name: "inspect_track",
            arguments: "{\"trackName\":\"Lead\"}",
          }],
        };
      }
      return { content: "Done.", toolCalls: [] };
    },
    observe: async (request) => {
      executedToolCallIds.push(request.type);
      return "Track Lead exists.";
    },
    confirmActions: async () => false,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(result.message, "Done.");
  assert.equal(modelInputs.length, 3);
  assert.equal(modelInputs[1]?.messages.length, 1);
  assert.deepEqual(executedToolCallIds, ["inspect_track"]);
  assert.equal(events.some((event) =>
    event.kind === "tool_call" && event.content.includes("partial-call")
  ), false);
  assert.equal(events.some((event) =>
    event.kind === "assistant" && event.content === "I will inspect the selected track. Continuing now."
  ), true);
  assert.deepEqual(
    events.find((event) => event.kind === "assistant")?.citations,
    [{
      url: "https://example.test/partial-source",
      title: "Partial source",
    }, {
      url: "https://example.test/complete-source",
      title: "Complete source",
    }],
  );
});

test("runAgentLoop bounds repeated output-limit continuations", async () => {
  let calls = 0;
  const events: AgentLoopTraceEvent[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxModelContinuations: 2,
    askModel: async () => {
      calls += 1;
      return {
        content: `partial-${calls}`,
        toolCalls: [],
        continuation: { reason: "output_limit" as const },
        providerState: { kind: "test", output: [calls] },
        citations: [{
          url: `https://example.test/partial-${calls}`,
          title: `Partial ${calls}`,
        }],
      };
    },
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(calls, 3);
  assert.match(result.message, /2 automatic continuation attempts/i);
  assert.match(result.message, /partial-1partial-2partial-3/u);
  assert.deepEqual(events.find((event) => event.kind === "assistant"), {
    kind: "assistant",
    content: "partial-1partial-2partial-3",
    citations: [1, 2, 3].map((index) => ({
      url: `https://example.test/partial-${index}`,
      title: `Partial ${index}`,
    })),
  });
  assert.equal(events.at(-1)?.kind, "error");
});

test("runAgentLoop honors cancellation between output-limit continuation attempts", async () => {
  const controller = new AbortController();
  const reason = new Error("stop continuation");
  let calls = 0;
  await assert.rejects(runAgentLoop({
    maxConsecutiveFailures: 2,
    maxModelContinuations: 2,
    signal: controller.signal,
    askModel: async () => {
      calls += 1;
      return {
        content: null,
        toolCalls: [],
        continuation: { reason: "output_limit" as const },
        providerState: { kind: "test", output: [] },
      };
    },
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: async () => mutationOutcome([]),
    onProgress: (message) => {
      if (message.startsWith("Continuing model response")) {
        controller.abort(reason);
      }
    },
  }), (error: unknown) => error === reason);
  assert.equal(calls, 1);
});

test("runAgentLoop keeps continuation citations within the model citation bound", async () => {
  const events: AgentLoopTraceEvent[] = [];
  let calls = 0;
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => {
      calls += 1;
      const citations = Array.from({ length: 20 }, (_, index) => ({
        url: `https://example.test/${calls}-${index}`,
        title: `Source ${calls}-${index}`,
      }));
      return calls === 1
        ? {
            content: "Partial. ",
            toolCalls: [],
            continuation: { reason: "output_limit" as const },
            providerState: { kind: "test", output: [1] },
            citations,
          }
        : { content: "Complete.", toolCalls: [], citations };
    },
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => { events.push(event); },
  });

  const assistant = events.find((event) => event.kind === "assistant");
  assert.equal(assistant?.citations?.length, 20);
});

test("runAgentLoop records only provider-confirmed hosted Web Search activity", async () => {
  const events: AgentLoopTraceEvent[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      content: "A current answer.",
      toolCalls: [],
      hostedWebSearches: [{
        id: "search-1",
        status: "completed",
        action: "search",
        queries: ["current Ableton release"],
        sources: [{
          url: "https://example.test/result",
          title: "Release notes",
        }],
      }],
      citations: [{
        url: "https://example.test/source",
        title: "Official source",
      }],
    }),
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events, [
    {
      kind: "web_search",
      content: "Searched for “current Ableton release” · 1 page",
      webSearch: {
        id: "search-1",
        status: "completed",
        action: "search",
        queries: ["current Ableton release"],
        sources: [{
          url: "https://example.test/result",
          title: "Release notes",
        }],
      },
    },
    {
      kind: "assistant",
      content: "A current answer.",
      citations: [{
        url: "https://example.test/source",
        title: "Official source",
      }],
    },
  ]);
});

test("runAgentLoop records provider-confirmed failed Web Search activity", async () => {
  const events: AgentLoopTraceEvent[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      content: "I could not complete the current search.",
      toolCalls: [],
      hostedWebSearches: [{
        id: "search-failed",
        status: "failed",
        action: "search",
        queries: ["current Ableton release"],
        sources: [],
      }],
    }),
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events, [{
    kind: "web_search",
    content: "Web Search failed for “current Ableton release”",
    webSearch: {
      id: "search-failed",
      status: "failed",
      action: "search",
      queries: ["current Ableton release"],
      sources: [],
    },
  }, {
    kind: "assistant",
    content: "I could not complete the current search.",
  }]);
});

test("runAgentLoop accepts compatible-provider Web Search overflow within the defensive bound", async () => {
  const events: AgentLoopTraceEvent[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      content: "Search completed.",
      toolCalls: [],
      hostedWebSearches: Array.from({ length: 6 }, (_, index) => ({
        id: `search-${index + 1}`,
        status: "completed" as const,
        action: "search" as const,
        queries: [`query ${index + 1}`],
        sources: [],
      })),
    }),
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => {
      events.push(event);
    },
  });
  assert.equal(events.filter((event) => event.kind === "web_search").length, 6);
});

test("runAgentLoop keeps the answer and truncates hosted Web Search activity beyond the display bound", async () => {
  const events: AgentLoopTraceEvent[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      content: "Answer preserved after a provider overflow.",
      toolCalls: [],
      hostedWebSearches: Array.from({ length: 21 }, (_, index) => ({
        id: `search-${index + 1}`,
        status: "completed" as const,
        action: "search" as const,
        queries: [`query ${index + 1}`],
        sources: [],
      })),
    }),
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => {
      events.push(event);
    },
  });
  assert.equal(events.filter((event) => event.kind === "web_search").length, 20);
  assert.equal(events.at(-1)?.kind, "assistant");
  assert.equal(events.at(-1)?.content, "Answer preserved after a provider overflow.");
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
    executeActions: async () => mutationOutcome([]),
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
              {
                id: "song_info",
                name: "inspect_song_info",
                arguments: JSON.stringify({ itemOffset: 16, itemLimit: 8 }),
              },
            ],
          }
        : { content: "The tempo is 120 BPM.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(
        request.type === "inspect_song_info"
          ? `${request.type}:${request.itemOffset}:${request.itemLimit}`
          : request.type,
      );
      return "tempo=120";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, ["inspect_song_info:16:8"]);
  assert.equal(result.message, "The tempo is 120 BPM.");
});

test("runAgentLoop passes an exact paged Take Lane inspection", async () => {
  const observedRequests: unknown[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> =>
      input.messages.length === 0
        ? {
            content: "I will inspect the alternate take.",
            toolCalls: [{
              id: "take-lane",
              name: "inspect_take_lane",
              arguments: JSON.stringify({
                trackName: "Lead",
                laneIndex: 2,
                laneName: "Alternate",
                itemOffset: 24,
                itemLimit: 12,
              }),
            }],
          }
        : { content: "The requested range is empty.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(request);
      return "clips page: offset=24, shown=0, total=24, nextOffset=none";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, [{
    type: "inspect_take_lane",
    trackName: "Lead",
    laneIndex: 2,
    laneName: "Alternate",
    itemOffset: 24,
    itemLimit: 12,
  }]);
});

test("runAgentLoop passes an exact paged Rack Chain inspection", async () => {
  const observedRequests: unknown[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> =>
      input.messages.length === 0
        ? {
            content: "I will inspect the Rack Chain.",
            toolCalls: [{
              id: "rack-chain",
              name: "inspect_rack_chain",
              arguments: JSON.stringify({
                trackRole: "return",
                trackIndex: 0,
                trackName: "A-Reverb",
                rackName: "Audio Effect Rack",
                rackPath: { deviceIndex: 1 },
                chainIndex: 2,
                itemOffset: 48,
                itemLimit: 24,
              }),
            }],
          }
        : { content: "The Chain is empty.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(request);
      return "devices page: offset=48, shown=0, total=48, nextOffset=none";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, [{
    type: "inspect_rack_chain",
    trackRole: "return",
    trackIndex: 0,
    trackName: "A-Reverb",
    rackName: "Audio Effect Rack",
    rackPath: { deviceIndex: 1 },
    chainIndex: 2,
    itemOffset: 48,
    itemLimit: 24,
  }]);
});

test("runAgentLoop passes Warp Marker pagination to inspect_clip", async () => {
  const observedRequests: unknown[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> =>
      input.messages.length === 0
        ? {
            content: "I will inspect the next Warp Marker.",
            toolCalls: [{
              id: "clip",
              name: "inspect_clip",
              arguments: JSON.stringify({
                trackName: "Audio",
                startBeat: 16,
                itemOffset: 64,
                itemLimit: 32,
              }),
            }],
          }
        : { content: "The marker is aligned.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(request);
      return "warp markers page: offset=64, shown=1, total=65, nextOffset=none";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, [{
    type: "inspect_clip",
    trackName: "Audio",
    startBeat: 16,
    itemOffset: 64,
    itemLimit: 32,
  }]);
});

test("runAgentLoop passes an exact Return track locator to inspection", async () => {
  const observedRequests: unknown[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> =>
      input.messages.length === 0
        ? {
            content: "I will inspect Return B.",
            toolCalls: [{
              id: "return-mixer",
              name: "inspect_mixer",
              arguments: JSON.stringify({
                trackRole: "return",
                trackIndex: 1,
                trackName: "B-Reverb",
              }),
            }],
          }
        : { content: "Return B is configured.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(request);
      return "Return track index 1 mixer";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, [{
    type: "inspect_mixer",
    trackRole: "return",
    trackIndex: 1,
    trackName: "B-Reverb",
  }]);
});

test("runAgentLoop supports strict analyze_audio_clip tool calls", async () => {
  const observedRequests: unknown[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => input.messages.length === 0
      ? {
          content: "I will analyze the rendered Clip.",
          toolCalls: [{
            id: "audio_analysis",
            name: "analyze_audio_clip",
            arguments: JSON.stringify({
              trackName: "Vocals",
              clipName: "Lead Vocal",
              startBeat: 16,
            }),
          }],
        }
      : { content: "The pre-FX RMS is -18 dBFS.", toolCalls: [] },
    observe: async (request) => {
      observedRequests.push(request);
      return "rmsDbfs=-18";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, [{
    type: "analyze_audio_clip",
    trackName: "Vocals",
    clipName: "Lead Vocal",
    startBeat: 16,
  }]);
  assert.match(result.message, /-18 dBFS/);
});

test("runAgentLoop binds rendered audio to its tool result for the next model turn", async () => {
  const observedRequests: unknown[] = [];
  const audio = {
    type: "audio" as const,
    fileName: "live-render.wav",
    mediaType: "audio/wav" as const,
    base64: "AAAA",
  };
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      if (input.messages.length === 0) {
        return {
          content: "I will read the requested Arrangement audio.",
          toolCalls: [{
            id: "read_audio",
            name: "read_arrangement_audio",
            arguments: JSON.stringify({
              trackName: "Reference",
              clipName: "track.mp3",
              clipStartBeat: 0,
              startBeat: 0,
              endBeat: 108,
            }),
          }],
        };
      }
      const tool = input.messages.find((message) => message.role === "tool");
      assert.equal(tool?.role, "tool");
      assert.deepEqual(tool?.modelInputPart, audio);
      return { content: "I can now hear the rendered range.", toolCalls: [] };
    },
    observe: async (request) => {
      observedRequests.push(request);
      return {
        content:
          'Rendered pre-FX audio for Clip "track.mp3" on track "Reference", beatRange=0-108.',
        modelInputPart: audio,
      };
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.deepEqual(observedRequests, [{
    type: "read_arrangement_audio",
    trackName: "Reference",
    clipName: "track.mp3",
    clipStartBeat: 0,
    startBeat: 0,
    endBeat: 108,
  }]);
  assert.match(result.message, /now hear/);
});

test("tool-produced audio is accepted only after its trace result succeeds", async () => {
  const audio = {
    type: "audio" as const,
    fileName: "live-render.wav",
    mediaType: "audio/wav" as const,
    base64: "AAAA",
  };
  let accepted = 0;
  let rejectFirstTrace = true;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => input.messages.length === 0
      ? {
          content: null,
          toolCalls: [{
            id: "read-audio",
            name: "read_arrangement_audio",
            arguments: JSON.stringify({ startBeat: 0, endBeat: 4 }),
          }],
        }
      : { content: "The audio result could not be recorded.", toolCalls: [] },
    observe: async () => ({
      content: "Rendered beats 0-4.",
      modelInputPart: audio,
    }),
    onEvent: async (event) => {
      if (
        rejectFirstTrace &&
        event.kind === "tool_result" &&
        event.content === "Rendered beats 0-4."
      ) {
        rejectFirstTrace = false;
        throw new Error("trace persistence failed");
      }
    },
    onModelInputPartAccepted: () => {
      accepted += 1;
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.equal(accepted, 0);
  assert.match(result.message, /could not be recorded/i);
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
    executeActions: async () => mutationOutcome([]),
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

test("runAgentLoop emits recoverable argument rejection and apply callbacks", async () => {
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
    executeActions: async () => mutationOutcome(['Created MIDI track "Bass".']),
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
      "tool_result",
      "assistant",
      "tool_call",
      "apply_requested",
      "apply_result",
      "assistant",
    ],
  );
  assert.equal(events.find((event) => event.kind === "tool_call")?.name, "apply_live_actions");
  assert.match(
    events.find((event) => event.kind === "tool_result")?.content ?? "",
    /Invalid JSON arguments/,
  );
  assert.match(events.find((event) => event.kind === "apply_result")?.content ?? "", /Created MIDI track/);
});

test("runAgentLoop records when a low-risk plan is automatically approved", async () => {
  const eventKinds: string[] = [];
  const approvalEvents: string[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => input.messages.length === 0
      ? {
          content: "I will update the tempo.",
          toolCalls: [{
            id: "auto_apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Set tempo to 128 BPM.",
              actions: [{ type: "set_tempo", tempo: 128 }],
            }),
          }],
        }
      : { content: "Tempo updated.", toolCalls: [] },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => ({
      confirmed: true,
      source: "automatic",
      mode: "low-risk",
    }),
    executeActions: async () => mutationOutcome(["Set tempo to 128 BPM."]),
    onEvent: (event) => {
      eventKinds.push(event.kind);
      if (event.kind === "apply_auto_approved") approvalEvents.push(event.content);
    },
  });

  assert.deepEqual(eventKinds, [
    "assistant",
    "tool_call",
    "apply_requested",
    "apply_auto_approved",
    "apply_result",
    "assistant",
  ]);
  assert.deepEqual(approvalEvents, [
    "1 change · Low Risk\nAutomatic approval. Standard safety checks completed.",
  ]);
});

test("runAgentLoop identifies Accept Everything automatic approvals", async () => {
  const approvalEvents: string[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => input.messages.length === 0
      ? {
          content: "I will delete the track.",
          toolCalls: [{
            id: "accept_everything_apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Delete Bass.",
              actions: [{ type: "delete_track", trackName: "Bass" }],
            }),
          }],
        }
      : { content: "Track deleted.", toolCalls: [] },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => ({
      confirmed: true,
      source: "automatic",
      mode: "everything",
    }),
    executeActions: async () => mutationOutcome(['Deleted track "Bass".']),
    onEvent: (event) => {
      if (event.kind === "apply_auto_approved") approvalEvents.push(event.content);
    },
  });

  assert.equal(approvalEvents.length, 1);
  assert.equal(
    approvalEvents[0],
    "1 change · Accept Everything\nAutomatic approval. Standard safety checks completed.",
  );
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
    executeActions: async () => mutationOutcome([]),
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
        return mutationOutcome(['Created MIDI track "Bass".']);
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
        return mutationOutcome([]);
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

test("runAgentLoop passes the confirmed plan guard to execution for post-prepare revalidation", async () => {
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
    executeActions: async (_plan, bindings, revalidate) => {
      assert.deepEqual(bindings, { track: "bound-handle" });
      order.push("execute");
      assert.deepEqual(await revalidate(), { track: "bound-handle" });
      return mutationOutcome(['Created MIDI track "Bass".']);
    },
  });

  assert.deepEqual(order, [
    "preflight",
    "confirm",
    "revalidate",
    "execute",
    "revalidate",
  ]);
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
        return mutationOutcome([]);
      },
    });

  assert.match(result.message, /inspect it again/i);
  assert.equal(modelCalls, 2);
  assert.deepEqual(order, ["preflight", "confirm", "revalidate"]);
  assert.equal(executeCalls, 0);
});

test("preflight failures do not tell the model to split a valid plan as if its JSON were too large", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  let modelCalls = 0;

  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      modelCalls += 1;
      return modelCalls === 1
        ? {
            content: "Renaming the Scene.",
            toolCalls: [{
              id: "rename-scene",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Rename Intro",
                actions: [{
                  type: "rename_scene",
                  sceneIndex: 0,
                  newName: "Intro",
                }],
              }),
            }],
          }
        : { content: "I will inspect the current Scene state.", toolCalls: [] };
    },
    observe: async () => "Scenes refreshed.",
    preflightActions: async () => {
      throw new TypeError("Do not know how to serialize a BigInt");
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  const failure = modelInputs[1]?.messages.at(-1)?.content ?? "";
  assert.match(failure, /could not verify current Live state/i);
  assert.match(failure, /not evidence.*payload.*too large/i);
  assert.doesNotMatch(failure, /split it into smaller tool calls|valid, complete JSON/i);
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
      return mutationOutcome(['Created MIDI track "Future Bass".']);
    },
  });

  assert.equal(modelInputs.length, 3);
  assert.equal(modelInputs[1]?.messages[1]?.role, "tool");
  assert.match(modelInputs[1]?.messages[1]?.content ?? "", /Invalid JSON arguments/);
  assert.deepEqual(executedPlans, ["create_midi_track"]);
  assert.match(modelInputs[2]?.messages.at(-1)?.content ?? "", /Created MIDI track/);
});

test("observation failures are reported as host failures, not argument or payload errors", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      return input.iteration === 1
        ? {
            content: "Inspecting the track.",
            toolCalls: [{
              id: "inspect_track",
              name: "inspect_track",
              arguments: JSON.stringify({ trackName: "Arp" }),
            }],
          }
        : { content: "I will reinspect before editing.", toolCalls: [] };
    },
    observe: async () => {
      throw new Error("Live object disappeared");
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  const failure = modelInputs[1]?.messages.at(-1)?.content ?? "";
  assert.match(failure, /observation "inspect_track" failed/i);
  assert.match(failure, /tool arguments were accepted/i);
  assert.doesNotMatch(failure, /invalid json|payload.*large|split.*smaller/i);
  assert.equal(result.message, "I will reinspect before editing.");
});

test("observation tools reject unknown fields and invalid optional values", async () => {
  for (const [toolName, argumentsValue] of [
    ["inspect_track", { trackName: "Lead", itemOffest: 1 }],
    ["inspect_track", { trackName: 42 }],
    ["inspect_track", { trackRole: "return" }],
    ["inspect_track", { trackRole: "main", trackIndex: 0 }],
    ["inspect_track", { trackIndex: 0 }],
    ["inspect_rack_chain", {
      rackName: "Instrument Rack",
      chainIndex: 4096,
    }],
  ] as const) {
    let observed = false;
    const result = await runAgentLoop({
      maxConsecutiveFailures: 1,
      askModel: async (): Promise<ModelTurn> => ({
        content: "Inspecting the track.",
        toolCalls: [{
          id: "inspect",
          name: toolName,
          arguments: JSON.stringify(argumentsValue),
        }],
      }),
      observe: async () => {
        observed = true;
        return "unexpected";
      },
      confirmActions: async () => true,
      executeActions: async () => mutationOutcome([]),
    });

    assert.equal(observed, false);
    assert.match(result.message, /invalid arguments/i);
  }
});

test("unknown internal tool failures do not receive JSON or payload-size advice", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      return input.iteration === 1
        ? {
            content: "Calling an unsupported tool.",
            toolCalls: [{ id: "unknown", name: "unknown_live_tool", arguments: "{}" }],
          }
        : { content: "I will use an available tool instead.", toolCalls: [] };
    },
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  const failure = modelInputs[1]?.messages.at(-1)?.content ?? "";
  assert.match(failure, /failure category is unknown/i);
  assert.doesNotMatch(failure, /invalid json|payload.*large|split.*smaller/i);
});

test("runAgentLoop stops when different observation requests return no new Live information", async () => {
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
            name: "inspect_song_info",
            arguments: JSON.stringify({ itemOffset: input.iteration - 1, itemLimit: 1 }),
          },
        ],
      };
    },
    observe: async (request) => {
      observedRequests.push(request.type);
      return "ok";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.equal(observedRequests.length, 5);
  assert.equal(modelInputs.length, 5);
  assert.match(
    result.message,
    /4 planning steps without new Live information or a completed Live mutation/,
  );
});

test("new paged observations renew the rolling planning window", async () => {
  let observations = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (input): Promise<ModelTurn> =>
      input.iteration <= 8
        ? {
            content: `Inspecting page ${input.iteration}.`,
            toolCalls: [{
              id: `inspect_${input.iteration}`,
              name: "inspect_song_info",
              arguments: JSON.stringify({ itemOffset: input.iteration - 1, itemLimit: 1 }),
            }],
          }
        : { content: "Inspection complete.", toolCalls: [] },
    observe: async () => {
      observations += 1;
      return `page ${observations}`;
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.equal(observations, 8);
  assert.equal(result.message, "Inspection complete.");
});

test("runAgentLoop returns excessive one-turn tool fanout to the model for repair", async () => {
  let observed = 0;
  const modelInputs: AgentLoopModelInput[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxToolCallsPerTurn: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (input.iteration === 1) {
        return {
          content: "Inspecting too much at once.",
          toolCalls: [1, 2, 3].map((number) => ({
            id: `inspect_${number}`,
            name: "inspect_live_set",
            arguments: "{}",
          })),
        };
      }
      if (input.iteration === 2) {
        return {
          content: "Regrouping into one inspection.",
          toolCalls: [{
            id: "inspect_repaired",
            name: "inspect_live_set",
            arguments: "{}",
          }],
        };
      }
      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => {
      observed += 1;
      return "ok";
    },
    confirmActions: async () => true,
    executeActions: async () => mutationOutcome([]),
  });

  assert.equal(observed, 1);
  assert.equal(result.message, "Done.");
  const rejectedResults = modelInputs[1]?.messages.filter(
    (message) => message.role === "tool",
  ) ?? [];
  assert.equal(rejectedResults.length, 3);
  assert.match(rejectedResults[0]?.content ?? "", /returned 3 tool calls.*limit of 2/i);
});

test("successful Live mutations renew the rolling planning window", async () => {
  let executions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (input): Promise<ModelTurn> =>
      input.iteration <= 4
        ? {
            content: `Building stage ${input.iteration}.`,
            toolCalls: [{
              id: `apply_${input.iteration}`,
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: `Create stage ${input.iteration}`,
                actions: [{
                  type: "create_midi_track",
                  name: `Stage ${input.iteration}`,
                }],
              }),
            }],
          }
        : { content: "All four stages are complete.", toolCalls: [] },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async () => {
      executions += 1;
      return mutationOutcome([`Completed stage ${executions}.`]);
    },
  });

  assert.equal(executions, 4);
  assert.equal(result.message, "All four stages are complete.");
});

test("long workflows can continue while every stage makes Live progress", async () => {
  let executions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (input): Promise<ModelTurn> =>
      input.iteration <= 70
        ? {
            content: `Building stage ${input.iteration}.`,
            toolCalls: [{
              id: `apply_${input.iteration}`,
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: `Create stage ${input.iteration}`,
                actions: [{
                  type: "create_midi_track",
                  name: `Stage ${input.iteration}`,
                }],
              }),
            }],
          }
        : { content: "All 70 stages are complete.", toolCalls: [] },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async () => {
      executions += 1;
      return mutationOutcome([`Completed stage ${executions}.`]);
    },
  });

  assert.equal(executions, 70);
  assert.equal(result.message, "All 70 stages are complete.");
});

test("repeated successful no-op Applies do not renew the planning window", async () => {
  let executions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (input): Promise<ModelTurn> =>
      input.iteration <= 4
        ? {
            content: "Checking the already-matching sample.",
            toolCalls: [{
              id: `apply_${input.iteration}`,
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Keep the matching sample",
                actions: [{
                  type: "replace_simpler_sample",
                  trackName: "Drums",
                  simplerName: "Simpler",
                  source: { kind: "selected" },
                }],
              }),
            }],
          }
        : { content: "Unexpected continuation.", toolCalls: [] },
    observe: async () => "",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async () => {
      executions += 1;
      return mutationOutcome(["Reused the already-matching sample."], 0);
    },
  });

  assert.equal(executions, 2);
  assert.match(result.message, /without new Live information or a completed Live mutation/i);
});

test("an automatic recovery observation renews progress on the deadline step", async () => {
  let modelCalls = 0;
  const assistantContents: string[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Malformed first attempt.",
          toolCalls: [{
            id: "bad",
            name: "apply_live_actions",
            arguments: "{",
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Trying the current target.",
          toolCalls: [{
            id: "host-failure",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Insert Drift",
              actions: [{
                type: "insert_device",
                trackName: "Arp",
                deviceName: "Drift",
              }],
            }),
          }],
        };
      }
      return { content: "I can use the refreshed track state.", toolCalls: [] };
    },
    observe: async () => "Track Arp devices: none",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Failed to insert device"),
        0,
        plan.actions[0],
        "Arp",
        [],
        0,
      );
    },
    onEvent: (event) => {
      if (event.kind === "assistant") assistantContents.push(event.content);
    },
  });

  assert.equal(modelCalls, 3);
  assert.match(result.message, /unfinished Live work/i);
  assert.equal(assistantContents.at(-1), "I can use the refreshed track state.");
});

test("automatic recovery progress is scoped to the failure even when the state text was already observed", async () => {
  let modelCalls = 0;
  const assistantContents: string[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 1,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Inspecting the track first.",
          toolCalls: [{
            id: "inspect-first",
            name: "inspect_track",
            arguments: JSON.stringify({ trackName: "Arp" }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Trying Drift.",
          toolCalls: [{
            id: "host-failure-after-inspection",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Insert Drift",
              actions: [{
                type: "insert_device",
                trackName: "Arp",
                deviceName: "Drift",
              }],
            }),
          }],
        };
      }
      return { content: "I received the post-failure refresh.", toolCalls: [] };
    },
    observe: async () => "Track Arp devices: none",
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Failed to insert device"),
        0,
        plan.actions[0],
        "Arp",
        [],
        0,
      );
    },
    onEvent: (event) => {
      if (event.kind === "assistant") assistantContents.push(event.content);
    },
  });

  assert.equal(modelCalls, 3);
  assert.match(result.message, /unfinished Live work/i);
  assert.equal(assistantContents.at(-1), "I received the post-failure refresh.");
});

test("automatic recovery preserves the failed Return track locator", async () => {
  let modelCalls = 0;
  const observations: unknown[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            content: "Adjusting Return B.",
            toolCalls: [{
              id: "apply-return",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Adjust Return B",
                actions: [{
                  type: "set_track_mixer_parameter",
                  trackRef: "bus",
                  parameter: "volume",
                  value: 0.7,
                }],
                targets: {
                  bus: { trackRole: "return", trackIndex: 1, trackName: "B-Reverb" },
                },
              }),
            }],
          }
        : { content: "I inspected the failed Return.", toolCalls: [] };
    },
    observe: async (request) => {
      observations.push(request);
      return "Return B mixer";
    },
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Mixer rejected value"),
        0,
        plan.actions[0],
        "B-Reverb",
        [],
        0,
        { trackRole: "return", trackIndex: 1, trackName: "B-Reverb" },
      );
    },
  });

  assert.deepEqual(observations, [{
    type: "inspect_mixer",
    trackRole: "return",
    trackIndex: 1,
    trackName: "B-Reverb",
  }]);
});

test("automatic recovery reinspects the Set when a failed role is no longer verifiable", async () => {
  let modelCalls = 0;
  const observations: unknown[] = [];
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxIterations: 2,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            content: "Editing Return B.",
            toolCalls: [{
              id: "apply-return",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Edit Return B",
                targets: { bus: { trackRole: "return", trackIndex: 1 } },
                actions: [{ type: "insert_device", trackRef: "bus", deviceName: "Utility" }],
              }),
            }],
          }
        : { content: "I reinspected the Set.", toolCalls: [] };
    },
    observe: async (request) => {
      observations.push(request);
      return "Current Live Set";
    },
    preflightActions: async () => async () => {},
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [], new Error("Return disappeared"), 0, plan.actions[0],
        "Shared", [], 0, null,
      );
    },
  });

  assert.deepEqual(observations, [{ type: "inspect_live_set" }]);
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
      executeActions: async () => mutationOutcome([]),
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
      executeActions: async () => mutationOutcome([]),
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
    executeActions: async () => mutationOutcome([]),
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

test("runAgentLoop stops after the same invalid tool error repeats", async () => {
  let calls = 0;
  const eventKinds: string[] = [];
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
    executeActions: async () => mutationOutcome([]),
    onEvent: (event) => {
      eventKinds.push(event.kind);
    },
  });

  assert.match(result.message, /Stopped after the same invalid tool error repeated 2 times/);
  assert.deepEqual(eventKinds.slice(-2), ["tool_result", "error"]);
});

test("different argument errors can be repaired without an early hard stop", async () => {
  let calls = 0;
  let executions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "First repair attempt.",
          toolCalls: [{
            id: "missing-new-name",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Name the first Scene",
              actions: [{ type: "rename_scene", sceneIndex: 0, sceneName: "Intro" }],
            }),
          }],
        };
      }
      if (calls === 2) {
        return {
          content: "Second repair attempt.",
          toolCalls: [{
            id: "empty-current-name",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Name the first Scene",
              actions: [{
                type: "rename_scene",
                sceneIndex: 0,
                sceneName: "",
                newName: "Intro",
              }],
            }),
          }],
        };
      }
      if (calls === 3) {
        return {
          content: "Third repair attempt.",
          toolCalls: [{
            id: "duplicate-track-target",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Rename the track",
              targets: { chords: { trackName: "1-MIDI" } },
              actions: [{
                type: "rename_track",
                trackName: "1-MIDI",
                trackRef: "chords",
                newName: "Chords",
              }],
            }),
          }],
        };
      }
      if (calls === 4) {
        return {
          content: "Using the valid target shape.",
          toolCalls: [{
            id: "valid-track-target",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Rename the track",
              targets: { chords: { trackName: "1-MIDI" } },
              actions: [{
                type: "rename_track",
                trackRef: "chords",
                newName: "Chords",
              }],
            }),
          }],
        };
      }
      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => "",
    preflightActions: async () => Object.assign(async () => ({}), { actionKeys: [] }),
    confirmActions: async () => true,
    executeActions: async () => {
      executions += 1;
      return mutationOutcome(['Renamed track "1-MIDI" to "Chords".']);
    },
  });

  assert.equal(result.message, "Done.");
  assert.equal(calls, 5);
  assert.equal(executions, 1);
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
      return mutationOutcome(["Renamed", "Created clip", "Inserted device"], 3);
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
      return mutationOutcome([plan.message]);
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
      return mutationOutcome([plan.message]);
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
              resolvesPriorFailure: true,
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
          undefined,
          undefined,
          undefined,
          [],
          1,
          undefined,
          1,
        );
      }
      return mutationOutcome(['Inserted "Delay" on track "Lead".']);
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

test("a first-action Live rejection returns current state without inventing a cause", async () => {
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
          content: "The host did not identify the cause, so I will use the observed current Delay device.",
          toolCalls: [{
            id: "current-delay",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Add current Delay",
              resolvesPriorFailure: true,
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
      return mutationOutcome(['Inserted "Delay" on track "Lead".']);
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
    /could not complete its first operation.*Current Live state after the failure:.*devices=Auto Filter/is,
  );
  assert.doesNotMatch(
    modelInputs[1]?.messages.at(-1)?.content ?? "",
    /treat .*device name.*as unavailable|choose .*alternative instead of retrying/i,
  );
  assert.equal(eventKinds.includes("error"), false);
});

test("an exact device insertion can be retried after inspecting repaired Live state", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const executedDevices: string[] = [];
  let modelCalls = 0;
  let confirmations = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Trying the requested legacy delay.",
          toolCalls: [{
            id: "legacy-delay-ref",
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
          content: "Trying the same device by observed track name.",
          toolCalls: [{
            id: "legacy-delay-name",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Retry Ping Pong Delay",
              resolvesPriorFailure: true,
              actions: [{
                type: "insert_device",
                trackName: "Lead",
                deviceName: "Ping Pong Delay",
              }],
            }),
          }],
        };
      }
      return { content: "Ping Pong Delay is in place after repairing its insertion position.", toolCalls: [] };
    },
    observe: async () => 'Track "Lead" devices=none',
    preflightActions: async (plan) => {
      const action = plan.actions[0];
      assert.equal(action?.type, "insert_device");
      const deviceKey = `insert-device:track-101:${action.deviceName.toLowerCase()}`;
      return Object.assign(
        async () => undefined,
        { actionKeys: [[deviceKey]] },
      );
    },
    confirmActions: async () => {
      confirmations += 1;
      return true;
    },
    executeActions: async (plan) => {
      const action = plan.actions[0];
      assert.equal(action?.type, "insert_device");
      executedDevices.push(action.deviceName);
      if (executedDevices.length === 1) {
        throw new AgentPartialCompletionError(
          [],
          new Error("Failed to insert device"),
          0,
          action,
          "Lead",
        );
      }
      return mutationOutcome(['Inserted "Ping Pong Delay" on track "Lead".']);
    },
  });

  assert.equal(result.message, "Ping Pong Delay is in place after repairing its insertion position.");
  assert.deepEqual(executedDevices, ["Ping Pong Delay", "Ping Pong Delay"]);
  assert.equal(confirmations, 2);
  assert.doesNotMatch(
    modelInputs[1]?.messages.at(-1)?.content ?? "",
    /already rejected|treat .*as unavailable/i,
  );
});

test("an unresolved Live rejection cannot silently end on stale assistant text", async () => {
  let modelCalls = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Adding Drum Rack.",
          toolCalls: [{
            id: "drum-rack",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Add Drum Rack",
              actions: [{
                type: "insert_device",
                trackName: "Drums",
                deviceName: "Drum Rack",
              }],
            }),
          }],
        };
      }
      return { content: "", toolCalls: [] };
    },
    observe: async () => 'Track "Drums" devices=none',
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Failed to insert device"),
        0,
        plan.actions[0],
        "Drums",
      );
    },
  });

  assert.match(result.message, /stopped with unfinished Live work/i);
  assert.match(result.message, /Failed to insert device/i);
  assert.notEqual(result.message, "Adding Drum Rack.");
});

test("model limit terminals preserve unresolved Live recovery context", async () => {
  for (const limit of ["output", "context", "provider-output"] as const) {
    let modelCalls = 0;
    const result = await runAgentLoop({
      maxConsecutiveFailures: 3,
      ...(limit === "output" ? { maxModelContinuations: 0 } : {}),
      askModel: async (): Promise<ModelTurn> => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: "Adding Drum Rack.",
            toolCalls: [{
              id: `drum-rack-${limit}`,
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Add Drum Rack",
                actions: [{
                  type: "insert_device",
                  trackName: "Drums",
                  deviceName: "Drum Rack",
                }],
              }),
            }],
          };
        }
        return {
          content: `Partial ${limit} response.`,
          toolCalls: [],
          ...(limit === "output"
            ? {
                continuation: { reason: "output_limit" as const },
                providerState: { kind: "test-output-limit" },
              }
            : {
                termination: {
                  reason: limit === "context" ? "context_limit" as const : "output_limit" as const,
                },
              }),
        };
      },
      observe: async () => 'Track "Drums" devices=none',
      preflightActions: async () => async () => undefined,
      confirmActions: async () => true,
      executeActions: async (plan) => {
        throw new AgentPartialCompletionError(
          [],
          new Error("Failed to insert device"),
          0,
          plan.actions[0],
          "Drums",
        );
      },
    });

    assert.match(result.message, new RegExp(`Partial ${limit} response`, "u"));
    assert.match(result.message, /stopped with unfinished Live work/i);
    assert.match(result.message, /Failed to insert device/i);
    if (limit === "provider-output") {
      assert.match(result.message, /output-token limit.*provider-hosted tool/i);
    }
  }
});

test("a zero-mutation rejection is transient and a successful alternative clears it", async () => {
  let modelCalls = 0;
  const recoveryUpdates: Array<AgentRecoveryLedgerUpdate | undefined> = [];
  const executedDevices: string[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Trying the requested device.",
          toolCalls: [{
            id: "unavailable-device",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Insert the requested device",
              actions: [{
                type: "insert_device",
                trackName: "Lead",
                deviceName: "Unavailable Device",
              }],
            }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Using an available alternative.",
          toolCalls: [{
            id: "available-alternative",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Insert an available alternative",
              actions: [{
                type: "insert_device",
                trackName: "Lead",
                deviceName: "Drift",
              }],
            }),
          }],
        };
      }
      return { content: "Drift is now on Lead.", toolCalls: [] };
    },
    observe: async () => 'Track "Lead" devices=none',
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      const action = plan.actions[0];
      assert.equal(action?.type, "insert_device");
      executedDevices.push(action.deviceName);
      if (action.deviceName === "Unavailable Device") {
        throw new AgentPartialCompletionError(
          [],
          new Error("Failed to insert device"),
          0,
          action,
          "Lead",
        );
      }
      return mutationOutcome(['Inserted "Drift" on track "Lead".']);
    },
    onEvent: (event) => {
      if (event.kind === "apply_result") recoveryUpdates.push(event.recovery);
    },
  });

  assert.equal(result.message, "Drift is now on Lead.");
  assert.deepEqual(executedDevices, ["Unavailable Device", "Drift"]);
  assert.deepEqual(recoveryUpdates, [undefined, undefined]);
});

test("an unresolved Live rejection cannot be hidden by tool-free completion text", async () => {
  let modelCalls = 0;
  const eventKinds: string[] = [];
  const assistantContents: string[] = [];
  const errorContents: string[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Adding Drum Rack.",
          toolCalls: [{
            id: "drum-rack-with-final-text",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Add Drum Rack",
              actions: [{
                type: "insert_device",
                trackName: "Drums",
                deviceName: "Drum Rack",
              }],
            }),
          }],
        };
      }
      return { content: "Done — the rack is ready.", toolCalls: [] };
    },
    observe: async () => 'Track "Drums" devices=none',
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      throw new AgentPartialCompletionError(
        [],
        new Error("Failed to insert device"),
        0,
        plan.actions[0],
        "Drums",
      );
    },
    onEvent: (event) => {
      eventKinds.push(event.kind);
      if (event.kind === "assistant") assistantContents.push(event.content);
      if (event.kind === "error") errorContents.push(event.content);
    },
  });

  assert.match(result.message, /stopped with unfinished Live work/i);
  assert.match(result.message, /Failed to insert device/i);
  assert.match(
    result.message,
    /model returned a completion response without resolving that Live failure/i,
  );
  assert.doesNotMatch(result.message, /Done — the rack is ready/i);
  assert.equal(assistantContents.at(-1), "Done — the rack is ready.");
  assert.deepEqual(eventKinds.slice(-2), ["assistant", "error"]);
  assert.equal(errorContents.at(-1), result.message);
});

test("varied host failures stop after a bounded no-mutation budget", async () => {
  let modelCalls = 0;
  let executions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    maxIterations: 2,
    maxHostFailuresWithoutMutation: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls > 8) {
        return { content: "Unexpectedly exhausted every fallback.", toolCalls: [] };
      }
      return {
        content: `Trying host candidate ${modelCalls}.`,
        toolCalls: [{
          id: `host-candidate-${modelCalls}`,
          name: "apply_live_actions",
          arguments: JSON.stringify({
            message: `Try candidate ${modelCalls}`,
            actions: [{
              type: "insert_device",
              trackName: "Lead",
              deviceName: `Candidate ${modelCalls}`,
            }],
          }),
        }],
      };
    },
    observe: async () => 'Track "Lead" devices=none',
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      executions += 1;
      throw new AgentPartialCompletionError(
        [],
        new Error(`Host rejected candidate ${executions}`),
        0,
        plan.actions[0],
        "Lead",
      );
    },
  });

  assert.equal(executions, 3);
  assert.equal(modelCalls, 3);
  assert.match(result.message, /3 host failures without a completed Live mutation/i);
  assert.match(result.message, /unfinished Live work/i);
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
              resolvesPriorFailure: true,
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
          [],
          1,
          undefined,
          1,
        );
      }
      return mutationOutcome(['Inserted "Delay" on track "Lead".']);
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

test("request-audio import progress does not mark an unstarted plan action complete", async () => {
  let modelCalls = 0;
  let executions = 0;
  const modelInputs: AgentLoopModelInput[] = [];
  const action = { type: "set_tempo" as const, tempo: 128 };

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      modelCalls += 1;
      if (modelCalls <= 2) {
        return {
          content: modelCalls === 1
            ? "Importing the reference before applying the tempo."
            : "Applying the tempo that did not start before cancellation.",
          toolCalls: [{
            id: `request-audio-recovery-${modelCalls}`,
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Set the tempo",
              ...(modelCalls === 2 ? { resolvesPriorFailure: true } : {}),
              actions: [action],
            }),
          }],
        };
      }
      return { content: "The tempo is now set.", toolCalls: [] };
    },
    observe: async () => "Tempo: 120 BPM",
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async () => {
      executions += 1;
      if (executions === 1) {
        return {
          results: ["Imported current request audio input 1 into the Live project."],
          mutationCount: 1,
          incompleteRecovery: {
            completedActionKeys: [[
              "live-action-step:request-audio-import:event-current:0",
            ]],
            completedActionCount: 0,
            failureMessage:
              "The request was stopped before every confirmed Live action completed.",
          },
        };
      }
      return mutationOutcome(["Set tempo to 128 BPM."]);
    },
  });

  assert.equal(executions, 2);
  assert.equal(result.message, "The tempo is now set.");
  const recoveryMessage = modelInputs[1]?.messages.at(-1)?.content ?? "";
  assert.match(recoveryMessage, /partially completed after 1 operation/i);
  assert.doesNotMatch(recoveryMessage, /partially completed after 1 action/i);
});

test("MIDI creation replay is allowed only after a reusable name was applied", async (t) => {
  const namedAction = {
    type: "create_midi_clip" as const,
    trackName: "Lead",
    laneIndex: 0,
    laneName: "Alternate",
    startBeat: 0,
    durationBeats: 4,
    name: "Alternate phrase",
    notes: [{ pitch: 64, startTime: 0, duration: 1, velocity: 96 }],
  };
  const unnamedAction = {
    ...namedAction,
    name: undefined,
  };
  const scenarios = [
    {
      name: "name applied before notes failed",
      action: namedAction,
      completedKeys: [["live-action-step:retryable-named-midi-create"]],
      mutationCount: 2,
      expectedExecutions: 2,
    },
    {
      name: "name assignment failed",
      action: namedAction,
      completedKeys: [[JSON.stringify(namedAction)]],
      mutationCount: 1,
      expectedExecutions: 1,
    },
    {
      name: "unnamed notes failed",
      action: unnamedAction,
      completedKeys: [[JSON.stringify(unnamedAction)]],
      mutationCount: 1,
      expectedExecutions: 1,
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let modelCalls = 0;
      let executions = 0;
      const result = await runAgentLoop({
        maxConsecutiveFailures: 3,
        askModel: async (): Promise<ModelTurn> => {
          modelCalls += 1;
          if (modelCalls <= 2) {
            return {
              content: modelCalls === 1 ? "Creating the Clip." : "Finishing its notes.",
              toolCalls: [{
                id: `take-lane-midi-${modelCalls}`,
                name: "apply_live_actions",
                arguments: JSON.stringify({
                  message: "Write the alternate phrase",
                  ...(modelCalls === 2 ? { resolvesPriorFailure: true } : {}),
                  actions: [scenario.action],
                }),
              }],
            };
          }
          return { content: "Done.", toolCalls: [] };
        },
        observe: async () => 'Track "Lead" Take Lane 0 "Alternate" clips=1',
        preflightActions: async () => async () => undefined,
        confirmActions: async () => true,
        executeActions: async (plan) => {
          executions += 1;
          if (executions === 1) {
            throw new AgentPartialCompletionError(
              ['Created MIDI clip "Alternate phrase" in Take Lane 0.'],
              new Error(`${scenario.name}.`),
              0,
              plan.actions[0],
              "Lead",
              scenario.completedKeys,
              scenario.mutationCount,
            );
          }
          return mutationOutcome(["Updated the exact named MIDI clip."]);
        },
      });

      assert.equal(executions, scenario.expectedExecutions);
      if (scenario.expectedExecutions === 2) {
        assert.equal(result.message, "Done.");
      } else {
        assert.match(result.message, /unfinished Live work/i);
      }
    });
  }
});

test("persisted completed-action digests block replay in a later loop", async () => {
  const completedAction = {
    type: "insert_device",
    trackName: "Lead",
    deviceName: "Auto Filter",
  } as const;
  let modelCalls = 0;
  let executions = 0;
  const assistantContents: string[] = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    initialRecoveryState: {
      completedActionDigests: [
        digestActionIdentity(JSON.stringify(completedAction)),
      ],
      unresolvedFailure: "A later device in the original plan still failed.",
    },
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            content: "Retrying the original completed action.",
            toolCalls: [{
              id: "persisted-repeat",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Retry completed filter",
                actions: [completedAction],
              }),
            }],
          }
        : { content: "I need a different repair.", toolCalls: [] };
    },
    observe: async () => 'Track "Lead" devices=Auto Filter',
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async () => {
      executions += 1;
      return mutationOutcome(["Unexpected duplicate"]);
    },
    onEvent: (event) => {
      if (event.kind === "assistant") assistantContents.push(event.content);
    },
  });

  assert.equal(executions, 0);
  assert.match(result.message, /unfinished Live work/i);
  assert.equal(assistantContents.at(-1), "I need a different repair.");
});

test("successful intermediate Applies keep and extend active replay protection", async () => {
  const completedAction = {
    type: "insert_device",
    trackName: "Lead",
    deviceName: "Auto Filter",
  } as const;
  const intermediateAction = { type: "set_tempo", tempo: 128 } as const;
  const recoveryUpdates: Array<{ active: boolean; completedActionDigests: string[] }> = [];
  const executedTypes: string[] = [];
  let modelCalls = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    initialRecoveryState: {
      completedActionDigests: [
        digestActionIdentity(JSON.stringify(completedAction)),
      ],
      unresolvedFailure: "A later device in the original plan still failed.",
    },
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "Applying an intermediate song-level change.",
          toolCalls: [{
            id: "intermediate-apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Set tempo while repair continues",
              actions: [intermediateAction],
            }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Retrying the earlier completed insertion.",
          toolCalls: [{
            id: "repeat-after-intermediate",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Repeat completed filter",
              actions: [completedAction],
            }),
          }],
        };
      }
      return { content: "The repair is still incomplete.", toolCalls: [] };
    },
    observe: async () => "tempo=128; devices=Auto Filter",
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      executedTypes.push(plan.actions[0]!.type);
      return mutationOutcome(["Set tempo to 128 BPM."]);
    },
    onEvent: (event) => {
      if (event.kind === "apply_result" && event.recovery) {
        recoveryUpdates.push(event.recovery);
      }
    },
  });

  assert.deepEqual(executedTypes, ["set_tempo"]);
  assert.match(result.message, /unfinished Live work/i);
  assert.equal(recoveryUpdates.at(-1)?.active, true);
  assert.ok(
    recoveryUpdates.at(-1)?.completedActionDigests.includes(
      digestActionIdentity(JSON.stringify(intermediateAction)),
    ),
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
              ...(modelCalls === 6 ? { resolvesPriorFailure: true } : {}),
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
      return mutationOutcome(['Inserted "Delay" on track "Lead".']);
    },
  });

  assert.equal(result.message, "Delay is in place.");
  assert.deepEqual(executedDevices, ["Ping Pong Delay", "Delay"]);
  assert.equal(observationCalls, 3);
});

test("a Take Lane recovery inspection may add the observed name guard", async () => {
  let modelCalls = 0;
  let observationCalls = 0;
  let executions = 0;
  const action = {
    type: "create_midi_clip" as const,
    trackName: "Lead",
    laneIndex: 2,
    startBeat: 0,
    durationBeats: 4,
    notes: [{ pitch: 64, startTime: 0, duration: 1, velocity: 96 }],
  };
  const result = await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async (): Promise<ModelTurn> => {
      modelCalls += 1;
      if (modelCalls === 1 || modelCalls === 3) {
        return {
          content: "Writing the alternate take.",
          toolCalls: [{
            id: `lane-apply-${modelCalls}`,
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Write the alternate take",
              actions: [action],
            }),
          }],
        };
      }
      if (modelCalls === 2) {
        return {
          content: "Checking the exact lane.",
          toolCalls: [{
            id: "lane-inspect",
            name: "inspect_take_lane",
            arguments: JSON.stringify({
              trackName: "Lead",
              laneIndex: 2,
              laneName: "Alternate",
            }),
          }],
        };
      }
      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => {
      observationCalls += 1;
      if (observationCalls === 1) throw new Error("Refresh unavailable");
      return 'Take Lane index 2 "Alternate" clips=0';
    },
    preflightActions: async () => async () => undefined,
    confirmActions: async () => true,
    executeActions: async (plan) => {
      executions += 1;
      if (executions === 1) {
        throw new AgentPartialCompletionError(
          [],
          new Error("Take Lane write failed"),
          0,
          plan.actions[0],
          "Lead",
        );
      }
      return mutationOutcome(["Created the Take Lane MIDI Clip."]);
    },
  });

  assert.equal(result.message, "Done.");
  assert.equal(executions, 2);
  assert.equal(observationCalls, 2);
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
        mode: "fill_empty_pad",
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
      name: "top-level duplicate device selected by index",
      action: {
        type: "duplicate_device",
        trackName: "Lead",
        deviceName: "Auto Filter",
        deviceIndex: 2,
      },
      trackName: "Lead",
      expected: {
        type: "inspect_device",
        trackName: "Lead",
        deviceName: "Auto Filter",
        deviceIndex: 2,
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
      name: "Rack Chain mixer",
      action: {
        type: "set_chain_mixer_parameter",
        trackName: "Lead",
        rackName: "Instrument Rack",
        rackPath: { deviceIndex: 0 },
        chainIndex: 1,
        parameter: "volume",
        value: 0.6,
      },
      trackName: "Lead",
      expected: {
        type: "inspect_rack_chain",
        trackName: "Lead",
        rackName: "Instrument Rack",
        rackPath: { deviceIndex: 0 },
        chainIndex: 1,
      },
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
      name: "high-index Session View Scene",
      action: {
        type: "rename_scene",
        sceneIndex: 42,
        sceneName: "Break",
        newName: "Verse",
      },
      trackName: undefined,
      expected: {
        type: "inspect_song_info",
        itemOffset: 42,
        itemLimit: 1,
      },
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
    mode: "fill_empty_pad",
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
              ...(modelCalls === 2 ? { resolvesPriorFailure: true } : {}),
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
      return mutationOutcome(["Configured MIDI note 36 in Drum Rack."]);
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
          undefined,
          undefined,
          undefined,
          [],
          1,
          undefined,
          1,
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
          undefined,
          undefined,
          undefined,
          [],
          1,
          undefined,
          1,
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
