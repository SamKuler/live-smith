import assert from "node:assert/strict";
import test from "node:test";

import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import type { TransportRequest } from "../provider.js";
import { decodeGoogleCloudCodeAssistCatalog } from "./google-catalog.js";
import { createGoogleCloudCodeAssistProtocol } from "./google-protocol.js";

const credential = {
  provider: "google" as const,
  accessToken: "google-access",
  refreshToken: "google-refresh",
  expiresAt: Date.now() + 3_600_000,
  projectId: "project-1",
  accountLabel: null,
};

function request(): TransportRequest {
  return {
    runtimeProfile: {
      profile: {
        id: "google-subscription",
        name: "Gemini",
        connection: { kind: "oauth-subscription", provider: "google" },
      },
      model: {
        model: "gemini-3.1-pro-preview",
        parameters: {
          reasoning: { mode: "enabled", effort: "high" },
        },
        advanced: {},
      },
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "supported",
        maxOutputTokens: 65_535,
        contextWindowTokens: 1_048_576,
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "high"],
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
    currentUserContent: [{ type: "text", text: "Inspect the selected track" }],
    systemInstructions: "Use Live Smith tools.",
    history: [],
    agentMessages: [],
    tools: [{
      type: "function",
      function: {
        name: "inspect",
        description: "Inspect Live state",
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

function catalogResponse(modelIds: readonly string[]): Record<string, unknown> {
  return {
    buckets: modelIds.map((modelId) => ({
      modelId,
      remainingFraction: 1,
    })),
  };
}

test("Google Cloud Code Assist loads the signed-in account model catalog", async () => {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody: unknown;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify(catalogResponse([
        "gemini-3.1-pro-preview",
        "gemini-account-experimental",
        "gemini-3.1-pro-preview",
      ])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const models = await protocol.listModels({
    id: "google-subscription",
    name: "Gemini",
    connection: { kind: "oauth-subscription", provider: "google" },
    defaultModel: "",
    models: [],
  }, credential);

  assert.equal(
    capturedUrl,
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  );
  assert.equal(capturedHeaders?.get("authorization"), "Bearer google-access");
  assert.deepEqual(capturedBody, { project: "project-1" });
  assert.deepEqual(models.map((model) => model.id), [
    "gemini-3.1-pro-preview",
    "gemini-account-experimental",
  ]);
  assert.deepEqual(models[1]?.capabilities, {});
});

test("Google Cloud Code Assist maps streaming text, tools, usage, and request auth", async () => {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        {
          error: null,
          response: {
            candidates: [{
              content: {
                role: "model",
                parts: [
                  { text: "I will inspect it. " },
                  {
                    functionCall: { name: "inspect", args: {}, id: "call-1" },
                    thoughtSignature: "signature-1",
                  },
                ],
              },
              finishReason: "STOP",
            }],
            usageMetadata: {
              totalTokenCount: 120,
              promptTokenCount: 100,
              candidatesTokenCount: 20,
            },
          },
        },
      ]);
    },
  });
  const deltas: string[] = [];
  const turn = await protocol.createToolTurn(
    { ...request(), onDelta: (delta) => { deltas.push(delta); } },
    {
      provider: "google",
      accessToken: "google-access",
      refreshToken: "google-refresh",
      expiresAt: Date.now() + 3_600_000,
      projectId: "project-1",
      accountLabel: "listener@example.com",
    },
  );

  assert.equal(capturedUrl, "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  assert.equal(capturedHeaders?.get("authorization"), "Bearer google-access");
  assert.equal(capturedHeaders?.has("client-metadata"), false);
  assert.equal(capturedBody?.project, "project-1");
  assert.deepEqual(Object.keys(capturedBody ?? {}).sort(), [
    "model",
    "project",
    "request",
    "user_prompt_id",
  ]);
  assert.match(String(capturedBody?.user_prompt_id), /^[0-9a-f-]{36}$/u);
  assert.equal("requestId" in (capturedBody ?? {}), false);
  assert.equal("userAgent" in (capturedBody ?? {}), false);
  assert.equal(turn.content, "I will inspect it. ");
  assert.deepEqual(turn.toolCalls, [{ id: "call-1", name: "inspect", arguments: "{}" }]);
  assert.deepEqual(turn.contextUsage, {
    usedTokens: 120,
    contextWindowTokens: 1_048_576,
  });
  assert.deepEqual(deltas, ["I will inspect it. "]);
});

test("Google generation classifies a rejected Fetch as connection loss", async () => {
  const promptIds: string[] = [];
  let requests = 0;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (_input, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as {
        user_prompt_id: string;
      };
      promptIds.push(body.user_prompt_id);
      if (requests === 1) {
        throw new Error("credential-bearing Fetch failure");
      }
      return streamResponse([{
        response: {
          candidates: [{
            content: { role: "model", parts: [{ text: "Recovered" }] },
            finishReason: "STOP",
          }],
        },
      }]);
    },
  });
  const reconnectState = {};
  const first = request();
  first.reconnectState = reconnectState;

  const error = await protocol.createToolTurn(first, credential).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof ModelConnectionError);
  assert.doesNotMatch(error.message, /credential-bearing/u);

  const retry = request();
  retry.reconnectState = reconnectState;
  await protocol.createToolTurn(retry, credential);
  assert.equal(promptIds[0], promptIds[1]);
});

