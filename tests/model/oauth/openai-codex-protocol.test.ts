import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import test from "node:test";

import type { OAuthCredential } from "../../../src/storage/oauth-credentials.js";
import { NetworkProxyError } from "../../../src/runtime/network-proxy-error.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelInputTooLargeError,
  ModelRetryableError,
} from "../../../src/model/connection-error.js";
import type { TransportRequest } from "../../../src/model/provider.js";
import { createOpenAICodexProtocol } from "../../../src/model/oauth/openai-codex-protocol.js";
import { modelToolsForProfile } from "../../../src/model/tools.js";

const credential: Extract<OAuthCredential, { provider: "openai" }> = {
  provider: "openai",
  accessToken: "openai-access",
  refreshToken: "openai-refresh",
  expiresAt: Date.now() + 3_600_000,
  accountId: "account-1",
};

function request(): TransportRequest {
  return {
    runtimeProfile: {
      profile: {
        id: "openai-oauth",
        name: "ChatGPT",
        connection: { kind: "oauth-subscription", provider: "openai" },
      },
      model: {
        model: "gpt-account-model",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        contextWindowTokens: 272_000,
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "medium", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: true, audio: false, pdf: false },
      },
      inputCapabilityEvidence: {
        image: "supported",
        audio: "unsupported",
        pdf: "unsupported",
      },
    },
    currentUserContent: [{ type: "text", text: "Inspect the track" }],
    systemInstructions: "Use Live Smith tools.",
    history: [],
    agentMessages: [],
    tools: [{
      type: "function",
      function: {
        name: "inspect_live_set",
        description: "Inspect Live",
        parameters: { type: "object", properties: {} },
      },
    }],
  };
}

function streamResponse(
  events: unknown[],
  headers: Record<string, string> = {},
): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    },
  );
}

test("ChatGPT subscription search uses the standalone endpoint and preserves mixed tool replay", async () => {
  const bodies: Record<string, any>[] = [];
  const searches: Record<string, any>[] = [];
  const updates: unknown[] = [];
  const source = { url: "https://www.ableton.com/en/manual/", title: "Live manual" };
  const search = { type: "function_call", id: "fc_search", call_id: "search_1", name: "live_smith_web_search", arguments: '{"query":"Live documentation"}', status: "completed" };
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "inspect_live_set", arguments: "{}", status: "completed" };
  const protocol = createOpenAICodexProtocol({ fetchImpl: async (input, init) => {
    if (String(input).endsWith("/alpha/search")) {
      searches.push(JSON.parse(String(init?.body)));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openai-access");
      assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "account-1");
      return new Response(JSON.stringify({ output: "The Live manual is at https://www.ableton.com/en/manual/", encrypted_output: "private-search-state",
        results: [{ type: "text_result", ref_id: "turn0search0", ...source }, { type: "text_result", url: "file:///private", title: "Invalid link" }] }));
    }
    bodies.push(JSON.parse(String(init?.body)));
    return streamResponse([{ type: "response.completed", response: { status: "completed", output: bodies.length === 1 ? [search, call]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished." }] }] } }]);
  } });
  const current = request();
  current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.tools = modelToolsForProfile(current.runtimeProfile,
    current.tools.filter(tool => tool.type === "function"), 3);
  current.onHostedWebSearch = update => { updates.push(update); };
  const turn = await protocol.createToolTurn(current, credential);
  assert.equal(bodies[0]?.tools.at(-1).name, "live_smith_web_search");
  assert(bodies[0]?.tools.every((tool: any) => tool.type === "function"));
  assert.equal(bodies[0]?.max_tool_calls, undefined);
  assert(!bodies[0]?.include.includes("web_search_call.action.sources"));
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0]?.commands, { search_query: [{ q: "Live documentation" }], response_length: "short" });
  assert.deepEqual(searches[0]?.settings, { allowed_callers: ["direct"], external_web_access: true });
  assert.equal(searches[0]?.model, current.runtimeProfile.model.model);
  assert.deepEqual(searches[0]?.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "Live documentation" }] }]);
  const id = turn.hostedWebSearches![0]!.id;
  assert.deepEqual(updates, [{ id, status: "searching", action: "search", queries: ["Live documentation"], sources: [] },
    { id, status: "completed", action: "search", queries: ["Live documentation"], sources: [source] }]);
  assert.deepEqual(turn.hostedWebSearches, [updates[1]]);
  assert.deepEqual(turn.toolCalls.map(tool => tool.name), ["inspect_live_set"]);
  assert.equal(turn.citations, undefined);
  current.agentMessages = [
    { role: "assistant", content: turn.content, toolCalls: turn.toolCalls, providerState: turn.providerState },
    { role: "tool", toolCallId: "call_1", content: "Inspected" },
  ];
  current.tools = current.tools.filter(tool => tool.type === "function");
  await protocol.createToolTurn(current, credential);
  assert(bodies[1]?.input.some((item: unknown) => JSON.stringify(item) === JSON.stringify(search)));
  assert(bodies[1]?.input.some((item: any) => item.type === "function_call_output" && item.call_id === "search_1" && item.output.includes(source.url)));
  assert(!JSON.stringify(bodies[1]).includes("private-search-state"));
  assert(bodies[1]?.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_1"));
});

