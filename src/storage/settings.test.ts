import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  compareDefaultFollowUpBehaviorRevisions,
  type DirectApiConnection,
  type DirectApiModelConfig,
  type DirectApiProfile,
  type SavedProfile,
} from "../model/profile.js";
import {
  CURRENT_AGENT_SETTINGS_SCHEMA_VERSION,
  decodeAgentSettings,
} from "./settings-migrations.js";
import {
  AgentSettingsCorruptionError,
  activateSavedProfile,
  deleteSavedProfile,
  loadAgentSettings,
  saveSavedProfile,
  saveGlobalSettings,
} from "./settings.js";

type ProfileOverrides = Partial<Pick<DirectApiProfile, "id" | "name">> & {
  connection?: DirectApiConnection;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  parameters?: DirectApiModelConfig["parameters"];
  advanced?: DirectApiModelConfig["advanced"];
};

function profile(overrides: ProfileOverrides = {}): DirectApiProfile {
  const {
    baseUrl = "https://example.test/v1/",
    apiKey = "secret",
    connection = {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl,
      apiKey,
    },
    model = "model-a",
    parameters = {
      maxOutputTokens: 8192,
      temperature: 0.3,
      reasoning: { mode: "default" },
    },
    advanced = {},
    ...fields
  } = overrides;
  return {
    id: "profile-1",
    name: "Studio",
    connection,
    defaultModel: model,
    models: [{ model, parameters, advanced }],
    ...fields,
  };
}

interface LegacyProfileFixture {
  id: string;
  name: string;
  apiFamily: DirectApiConnection["apiFamily"];
  apiMode: DirectApiConnection["apiMode"];
  baseUrl: string;
  apiKey: string;
  model: string;
  parameters: DirectApiModelConfig["parameters"];
  advanced: DirectApiModelConfig["advanced"];
}

function legacyProfile(profile: DirectApiProfile): LegacyProfileFixture {
  assert.equal(profile.connection.kind, "direct-api");
  if (profile.connection.kind !== "direct-api") throw new Error("Expected direct Profile.");
  const model = profile.models.find((entry) => entry.model === profile.defaultModel);
  assert(model);
  return {
    id: profile.id,
    name: profile.name,
    apiFamily: profile.connection.apiFamily,
    apiMode: profile.connection.apiMode,
    baseUrl: profile.connection.baseUrl,
    apiKey: profile.connection.apiKey,
    model: model.model,
    parameters: model.parameters,
    advanced: model.advanced,
  };
}

function profileV4(overrides: ProfileOverrides = {}) {
  const saved = profile(overrides);
  const model = saved.models.find(
    (entry) => entry.model === saved.defaultModel,
  );
  assert(model);
  return {
    id: saved.id,
    name: saved.name,
    connection: saved.connection,
    model: model.model,
    parameters: model.parameters,
    advanced: model.advanced,
  };
}

test("loadAgentSettings starts empty and rejects every legacy or invalid settings shape", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  assert.deepEqual(await loadAgentSettings(directory), {
    schemaVersion: 5,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  });

  const legacyShapes = [
    { provider: "openai", apiKey: "old", model: "old" },
    { providerConfigs: { openai: { apiKey: "old" } } },
    { schemaVersion: 0, provider: "anthropic" },
    { schemaVersion: 1, activeProfileId: null, profiles: "not-an-array", autoApprove: false },
    { schemaVersion: 1, activeProfileId: null, profiles: [{ provider: "openai" }], autoApprove: false },
    { schemaVersion: 2, activeProfileId: null, profiles: [], approvalMode: "unsafe" },
    {
      schemaVersion: 3,
      activeProfileId: null,
      profiles: [],
      approvalMode: "manual",
      defaultFollowUpBehavior: "steer",
    },
  ];
  for (const legacy of legacyShapes) {
    await fs.writeFile(
      path.join(directory, "live-smith-settings.json"),
      JSON.stringify(legacy),
    );
    await assert.rejects(
      loadAgentSettings(directory),
      (error: unknown) => error instanceof AgentSettingsCorruptionError,
    );
  }

  await fs.writeFile(path.join(directory, "live-smith-settings.json"), "{invalid");
  await assert.rejects(
    loadAgentSettings(directory),
    (error: unknown) => error instanceof AgentSettingsCorruptionError,
  );
});

