import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { DiscoveredModelInfo } from "../model/provider.js";
import type {
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

type ProfileOverrides = Partial<Omit<SavedProfile, "connection">> &
  Partial<Omit<OpenAIDirectApiConnection, "kind" | "apiFamily">>;

function profile(overrides: ProfileOverrides = {}): SavedProfile {
  const {
    apiMode = "responses",
    baseUrl = "https://example.test/v1",
    apiKey = "secret-key",
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
    model: "model-a",
    parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } },
    advanced: {},
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

test("model cache is profile and fingerprint scoped", async () => {
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
  assert.equal(files.some((file) => file.includes("profile_unsafe")), true);
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
        capabilities: { reasoning: { strategy: "unknown" } },
      }],
    },
  ];

  for (const entry of invalidEntries) {
    await fs.writeFile(path.join(directory, file), JSON.stringify(entry));
    assert.deepEqual(await loadModelCache(directory, active), []);
  }
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

test("subscription fingerprints contain only non-secret connection identity", () => {
  const subscription: SavedProfile = {
    id: "codex-subscription",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
    advanced: {},
  };

  const fingerprint = connectionFingerprint(subscription);
  assert.equal(fingerprint.length, 64);
  assert.equal(fingerprint.includes("openai"), false);
  assert.equal(fingerprint, connectionFingerprint({ ...subscription, model: "other" }));
});

test("subscription model metadata is modal-scoped rather than persisted across accounts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-models-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const subscription: SavedProfile = {
    id: "managed-model-cache",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
    advanced: {},
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