test("Google generation preserves an explicitly safe network proxy diagnosis", async () => {
  const error = new NetworkProxyError(
    "macOS automatic proxy configuration is not supported; choose Manual proxy instead.",
  );
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async () => {
      throw error;
    },
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (failure: unknown) => failure === error,
  );
});

test("Google retryable HTTP responses reuse the reconnect prompt identity", async () => {
  const promptIds: string[] = [];
  let requests = 0;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (_input, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as { user_prompt_id: string };
      promptIds.push(body.user_prompt_id);
      if (requests === 1) {
        return new Response("", { status: 503 });
      }
      return streamResponse([{
        response: {
          candidates: [{
            content: { role: "model", parts: [{ text: "Recovered" }] },
            finishReason: "STOP",
          }],
        },
      }]);
    },
  });
  const reconnectState = {};
  const first = request();
  first.reconnectState = reconnectState;
  await assert.rejects(
    protocol.createToolTurn(first, credential),
    ModelRetryableError,
  );

  const retry = request();
  retry.reconnectState = reconnectState;
  await protocol.createToolTurn(retry, credential);
  assert.equal(promptIds[0], promptIds[1]);
});

test("Google generation rejects partial clean EOF as connection loss", async () => {
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async () => streamResponse([{
      response: {
        candidates: [{
          content: { role: "model", parts: [{ text: "Partial" }] },
        }],
      },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    ModelConnectionError,
  );
});

test("Google generation treats explicit stream errors as provider failures", async () => {
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async () => streamResponse([{
      error: { message: "credential-bearing upstream detail" },
    }]),
  });

  const error = await protocol.createToolTurn(request(), credential).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof Error);
  assert.equal(error instanceof ModelConnectionError, false);
  assert.match(error.message, /Google Cloud Code Assist stream error/u);
  assert.doesNotMatch(error.message, /credential-bearing/u);
});

test("Google generation classifies HTTP authentication, retryable, and fatal failures", async (t) => {
  const cases = [
    {
      status: 401,
      assertError(error: unknown) {
        assert.ok(error instanceof ModelAuthenticationError);
        assert.equal(error.message, "Google Cloud Code Assist HTTP 401: request failed");
      },
    },
    ...[429, 499, 500, 503, 599].map((status) => ({
      status,
      assertError(error: unknown) {
        assert.ok(error instanceof ModelRetryableError);
        assert.equal(error.retryAfterMs, 2_500);
        assert.equal(
          error.message,
          `Google Cloud Code Assist HTTP ${status}: retryable request failure`,
        );
      },
    })),
    {
      status: 400,
      assertError(error: unknown) {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.equal(error.message, "Google Cloud Code Assist HTTP 400: request failed");
      },
    },
    {
      status: 403,
      assertError(error: unknown) {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.equal(error.message, "Google Cloud Code Assist HTTP 403: request failed");
      },
    },
    {
      status: 501,
      assertError(error: unknown) {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.equal(error.message, "Google Cloud Code Assist HTTP 501: request failed");
      },
    },
  ];

  for (const entry of cases) {
    await t.test(`HTTP ${entry.status}`, async () => {
      const protocol = createGoogleCloudCodeAssistProtocol({
        fetchImpl: async () => new Response(JSON.stringify({
          error: {
            message: "credential-bearing provider detail",
            metadata: { accessToken: "secret-access-token" },
          },
        }), {
          status: entry.status,
          headers: {
            "content-type": "application/json",
            "retry-after": "2.5",
          },
        }),
      });

      const error = await protocol.createToolTurn(request(), credential).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      entry.assertError(error);
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /credential-bearing|secret-access-token/u,
      );
    });
  }
});

