import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";

import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import type { ModelConversationMessage, ModelInputPart } from "../../../src/model/contracts.js";
import type { DirectApiConnection, DirectApiProfile } from "../../../src/model/profile.js";
import type { ModelTransport, TransportRequest } from "../../../src/model/provider.js";
import { createAnthropicMessagesTransport } from "../../../src/model/transports/anthropic-messages.js";
import { createOpenAIChatTransport } from "../../../src/model/transports/openai-chat.js";
import { createOpenAIResponsesTransport } from "../../../src/model/transports/openai-responses.js";

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

function profile(...pair: DirectApiPair): DirectApiProfile {
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
    defaultModel: "test-model",
    models: [{
      model: "test-model",
      parameters: {
        maxOutputTokens: 1024,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
}

function request(savedProfile: DirectApiProfile): TransportRequest {
  return {
    runtimeProfile: runtimeProfileForSavedProfile(savedProfile),
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
    type: "message",
    role: "assistant",
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
    if (item.role === "user" && hasSteeringText(item.content)) {
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
    if (message.role === "user" && hasSteeringText(message.content)) {
      return [{ kind: "steering" }];
    }
    return [];
  });
}

function hasSteeringText(content: unknown): boolean {
  return content === steeringContent || Array.isArray(content) && content.some((part) =>
    part && typeof part === "object" && "text" in part && part.text === steeringContent);
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
  savedProfile: DirectApiProfile;
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

  test(`${testCase.name} maps steered media after closing every tool call`, async () => {
    let body: Record<string, unknown> = {};
    const transport = testCase.createTransport(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return testCase.completedResponse();
    });
    const target = request(testCase.savedProfile);
    target.runtimeProfile.capabilities.inputs = { image: true, pdf: true, audio: true };
    target.runtimeProfile.inputCapabilityEvidence = { image: "supported", pdf: "supported", audio: "supported" };
    const chat = testCase.savedProfile.connection.apiMode === "chat-completions";
    const parts: ModelInputPart[] = [
      { type: "text", text: steeringContent },
      { type: "image", fileName: "reference.png", mediaType: "image/png", base64: "AA==" },
      chat
        ? { type: "audio", fileName: "reference.wav", mediaType: "audio/wav", bytes: Uint8Array.from(Buffer.from("AA==", "base64")) }
        : { type: "document", fileName: "score.pdf", mediaType: "application/pdf", base64: "AA==" },
    ];
    target.agentMessages = [...agentMessages.slice(0, -1), { role: "user", content: parts }];
    await transport.createToolTurn(target);
    assert.equal(testCase.replayFromBody(body).at(-1)?.kind, "steering");
    assert.deepEqual(testCase.replayFromBody(body).map((entry) => entry.kind), [
      "tool-call", "tool-call", "tool-result", "tool-result", "steering",
    ]);
    const messages = (body.input ?? body.messages) as Array<Record<string, unknown>>;
    const lastContent = messages.at(-1)?.content as Array<Record<string, unknown>>;
    const mapped = lastContent.filter((part) => part.type !== "tool_result");
    const mode = testCase.savedProfile.connection.apiMode;
    assert.deepEqual(mapped, mode === "responses" ? [
      { type: "input_text", text: steeringContent },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
      { type: "input_file", filename: "score.pdf", file_data: "data:application/pdf;base64,AA==" },
    ] : mode === "chat-completions" ? [
      { type: "text", text: steeringContent },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "auto" } },
      { type: "input_audio", input_audio: { data: "AA==", format: "wav" } },
    ] : [
      { type: "text", text: steeringContent },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "document", title: "score.pdf", source: { type: "base64", media_type: "application/pdf", data: "AA==" } },
    ]);
  });

  test(`${testCase.name} includes steered media in the combined request budget`, async () => {
    let fetchCalls = 0;
    const transport = testCase.createTransport(async () => {
      fetchCalls++;
      return testCase.completedResponse();
    });
    const target = request(testCase.savedProfile);
    target.runtimeProfile.capabilities.inputs.image = true;
    const image: ModelInputPart = { type: "image", fileName: "image.png", mediaType: "image/png", base64: "AA==" };
    target.history = [{ role: "user", content: [image, image] }];
    target.currentUserContent.push(image);
    target.agentMessages = [{ role: "user", content: [image, image] }];
    await assert.rejects(transport.createToolTurn(target), /at most 4 binary attachments/);
    assert.equal(fetchCalls, 0);
  });

  test(`${testCase.name} applies image capability checks to steering before sending`, async () => {
    let fetchCalls = 0;
    const transport = testCase.createTransport(async () => {
      fetchCalls++;
      return testCase.completedResponse();
    });
    const target = request(testCase.savedProfile);
    target.runtimeProfile.capabilities.inputs.image = false;
    target.agentMessages = [{ role: "user", content: [
      { type: "image", fileName: "image.png", mediaType: "image/png", base64: "AA==" },
    ] }];
    await assert.rejects(transport.createToolTurn(target), /Image input is disabled/);
    assert.equal(fetchCalls, 0);
  });
}