test("schema version 1 auto approval migrates to the equivalent approval mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-migration-"));
  const settingsPath = path.join(directory, "live-smith-settings.json");
  const completeProfile = legacyProfile(profile({
    parameters: {
      maxOutputTokens: 32_768,
      temperature: 0.7,
      reasoning: { mode: "enabled", effort: "high", budgetTokens: 4_096 },
    },
    advanced: {
      capabilityOverrides: {
        tools: true,
        streaming: false,
        maxOutputTokens: 64_000,
        reasoning: {
          supported: true,
          canDisable: true,
          efforts: ["low", "high"],
          budgetTokens: true,
          strategy: "effort",
        },
      },
      extraBody: { nested: { flag: true }, labels: ["a", "b"] },
    },
  }));

  for (const [autoApprove, approvalMode] of [
    [false, "manual"],
    [true, "low-risk"],
  ] as const) {
    const original = JSON.stringify({
      schemaVersion: 1,
      activeProfileId: "profile-1",
      profiles: [completeProfile],
      autoApprove,
    }, null, 2);
    await fs.writeFile(settingsPath, original);
    const loaded = await loadAgentSettings(directory);
    assert.equal(loaded.schemaVersion, 5);
    assert.equal(loaded.approvalMode, approvalMode);
    assert.equal(loaded.defaultFollowUpBehavior, "queue");
    assert.equal(loaded.defaultFollowUpBehaviorRevision, "0");
    assert.deepEqual(loaded.profiles, [{
      id: "profile-1",
      name: "Studio",
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "responses",
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
      },
      defaultModel: "model-a",
      models: [{
        model: "model-a",
        parameters: completeProfile.parameters,
        advanced: completeProfile.advanced,
      }],
    }]);
    assert.equal(await fs.readFile(settingsPath, "utf8"), original);
  }
});

test("schema version 2 settings migrate to queued follow-ups without rewriting on read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-v2-"));
  const settingsPath = path.join(directory, "live-smith-settings.json");
  const original = JSON.stringify({
    schemaVersion: 2,
    activeProfileId: "profile-1",
    profiles: [legacyProfile(profile())],
    approvalMode: "everything",
  }, null, 2);
  await fs.writeFile(settingsPath, original);

  const loaded = await loadAgentSettings(directory);
  assert.equal(loaded.schemaVersion, 5);
  assert.equal(loaded.defaultFollowUpBehavior, "queue");
  assert.equal(loaded.defaultFollowUpBehaviorRevision, "0");
  assert.equal(loaded.approvalMode, "everything");
  assert.equal(loaded.activeProfileId, "profile-1");
  assert.equal(loaded.profiles[0]?.connection.kind, "direct-api");
  assert.equal(await fs.readFile(settingsPath, "utf8"), original);

  const saved = await saveGlobalSettings(directory, {
    defaultFollowUpBehavior: "steer",
  });
  assert.equal(saved.schemaVersion, 5);
  assert.equal(saved.defaultFollowUpBehavior, "steer");
  assert.equal(saved.defaultFollowUpBehaviorRevision, "1");
  assert.equal(saved.approvalMode, "everything");
  assert.equal(saved.activeProfileId, "profile-1");
  assert.equal(saved.profiles.length, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(settingsPath, "utf8")),
    saved,
  );
});

test("the migration decoder accepts only canonical current revisions", () => {
  assert.equal(CURRENT_AGENT_SETTINGS_SCHEMA_VERSION, 5);
  for (const defaultFollowUpBehavior of ["queue", "steer"] as const) {
    for (const defaultFollowUpBehaviorRevision of [
      "0",
      "7",
      "90071992547409931234567890",
    ]) {
      const current = {
        schemaVersion: 5,
        activeProfileId: null,
        profiles: [],
        approvalMode: "everything",
        defaultFollowUpBehavior,
        defaultFollowUpBehaviorRevision,
      } as const;
      assert.deepEqual(decodeAgentSettings(current), current);
    }
  }

  for (const invalid of [undefined, "later", false]) {
    assert.throws(
      () => decodeAgentSettings({
        schemaVersion: 5,
        activeProfileId: null,
        profiles: [],
        approvalMode: "manual",
        ...(invalid === undefined
          ? {}
          : { defaultFollowUpBehavior: invalid }),
        defaultFollowUpBehaviorRevision: "0",
      }),
      /Default follow-up behavior must be queue or steer/,
    );
  }

  for (const invalid of [
    undefined,
    0,
    -1,
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    " 1",
    "1 ",
  ]) {
    assert.throws(
      () => decodeAgentSettings({
        schemaVersion: 5,
        activeProfileId: null,
        profiles: [],
        approvalMode: "manual",
        defaultFollowUpBehavior: "queue",
        ...(invalid === undefined
          ? {}
          : { defaultFollowUpBehaviorRevision: invalid }),
      }),
      /Default follow-up behavior revision must be a canonical nonnegative decimal string/,
    );
  }

  for (const schemaVersion of [0, 6]) {
    assert.throws(
      () => decodeAgentSettings({
        schemaVersion,
        activeProfileId: null,
        profiles: [],
        approvalMode: "manual",
      }),
      /Unsupported settings schema/,
    );
  }
});