test("ChatGPT persists terminal search activity before empty-answer parsing fails", async () => {
  const activity: unknown[] = [];
  const protocol = createOpenAICodexProtocol({ fetchImpl: async () => streamResponse([{
    type: "response.completed",
    response: { status: "completed", output: [{
      id: "failed-search", type: "web_search_call", status: "failed",
      action: { type: "search", query: "Live manual", sources: [] },
    }] },
  }]) });
  const current = request();
  current.tools.push({ type: "hosted_web_search", maxUses: 1 });
  current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.onHostedWebSearch = update => { activity.push(update); };
  await assert.rejects(protocol.createToolTurn(current, credential), /empty response/);
  assert.deepEqual(activity, [{ id: "failed-search", status: "failed", action: "search", queries: ["Live manual"], sources: [] }]);
});

for (const failure of ["request", "body", "server", "auth"] as const) test(`ChatGPT standalone search resumes only its pending query after ${failure} failure`, async () => {
  let modelCalls = 0;
  const searches: Array<{ id: string; query: string; authorization: string | null }> = [];
  const protocol = createOpenAICodexProtocol({ fetchImpl: async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/alpha/search")) {
      searches.push({ id: body.id, query: body.commands.search_query[0].q, authorization: new Headers(init?.headers).get("authorization") });
      if (searches.length === 2) {
        if (failure === "request") throw new TypeError("private connection diagnostic");
        if (failure === "body") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body diagnostic")); } }) as unknown as BodyInit);
        return new Response("{}", { status: failure === "auth" ? 401 : 503 });
      }
      return new Response(JSON.stringify({ output: `Result for ${body.commands.search_query[0].q}`, results: [] }));
    }
    modelCalls++;
    return streamResponse([{ type: "response.completed", response: { status: "completed", output: modelCalls === 1
      ? ["First", "Second"].map((query, index) => ({ type: "function_call", call_id: `search_${index}`, name: "live_smith_web_search", arguments: JSON.stringify({ query }) }))
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Both searches completed." }] }] } }]);
  } });
  const current = request();
  current.reconnectState = {};
  current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.tools = [{ type: "hosted_web_search", maxUses: 2 }];
  await assert.rejects(protocol.createToolTurn(current, credential), failure === "auth" ? ModelAuthenticationError : ModelRetryableError);
  // The application has already charged the completed search to this send.
  current.tools = [{ type: "hosted_web_search", maxUses: 1 }];
  const turn = await protocol.createToolTurn(current, { ...credential, accessToken: "refreshed" });
  assert.equal(modelCalls, 1);
  assert.deepEqual(searches.map(search => search.query), ["First", "Second", "Second"]);
  assert.equal(searches[1]!.id, searches[2]!.id);
  assert.equal(searches[2]!.authorization, "Bearer refreshed");
  assert.equal(turn.continuation?.reason, "hosted_tools");
  assert.equal(turn.contextProjection?.messages.length, 3);
  assert.equal(turn.contextProjection?.usageMessageCount, 1);
  assert.deepEqual(turn.hostedWebSearches?.map(search => search.status), ["completed", "completed"]);
  assert.deepEqual(turn.toolCalls, []);
  current.agentMessages = [{ role: "assistant", content: turn.content, toolCalls: [], providerState: turn.providerState }];
  current.tools = []; current.reconnectState = {};
  const answer = await protocol.createToolTurn(current, credential);
  assert.equal(answer.content, "Both searches completed.");
  assert.equal(searches.length, 3);
});

test("ChatGPT standalone search observes cancellation without requesting an answer or publishing completion", async () => {
  const controller = new AbortController();
  const updates: string[] = [];
  let modelCalls = 0;
  const protocol = createOpenAICodexProtocol({ fetchImpl: async input => {
    if (String(input).endsWith("/alpha/search")) {
      controller.abort(new Error("Stopped search"));
      throw new TypeError("private abort diagnostic");
    }
    modelCalls++;
    return streamResponse([{ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "search", name: "live_smith_web_search", arguments: '{"query":"Live manual"}' }] } }]);
  } });
  const current = request(); current.signal = controller.signal;
  current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.tools = [{ type: "hosted_web_search", maxUses: 1 }];
  current.onHostedWebSearch = update => { updates.push(update.status); };
  await assert.rejects(protocol.createToolTurn(current, credential), /Stopped search/);
  assert.equal(modelCalls, 1); assert.deepEqual(updates, ["searching"]);
});

