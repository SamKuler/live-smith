import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCommandInput, parseSendInput } from "../app/chat-bridge-http.js";
import {
  LEGACY_AUDIO_SERVICE_ID,
  type AudioServiceConnection,
} from "../audio-services/contracts.js";
import {
  cloneAgentSettings,
  freshEmptyAgentSettings,
  isAudioServiceCallbackUrl,
} from "../model/profile.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import {
  MAX_INTEGRATION_CONNECTIONS,
  integrationConnectionsView,
  migrateAudioServiceConnection,
  normalizeIntegrationConnection,
  type IntegrationConnection,
  type IntegrationConnectionsSettingsPatch,
} from "../plugins/integration-connections.js";
import { decodeAgentSettings } from "./settings-migrations.js";
import { loadAgentSettings, saveGlobalSettings } from "./settings.js";

function legacyConnection(
  overrides: Partial<AudioServiceConnection> = {},
): AudioServiceConnection {
  return {
    id: "audio-work",
    name: "Work separation",
    provider: "lalal",
    enabled: true,
    apiKey: "fixture-work",
    ...overrides,
  };
}

function connection(
  overrides: Partial<AudioServiceConnection> = {},
): IntegrationConnection {
  return migrateAudioServiceConnection(legacyConnection(overrides));
}

