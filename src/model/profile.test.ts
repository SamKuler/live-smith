import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDefaultFollowUpBehaviorRevisions,
  incrementDefaultFollowUpBehaviorRevision,
  isDefaultFollowUpBehaviorRevision,
  validateDraftProfileForDiscovery,
  validateDraftProfileForSave,
  type DirectApiConnection,
  type ReasoningEffort,
} from "./profile.js";

test("Direct API connection types correlate every family with its supported modes", () => {
  const valid: DirectApiConnection[] = [
    {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
    },
    {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "chat-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
    },
    {
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "test-key",
    },
  ];

  // @ts-expect-error Anthropic direct API connections cannot use Responses.
  const invalidAnthropicResponses: DirectApiConnection = {
    kind: "direct-api",
    apiFamily: "anthropic",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  };
  // @ts-expect-error Anthropic direct API connections cannot use Chat Completions.
  const invalidAnthropicChat: DirectApiConnection = {
    kind: "direct-api",
    apiFamily: "anthropic",
    apiMode: "chat-completions",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  };
  // @ts-expect-error OpenAI direct API connections cannot use Messages.
  const invalidOpenAIMessages: DirectApiConnection = {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "messages",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  };

  assert.deepEqual(valid.map((connection) => connection.apiMode), [
    "responses",
    "chat-completions",
    "messages",
  ]);
  void invalidAnthropicResponses;
  void invalidAnthropicChat;
  void invalidOpenAIMessages;
});

test("follow-up behavior revisions are canonical unbounded decimal strings", () => {
  for (const revision of ["0", "1", "9007199254740993", "1".repeat(256)]) {
    assert.equal(isDefaultFollowUpBehaviorRevision(revision), true);
  }
  for (const revision of [0, "", "00", "01", "+1", "-1", "1.0", "1e3", " 1"]) {
    assert.equal(isDefaultFollowUpBehaviorRevision(revision), false);
  }

  assert.equal(incrementDefaultFollowUpBehaviorRevision("0"), "1");
  assert.equal(incrementDefaultFollowUpBehaviorRevision("9"), "10");
  assert.equal(incrementDefaultFollowUpBehaviorRevision("1099"), "1100");
  assert.equal(
    incrementDefaultFollowUpBehaviorRevision("9007199254740991"),
    "9007199254740992",
  );
  assert.equal(compareDefaultFollowUpBehaviorRevisions("9", "10"), -1);
  assert.equal(compareDefaultFollowUpBehaviorRevisions("10", "9"), 1);
  assert.equal(
    compareDefaultFollowUpBehaviorRevisions(
      "9007199254740993",
      "9007199254740993",
    ),
    0,
  );
});

function profile(baseUrl: string): Record<string, unknown> {
  return {
    id: "deepseek-anthropic",
    name: "DeepSeek Anthropic",
    connection: {
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "messages",
      baseUrl,
      apiKey: "test-key",
    },
    model: "deepseek-v4-flash",
    parameters: {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

test("Profile validation does not depend on an ambient URL constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    const validated = validateDraftProfileForSave(
      profile("https://api.deepseek.com/anthropic"),
    );
    assert.equal(
      validated.connection.kind === "direct-api"
        ? validated.connection.baseUrl
        : undefined,
      "https://api.deepseek.com/anthropic",
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "URL", descriptor);
    else Reflect.deleteProperty(globalThis, "URL");
  }
});

test("Profile validation still rejects malformed and non-HTTP Base URLs", () => {
  assert.throws(
    () => validateDraftProfileForSave(profile("not a URL")),
    /Base URL is invalid/,
  );
  assert.throws(
    () => validateDraftProfileForSave(profile("file:///tmp/provider")),
    /Base URL must use HTTP or HTTPS/,
  );
});

test("Profile validation rejects Base URLs containing userinfo credentials", () => {
  for (const baseUrl of [
    "https://alice@example.test/v1",
    "https://alice:url-secret@example.test/v1",
  ]) {
    assert.throws(
      () => validateDraftProfileForSave(profile(baseUrl)),
      /Base URL must not include credentials/,
    );
  }
});