test("ChatGPT standalone search keeps account rejection private and obeys the local search allowance", async () => {
  let searches = 0;
  const protocol = createOpenAICodexProtocol({ fetchImpl: async input => {
    if (String(input).endsWith("/alpha/search")) {
      searches++;
      return new Response(JSON.stringify({ error: { code: "permission_denied", message: "private credential-bearing error" } }), { status: 403 });
    }
    return streamResponse([{ type: "response.completed", response: { status: "completed", output: [0, 1].map(index => ({
      type: "function_call", call_id: `search_${index}`, name: "live_smith_web_search", arguments: '{"query":"Live manual"}',
    })) } }]);
  } });
  const current = request(); current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.tools = [{ type: "hosted_web_search", maxUses: 1 }];
  const turn = await protocol.createToolTurn(current, credential);
  assert.equal(searches, 1); assert.equal(turn.continuation?.reason, "hosted_tools");
  assert.deepEqual(turn.hostedWebSearches?.map(search => search.status), ["failed"]);
  assert.deepEqual(turn.toolCalls, []);
  const replay = JSON.stringify(turn.providerState);
  assert.match(replay, /allowance exhausted/); assert.doesNotMatch(replay, /private credential-bearing/);
});

for (const results of [undefined, null, []]) test(`ChatGPT standalone search accepts the optional results field: ${JSON.stringify(results)}`, async () => {
  const protocol = createOpenAICodexProtocol({ fetchImpl: async input => String(input).endsWith("/alpha/search")
    ? new Response(JSON.stringify({ output: "No matching pages.", results }))
    : streamResponse([{ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "search", name: "live_smith_web_search", arguments: '{"query":"Live manual"}' }] } }]),
  });
  const current = request(); current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.tools = [{ type: "hosted_web_search", maxUses: 1 }];
  const turn = await protocol.createToolTurn(current, credential);
  assert.equal(turn.continuation?.reason, "hosted_tools");
  assert.equal(turn.hostedWebSearches?.[0]?.status, "completed");
  assert.deepEqual(turn.hostedWebSearches?.[0]?.sources, []);
  assert.match(JSON.stringify(turn.providerState), /No matching pages/);
});

test("ChatGPT OAuth loads the signed-in Codex model catalog", async () => {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6 Astra",
            supported_in_api: true,
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
              { effort: "medium", description: "Balanced" },
              { effort: "high", description: "Deep" },
              { effort: "ultra", description: "Deepest" },
            ],
            context_window: 272_000,
            input_modalities: ["text", "image", "audio", "pdf"],
          },
          {
            slug: "gpt-subscription-only",
            display_name: "GPT Subscription Only",
            supported_in_api: false,
            visibility: "list",
            max_context_window: 500_000,
          },
          {
            slug: "gpt-internal",
            display_name: "GPT Internal",
            supported_in_api: false,
            visibility: "none",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const models = await protocol.listModels({
    id: "openai-oauth",
    name: "ChatGPT",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "",
    models: [],
  }, credential);

  assert.equal(
    capturedUrl,
    "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1",
  );
  assert.equal(capturedHeaders?.get("authorization"), "Bearer openai-access");
  assert.equal(capturedHeaders?.get("chatgpt-account-id"), "account-1");
  assert.equal(capturedHeaders?.get("user-agent"), "live-smith");
  assert.deepEqual(models, [
    {
      id: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        contextWindowTokens: 272_000,
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "medium", "high", "ultra"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: true, audio: false, pdf: true },
      },
      providerReported: {
        inputs: { inputModalities: ["text", "image", "audio", "pdf"] },
      },
    },
    {
      id: "gpt-subscription-only",
      displayName: "GPT Subscription Only",
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        contextWindowTokens: 500_000,
      },
    },
  ]);
});