test("settings v2 migrate every legacy Profile to a direct API connection", () => {
  const decoded = decodeAgentSettings({
    schemaVersion: 2,
    activeProfileId: "p1",
    profiles: [{
      id: "p1",
      name: "Legacy API",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "model-a",
      parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
      advanced: {},
    }],
    approvalMode: "manual",
  });

  assert.equal(decoded.schemaVersion, 5);
  assert.equal(decoded.defaultFollowUpBehavior, "queue");
  assert.equal(decoded.defaultFollowUpBehaviorRevision, "0");
  assert.deepEqual(decoded.profiles[0]?.connection, {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
  });
});

test("both historical schema-v3 shapes migrate losslessly without rewriting on read", async () => {
  const cases = [
    {
      name: "main-flat",
      source: {
        schemaVersion: 3,
        activeProfileId: "profile-1",
        profiles: [legacyProfile(profile())],
        approvalMode: "everything",
        defaultFollowUpBehavior: "steer",
        defaultFollowUpBehaviorRevision: "90071992547409931234567890",
      },
      behavior: "steer",
      revision: "90071992547409931234567890",
    },
    {
      name: "subscription-nested",
      source: {
        schemaVersion: 3,
        activeProfileId: "profile-1",
        profiles: [profileV4()],
        approvalMode: "low-risk",
      },
      behavior: "queue",
      revision: "0",
    },
  ] as const;

  for (const migrationCase of cases) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `live-smith-settings-${migrationCase.name}-`),
    );
    const settingsPath = path.join(directory, "live-smith-settings.json");
    const original = JSON.stringify(migrationCase.source, null, 2);
    await fs.writeFile(settingsPath, original);

    const loaded = await loadAgentSettings(directory);
    assert.equal(loaded.schemaVersion, 5);
    assert.equal(loaded.activeProfileId, "profile-1");
    assert.equal(loaded.defaultFollowUpBehavior, migrationCase.behavior);
    assert.equal(loaded.defaultFollowUpBehaviorRevision, migrationCase.revision);
    assert.deepEqual(loaded.profiles, [{
      ...profile(),
      connection: {
        ...profile().connection,
        baseUrl: "https://example.test/v1",
      },
    }]);
    assert.equal(await fs.readFile(settingsPath, "utf8"), original);
  }
});

test("schema-v3 discrimination uses follow-up field presence for empty Profile arrays", () => {
  assert.deepEqual(decodeAgentSettings({
    schemaVersion: 3,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
    defaultFollowUpBehavior: "steer",
    defaultFollowUpBehaviorRevision: "17",
  }), {
    schemaVersion: 5,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
    defaultFollowUpBehavior: "steer",
    defaultFollowUpBehaviorRevision: "17",
  });

  assert.deepEqual(decodeAgentSettings({
    schemaVersion: 3,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
  }), {
    schemaVersion: 5,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  });
});

