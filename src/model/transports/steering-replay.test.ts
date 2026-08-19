import assert from "node:assert/strict";
import test from "node:test";

import { resolveModelCapabilities } from "../capabilities.js";
import type { ModelConversationMessage } from "../contracts.js";
import type { DirectApiConnection, SavedProfile } from "../profile.js";
import type { ModelTransport, TransportRequest } from "../provider.js";
import { createAnthropicMessagesTransport } from "./anthropic-messages.js";
import { createOpenAIChatTransport } from "./openai-chat.js";
import { createOpenAIResponsesTransport } from "./openai-responses.js";

type ReplayEntry =
  | { kind: "tool-call"; id: string }
  | { kind: "tool-result"; id: string; content: string }
  | { kind: "steering" };

const steeringContent = "Steer toward the Lead track.";
const agentMessages: ModelConversationMessage[] = [
  {
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "call-completed", name: "inspect", arguments: "{}" },
      { id: "call-skipped", name: "apply", arguments: "{}" },
    ],
  },
  { role: "tool", toolCallId: "call-completed", content: "completed" },
  {
    role: "tool",
    toolCallId: "call-skipped",
    content: "skipped: superseded by steering",
  },
  { role: "user", content: steeringContent },
];

type DirectApiPair =
  | [apiFamily: "openai", apiMode: "responses" | "chat-completions"]
  | [apiFamily: "anthropic", apiMode: "messages"];

function profile(...pair: DirectApiPair): SavedProfile {
  const connection: DirectApiConnection = pair[0] === "openai"
    ? {
        kind: "direct-api",
        apiFamily: pair[0],
        apiMode: pair[1],
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
      }
    : {
        kind: "direct-api",
        apiFamily: pair[0],
        apiMode: pair[1],
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
      };
  return {
    id: `${connection.apiFamily}-${connection.apiMode}`,
    name: `${connection.apiFamily} ${connection.apiMode}`,
    connection,
    model: "test-model",
    parameters: {
      maxOutputTokens: 1024,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

function request(savedProfile: SavedProfile): TransportRequest {
  return {
    runtimeProfile: {
      profile: savedProfile,
      capabilities: resolveModelCapabilities(savedProfile),
    },
    currentUserContent: [{ type: "text", text: "Inspect the current Set." }],
    systemInstructions: "Test system instructions",
    history: [],
    agentMessages,
    tools: [
      { type: "function", function: { name: "inspect", description: "Inspect" } },
      { type: "function", function: { name: "apply", description: "Apply" } },
    ],
  };
}

function completedOpenAIResponse(): Response {
  return new Response(JSON.stringify({
    status: "completed",
    output_text: "Done",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function completedChatResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Done" },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function completedAnthropicResponse(): Response {
  return new Response(JSON.stringify({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Done" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function responsesReplay(body: Record<string, unknown>): ReplayEntry[] {
  const input = body.input as Array<Record<string, unknown>>;
  return input.flatMap((item): ReplayEntry[] => {
    if (item.type === "function_call") {
      return [{ kind: "tool-call", id: String(item.call_id) }];
    }
    if (item.type === "function_call_output") {
      return [{
        kind: "tool-result",
        id: String(item.call_id),
        content: String(item.output),
      }];
    }
    if (item.role === "user" && item.content === steeringContent) {
      return [{ kind: "steering" }];
    }
    return [];
  });
}

function chatReplay(body: Record<string, unknown>): ReplayEntry[] {
  const messages = body.messages as Array<Record<string, unknown>>;
  return messages.flatMap((message): ReplayEntry[] => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      return (message.tool_calls as Array<Record<string, unknown>>).map((call) => ({
        kind: "tool-call",
        id: String(call.id),
      }));
    }
    if (message.role === "tool") {
      return [{
        kind: "tool-result",
        id: String(message.tool_call_id),
        content: String(message.content),
      }];
    }
    if (message.role === "user" && message.content === steeringContent) {
      return [{ kind: "steering" }];
    }
    return [];
  });
}

function anthropicReplay(body: Record<string, unknown>): ReplayEntry[] {
  const messages = body.messages as Array<Record<string, unknown>>;
  return messages.flatMap((message): ReplayEntry[] => {
    if (!Array.isArray(message.content)) return [];
    return (message.content as Array<Record<string, unknown>>).flatMap(
      (block): ReplayEntry[] => {
        if (block.type === "tool_use") {
          return [{ kind: "tool-call", id: String(block.id) }];
        }
        if (block.type === "tool_result") {
          return [{
            kind: "tool-result",
            id: String(block.tool_use_id),
            content: String(block.content),
          }];
        }
        if (block.type === "text" && block.text === steeringContent) {
          return [{ kind: "steering" }];
        }
        return [];
      },
    );
  });
}

const cases: Array<{
  name: string;
  savedProfile: SavedProfile;
  createTransport: (fetchImpl: typeof fetch) => ModelTransport;
  completedResponse: () => Response;
  replayFromBody: (body: Record<string, unknown>) => ReplayEntry[];
}> = [
  {
    name: "OpenAI Responses",
    savedProfile: profile("openai", "responses"),
    createTransport: (fetchImpl) => createOpenAIResponsesTransport({ fetchImpl }),
    completedResponse: completedOpenAIResponse,
    replayFromBody: responsesReplay,
  },
  {
    name: "OpenAI Chat Completions",
    savedProfile: profile("openai", "chat-completions"),
    createTransport: (fetchImpl) => createOpenAIChatTransport({ fetchImpl }),
    completedResponse: completedChatResponse,
    replayFromBody: chatReplay,
  },
  {
    name: "Anthropic Messages",
    savedProfile: profile("anthropic", "messages"),
    createTransport: (fetchImpl) => createAnthropicMessagesTransport({ fetchImpl }),
    completedResponse: completedAnthropicResponse,
    replayFromBody: anthropicReplay,
  },
];

for (const testCase of cases) {
  test(`${testCase.name} closes every tool call before replaying steering`, async () => {
    let body: Record<string, unknown> = {};
    const transport = testCase.createTransport(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return testCase.completedResponse();
    });

    await transport.createToolTurn(request(testCase.savedProfile));

    const replay = testCase.replayFromBody(body);
    assert.deepEqual(replay, [
      { kind: "tool-call", id: "call-completed" },
      { kind: "tool-call", id: "call-skipped" },
      { kind: "tool-result", id: "call-completed", content: "completed" },
      {
        kind: "tool-result",
        id: "call-skipped",
        content: "skipped: superseded by steering",
      },
      { kind: "steering" },
    ]);
    const calls = replay
      .filter((entry) => entry.kind === "tool-call")
      .map((entry) => entry.id);
    const results = replay
      .filter((entry) => entry.kind === "tool-result")
      .map((entry) => entry.id);
    assert.deepEqual(results, calls, "every replayed tool call must be closed");
  });
}