test("ChatGPT OAuth captures and replays Codex turn state within a tool loop", async () => {
  const requestHeaders: Headers[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestNumber = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestNumber += 1;
      if (requestNumber === 1) {
        return streamResponse([
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              status: "completed",
              call_id: "call-1",
              name: "inspect_live_set",
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
            },
          },
        ], { "x-codex-turn-state": "turn-state-1" });
      }
      return streamResponse([
        {
          type: "response.metadata",
          headers: { "X-Codex-Turn-State": "turn-state-2" },
        },
        {
          type: "response.output_text.delta",
          delta: "Ready",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Ready" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "response-2",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          },
        },
      ]);
    },
  });

  const first = await protocol.createToolTurn(request(), credential);
  assert.deepEqual(first.providerState, {
    kind: "openai-responses",
    output: [{
      type: "function_call",
      status: "completed",
      call_id: "call-1",
      name: "inspect_live_set",
      arguments: "{}",
    }],
    codexTurnState: "turn-state-1",
  });

  const next = request();
  next.agentMessages = [
    {
      role: "assistant",
      content: null,
      toolCalls: first.toolCalls,
      providerState: first.providerState,
    },
    { role: "tool", toolCallId: "call-1", content: "Track state" },
  ];
  const second = await protocol.createToolTurn(next, credential);

  assert.equal(requestHeaders[0]?.has("x-codex-turn-state"), false);
  assert.equal(requestHeaders[0]?.get("content-type"), "application/json");
  assert.equal(requestHeaders[1]?.get("x-codex-turn-state"), "turn-state-1");
  assert.equal(requestBodies[0]?.store, false);
  assert.equal(requestBodies[0]?.stream, true);
  assert.equal(requestBodies[0]?.parallel_tool_calls, true);
  assert.equal("max_output_tokens" in requestBodies[0]!, false);
  assert.equal(second.content, "Ready");
  assert.deepEqual(second.contextUsage, {
    usedTokens: 12,
    contextWindowTokens: 272_000,
  });
  assert.deepEqual(second.providerState, {
    kind: "openai-responses",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Ready" }],
    }],
    codexTurnState: "turn-state-1",
  });
});

test("ChatGPT OAuth restores streamed output order before replay", async () => {
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "call-2",
          name: "second_call",
          arguments: "{}",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "first_call",
          arguments: "{}",
        },
      },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]),
  });

  const turn = await protocol.createToolTurn(request(), credential);

  assert.deepEqual(turn.toolCalls.map((call) => call.name), [
    "first_call",
    "second_call",
  ]);
  assert.deepEqual(
    (turn.providerState as { output: Array<{ call_id?: unknown }> }).output.map(
      (item) => item.call_id,
    ),
    ["call-1", "call-2"],
  );
});

test("ChatGPT OAuth rejects duplicate and incomplete streamed output indices", async () => {
  const cases = [
    {
      name: "duplicate",
      events: [
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "First" }],
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Duplicate" }],
          },
        },
      ],
      error: /duplicate completed output index/u,
    },
    {
      name: "incomplete",
      events: [{
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Missing index zero" }],
        },
      }],
      error: /incomplete completed output indices/u,
    },
  ];

  for (const candidate of cases) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([
        ...candidate.events,
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      candidate.error,
      candidate.name,
    );
  }
});

test("ChatGPT OAuth preserves incomplete and contradictory terminal semantics", async () => {
  const partial = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Partial" }],
        },
      },
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
    ]),
  });
  const turn = await partial.createToolTurn(request(), credential);
  assert.equal(turn.content, "Partial");
  assert.deepEqual(turn.continuation, { reason: "output_limit" });

  const contradictory = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.completed",
      response: { status: "incomplete", output: [] },
    }]),
  });
  await assert.rejects(
    contradictory.createToolTurn(request(), credential),
    /terminal event.*contradicted/u,
  );

  const malformed = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Must not mask malformed output" }],
        },
      },
      {
        type: "response.completed",
        response: { status: "completed", output: null },
      },
    ]),
  });
  await assert.rejects(
    malformed.createToolTurn(request(), credential),
    /returned no output items/u,
  );
});