test("Profile validation permits plaintext HTTP only for loopback providers", () => {
  for (const baseUrl of [
    "http://localhost:11434/v1",
    "http://models.localhost/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.42.0.7/v1",
    "http://[::1]:11434/v1",
    "http://[::ffff:127.0.0.1]/v1",
  ]) {
    const saved = validateDraftProfileForSave(profile(baseUrl));
    assert.equal(
      saved.connection.kind === "direct-api"
        ? saved.connection.baseUrl
        : undefined,
      baseUrl,
    );
  }

  for (const baseUrl of [
    "http://example.com/v1",
    "http://192.168.1.20/v1",
    "http://10.0.0.20/v1",
    "http://169.254.1.1/v1",
  ]) {
    assert.throws(
      () => validateDraftProfileForSave(profile(baseUrl)),
      /HTTPS.*loopback|loopback.*HTTPS/i,
    );
  }
});

test("loopback Profiles may omit authentication while remote Profiles require it", () => {
  for (const [apiFamily, apiMode] of [
    ["openai", "chat-completions"],
    ["anthropic", "messages"],
  ] as const) {
    const localProfile = {
      ...profile("http://127.0.0.1:1234/v1"),
      connection: {
        kind: "direct-api",
        apiFamily,
        apiMode,
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "   ",
      },
    };
    assert.deepEqual(validateDraftProfileForDiscovery(localProfile).connection, {
      ...localProfile.connection,
      apiKey: "",
    });
    assert.deepEqual(validateDraftProfileForSave(localProfile).connection, {
      ...localProfile.connection,
      apiKey: "",
    });

    assert.throws(
      () => validateDraftProfileForDiscovery({
        ...localProfile,
        connection: {
          ...localProfile.connection,
          baseUrl: "https://models.example.test/v1",
        },
      }),
      /API key is required for non-local endpoints/,
    );
    assert.throws(
      () => validateDraftProfileForSave({
        ...localProfile,
        connection: {
          ...localProfile.connection,
          baseUrl: "https://models.example.test/v1",
        },
      }),
      /API key is required for non-local endpoints/,
    );
  }
});

