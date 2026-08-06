import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { SavedProfile } from "../model/profile.js";
import {
  AgentSettingsCorruptionError,
  activateSavedProfile,
  deleteSavedProfile,
  loadAgentSettings,
  saveSavedProfile,
  saveGlobalSettings,
} from "./settings.js";

function profile(
  overrides: Partial<SavedProfile> = {},
): SavedProfile {
  return {
    id: "profile-1",
    name: "Studio",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1/",
    apiKey: "secret",
    model: "model-a",
    parameters: {
      maxOutputTokens: 8192,
      temperature: 0.3,
      reasoning: { mode: "default" },
    },
    advanced: {},
    ...overrides,
  };
}

test("loadAgentSettings starts empty and rejects every legacy or invalid settings shape", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  assert.deepEqual(await loadAgentSettings(directory), {
    schemaVersion: 1,
    activeProfileId: null,
    profiles: [],
    autoApprove: false,
  });

  const legacyShapes = [
    { provider: "openai", apiKey: "old", model: "old" },
    { providerConfigs: { openai: { apiKey: "old" } } },
    { schemaVersion: 0, provider: "anthropic" },
    { schemaVersion: 1, activeProfileId: null, profiles: "not-an-array", autoApprove: false },
    { schemaVersion: 1, activeProfileId: null, profiles: [{ provider: "openai" }], autoApprove: false },
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

test("settings mutations preserve the original bytes when one stored Profile is invalid", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const settingsPath = path.join(directory, "live-smith-settings.json");
  const original = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: "profile-1",
    profiles: [
      profile(),
      {
        ...profile({ id: "profile-2", name: "Recoverable" }),
        apiKey: "",
      },
    ],
    autoApprove: false,
  }, null, 2);
  await fs.writeFile(settingsPath, original);

  await assert.rejects(
    saveGlobalSettings(directory, { autoApprove: true }),
    (error: unknown) => error instanceof AgentSettingsCorruptionError,
  );
  assert.equal(await fs.readFile(settingsPath, "utf8"), original);
  assert.match(original, /"apiKey": "secret"/);
});

test("saveSavedProfile normalizes, persists, and activates the complete profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-settings-"));
  const saved = await saveSavedProfile(directory, profile());

  assert.equal(saved.activeProfileId, "profile-1");
  assert.equal(saved.profiles[0]?.baseUrl, "https://example.test/v1");
  const persisted = JSON.parse(
    await fs.readFile(path.join(directory, "live-smith-settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), [
    "activeProfileId",
    "autoApprove",
    "profiles",
    "schemaVersion",
  ]);
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
  await assert.rejects(
    saveSavedProfile(undefined, profile({ apiFamily: "anthropic", apiMode: "responses" })),
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

  const global = await saveGlobalSettings(directory, { autoApprove: true });
  assert.equal(global.autoApprove, true);
  assert.equal(global.profiles.length, 2);

  const deleted = await deleteSavedProfile(directory, "profile-1");
  assert.equal(deleted.activeProfileId, "profile-2");
  assert.deepEqual(deleted.profiles.map((entry) => entry.id), ["profile-2"]);
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