test("ChatGPT OAuth answers a truncated function call before continuing", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestNumber = 0;
  const partialCall = {
    id: "fc-codex-incomplete",
    type: "function_call",
    call_id: "call-codex-incomplete",
    name: "inspect_live_set",
    arguments: "{",
    status: "incomplete",
  };
  const secondPartialCall = {
    id: "fc-codex-incomplete-2",
    type: "function_call",
    call_id: "call-codex-incomplete-2",
    name: "inspect_live_set",
    arguments: "{\"track",
    status: "incomplete",
  };
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestNumber += 1;
      return requestNumber === 1
        ? streamResponse([{
          type: "response.output_item.done",
          output_index: 0,
          item: partialCall,
        }, {
          type: "response.output_item.done",
          output_index: 1,
          item: secondPartialCall,
        }, {
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
          }])
        : streamResponse([{
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "message-codex-completed",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Done", annotations: [] }],
            },
          }, {
            type: "response.completed",
            response: { status: "completed", output: [] },
          }]);
    },
  });
  const first = await protocol.createToolTurn(request(), credential);
  assert.deepEqual(first.toolCalls, []);
  assert.equal(
    (first.providerState as { outputLimited?: unknown }).outputLimited,
    true,
  );
  const next = request();
  next.agentMessages = [{
    role: "assistant",
    content: first.content,
    toolCalls: first.toolCalls,
    providerState: first.providerState,
  }];

  await protocol.createToolTurn(next, credential);

  const secondInput = requestBodies[1]?.input as Array<Record<string, unknown>>;
  assert.deepEqual(secondInput.slice(-4), [
    partialCall,
    secondPartialCall,
    {
      type: "function_call_output",
      call_id: "call-codex-incomplete",
      output:
        "Function call was not executed because the model response reached its output-token limit.",
    },
    {
      type: "function_call_output",
      call_id: "call-codex-incomplete-2",
      output:
        "Function call was not executed because the model response reached its output-token limit.",
    },
  ]);
});

test("ChatGPT OAuth rejects duplicate call IDs in incomplete output", async () => {
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc-duplicate-1",
        type: "function_call",
        call_id: "duplicate-call",
        name: "inspect_live_set",
        arguments: "{",
        status: "incomplete",
      },
    }, {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "fc-duplicate-2",
        type: "function_call",
        call_id: "duplicate-call",
        name: "inspect_live_set",
        arguments: "{",
        status: "incomplete",
      },
    }, {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    /duplicate tool call ID/u,
  );
});

test("ChatGPT OAuth rejects success terminals after an error event", async () => {
  const sentinel = "codex-private-contradictory-error";
  for (const eventType of ["response.completed", "response.incomplete"] as const) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "error",
        code: "provider_failure",
        message: sentinel,
      }, {
        type: eventType,
        response: {
          ...(eventType === "response.incomplete"
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
          output: [{
            id: "message-after-error",
            type: "message",
            role: "assistant",
            status: eventType === "response.completed" ? "completed" : "incomplete",
            content: [{ type: "output_text", text: "must not survive", annotations: [] }],
          }],
        },
      }]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (error: unknown) => {
        assert.match(String(error), /terminal response after an error event/u);
        assert.doesNotMatch(String(error), new RegExp(sentinel));
        return true;
      },
    );
  }
});

test("ChatGPT OAuth shares strict terminal Web Search and citation decoding", async () => {
  const malformedItems = [{
    id: "search-invalid-status",
    type: "web_search_call",
    status: "in_progress",
    action: { type: "search", query: "Ableton" },
  }, {
    id: "message-invalid-citation",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{
      type: "output_text",
      text: "Done",
      annotations: [{ type: "url_citation", url: 42 }],
    }],
  }];
  for (const item of malformedItems) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.output_item.done",
        output_index: 0,
        item,
      }, {
        type: "response.completed",
        response: { status: "completed", output: [] },
      }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      /invalid (?:web_search_call|url_citation)/u,
    );
  }
});

test("ChatGPT OAuth shares incomplete message-role and Web Search replay validation", async () => {
  const validSearch = {
    id: "search-codex-in-progress",
    type: "web_search_call",
    status: "in_progress",
    action: { type: "search", query: "Ableton", sources: [] },
  };
  const validProtocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.output_item.done",
      output_index: 0,
      item: validSearch,
    }, {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    }]),
  });

  const turn = await validProtocol.createToolTurn(request(), credential);

  assert.deepEqual(turn.continuation, { reason: "output_limit" });
  assert.equal(turn.hostedWebSearches, undefined);
  assert.deepEqual(
    (turn.providerState as { output: unknown[] }).output,
    [validSearch],
  );

  for (const item of [{
    id: "message-codex-invalid-role",
    type: "message",
    role: "user",
    status: "incomplete",
    content: [{ type: "output_text", text: "must not survive", annotations: [] }],
  }, {
    ...validSearch,
    action: { type: "search", query: 42 },
  }]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.output_item.done",
        output_index: 0,
        item,
      }, {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      /invalid (?:message role|web_search_call)/u,
    );
  }
});