test("Google HTTP errors honor structured terminal reasons and RetryInfo", async () => {
  const cases = [
    {
      reason: "RATE_LIMIT_EXCEEDED",
      status: 429,
      extraDetail: {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "3.25s",
      },
      retryAfterMs: 3_250,
      message: "Google Cloud Code Assist rate limit was reached.",
    },
    {
      reason: "QUOTA_EXHAUSTED",
      status: 429,
      message: "Google Cloud Code Assist quota is exhausted for this account.",
    },
    {
      reason: "VALIDATION_REQUIRED",
      status: 403,
      message: "Google Cloud Code Assist requires account validation before continuing.",
    },
  ] as const;

  for (const entry of cases) {
    const protocol = createGoogleCloudCodeAssistProtocol({
      fetchImpl: async () => new Response(JSON.stringify({
        error: {
          code: entry.status,
          status: entry.status === 403 ? "PERMISSION_DENIED" : "RESOURCE_EXHAUSTED",
          message: "credential-bearing provider detail",
          details: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: entry.reason,
            metadata: { private_project: "secret-project" },
          }, ...("extraDetail" in entry ? [entry.extraDetail] : [])],
        },
      }), {
        status: entry.status,
        headers: { "content-type": "application/json" },
      }),
    });

    const error = await protocol.createToolTurn(request(), credential).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message, entry.message);
    const retryAfterMs = "retryAfterMs" in entry
      ? entry.retryAfterMs
      : undefined;
    assert.equal(error instanceof ModelRetryableError, retryAfterMs !== undefined);
    if (error instanceof ModelRetryableError) {
      assert.equal(error.retryAfterMs, retryAfterMs);
    }
    assert.doesNotMatch(error.message, /credential-bearing|secret-project/u);
  }
});

test("Google generation classifies structured SSE errors without exposing provider detail", async (t) => {
  const cases = [
    {
      label: "numeric transient",
      error: { status: 503 },
      retryable: true,
      message: "Google Cloud Code Assist temporarily could not complete the request.",
    },
    {
      label: "status transient",
      error: { status: "RESOURCE_EXHAUSTED" },
      retryable: true,
      message: "Google Cloud Code Assist temporarily could not complete the request.",
    },
    {
      label: "canonical data loss",
      error: { code: 500, status: "DATA_LOSS" },
      retryable: false,
      message: "Google Cloud Code Assist stream error.",
    },
    {
      label: "canonical not implemented",
      error: { code: 501, status: "NOT_IMPLEMENTED" },
      retryable: false,
      message: "Google Cloud Code Assist stream error.",
    },
    {
      label: "rate limit",
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
        }],
      },
      retryable: true,
      message: "Google Cloud Code Assist rate limit was reached.",
    },
    {
      label: "quota exhausted",
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "QUOTA_EXHAUSTED",
        }],
      },
      retryable: false,
      message: "Google Cloud Code Assist quota is exhausted for this account.",
    },
    {
      label: "model capacity exhausted",
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "MODEL_CAPACITY_EXHAUSTED",
        }],
      },
      retryable: false,
      message: "Google Cloud Code Assist model capacity is exhausted.",
    },
    {
      label: "validation required",
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "VALIDATION_REQUIRED",
          metadata: { validation_link: "https://secret.example/validate" },
        }],
      },
      retryable: false,
      message: "Google Cloud Code Assist requires account validation before continuing.",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const protocol = createGoogleCloudCodeAssistProtocol({
        fetchImpl: async () => streamResponse([{
          error: {
            ...entry.error,
            message: "credential-bearing upstream detail",
          },
        }], { "retry-after-ms": "1750" }),
      });

      const error = await protocol.createToolTurn(request(), credential).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ModelRetryableError, entry.retryable);
      assert.equal(error.message, entry.message);
      if (error instanceof ModelRetryableError) {
        assert.equal(error.retryAfterMs, 1_750);
      }
      assert.doesNotMatch(
        error.message,
        /credential-bearing|secret\.example/u,
      );
    });
  }
});

