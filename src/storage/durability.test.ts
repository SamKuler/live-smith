import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:process";
import test from "node:test";

import type { SavedProfile } from "../model/profile.js";
import { appendSessionEvent, loadSessionEvents } from "./events.js";
import { createSession, listSessions } from "./sessions.js";
import { loadAgentSettings, saveSavedProfile } from "./settings.js";

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

test(
  "storage creates private directories and files",
  { skip: platform === "win32" },
  async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durability-"));
    const directory = path.join(parent, "new-storage");
    const profile: SavedProfile = {
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
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "default" },
        },
        advanced: {},
      }],
    };

    await saveSavedProfile(directory, profile);
    await createSession(directory, {
      title: "Private session",
      projectKey: "set-001",
      scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    });
    await appendSessionEvent(directory, "session-1", {
      kind: "user",
      content: "Private event",
    });

    const eventsDirectory = path.join(directory, "live-smith-events");
    const paths = [
      [directory, privateDirectoryMode],
      [eventsDirectory, privateDirectoryMode],
      [path.join(directory, "live-smith-settings.json"), privateFileMode],
      [path.join(directory, "live-smith-sessions.json"), privateFileMode],
      [path.join(eventsDirectory, "session-1.json"), privateFileMode],
    ] as const;
    for (const [target, expectedMode] of paths) {
      const stat = await fs.stat(target);
      assert.equal(stat.mode & 0o777, expectedMode, target);
    }
  },
);

test(
  "storage tightens pre-existing directory and file permissions",
  { skip: platform === "win32" },
  async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durability-"));
    const directory = path.join(parent, "existing-storage");
    const eventsDirectory = path.join(directory, "live-smith-events");
    await fs.mkdir(eventsDirectory, { recursive: true });
    await fs.chmod(directory, 0o755);
    await fs.chmod(eventsDirectory, 0o755);
    const settingsPath = path.join(directory, "live-smith-settings.json");
    const sessionsPath = path.join(directory, "live-smith-sessions.json");
    const eventsPath = path.join(eventsDirectory, "session-1.json");
    await fs.writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      activeProfileId: null,
      profiles: [],
      autoApprove: false,
    }));
    await fs.writeFile(sessionsPath, "[]");
    await fs.writeFile(eventsPath, "[]");
    await fs.chmod(settingsPath, 0o644);
    await fs.chmod(sessionsPath, 0o644);
    await fs.chmod(eventsPath, 0o644);

    await saveSavedProfile(directory, {
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
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "default" },
        },
        advanced: {},
      }],
    });
    await appendSessionEvent(directory, "session-1", {
      kind: "user",
      content: "Private event",
    });
    await createSession(directory, {
      title: "Private session",
      projectKey: "set-001",
      scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    });

    assert.equal((await fs.stat(directory)).mode & 0o777, privateDirectoryMode);
    assert.equal(
      (await fs.stat(eventsDirectory)).mode & 0o777,
      privateDirectoryMode,
    );
    assert.equal((await fs.stat(settingsPath)).mode & 0o777, privateFileMode);
    assert.equal((await fs.stat(sessionsPath)).mode & 0o777, privateFileMode);
    assert.equal((await fs.stat(eventsPath)).mode & 0o777, privateFileMode);
  },
);

test(
  "read-only startup tightens existing storage and JSON permissions",
  { skip: platform === "win32" },
  async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durability-"));
    const directory = path.join(parent, "read-only-storage");
    const eventsDirectory = path.join(directory, "live-smith-events");
    await fs.mkdir(eventsDirectory, { recursive: true });
    const settingsPath = path.join(directory, "live-smith-settings.json");
    const sessionsPath = path.join(directory, "live-smith-sessions.json");
    const eventsPath = path.join(eventsDirectory, "session-1.json");
    await fs.writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      activeProfileId: null,
      profiles: [],
      autoApprove: false,
    }));
    await fs.writeFile(sessionsPath, "[]");
    await fs.writeFile(eventsPath, "[]");
    await fs.chmod(directory, 0o755);
    await fs.chmod(eventsDirectory, 0o755);
    await fs.chmod(settingsPath, 0o644);
    await fs.chmod(sessionsPath, 0o644);
    await fs.chmod(eventsPath, 0o644);

    await loadAgentSettings(directory);
    await listSessions(directory);
    await loadSessionEvents(directory, "session-1");

    assert.equal((await fs.stat(directory)).mode & 0o777, privateDirectoryMode);
    assert.equal((await fs.stat(eventsDirectory)).mode & 0o777, privateDirectoryMode);
    assert.equal((await fs.stat(settingsPath)).mode & 0o777, privateFileMode);
    assert.equal((await fs.stat(sessionsPath)).mode & 0o777, privateFileMode);
    assert.equal((await fs.stat(eventsPath)).mode & 0o777, privateFileMode);
  },
);