test("schema-v3 migration rejects partial, mixed, and unknown shapes", () => {
  const flat = legacyProfile(profile());
  const nested = profileV4();
  const shared = {
    schemaVersion: 3,
    activeProfileId: "profile-1",
    approvalMode: "manual",
  } as const;

  for (const invalid of [
    {
      ...shared,
      profiles: [flat],
      defaultFollowUpBehavior: "queue",
    },
    {
      ...shared,
      profiles: [flat],
      defaultFollowUpBehaviorRevision: "0",
    },
    {
      ...shared,
      profiles: [nested],
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
    },
    {
      ...shared,
      profiles: [flat],
    },
    {
      ...shared,
      profiles: [{ ...flat, unexpected: true }],
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
    },
    {
      ...shared,
      profiles: [{ ...nested, unexpected: true }],
    },
    {
      ...shared,
      profiles: [{
        ...flat,
        parameters: { ...flat.parameters, unexpected: true },
      }],
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
    },
    {
      ...shared,
      profiles: [{
        ...flat,
        parameters: {
          ...flat.parameters,
          reasoning: { ...flat.parameters.reasoning, mystery: true },
        },
      }],
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
    },
    {
      ...shared,
      profiles: [{
        ...nested,
        parameters: { ...nested.parameters, unexpected: true },
      }],
    },
    {
      ...shared,
      profiles: [{
        ...nested,
        parameters: {
          ...nested.parameters,
          reasoning: { ...nested.parameters.reasoning, mystery: true },
        },
      }],
    },
    {
      ...shared,
      profiles: [flat],
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      unexpected: true,
    },
    {
      ...shared,
      profiles: [nested],
      unexpected: true,
    },
  ]) {
    assert.throws(
      () => decodeAgentSettings(invalid),
      (error: unknown) =>
        error instanceof Error && error.name === "ProfileValidationError",
    );
  }
});

test("schema-v4 rejects unknown top-level and Profile fields", () => {
  const historical = profileV4();
  const current = {
    schemaVersion: 4,
    activeProfileId: "profile-1",
    profiles: [historical],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  } as const;

  assert.throws(
    () => decodeAgentSettings({ ...current, unexpected: true }),
    /does not support property/,
  );
  assert.throws(
    () => decodeAgentSettings({
      ...current,
      profiles: [{ ...historical, unexpected: true }],
    }),
    /does not support property/,
  );
  assert.throws(
    () => decodeAgentSettings({
      ...current,
      profiles: [{
        ...historical,
        parameters: { ...historical.parameters, unexpected: true },
      }],
    }),
    /parameters does not support property unexpected/,
  );
  assert.throws(
    () => decodeAgentSettings({
      ...current,
      profiles: [{
        ...historical,
        parameters: {
          ...historical.parameters,
          reasoning: { ...historical.parameters.reasoning, mystery: true },
        },
      }],
    }),
    /parameters\.reasoning does not support property mystery/,
  );
});

test("schema-v4 single-model Profiles migrate to schema-v5 model collections", () => {
  const historical = profileV4({
    model: "model-b",
    parameters: {
      maxOutputTokens: 32_768,
      reasoning: { mode: "enabled", effort: "high" },
    },
  });
  const decoded = decodeAgentSettings({
    schemaVersion: 4,
    activeProfileId: historical.id,
    profiles: [historical],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "9",
  });

  assert.equal(decoded.schemaVersion, 5);
  assert.equal(decoded.profiles[0]?.defaultModel, "model-b");
  assert.deepEqual(decoded.profiles[0]?.models, [{
    model: "model-b",
    parameters: {
      maxOutputTokens: 32_768,
      reasoning: { mode: "enabled", effort: "high" },
    },
    advanced: {},
  }]);
});

test("schema-v5 strictly validates model collection fields", () => {
  const savedProfile = profile({ baseUrl: "https://example.test/v1" });
  const current = {
    schemaVersion: 5,
    activeProfileId: "profile-1",
    profiles: [savedProfile],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  } as const;

  assert.deepEqual(decodeAgentSettings(current), current);
  assert.throws(
    () => decodeAgentSettings({
      ...current,
      profiles: [{ ...savedProfile, unexpected: true }],
    }),
    /does not support property/,
  );
  assert.throws(
    () => decodeAgentSettings({
      ...current,
      profiles: [{ ...savedProfile, defaultModel: "missing-model" }],
    }),
    /Default model must reference a configured model/,
  );
  assert.throws(
    () => decodeAgentSettings({
      ...current,
      profiles: [{ ...savedProfile, models: [] }],
    }),
    /at least one model/,
  );
});

