import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { DiscoveredModelInfo } from "../model/provider.js";
import type {
  DirectApiModelConfig,
  DirectApiProfile,
  OpenAIDirectApiConnection,
  SavedProfile,
} from "../model/profile.js";
import {
  connectionFingerprint,
  loadModelCache,
  saveModelCache,
} from "./model-cache.js";

const capabilities: DiscoveredModelInfo["capabilities"] = {
  tools: true,
  streaming: false,
  temperature: "unsupported",
  maxOutputTokens: 32000,
  inputs: { image: true, audio: false, pdf: true },
  reasoning: {
    supported: true,
    canDisable: true,
    efforts: ["low", "high", "max", "ultra"],
    budgetTokens: false,
    strategy: "adaptive-thinking",
  },
};

type ProfileOverrides = Partial<Pick<DirectApiProfile, "id" | "name">> &
  Partial<Omit<OpenAIDirectApiConnection, "kind" | "apiFamily">> & {
    model?: string;
    parameters?: DirectApiModelConfig["parameters"];
    advanced?: DirectApiModelConfig["advanced"];
  };

function profile(overrides: ProfileOverrides = {}): DirectApiProfile {
  const {
    apiMode = "responses",
    baseUrl = "https://example.test/v1",
    apiKey = "secret-key",
    model = "model-a",
    parameters = {
      maxOutputTokens: 4096,
      reasoning: { mode: "default" },
    },
    advanced = {},
    ...fields
  } = overrides;
  return {
    id: "p1",
    name: "Profile",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode,
      baseUrl,
      apiKey,
    },
    defaultModel: model,
    models: [{ model, parameters, advanced }],
    ...fields,
  };
}

test("connection fingerprints isolate connection changes", () => {
  const original = connectionFingerprint(profile());
  assert.notEqual(original, connectionFingerprint(profile({ apiKey: "other" })));
  assert.notEqual(original, connectionFingerprint(profile({ apiMode: "chat-completions" })));
  assert.equal(original.length, 64);
  assert.equal(original.includes("secret-key"), false);
});

test("model cache is connection-fingerprint scoped without exposing identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  const active = profile({ id: "profile/unsafe" });
  const models: DiscoveredModelInfo[] = [{ id: "model-a", displayName: "A", capabilities }];
  await saveModelCache(directory, active, models);
  assert.deepEqual(await loadModelCache(directory, active), models);
  assert.deepEqual(await loadModelCache(
    directory,
    profile({ id: active.id, apiKey: "changed" }),
  ), []);

  const files = await fs.readdir(directory);
  assert.equal(files.some((file) => file.includes("secret-key")), false);
  assert.equal(files.some((file) => file.includes("profile_unsafe")), false);
  assert.match(files[0]!, /^live-smith-models-v2-[a-f0-9]{64}\.json$/);
  const persisted = JSON.parse(
    await fs.readFile(path.join(directory, files[0]!), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 1);
});

test("model cache bounds its filename even for a defensively invalid long Profile ID", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  const active = profile({ id: `unsafe/${"a".repeat(300)}` });
  const models: DiscoveredModelInfo[] = [{ id: "model-a", displayName: "A", capabilities }];

  await saveModelCache(directory, active, models);
  assert.deepEqual(await loadModelCache(directory, active), models);

  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  assert.ok(files[0]!.length < 128);
});

test("model cache rejects pre-raw-format entries even when the fingerprint matches", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  const active = profile({ id: "legacy-cache" });
  await saveModelCache(directory, active, []);
  const [file] = await fs.readdir(directory);
  assert.ok(file);
  const staleEffectiveModels = [{
    id: "model-a",
    displayName: "A",
    capabilities: {
      tools: true,
      streaming: true,
      temperature: "unsupported",
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["high"],
        budgetTokens: false,
        strategy: "effort",
      },
    },
  }];
  await fs.writeFile(
    path.join(directory, file),
    JSON.stringify({
      fingerprint: connectionFingerprint(active),
      models: staleEffectiveModels,
    }),
  );

  assert.deepEqual(await loadModelCache(directory, active), []);
});

test("model cache rejects every structurally invalid derived cache shape", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  const active = profile({ id: "corrupt-cache" });
  await saveModelCache(directory, active, []);
  const [file] = await fs.readdir(directory);
  assert.ok(file);
  const fingerprint = connectionFingerprint(active);
  const validModel = {
    id: "model-a",
    displayName: "A",
    capabilities: {},
  };
  const invalidEntries: unknown[] = [
    null,
    [],
    { schemaVersion: 1, fingerprint, models: {} },
    { schemaVersion: 1, fingerprint, models: [null] },
    { schemaVersion: 1, fingerprint, models: [[]] },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: null }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { inputs: { image: "yes" } } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { inputs: { video: true } } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: [] }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { tools: "yes" } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { temperature: "sometimes" } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { maxOutputTokens: -1 } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { maxOutputTokens: 1.5 } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, id: "" }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [validModel, { ...validModel }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { unknown: true } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{ ...validModel, capabilities: { reasoning: null } }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{
        ...validModel,
        capabilities: { reasoning: { efforts: ["turbo"] } },
      }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{
        ...validModel,
        capabilities: { reasoning: { efforts: ["high", "high"] } },
      }],
    },
    {
      schemaVersion: 1,
      fingerprint,
      models: [{
        ...validModel,
        capabilities: { reasoning: { strategy: "unknown" } },
      }],
    },
  ];

  for (const entry of invalidEntries) {
    await fs.writeFile(path.join(directory, file), JSON.stringify(entry));
    assert.deepEqual(await loadModelCache(directory, active), []);
  }
});