test("Google accepts only successful finish reasons even when text is present", async (t) => {
  for (const finishReason of [
    "MALFORMED_FUNCTION_CALL",
    "SAFETY",
    "FUTURE_FINISH_REASON",
  ]) {
    await t.test(finishReason, async () => {
      const deltas: string[] = [];
      const protocol = createGoogleCloudCodeAssistProtocol({
        fetchImpl: async () => streamResponse([{
          response: {
            candidates: [{
              content: { role: "model", parts: [{ text: "Do not accept me" }] },
              finishReason,
            }],
          },
        }]),
      });
      const target = request();
      target.onDelta = (delta) => { deltas.push(delta); };

      await assert.rejects(protocol.createToolTurn(target, credential), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.equal(
          error.message,
          "Google Cloud Code Assist did not complete the response.",
        );
        assert.doesNotMatch(error.message, /Do not accept me/u);
        return true;
      });
      assert.deepEqual(deltas, []);
    });
  }
});

test("Google treats prompt policy feedback as a fatal provider result", async () => {
  for (const blockReason of ["SAFETY", "FUTURE_BLOCK_REASON"]) {
    const protocol = createGoogleCloudCodeAssistProtocol({
      fetchImpl: async () => streamResponse([{
        response: {
          promptFeedback: {
            blockReason,
            blockReasonMessage: "credential-bearing policy detail",
          },
        },
      }]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.equal(error.message, "Google Cloud Code Assist blocked the prompt.");
        assert.doesNotMatch(error.message, /credential-bearing/u);
        return true;
      },
      blockReason,
    );
  }
});

test("Google does not expose an output-limited tool call", async () => {
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async () => streamResponse([{
      response: {
        candidates: [{
          content: {
            role: "model",
            parts: [{ functionCall: { name: "inspect", args: {} } }],
          },
          finishReason: "MAX_TOKENS",
        }],
      },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    /output limit with an incomplete tool call/u,
  );
});

test("Google rejects malformed non-null stream error envelopes", async () => {
  for (const errorValue of ["private error", 503, true]) {
    const protocol = createGoogleCloudCodeAssistProtocol({
      fetchImpl: async () => streamResponse([{ error: errorValue }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.equal(error.message, "Google Cloud Code Assist stream error.");
        assert.doesNotMatch(error.message, /private/u);
        return true;
      },
    );
  }
});

test("Google rejects malformed stream and response envelopes without retrying", async () => {
  for (const event of [null, "private event", { response: "private response" }]) {
    const protocol = createGoogleCloudCodeAssistProtocol({
      fetchImpl: async () => streamResponse([event]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ModelRetryableError, false);
        assert.match(error.message, /non-object stream event|invalid response event/u);
        assert.doesNotMatch(error.message, /private/u);
        return true;
      },
    );
  }
});

test("Google quota windows distinguish daily from per-minute limits", async () => {
  for (const source of ["http", "stream"] as const) {
    for (const quota of [
      {
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-Daily-secret",
        retryable: false,
        message: "Google Cloud Code Assist daily quota is exhausted.",
      },
      {
        quotaId: "GenerateRequestsPerMinutePerProjectPerModel-secret",
        retryable: true,
        retryAfterMs: 60_000,
        message: "Google Cloud Code Assist rate limit was reached.",
      },
      {
        quotaId: "UnknownCloudCodeQuota-secret",
        retryable: true,
        message: "Google Cloud Code Assist temporarily could not complete the request.",
      },
    ]) {
      const providerError = {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "credential-bearing quota detail",
        details: [{
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: quota.quotaId }],
        }],
      };
      const protocol = createGoogleCloudCodeAssistProtocol({
        fetchImpl: async () => source === "http"
          ? new Response(JSON.stringify({ error: providerError }), {
              status: 429,
              headers: { "content-type": "application/json" },
            })
          : streamResponse([{ error: providerError }]),
      });

      const error = await protocol.createToolTurn(request(), credential).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ModelRetryableError, quota.retryable);
      assert.equal(error.message, quota.message);
      if (error instanceof ModelRetryableError) {
        assert.equal(
          error.retryAfterMs,
          "retryAfterMs" in quota ? quota.retryAfterMs : undefined,
        );
      }
      assert.doesNotMatch(error.message, /credential-bearing|secret/u);
    }
  }
});

test("Google Cloud Code Assist replays signed model parts and tool results", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([{
        response: {
          candidates: [{
            content: { role: "model", parts: [{ text: "Done" }] },
            finishReason: "STOP",
          }],
        },
      }]);
    },
  });
  const first = request();
  first.agentMessages = [
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "inspect", arguments: "{}" }],
      providerState: {
        kind: "google-cloud-code-assist",
        parts: [{
          functionCall: { name: "inspect", args: {}, id: "call-1" },
          thoughtSignature: "signature-1",
        }],
      },
    },
    { role: "tool", toolCallId: "call-1", content: "track state" },
  ];
  await protocol.createToolTurn(first, {
    provider: "google",
    accessToken: "google-access",
    refreshToken: "google-refresh",
    expiresAt: Date.now() + 3_600_000,
    projectId: "project-1",
    accountLabel: null,
  });

  const contents = ((capturedBody?.request as Record<string, unknown>)?.contents ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(contents.at(-2), {
    role: "model",
    parts: [{
      functionCall: { name: "inspect", args: {}, id: "call-1" },
      thoughtSignature: "signature-1",
    }],
  });
  assert.deepEqual(contents.at(-1), {
    role: "user",
    parts: [{
      functionResponse: {
        id: "call-1",
        name: "inspect",
        response: { result: "track state" },
      },
    }],
  });
});