function upsert(
  expectedRevision = "0",
  overrides: Partial<AudioServiceConnection> = {},
  includeSecrets = true,
): IntegrationConnectionsSettingsPatch {
  const normalized = connection(overrides);
  const { secrets, ...fields } = normalized;
  return {
    action: "upsert",
    expectedRevision,
    connection: { ...fields, ...(includeSecrets ? { secrets } : {}) },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-integration-settings-"));
  return {
    directory,
    file: join(directory, "live-smith-settings.json"),
    save: (integrationConnections: IntegrationConnectionsSettingsPatch) =>
      saveGlobalSettings(directory, { integrationConnections }),
  };
}

test("Plugin-owned Connection settings round-trip, deep clone, and hide secrets", () => {
  const original = freshEmptyAgentSettings();
  assert.equal(decodeAgentSettings(original).integrationConnections, undefined);
  assert.deepEqual(integrationConnectionsView(undefined), { connections: [], revision: "0" });
  const settings = {
    ...original,
    integrationConnections: {
      connections: [
        connection(),
        connection({
          id: "audio-music",
          name: "Music",
          provider: "elevenlabs",
          modelId: "music_v2",
        }),
      ],
      revision: "19",
    },
  };
  assert.deepEqual(decodeAgentSettings(settings), settings);
  const clone = cloneAgentSettings(settings);
  clone.integrationConnections!.connections[0]!.secrets.apiKey = "replacement";
  assert.equal(settings.integrationConnections.connections[0]!.secrets.apiKey, "fixture-work");
  const view = integrationConnectionsView(settings.integrationConnections);
  assert.equal(view.connections.length, 2);
  assert.equal(view.connections[1]!.configuration.modelId, "music_v2");
  assert.deepEqual(view.connections[0]!.configuredSecrets, ["apiKey"]);
  assert.doesNotMatch(JSON.stringify(view), /fixture-work|"secrets"|"apiKey":/);
});

test("schema v8 audioServices migrate losslessly to schema v9 Integration Connections", () => {
  const source = {
    ...freshEmptyAgentSettings(),
    schemaVersion: 8,
    audioServices: {
      revision: "7",
      connections: [
        legacyConnection(),
        legacyConnection({
          id: "music",
          name: "Music",
          provider: "elevenlabs",
          modelId: "music_v2",
          apiKey: "fixture-music",
        }),
      ],
    },
  };
  const decoded = decodeAgentSettings(source);
  assert.equal(decoded.schemaVersion, 9);
  assert.deepEqual(decoded.integrationConnections, {
    revision: "7",
    connections: [connection(), connection({
      id: "music",
      name: "Music",
      provider: "elevenlabs",
      modelId: "music_v2",
      apiKey: "fixture-music",
    })],
  });
  assert.equal(Object.hasOwn(decoded, "audioServices"), false);
});

test("SunoAPI configuration persists without exposing secrets and enabling requires callback plus key", async () => {
  const { file, save } = await fixture();
  await save(upsert());
  const suno = connection({
    id: "suno-api",
    name: "Third-party music",
    provider: "sunoapi",
    enabled: false,
    apiKey: "",
  });
  const disabled = await save({ action: "upsert", expectedRevision: "1", connection: suno });
  const before = await readFile(file, "utf8");
  await assert.rejects(save({ action: "upsert", expectedRevision: "2", connection: {
    ...suno,
    enabled: true,
    secrets: { apiKey: "fixture-suno" },
  } }), /callback/i);
  const callbackUrl = "https://hooks.example.com/%E9%9F%B3%E4%B9%90";
  await assert.rejects(save({ action: "upsert", expectedRevision: "2", connection: {
    ...suno,
    enabled: true,
    configuration: { callbackUrl },
  } }), /API key/);
  assert.equal(await readFile(file, "utf8"), before);
  const saved = await save({ action: "upsert", expectedRevision: "2", connection: {
    ...suno,
    enabled: true,
    configuration: { callbackUrl, modelId: "V4_5ALL" },
    secrets: { apiKey: "fixture-suno" },
  } });
  assert.equal(saved.integrationConnections?.lastChangeTouchesAudio, true);
  assert.deepEqual(saved.integrationConnections!.connections[0], disabled.integrationConnections!.connections[0]);
  const clone = cloneAgentSettings(saved);
  clone.integrationConnections!.connections[1]!.configuration.callbackUrl = "https://other.example.com/hook";
  assert.equal(saved.integrationConnections!.connections[1]!.configuration.callbackUrl, callbackUrl);
  assert.equal(integrationConnectionsView(saved.integrationConnections).connections[1]!.configuration.callbackUrl, callbackUrl);
  assert.doesNotMatch(JSON.stringify(integrationConnectionsView(saved.integrationConnections)), /fixture-suno|"secrets"/);
  await assert.rejects(save({ action: "upsert", expectedRevision: "3", connection: {
    ...suno,
    enabled: true,
    configuration: { callbackUrl: "https://hooks.example.com/%66ixture-suno" },
    secrets: { apiKey: "fixture-suno" },
  } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /callback URL must not contain API credentials/);
    assert.doesNotMatch(error.message, /fixture-suno/);
    return true;
  });
});

test("Plugin connection descriptors own model and callback fields", () => {
  const platform = connection({
    id: "suno-platform",
    name: "Official Suno",
    provider: "suno-platform",
    enabled: false,
    apiKey: "",
  });
  assert.throws(() => normalizeIntegrationConnection({
    ...platform,
    configuration: { modelId: "v6" },
  }), /unsupported configuration/u);
  assert.throws(() => normalizeIntegrationConnection({
    ...platform,
    configuration: { callbackUrl: "https://example.test/hook" },
  }), /unsupported configuration/u);
  const command = {
    kind: "save_global_settings",
    integrationConnections: upsert("0", {
      provider: "elevenlabs",
      modelId: "m".repeat(128),
    }),
  };
  assert.deepEqual(parseCommandInput(command), command);
  assert.throws(() => parseCommandInput({
    ...command,
    integrationConnections: upsert("0", {
      provider: "elevenlabs",
      modelId: "m".repeat(129),
    }),
  }));
});

test("callback validation rejects malformed or credential-bearing values without reflecting input", () => {
  for (const callbackUrl of [
    "",
    "ftp://hooks.example.com/cb",
    "https://fixture-secret@hooks.example.com/cb",
    "https://%66ixture-secret@hooks.example.com/cb",
    "https://hooks.example.com/cb#fixture-secret",
    "https://hooks.example.com\\@localhost/cb",
    "https://hooks.example.com/c b",
    "https://hooks.example.com/%",
    "https://hooks.example.com/%GG",
    "https://hooks.example.com/%C0%AF",
    "https://hooks.example.com/" + "a".repeat(2048),
    null,
  ]) {
    const candidate = connection({ provider: "sunoapi", enabled: false, apiKey: "fixture-secret" });
    assert.throws(() => normalizeIntegrationConnection({
      ...candidate,
      configuration: { callbackUrl },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /callback|configuration/i);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
  for (const callbackUrl of [
    "http://localhost:8787/cb?token=fixture",
    "https://127.0.0.1:9443/cb?stage=done",
    "https://hooks.example.com./cb?",
  ]) assert.equal(isAudioServiceCallbackUrl(callbackUrl), true, callbackUrl);
});

test("historical single LALAL connection migrates on read and the next write persists only schema v9", async () => {
  const { directory, file, save } = await fixture();
  const source = JSON.stringify({
    ...freshEmptyAgentSettings(),
    schemaVersion: 8,
    audioService: {
      provider: "lalal",
      enabled: true,
      apiKey: "fixture-legacy",
      revision: "9007199254740999",
    },
  });
  await writeFile(file, source);
  const loaded = await loadAgentSettings(directory);
  assert.deepEqual(loaded.integrationConnections, {
    revision: "9007199254740999",
    connections: [connection({
      id: LEGACY_AUDIO_SERVICE_ID,
      name: "LALAL.AI",
      apiKey: "fixture-legacy",
    })],
  });
  assert.equal(await readFile(file, "utf8"), source);
  const { secrets: _omitted, ...fields } = loaded.integrationConnections!.connections[0]!;
  const saved = await save({
    action: "upsert",
    expectedRevision: loaded.integrationConnections!.revision,
    connection: { ...fields, name: "Migrated" },
  });
  assert.equal(saved.integrationConnections?.revision, "9007199254741000");
  assert.equal(saved.integrationConnections?.connections[0]!.secrets.apiKey, "fixture-legacy");
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.schemaVersion, 9);
  assert.equal(Object.hasOwn(persisted, "audioService"), false);
  assert.equal(Object.hasOwn(persisted, "audioServices"), false);
});

test("corrupt collections and Connection fields fail without reflecting secrets", () => {
  const valid = { connections: [connection()], revision: "0" };
  for (const value of [
    null,
    {},
    { ...valid, revision: "01" },
    { ...valid, endpoint: "fixture-secret" },
    { ...valid, connections: [connection(), connection()] },
    { ...valid, connections: [connection(), connection({ id: "other", name: "work SEPARATION" })] },
    { ...valid, connections: Array.from({ length: MAX_INTEGRATION_CONNECTIONS + 1 }, (_, index) =>
      connection({ id: `c${index}`, name: `C${index}` })) },
    ...[
      { id: "../audio" },
      { name: " " },
      { pluginId: "missing.plugin" },
      { configuration: { unknown: "value" } },
      { secrets: { apiKey: "fixture-secret\nheader" } },
      { secrets: { apiKey: "x".repeat(4_097) } },
    ].map((fields) => ({ ...valid, connections: [{ ...connection(), ...fields }] })),
  ]) {
    assert.throws(() => decodeAgentSettings({
      ...freshEmptyAgentSettings(),
      integrationConnections: value,
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
});

test("same-Plugin accounts preserve independent secrets; Plugin switches never inherit them", async () => {
  const { directory, file, save } = await fixture();
  await save(upsert());
  await save(upsert("1", { id: "audio-personal", name: "Personal", apiKey: "fixture-personal" }));
  await save(upsert("2", {
    id: "audio-music",
    name: "Music",
    provider: "elevenlabs",
    apiKey: "fixture-music",
  }));
  const renamed = connection({ name: "Work renamed", enabled: false, apiKey: "" });
  const { secrets: _secret, ...renamedFields } = renamed;
  const edited = await save({ action: "upsert", expectedRevision: "3", connection: renamedFields });
  assert.deepEqual(edited.integrationConnections?.connections.map((entry) => entry.secrets.apiKey),
    ["fixture-work", "fixture-personal", "fixture-music"]);
  await saveGlobalSettings(directory, { uiLanguage: "zh-CN" });
  assert.deepEqual((await loadAgentSettings(directory)).integrationConnections, edited.integrationConnections);
  const cleared = await save(upsert("4", { enabled: false, apiKey: "" }));
  assert.deepEqual(cleared.integrationConnections?.connections.map((entry) => [entry.enabled, entry.secrets.apiKey ?? ""]),
    [[false, ""], [true, "fixture-personal"], [true, "fixture-music"]]);
  const removed = await save({ action: "remove", connectionId: "audio-personal", expectedRevision: "5" });
  assert.deepEqual(removed.integrationConnections?.connections.map((entry) => entry.id), ["audio-work", "audio-music"]);
  assert.doesNotMatch(await readFile(file, "utf8"), /fixture-work|fixture-personal/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const switched = connection({ provider: "suno", enabled: true, apiKey: "" });
  const { secrets: _none, ...switchedFields } = switched;
  const website = await save({ action: "upsert", expectedRevision: "6", connection: switchedFields });
  assert.equal(website.integrationConnections?.connections[0]!.pluginId, builtInAudioPluginId("suno"));
  assert.deepEqual(website.integrationConnections?.connections[0]!.secrets, {});
});

test("stale, invalid, and missing-target writes are atomic; one collection revision wins", async () => {
  const { directory, file, save } = await fixture();
  await save(upsert());
  const before = await readFile(file, "utf8");
  await assert.rejects(save(upsert("0", { apiKey: "fixture-stale" })), /changed in another window/);
  await assert.rejects(save({ action: "remove", connectionId: "missing", expectedRevision: "1" }), /no longer exists/);
  await assert.rejects(save(upsert("1", { id: "duplicate-name" })), /unique/);
  const invalidMissingKey = connection({ enabled: false, apiKey: "" });
  await assert.rejects(save({
    action: "upsert",
    expectedRevision: "1",
    connection: { ...invalidMissingKey, enabled: true },
  }), /API key/);
  assert.equal(await readFile(file, "utf8"), before);
  const results = await Promise.allSettled([
    save(upsert("1", { apiKey: "fixture-one" })),
    save(upsert("1", { apiKey: "fixture-two" })),
    saveGlobalSettings(directory, { showContextUsage: false }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  const stored = await loadAgentSettings(directory);
  assert.equal(stored.integrationConnections?.revision, "2");
  assert.equal(stored.showContextUsage, false);
  await assert.rejects(
    saveGlobalSettings(undefined, { integrationConnections: upsert() }),
    /persistent private storage/,
  );
});

test("Bridge accepts only strict Integration Connection patches and Send cannot carry them", () => {
  const withoutSecret = upsert("0", { enabled: false, apiKey: "" }, false);
  for (const patch of [
    upsert(),
    withoutSecret,
    { action: "remove", expectedRevision: "3", connectionId: "old" },
  ]) {
    const command = { kind: "save_global_settings", integrationConnections: patch };
    assert.deepEqual(parseCommandInput(command), command);
  }
  const resume = { kind: "resume_audio_job", sessionId: "session-1", jobId: "job-1" };
  assert.deepEqual(parseCommandInput(resume), resume);
  for (const patch of [
    null,
    {},
    { ...upsert(), expectedRevision: "01" },
    { ...upsert(), connection: { ...connection(), secrets: { apiKey: null } } },
    { ...upsert(), connection: { ...connection(), enabled: "true" } },
    { ...upsert(), serviceId: "foreign" },
    { action: "remove", expectedRevision: "0", connectionId: "../bad" },
    { action: "remove", expectedRevision: "0", connectionId: "ok", connection: connection() },
  ]) {
    assert.throws(() => parseCommandInput({ kind: "save_global_settings", integrationConnections: patch }));
  }
  for (const command of [
    { ...resume, jobId: "../job" },
    { ...resume, apiKey: "fixture-secret" },
    { kind: "save_global_settings", audioServices: { connections: [], revision: "0" } },
    { kind: "save_global_settings", integrationConnections: upsert(), uiLanguage: "en" },
  ]) assert.throws(() => parseCommandInput(command));
  assert.throws(() => parseSendInput({
    prompt: "split",
    sessionId: "s1",
    integrationConnections: {},
  }));
});