test("model cache refuses to persist a noncanonical catalog", async () => {
  const active = profile({ id: `invalid-catalog-${Date.now()}` });
  const duplicateModels: DiscoveredModelInfo[] = [
    { id: "model-a", displayName: "A", capabilities: {} },
    { id: "model-a", displayName: "Duplicate", capabilities: {} },
  ];

  await assert.rejects(
    saveModelCache(undefined, active, duplicateModels),
    /Model catalog is invalid/,
  );
  assert.deepEqual(await loadModelCache(undefined, active), []);
});

test("model cache supports isolated in-memory entries", async () => {
  const p1 = profile({ id: `p-${Date.now()}` });
  const models: DiscoveredModelInfo[] = [{ id: "model-a", displayName: "A", capabilities }];
  await saveModelCache(undefined, p1, models);
  assert.deepEqual(await loadModelCache(undefined, p1), models);
  assert.deepEqual(
    await loadModelCache(undefined, profile({
      id: p1.id,
      baseUrl: "https://other.test",
    })),
    [],
  );
});

test("different connections of one Profile keep independent persistent caches", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const connectionA = profile({ id: "shared-profile", apiKey: "key-a" });
  const connectionB = profile({
    id: connectionA.id,
    apiKey: "key-b",
    baseUrl: "https://other.example.test/v1",
  });
  const modelsA: DiscoveredModelInfo[] = [{
    id: "model-a",
    displayName: "A",
    capabilities,
  }];
  const modelsB: DiscoveredModelInfo[] = [{
    id: "model-b",
    displayName: "B",
    capabilities,
  }];

  await saveModelCache(directory, connectionA, modelsA);
  await saveModelCache(directory, connectionB, modelsB);

  assert.deepEqual(await loadModelCache(directory, connectionA), modelsA);
  assert.deepEqual(await loadModelCache(directory, connectionB), modelsB);
  assert.equal((await fs.readdir(directory)).length, 2);

  await saveModelCache(directory, connectionA, []);
  assert.deepEqual(await loadModelCache(directory, connectionA), []);
  assert.deepEqual(await loadModelCache(directory, connectionB), modelsB);
});

test("different connections of one Profile keep independent in-memory caches", async () => {
  const id = `shared-memory-profile-${Date.now()}`;
  const connectionA = profile({ id, apiKey: "memory-key-a" });
  const connectionB = profile({ id, apiKey: "memory-key-b" });
  const modelsA: DiscoveredModelInfo[] = [{
    id: "model-a",
    displayName: "A",
    capabilities,
  }];
  const modelsB: DiscoveredModelInfo[] = [{
    id: "model-b",
    displayName: "B",
    capabilities,
  }];

  await saveModelCache(undefined, connectionA, modelsA);
  await saveModelCache(undefined, connectionB, modelsB);

  assert.deepEqual(await loadModelCache(undefined, connectionA), modelsA);
  assert.deepEqual(await loadModelCache(undefined, connectionB), modelsB);
});

test("model cache reads an exact legacy slot only while its v2 slot is absent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const active = profile({ id: "legacy-profile" });
  const legacyModels: DiscoveredModelInfo[] = [{
    id: "legacy-model",
    displayName: "Legacy",
    capabilities,
  }];
  const idHash = createHash("sha256").update(active.id).digest("hex").slice(0, 16);
  const legacyPath = path.join(
    directory,
    `live-smith-models-${active.id}-${idHash}.json`,
  );
  await fs.writeFile(legacyPath, JSON.stringify({
    schemaVersion: 1,
    fingerprint: connectionFingerprint(active),
    models: legacyModels,
  }));

  assert.deepEqual(await loadModelCache(directory, active), legacyModels);
  assert.deepEqual(
    await loadModelCache(directory, profile({ id: active.id, apiKey: "other" })),
    [],
  );

  await saveModelCache(directory, active, []);
  assert.deepEqual(await loadModelCache(directory, active), []);
  const v2File = (await fs.readdir(directory)).find((file) =>
    file.startsWith("live-smith-models-v2-")
  );
  assert.ok(v2File);
  await fs.writeFile(path.join(directory, v2File), "{");
  assert.deepEqual(
    await loadModelCache(directory, active),
    [],
    "a corrupt v2 slot must not revive stale legacy metadata",
  );
});

test("subscription fingerprints contain only non-secret connection identity", () => {
  const subscription: SavedProfile = {
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

  const fingerprint = connectionFingerprint(subscription);
  assert.equal(fingerprint.length, 64);
  assert.equal(fingerprint.includes("openai"), false);
  assert.equal(fingerprint, connectionFingerprint({
    ...subscription,
    defaultModel: "other",
    models: [{
      model: "other",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  }));
});

test("subscription model metadata is modal-scoped rather than persisted across accounts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const subscription: SavedProfile = {
    id: "managed-model-cache",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "gpt-5.6-sol",
    models: [{
      model: "gpt-5.6-sol",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
  const models: DiscoveredModelInfo[] = [{
    id: "gpt-5.6-sol",
    displayName: "GPT 5.6 Sol",
    capabilities,
  }];

  await saveModelCache(directory, subscription, models);

  assert.deepEqual(await loadModelCache(directory, subscription), []);
  assert.deepEqual(await fs.readdir(directory), []);
});
