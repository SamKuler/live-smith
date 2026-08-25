import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDefaultFollowUpBehaviorRevisions,
  incrementDefaultFollowUpBehaviorRevision,
  isDefaultFollowUpBehaviorRevision,
  MAX_PROFILE_MODEL_COUNT,
  profileSecrets,
  validateDraftProfileForDiscovery,
  validateDraftProfileForSave,
  type DirectApiConnection,
  type DraftModelConfig,
  type ReasoningEffort,
  type SavedProfile,
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
  const model: DraftModelConfig = {
    model: "deepseek-v4-flash",
    parameters: {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
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
    defaultModel: model.model,
    models: [model],
  };
}

function withDefaultModel(
  value: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const [model] = value.models as DraftModelConfig[];
  assert(model);
  return {
    ...value,
    models: [{ ...model, ...update }],
  };
}

function configuredModel(profile: SavedProfile) {
  const model = profile.models.find(
    (entry) => entry.model === profile.defaultModel,
  );
  assert(model);
  return model;
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

test("profileSecrets retains every raw and decoded Base URL secret form", () => {
  const rawFragment =
    "token=fragment%2Dsecret&tenant=studio%20fragment" +
    "&malformed=broken%2Dfragment%zz" +
    "&repeat=first%2Dfragment&repeat=second%2Dfragment" +
    "&literal=plus+fragment";
  const forgivingDecodedFragment =
    "token=fragment-secret&tenant=studio fragment" +
    "&malformed=broken-fragment%zz" +
    "&repeat=first-fragment&repeat=second-fragment" +
    "&literal=plus+fragment";
  const saved = validateDraftProfileForSave(profile(
    "https://api.deepseek.com/anthropic" +
      "?encoded=raw%2Dquery&space=signed%20query" +
      "&slash=signed%2fquery&plus=plus+query" +
      "&repeat=first%2Drepeat&repeat=second%2Drepeat" +
      "&malformed=broken%2Dquery%zz" +
      `#${rawFragment}`,
  ));

  const secrets = profileSecrets(saved);
  for (const expected of [
    "raw%2Dquery",
    "raw-query",
    "signed%20query",
    "signed+query",
    "signed query",
    "signed%2fquery",
    "signed%2Fquery",
    "signed/query",
    "plus+query",
    "plus query",
    "first%2Drepeat",
    "first-repeat",
    "second%2Drepeat",
    "second-repeat",
    "broken%2Dquery%zz",
    "broken-query%25zz",
    "broken-query%zz",
    rawFragment,
    "broken%2Dfragment%zz",
    "broken-fragment%zz",
    forgivingDecodedFragment,
    "fragment%2Dsecret",
    "fragment-secret",
    "studio%20fragment",
    "studio fragment",
    "first%2Dfragment",
    "first-fragment",
    "second%2Dfragment",
    "second-fragment",
    "plus+fragment",
  ]) {
    assert.ok(secrets.includes(expected), `Expected secret form ${expected}`);
  }
  for (const unrelated of ["token", "tenant", "malformed", "repeat", "literal"]) {
    assert.equal(secrets.includes(unrelated), false);
  }
  assert.equal(secrets.includes("plus fragment"), false);

  assert.equal(new Set(secrets).size, secrets.length);
  assert.deepEqual(
    secrets.map((secret) => secret.length),
    secrets.map((secret) => secret.length).sort((left, right) => right - left),
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
  const draft = validateDraftProfileForDiscovery(withDefaultModel({
    ...profile("https://example.test/v1"),
    name: "",
    defaultModel: "",
  }, { model: "" }));

  assert.equal(draft.name, "");
  assert.equal(draft.defaultModel, "");
  assert.equal(draft.models[0]?.model, "");
  assert.equal(
    draft.connection.kind === "direct-api"
      ? draft.connection.baseUrl
      : undefined,
    "https://example.test/v1",
  );
});

test("Draft save validation still requires Profile name and model", () => {
  assert.throws(
    () => validateDraftProfileForSave(withDefaultModel({
      ...profile("https://example.test/v1"),
      name: "",
      defaultModel: "",
    }, { model: "" })),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Profile name is required/.test(error.message),
  );

  assert.throws(
    () => validateDraftProfileForSave(withDefaultModel({
      ...profile("https://example.test/v1"),
      name: "Complete Profile",
    }, { model: "" })),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Model is required/.test(error.message),
  );
});

test("Profile validation preserves multiple model-specific configurations", () => {
  const first = profile("https://example.test/v1");
  const [firstModel] = first.models as DraftModelConfig[];
  assert(firstModel);
  const saved = validateDraftProfileForSave({
    ...first,
    defaultModel: "model-b",
    models: [
      firstModel,
      {
        model: "model-b",
        parameters: {
          maxOutputTokens: 32_768,
          reasoning: { mode: "enabled", effort: "high" },
        },
        advanced: {
          capabilityOverrides: {
            temperature: "unsupported",
            reasoning: {
              supported: true,
              efforts: ["high"],
              strategy: "effort",
            },
          },
        },
      },
    ],
  });

  assert.equal(saved.defaultModel, "model-b");
  assert.deepEqual(saved.models.map((model) => model.model), [
    "deepseek-v4-flash",
    "model-b",
  ]);
  assert.deepEqual(saved.models[1]?.parameters.reasoning, {
    mode: "enabled",
    effort: "high",
  });
});

test("Profile validation requires a unique configured default model", () => {
  const base = profile("https://example.test/v1");
  const [model] = base.models as DraftModelConfig[];
  assert(model);

  assert.throws(
    () => validateDraftProfileForSave({ ...base, models: [] }),
    /at least one model/i,
  );
  assert.throws(
    () => validateDraftProfileForSave({
      ...base,
      defaultModel: "missing-model",
    }),
    /Default model must reference a configured model/,
  );
  assert.throws(
    () => validateDraftProfileForSave({
      ...base,
      models: [model, { ...model }],
    }),
    /appears more than once/,
  );
});

test("Profile validation rejects model sets above the Profile limit", () => {
  const base = profile("https://example.test/v1");
  const [model] = base.models as DraftModelConfig[];
  assert(model);
  assert.throws(
    () => validateDraftProfileForSave({
      ...base,
      defaultModel: "model-0",
      models: Array.from(
        { length: MAX_PROFILE_MODEL_COUNT + 1 },
        (_, index) => ({ ...model, model: `model-${index}` }),
      ),
    }),
    new RegExp(`at most ${MAX_PROFILE_MODEL_COUNT} models`, "i"),
  );
});

test("image capability override is strictly validated and preserved", () => {
  const validated = validateDraftProfileForSave(withDefaultModel(
    profile("https://example.test/v1"),
    {
    advanced: {
      capabilityOverrides: {
        inputs: { image: true, audio: false },
      },
    },
  }));
  assert.deepEqual(configuredModel(validated).advanced.capabilityOverrides?.inputs, {
    image: true,
    audio: false,
  });

  for (const inputs of [
    { image: "yes" },
    { image: true, video: true },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave(withDefaultModel(
        profile("https://example.test/v1"),
        {
        advanced: { capabilityOverrides: { inputs } },
      })),
      /capabilityOverrides\.inputs/,
    );
  }
});

test("hosted Web Search is opt-in, normalized, and limited to supported protocols", () => {
  const responses = validateDraftProfileForSave(withDefaultModel({
    ...profile("https://example.test/v1"),
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
    },
  }, {
    advanced: { hostedTools: { webSearch: true } },
  }));
  assert.deepEqual(configuredModel(responses).advanced.hostedTools, { webSearch: true });

  const disabled = validateDraftProfileForSave(withDefaultModel(
    profile("https://example.test/v1"),
    {
    advanced: { hostedTools: { webSearch: false } },
  }));
  assert.equal(configuredModel(disabled).advanced.hostedTools, undefined);

  assert.throws(
    () => validateDraftProfileForSave(withDefaultModel({
      ...profile("https://example.test/v1"),
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "chat-completions",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
      },
    }, {
      advanced: { hostedTools: { webSearch: true } },
    })),
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
      () => validateDraftProfileForSave(withDefaultModel(
        profile("https://example.test/v1"),
        {
        advanced: { hostedTools },
      })),
      /hostedTools/,
    );
  }
});