test("nested schema-v3/v4 settings drop the legacy subscription output limit", () => {
  for (const schemaVersion of [3, 4] as const) {
    const decoded = decodeAgentSettings({
      schemaVersion,
      activeProfileId: "subscription",
      profiles: [{
        id: "subscription",
        name: "ChatGPT subscription",
        connection: { kind: "codex-subscription", provider: "openai" },
        model: "gpt-5.6-sol",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "default" },
        },
        advanced: {},
      }],
      approvalMode: "manual",
      ...(schemaVersion === 4
        ? {
            defaultFollowUpBehavior: "queue",
            defaultFollowUpBehaviorRevision: "0",
          }
        : {}),
    });

    assert.deepEqual(decoded.profiles[0]?.models[0]?.parameters, {
      reasoning: { mode: "default" },
    });
  }
});

test("the next authorized settings write omits a legacy subscription output limit", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-settings-subscription-shape-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "live-smith-settings.json");
  const stored = {
    schemaVersion: 4,
    activeProfileId: "subscription",
    profiles: [{
      id: "subscription",
      name: "ChatGPT subscription",
      connection: { kind: "codex-subscription", provider: "openai" },
      model: "gpt-5.6-sol",
      parameters: {
        maxOutputTokens: 8192,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  } as const;
  const original = JSON.stringify(stored, null, 2);
  await fs.writeFile(target, original);

  assert.equal(
    (await loadAgentSettings(directory)).profiles[0]?.models[0]?.parameters
      .maxOutputTokens,
    undefined,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);

  await saveGlobalSettings(directory, { defaultFollowUpBehavior: "steer" });
  const persisted = JSON.parse(await fs.readFile(target, "utf8")) as {
    profiles: Array<{
      models: Array<{ parameters: Record<string, unknown> }>;
    }>;
  };
  assert.deepEqual(persisted.profiles[0]?.models[0]?.parameters, {
    reasoning: { mode: "default" },
  });
});

test("settings mutations preserve the original bytes when one stored Profile is invalid", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const settingsPath = path.join(directory, "live-smith-settings.json");
  const original = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: "profile-1",
    profiles: [
      legacyProfile(profile()),
      {
        ...legacyProfile(profile({ id: "profile-2", name: "Recoverable" })),
        apiKey: "",
      },
    ],
    autoApprove: false,
  }, null, 2);
  await fs.writeFile(settingsPath, original);

  await assert.rejects(
    saveGlobalSettings(directory, { defaultFollowUpBehavior: "steer" }),
    (error: unknown) => error instanceof AgentSettingsCorruptionError,
  );
  assert.equal(await fs.readFile(settingsPath, "utf8"), original);
  assert.match(original, /"apiKey": "secret"/);
});

test("saveSavedProfile normalizes, persists, and activates the complete profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const saved = await saveSavedProfile(directory, profile({
    advanced: { hostedTools: { webSearch: true } },
  }));

  assert.equal(saved.activeProfileId, "profile-1");
  assert.equal(
    saved.profiles[0]?.connection.kind === "direct-api"
      ? saved.profiles[0].connection.baseUrl
      : undefined,
    "https://example.test/v1",
  );
  assert.deepEqual(saved.profiles[0]?.models[0]?.advanced.hostedTools, {
    webSearch: true,
  });
  const persisted = JSON.parse(
    await fs.readFile(path.join(directory, "live-smith-settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), [
    "activeProfileId",
    "approvalMode",
    "defaultFollowUpBehavior",
    "defaultFollowUpBehaviorRevision",
    "profiles",
    "schemaVersion",
  ]);
});

test("saveSavedProfile persists a keyless loopback connection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const saved = await saveSavedProfile(directory, profile({
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
  }));

  assert.equal(
    saved.profiles[0]?.connection.kind === "direct-api"
      ? saved.profiles[0].connection.apiKey
      : undefined,
    "",
  );
  const loaded = (await loadAgentSettings(directory)).profiles[0];
  assert.equal(
    loaded?.connection.kind === "direct-api" ? loaded.connection.apiKey : undefined,
    "",
  );
});

test("concurrent profile saves neither fail nor lose profiles", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const profiles = Array.from({ length: 16 }, (_, index) =>
    profile({
      id: `profile-${index}`,
      name: `Studio ${index}`,
      model: `model-${index}`,
    }),
  );

  const results = await Promise.allSettled(
    profiles.map((entry) => saveSavedProfile(directory, entry)),
  );
  const rejected = results.filter((result) => result.status === "rejected");
  const saved = await loadAgentSettings(directory);

  assert.equal(rejected.length, 0);
  assert.deepEqual(
    saved.profiles.map((entry) => entry.id).sort(),
    profiles.map((entry) => entry.id).sort(),
  );
});