test("Profile validation rejects unsafe or overlong internal IDs", () => {
  for (const id of ["../profile", "profile.with-dot", "a".repeat(129)]) {
    assert.throws(
      () => validateDraftProfileForSave({
        ...profile("https://example.test/v1"),
        id,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "ProfileValidationError" &&
        /Profile ID must be 1-128/.test(error.message),
    );
  }
});

test("Draft discovery validation permits blank Profile name and model", () => {
  const draft = validateDraftProfileForDiscovery({
    ...profile("https://example.test/v1"),
    name: "",
    model: "",
  });

  assert.equal(draft.name, "");
  assert.equal(draft.model, "");
  assert.equal(
    draft.connection.kind === "direct-api"
      ? draft.connection.baseUrl
      : undefined,
    "https://example.test/v1",
  );
});

test("Draft save validation still requires Profile name and model", () => {
  assert.throws(
    () => validateDraftProfileForSave({
      ...profile("https://example.test/v1"),
      name: "",
      model: "",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Profile name is required/.test(error.message),
  );

  assert.throws(
    () => validateDraftProfileForSave({
      ...profile("https://example.test/v1"),
      name: "Complete Profile",
      model: "",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Model is required/.test(error.message),
  );
});

test("image capability override is strictly validated and preserved", () => {
  const validated = validateDraftProfileForSave({
    ...profile("https://example.test/v1"),
    advanced: {
      capabilityOverrides: {
        inputs: { image: true, audio: false },
      },
    },
  });
  assert.deepEqual(validated.advanced.capabilityOverrides?.inputs, {
    image: true,
    audio: false,
  });

  for (const inputs of [
    { image: "yes" },
    { image: true, video: true },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({
        ...profile("https://example.test/v1"),
        advanced: { capabilityOverrides: { inputs } },
      }),
      /capabilityOverrides\.inputs/,
    );
  }
});

test("hosted Web Search is opt-in, normalized, and limited to supported protocols", () => {
  const responses = validateDraftProfileForSave({
    ...profile("https://example.test/v1"),
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
    },
    advanced: { hostedTools: { webSearch: true } },
  });
  assert.deepEqual(responses.advanced.hostedTools, { webSearch: true });

  const disabled = validateDraftProfileForSave({
    ...profile("https://example.test/v1"),
    advanced: { hostedTools: { webSearch: false } },
  });
  assert.equal(disabled.advanced.hostedTools, undefined);

  assert.throws(
    () => validateDraftProfileForSave({
      ...profile("https://example.test/v1"),
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "chat-completions",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
      },
      advanced: { hostedTools: { webSearch: true } },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Web search requires OpenAI Responses or Anthropic Messages/.test(error.message),
  );

  for (const hostedTools of [
    { webSearch: "yes" },
    { webSearch: true, shell: true },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({
        ...profile("https://example.test/v1"),
        advanced: { hostedTools },
      }),
      /hostedTools/,
    );
  }
});

test("draft discovery preserves the hosted Web Search opt-in", () => {
  const draft = validateDraftProfileForDiscovery({
    ...profile("https://example.test/v1"),
    advanced: { hostedTools: { webSearch: true } },
  });
  assert.deepEqual(draft.advanced.hostedTools, { webSearch: true });
});

test("subscription Profiles persist no direct API credentials", () => {
  const saved = validateDraftProfileForSave({
    id: "codex-subscription",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
    advanced: {},
  });

  assert.deepEqual(saved.connection, {
    kind: "codex-subscription",
    provider: "openai",
  });
  assert.equal(JSON.stringify(saved).includes("apiKey"), false);
});

test("reasoning effort validation preserves ultra and rejects unknown values", () => {
  const direct = profile("https://example.test/v1");
  const ultra: ReasoningEffort = "ultra";
  const saved = validateDraftProfileForSave({
    ...direct,
    parameters: {
      ...(direct.parameters as Record<string, unknown>),
      reasoning: { mode: "enabled", effort: ultra },
    },
    advanced: {
      capabilityOverrides: {
        reasoning: {
          supported: true,
          efforts: ["high", ultra],
          strategy: "effort",
        },
      },
    },
  });
  assert.deepEqual(saved.parameters.reasoning, {
    mode: "enabled",
    effort: "ultra",
  });
  assert.deepEqual(saved.advanced.capabilityOverrides?.reasoning?.efforts, [
    "high",
    "ultra",
  ]);

  for (const reasoning of [
    { mode: "enabled", effort: "future-effort" },
    { mode: "enabled", effort: 7 },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({
        ...direct,
        parameters: {
          ...(direct.parameters as Record<string, unknown>),
          reasoning,
        },
      }),
      /Reasoning effort is unsupported/i,
    );
  }
});

test("subscription Profiles reject direct credentials and unsupported request settings", () => {
  const base = {
    id: "codex-subscription",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
    advanced: {},
  };

  for (const connection of [
    { ...base.connection, apiKey: "forbidden" },
    { ...base.connection, baseUrl: "https://api.openai.com/v1" },
    { kind: "codex-subscription", provider: "anthropic" },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({ ...base, connection }),
      /does not support property|require.*OpenAI/i,
    );
  }

  for (const settings of [
    {
      parameters: {
        ...base.parameters,
        reasoning: { mode: "disabled" },
      },
    },
    { parameters: { ...base.parameters, temperature: 0.2 } },
    {
      parameters: {
        ...base.parameters,
        reasoning: { mode: "enabled", budgetTokens: 4096 },
      },
    },
    { advanced: { capabilityOverrides: { tools: true } } },
    { advanced: { hostedTools: { webSearch: true } } },
    { advanced: { extraBody: {} } },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({ ...base, ...settings }),
      /not supported by Codex subscription Profiles|cannot be disabled/,
    );
  }
});