test("ChatGPT OAuth preserves refusal events and unknown object output for replay", async () => {
  const sentinel = "codex-private-refusal-metadata";
  const deltas: string[] = [];
  const refusalItem = {
    type: "message",
    role: "assistant",
    content: [
      { type: "refusal", refusal: "I cannot help with that request." },
      { type: "future_private_part", private_metadata: sentinel },
    ],
  };
  const unknownOutputItem = {
    type: "future_output_item",
    opaque_state: sentinel,
  };
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.refusal.delta",
        delta: "I cannot ",
        private_metadata: sentinel,
      },
      {
        type: "response.refusal.delta",
        delta: "help with that request.",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: refusalItem,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: unknownOutputItem,
      },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]),
  });
  const req = request();
  req.onDelta = (delta) => { deltas.push(delta); };

  const turn = await protocol.createToolTurn(req, credential);

  assert.equal(turn.content, "I cannot help with that request.");
  assert.deepEqual(deltas, ["I cannot ", "help with that request."]);
  assert.deepEqual(
    (turn.providerState as { output: unknown[] }).output,
    [refusalItem, unknownOutputItem],
  );
  assert.doesNotMatch(turn.content ?? "", new RegExp(sentinel));
});

test("ChatGPT OAuth rejects malformed known visible delta events", async () => {
  for (const type of ["response.output_text.delta", "response.refusal.delta"]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type,
        delta: { private_value: "do-not-expose" },
      }]),
    });
    const req = request();
    req.onDelta = () => {};

    await assert.rejects(
      protocol.createToolTurn(req, credential),
      (error: unknown) => {
        assert.match(String(error), /invalid visible text delta/i);
        assert.doesNotMatch(String(error), /do-not-expose/u);
        return true;
      },
      type,
    );
  }
});

test("ChatGPT OAuth rejects non-object terminal output items", async () => {
  const sentinel = "codex-private-primitive-output";
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.completed",
      response: {
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Safe text" }],
        }, sentinel],
      },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (error: unknown) => {
      assert.match(String(error), /non-object output item/i);
      assert.doesNotMatch(String(error), new RegExp(sentinel));
      return true;
    },
  );
});

test("ChatGPT OAuth preserves the first Codex turn state across reconnect", async () => {
  const requestHeaders: Headers[] = [];
  let requestNumber = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      requestNumber += 1;
      if (requestNumber === 1) {
        return streamResponse([], { "x-codex-turn-state": "turn-state-1" });
      }
      return streamResponse([
        {
          type: "response.metadata",
          headers: { "X-Codex-Turn-State": "turn-state-2" },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Recovered" }],
            }],
          },
        },
      ]);
    },
  });
  const reconnectState = {};
  const first = request();
  first.reconnectState = reconnectState;

  await assert.rejects(
    protocol.createToolTurn(first, credential),
    ModelConnectionError,
  );

  const second = request();
  second.reconnectState = reconnectState;
  const recovered = await protocol.createToolTurn(second, credential);

  assert.equal(requestHeaders[0]?.has("x-codex-turn-state"), false);
  assert.equal(
    requestHeaders[1]?.get("x-codex-turn-state"),
    "turn-state-1",
  );
  assert.equal(recovered.content, "Recovered");
  assert.equal(
    (recovered.providerState as { codexTurnState?: unknown }).codexTurnState,
    "turn-state-1",
  );
});

test("ChatGPT OAuth preserves an explicitly safe network proxy diagnosis", async () => {
  const error = new NetworkProxyError(
    "macOS automatic proxy configuration is not supported; choose Manual proxy instead.",
  );
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => {
      throw error;
    },
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.equal(failure instanceof ModelConnectionError, false);
      assert.match(failure.message, /choose Manual proxy instead/u);
      return true;
    },
  );
});

test("ChatGPT OAuth classifies transient HTTP generation failures", async () => {
  for (const status of [408, 409, 429, 500, 503]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => new Response("sensitive upstream detail", {
        status,
        headers: { "retry-after-ms": "2250" },
      }),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof ModelRetryableError);
        assert.equal(failure.retryAfterMs, 2_250);
        assert.match(failure.message, new RegExp(`HTTP ${status}.*retryable`, "u"));
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      String(status),
    );
  }
});