test("Google reuses prompt identity for tools but resets it after steering", async () => {
  let requestCount = 0;
  let replayBody: Record<string, unknown> | undefined;
  const promptIds: string[] = [];
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      promptIds.push(String(body.user_prompt_id));
      if (requestCount === 1) {
        return streamResponse([{
          response: {
            candidates: [{
              content: {
                role: "model",
                parts: [{ functionCall: { name: "inspect", args: {} } }],
              },
              finishReason: "STOP",
            }],
          },
        }]);
      }
      replayBody = body;
      return streamResponse([{
        response: {
          candidates: [{
            content: { role: "model", parts: [{ text: "Done" }] },
            finishReason: "STOP",
          }],
        },
      }]);
    },
  });

  const firstTurn = await protocol.createToolTurn(request(), credential);
  assert.deepEqual(firstTurn.toolCalls, [{
    id: "google-call-1",
    name: "inspect",
    arguments: "{}",
  }]);
  const second = request();
  second.agentMessages = [
    {
      role: "assistant",
      content: firstTurn.content,
      toolCalls: firstTurn.toolCalls,
      providerState: firstTurn.providerState,
    },
    {
      role: "tool",
      toolCallId: firstTurn.toolCalls[0]!.id,
      content: "track state",
    },
  ];
  await protocol.createToolTurn(second, credential);
  assert.equal(promptIds[0], promptIds[1]);

  const contents = ((replayBody?.request as Record<string, unknown>)?.contents ?? []) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(contents.at(-2), {
    role: "model",
    parts: [{ functionCall: { name: "inspect", args: {} } }],
  });
  assert.deepEqual(contents.at(-1), {
    role: "user",
    parts: [{
      functionResponse: {
        name: "inspect",
        response: { result: "track state" },
      },
    }],
  });

  const steered = request();
  steered.agentMessages = [
    ...second.agentMessages,
    { role: "user", content: "Use a different approach." },
  ];
  await protocol.createToolTurn(steered, credential);
  assert.notEqual(promptIds[1], promptIds[2]);
});

test("Google reuses prompt identity for output-limit continuation", async () => {
  const promptIds: string[] = [];
  let requestCount = 0;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      promptIds.push(String(body.user_prompt_id));
      return streamResponse([{
        response: {
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: requestCount === 1 ? "Partial" : " complete" }],
            },
            finishReason: requestCount === 1 ? "MAX_TOKENS" : "STOP",
          }],
        },
      }]);
    },
  });

  const first = await protocol.createToolTurn(request(), credential);
  assert.deepEqual(first.continuation, { reason: "output_limit" });
  const continuation = request();
  continuation.agentMessages = [{
    role: "assistant",
    content: first.content,
    toolCalls: [],
    providerState: first.providerState,
  }];
  await protocol.createToolTurn(continuation, credential);

  assert.equal(promptIds[0], promptIds[1]);
});