test("draft discovery preserves the hosted Web Search opt-in", () => {
  const draft = validateDraftProfileForDiscovery(withDefaultModel(
    profile("https://example.test/v1"),
    {
    advanced: { hostedTools: { webSearch: true } },
  }));
  assert.deepEqual(draft.models[0]?.advanced.hostedTools, { webSearch: true });
});

test("subscription Profiles persist no direct API credentials", () => {
  const saved = validateDraftProfileForSave({
    id: "codex-subscription",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "gpt-5.6-sol",
    models: [{
      model: "gpt-5.6-sol",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  });

  assert.deepEqual(saved.connection, {
    kind: "codex-subscription",
    provider: "openai",
  });
  assert.equal(JSON.stringify(saved).includes("apiKey"), false);
  assert.equal(JSON.stringify(saved).includes("maxOutputTokens"), false);
});

test("reasoning effort validation preserves ultra and rejects unknown values", () => {
  const direct = profile("https://example.test/v1");
  const [directModel] = direct.models as DraftModelConfig[];
  assert(directModel);
  const ultra: ReasoningEffort = "ultra";
  const saved = validateDraftProfileForSave(withDefaultModel(direct, {
    parameters: {
      ...directModel.parameters,
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
  }));
  assert.deepEqual(configuredModel(saved).parameters.reasoning, {
    mode: "enabled",
    effort: "ultra",
  });
  assert.deepEqual(configuredModel(saved).advanced.capabilityOverrides?.reasoning?.efforts, [
    "high",
    "ultra",
  ]);

  for (const reasoning of [
    { mode: "enabled", effort: "future-effort" },
    { mode: "enabled", effort: 7 },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave(withDefaultModel(direct, {
        parameters: {
          ...directModel.parameters,
          reasoning,
        },
      })),
      /Reasoning effort is unsupported/i,
    );
  }
});

test("subscription Profiles reject direct credentials and unsupported request settings", () => {
  const base = {
    id: "codex-subscription",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "gpt-5.6-sol",
    models: [{
      model: "gpt-5.6-sol",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
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

  for (const modelSettings of [
    { parameters: { reasoning: { mode: "default" }, maxOutputTokens: 8192 } },
    { parameters: { reasoning: { mode: "disabled" } } },
    { parameters: { reasoning: { mode: "default" }, temperature: 0.2 } },
    { parameters: { reasoning: { mode: "enabled", budgetTokens: 4096 } } },
    { advanced: { capabilityOverrides: { tools: true } } },
    { advanced: { hostedTools: { webSearch: true } } },
    { advanced: { extraBody: {} } },
  ]) {
    const [baseModel] = base.models;
    assert(baseModel);
    assert.throws(
      () => validateDraftProfileForSave({
        ...base,
        models: [{ ...baseModel, ...modelSettings }],
      }),
      /does not support property|not supported by Codex subscription Profiles|cannot be disabled/,
    );
  }
});