test("ChatGPT OAuth preserves request-size rejection for attachment recovery", async () => {
  let requests = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: {
        type: "invalid_request_error", message: "private upstream detail openai-access",
      } }), { status: 413, headers: { "content-type": "application/json" } });
    },
  });
  const input = request();
  input.currentUserContent.push({
    type: "image", fileName: "reference.png", mediaType: "image/png", base64: "AQID",
  });

  await assert.rejects(protocol.createToolTurn(input, credential), (failure: unknown) => {
    assert.ok(failure instanceof ModelInputTooLargeError);
    assert.equal(failure instanceof ModelRetryableError, false);
    assert.match(failure.message, /ChatGPT Codex HTTP 413.*Choose fewer files/u);
    assert.doesNotMatch(failure.message, /private upstream detail|openai-access/u);
    return true;
  });
  assert.equal(requests, 1);
});

test("ChatGPT OAuth decodes bounded headerless HTTP errors", async () => {
  const sentinel = "codex-private-headerless-error";
  const bytes = new TextEncoder().encode(JSON.stringify({
    error: {
      code: "invalid_prompt",
      type: "invalid_request_error",
      message: sentinel,
    },
  }));
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }) as never, { status: 400 }),
  });

  await assert.rejects(protocol.createToolTurn(request(), credential), (failure: unknown) => {
    assert.ok(failure instanceof Error);
    assert.equal(failure instanceof ModelRetryableError, false);
    assert.match(
      failure.message,
      /HTTP 400.*rejected.*code=invalid_prompt; type=invalid_request_error/u,
    );
    assert.doesNotMatch(failure.message, new RegExp(sentinel));
    return true;
  });
});

test("ChatGPT OAuth cancels a hanging headerless HTTP error body", {
  timeout: 2_000,
}, async () => {
  let cancelled = false;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }) as never, { status: 503 }),
  });

  await assert.rejects(protocol.createToolTurn(request(), credential), (failure: unknown) => {
    assert.ok(failure instanceof ModelRetryableError);
    assert.match(failure.message, /HTTP 503/u);
    return true;
  });
  assert.equal(cancelled, true);
});

test("ChatGPT OAuth replays turn state captured from a retryable HTTP response", async () => {
  const requestHeaders: Headers[] = [];
  let calls = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      calls += 1;
      if (calls === 1) {
        return new Response("temporary failure", {
          status: 503,
          headers: { "x-codex-turn-state": "retry-turn-state" },
        });
      }
      return streamResponse([{
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Recovered" }],
          }],
        },
      }]);
    },
  });
  const reconnectState = {};
  const first = request();
  first.reconnectState = reconnectState;
  await assert.rejects(protocol.createToolTurn(first, credential), ModelRetryableError);

  const second = request();
  second.reconnectState = reconnectState;
  const turn = await protocol.createToolTurn(second, credential);

  assert.equal(requestHeaders[0]?.has("x-codex-turn-state"), false);
  assert.equal(requestHeaders[1]?.get("x-codex-turn-state"), "retry-turn-state");
  assert.equal(turn.content, "Recovered");
});

test("ChatGPT OAuth classifies response failures after their error envelope", async () => {
  for (const code of [
    "rate_limit_exceeded",
    "provider_failure",
    "server_is_overloaded",
    "slow_down",
    "future_transient_failure",
  ]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([
        {
          type: "error",
          code,
          message: "sensitive envelope detail",
          param: null,
        },
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code, message: "sensitive terminal detail" },
          },
        },
      ], { "retry-after-ms": "1500" }),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof ModelRetryableError);
        assert.equal(failure instanceof ModelConnectionError, false);
        assert.equal(failure.retryAfterMs, 1_500);
        assert.match(failure.message, /ChatGPT Codex.*retryable/u);
        assert.match(failure.message, new RegExp(`code=${code}`));
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      code,
    );
  }
});

test("ChatGPT OAuth keeps fatal response failure categories safe and actionable", async () => {
  const cases = [
    ["context_length_exceeded", /context window was exceeded/u],
    ["insufficient_quota", /account usage limit was reached/u],
    ["credit_balance_exhausted", /account usage limit was reached/u],
    ["organization_spend_limit_exceeded", /account usage limit was reached/u],
    ["project_spend_limit_exceeded", /account usage limit was reached/u],
    ["organization_usage_limit_exceeded", /account usage limit was reached/u],
    ["usage_not_included", /usage is not included/u],
    ["invalid_prompt", /rejected the request/u],
    ["bio_policy", /rejected the request/u],
    ["cyber_policy", /rejected the request/u],
    ["misalignment_policy_violation", /rejected the request/u],
  ] as const;

  for (const [code, expected] of cases) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.failed",
        response: {
          status: "failed",
          error: { code, message: "sensitive terminal detail" },
        },
      }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof Error);
        assert.equal(failure instanceof ModelRetryableError, false);
        assert.match(failure.message, expected);
        assert.match(failure.message, new RegExp(`code=${code}`));
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      code,
    );
  }
});