test("Google catalog exposes only reasoning controls each model can encode", () => {
  const decoded = decodeGoogleCloudCodeAssistCatalog(catalogResponse([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
  ]));
  assert.ok(decoded);
  const catalog = new Map(decoded.map((model) => [model.id, model.capabilities.reasoning]));
  assert.deepEqual(catalog.get("gemini-2.5-flash"), {
    supported: true,
    canDisable: true,
    efforts: ["minimal", "low", "medium", "high"],
    budgetTokens: false,
    strategy: "budget-thinking",
  });
  assert.deepEqual(catalog.get("gemini-2.5-pro"), {
    supported: true,
    canDisable: false,
    efforts: ["minimal", "low", "medium", "high"],
    budgetTokens: false,
    strategy: "budget-thinking",
  });
  assert.deepEqual(catalog.get("gemini-3-pro-preview"), {
    supported: true,
    canDisable: false,
    efforts: ["low", "high"],
    budgetTokens: false,
    strategy: "effort",
  });
  assert.deepEqual(catalog.get("gemini-3.1-pro-preview"), {
    supported: true,
    canDisable: false,
    efforts: ["low", "medium", "high"],
    budgetTokens: false,
    strategy: "effort",
  });
  for (const model of ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"]) {
    assert.deepEqual(catalog.get(model), {
      supported: true,
      canDisable: false,
      efforts: ["minimal", "low", "medium", "high"],
      budgetTokens: false,
      strategy: "effort",
    });
  }
});

test("Google request mapping matches every advertised reasoning strategy", async () => {
  const cases = [
    {
      model: "gemini-2.5-flash",
      reasoning: { mode: "disabled" as const },
      expected: { thinkingBudget: 0 },
    },
    {
      model: "gemini-2.5-pro",
      reasoning: { mode: "enabled" as const, effort: "minimal" as const },
      expected: { includeThoughts: true, thinkingBudget: 1_024 },
    },
    {
      model: "gemini-3-pro-preview",
      reasoning: { mode: "enabled" as const, effort: "low" as const },
      expected: { includeThoughts: true, thinkingLevel: "LOW" },
    },
    {
      model: "gemini-3.1-pro-preview",
      reasoning: { mode: "enabled" as const, effort: "medium" as const },
      expected: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    },
    {
      model: "gemini-3-flash-preview",
      reasoning: { mode: "enabled" as const, effort: "medium" as const },
      expected: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    },
    {
      model: "gemini-3.1-flash-lite-preview",
      reasoning: { mode: "enabled" as const, effort: "minimal" as const },
      expected: { includeThoughts: true, thinkingLevel: "MINIMAL" },
    },
  ];
  const decoded = decodeGoogleCloudCodeAssistCatalog(catalogResponse(
    cases.map((entry) => entry.model),
  ));
  assert.ok(decoded);
  const catalog = new Map(decoded.map((model) => [model.id, model]));
  for (const entry of cases) {
    let body: Record<string, unknown> | undefined;
    const protocol = createGoogleCloudCodeAssistProtocol({
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return streamResponse([{
          response: {
            candidates: [{
              content: { role: "model", parts: [{ text: "Done" }] },
              finishReason: "STOP",
            }],
          },
        }]);
      },
    });
    const discovered = catalog.get(entry.model);
    assert.ok(discovered);
    const target = request();
    target.runtimeProfile.model.model = entry.model;
    target.runtimeProfile.model.parameters.reasoning = entry.reasoning;
    target.runtimeProfile.capabilities = discovered.capabilities as typeof target.runtimeProfile.capabilities;
    await protocol.createToolTurn(target, credential);
    const generationConfig = (body?.request as Record<string, unknown>)
      ?.generationConfig as Record<string, unknown>;
    assert.deepEqual(generationConfig.thinkingConfig, entry.expected, entry.model);
  }
});

test("Google rejects an unadvertised disabled reasoning mode before HTTP", async () => {
  let requests = 0;
  const protocol = createGoogleCloudCodeAssistProtocol({
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected HTTP");
    },
  });
  const catalog = decodeGoogleCloudCodeAssistCatalog(catalogResponse([
    "gemini-2.5-pro",
  ]));
  assert.ok(catalog);
  const discovered = catalog.find(
    (model) => model.id === "gemini-2.5-pro",
  );
  assert.ok(discovered);
  const target = request();
  target.runtimeProfile.model.model = discovered.id;
  target.runtimeProfile.model.parameters.reasoning = { mode: "disabled" };
  target.runtimeProfile.capabilities = discovered.capabilities as typeof target.runtimeProfile.capabilities;

  await assert.rejects(
    protocol.createToolTurn(target, credential),
    /cannot explicitly disable reasoning/i,
  );
  assert.equal(requests, 0);
});