test("settings persistence does not depend on an ambient process object", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  Object.defineProperty(globalThis, "process", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    const saved = await saveSavedProfile(directory, profile());
    assert.equal(saved.activeProfileId, "profile-1");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "process", descriptor);
    else Reflect.deleteProperty(globalThis, "process");
  }
});

test("profiles enforce valid family modes and unique case-insensitive names", async () => {
  const invalidPair = {
    ...profile(),
    connection: {
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
    },
  } as unknown as SavedProfile;
  await assert.rejects(
    saveSavedProfile(undefined, invalidPair),
    /does not support API mode/,
  );

  await saveSavedProfile(undefined, profile());
  await assert.rejects(
    saveSavedProfile(
      undefined,
      profile({ id: "profile-2", name: "studio", model: "model-b" }),
    ),
    /already exists/,
  );

  await assert.rejects(
    saveSavedProfile(
      undefined,
      profile({ id: "a".repeat(129), name: "Oversized" }),
    ),
    /Profile ID must be 1-128/,
  );
});

test("activation, deletion, and global settings are independent operations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  await saveSavedProfile(directory, profile());
  await saveSavedProfile(
    directory,
    profile({ id: "profile-2", name: "Mix", model: "model-b" }),
  );
  assert.equal((await activateSavedProfile(directory, "profile-1")).activeProfileId, "profile-1");

  const global = await saveGlobalSettings(directory, {
    defaultFollowUpBehavior: "steer",
  });
  assert.equal(global.defaultFollowUpBehavior, "steer");
  assert.equal(global.defaultFollowUpBehaviorRevision, "1");
  assert.equal(global.approvalMode, "manual");
  assert.equal(global.profiles.length, 2);

  const deleted = await deleteSavedProfile(directory, "profile-1");
  assert.equal(deleted.activeProfileId, "profile-2");
  assert.deepEqual(deleted.profiles.map((entry) => entry.id), ["profile-2"]);
});

test("global settings accept only queue or steer follow-up behavior", async () => {
  await assert.rejects(
    saveGlobalSettings(undefined, {
      defaultFollowUpBehavior: "later",
    } as never),
    /Default follow-up behavior must be queue or steer/,
  );
});

test("every global settings write atomically increments and returns its revision", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));

  const first = await saveGlobalSettings(directory, {
    defaultFollowUpBehavior: "queue",
  });
  const second = await saveGlobalSettings(directory, {
    defaultFollowUpBehavior: "queue",
  });
  assert.equal(first.defaultFollowUpBehaviorRevision, "1");
  assert.equal(second.defaultFollowUpBehaviorRevision, "2");

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      saveGlobalSettings(directory, {
        defaultFollowUpBehavior: index % 2 === 0 ? "steer" : "queue",
      }),
    ),
  );
  assert.deepEqual(
    concurrent
      .map((settings) => settings.defaultFollowUpBehaviorRevision)
      .sort(compareDefaultFollowUpBehaviorRevisions),
    ["3", "4", "5", "6", "7", "8", "9", "10"],
  );
  assert.equal(
    (await loadAgentSettings(directory)).defaultFollowUpBehaviorRevision,
    "10",
  );
});

test("global settings revisions increment beyond Number.MAX_SAFE_INTEGER", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-settings-large-revision-"),
  );
  const settingsPath = path.join(directory, "live-smith-settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({
    schemaVersion: 4,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "9007199254740991",
  }));

  const first = await saveGlobalSettings(directory, {
    defaultFollowUpBehavior: "steer",
  });
  const second = await saveGlobalSettings(directory, {
    defaultFollowUpBehavior: "queue",
  });

  assert.equal(first.defaultFollowUpBehaviorRevision, "9007199254740992");
  assert.equal(second.defaultFollowUpBehaviorRevision, "9007199254740993");
  assert.equal(
    (await loadAgentSettings(directory)).defaultFollowUpBehaviorRevision,
    "9007199254740993",
  );
});

test("settings keep an in-memory fallback without a storage directory", async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const saved = await saveSavedProfile(
    undefined,
    profile({ id: unique, name: unique }),
  );
  assert.equal(saved.activeProfileId, unique);
  assert.ok((await loadAgentSettings(undefined)).profiles.some((entry) => entry.id === unique));
});