test("ChatGPT OAuth treats failed envelopes without a safe code or type as malformed", async () => {
  const sentinel = "codex-private-malformed-failure";
  const malformedResponses: unknown[] = [
    undefined,
    null,
    {},
    { status: "failed" },
    { status: "failed", error: "provider_failure" },
    { status: "failed", error: {} },
    { status: "failed", error: { code: "BAD-CODE", message: sentinel } },
    { status: "completed", error: { code: "provider_failure" } },
    { status: "failed", code: "provider_failure", message: sentinel },
  ];
  for (const response of malformedResponses) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.failed",
        ...(response === undefined ? {} : { response }),
      }]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof Error);
        assert.equal(failure instanceof ModelRetryableError, false);
        assert.match(failure.message, /malformed failed response/u);
        assert.doesNotMatch(failure.message, /BAD-CODE|provider_failure|private/u);
        return true;
      },
    );
  }
});

test("ChatGPT OAuth accepts a canonical type-only failed envelope", async () => {
  const sentinel = "codex-private-type-only-failure";
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.failed",
      response: {
        status: "failed",
        error: { type: "server_error", message: sentinel },
      },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (failure: unknown) => {
      assert.ok(failure instanceof ModelRetryableError);
      assert.match(failure.message, /type=server_error/u);
      assert.doesNotMatch(failure.message, new RegExp(sentinel));
      return true;
    },
  );
});

test("ChatGPT OAuth preserves top-level and nested unterminated error envelopes", async () => {
  for (const event of [{
    type: "error",
    code: "provider_failure",
    message: "sensitive upstream detail",
  }, {
    type: "error",
    error: {
      code: "provider_failure",
      type: "server_error",
      message: "sensitive upstream detail",
    },
  }]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([event]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof ModelRetryableError);
        assert.match(failure.message, /retryable failure.*code=provider_failure/u);
        if ("error" in event) assert.match(failure.message, /type=server_error/u);
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
    );
  }
});

test("ChatGPT OAuth requests reasoning summaries and keeps encrypted state private", async () => {
  const reasoning = {
    id: "reasoning-codex",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Reading the Live context." }],
    encrypted_content: "private-codex-state",
  };
  const message = {
    id: "message-codex",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done", annotations: [] }],
  };
  const bodies: Array<Record<string, unknown>> = [];
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamResponse([
        { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
        { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Reading " },
        { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "the Live context." },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 1, item: message },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ]);
    },
  });
  const updates: unknown[] = [];
  const req = request();
  req.onReasoning = (update) => { updates.push(update); };

  const turn = await protocol.createToolTurn(req, credential);

  assert.deepEqual(bodies[0]?.reasoning, { summary: "auto" });
  assert.deepEqual(updates, [
    { type: "start" },
    { type: "delta", delta: "Reading " },
    { type: "delta", delta: "the Live context." },
  ]);
  assert.deepEqual(turn.reasoning, { content: "Reading the Live context." });
  assert.equal(JSON.stringify(turn.reasoning).includes("private-codex-state"), false);

  req.runtimeProfile.model.parameters.reasoning = { mode: "enabled", effort: "high" };
  req.agentMessages = [{
    role: "assistant",
    content: turn.content,
    toolCalls: turn.toolCalls,
    providerState: turn.providerState,
  }];
  await protocol.createToolTurn(req, credential);
  assert.deepEqual(bodies[1]?.reasoning, { effort: "high", summary: "auto" });
  assert.ok(JSON.stringify(bodies[1]?.input).includes("private-codex-state"));

  req.runtimeProfile.model.parameters.reasoning = { mode: "disabled" };
  await protocol.createToolTurn(req, credential);
  assert.deepEqual(bodies[2]?.reasoning, { effort: "none" });

  req.runtimeProfile.model.parameters.reasoning = { mode: "default" };
  req.runtimeProfile.capabilities.reasoning.supported = false;
  await protocol.createToolTurn(req, credential);
  assert.equal(bodies[3]?.reasoning, undefined);
});
