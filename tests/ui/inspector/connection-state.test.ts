import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationConnectionsView } from "../../../src/plugins/integration-connections.js";
import { createConnectionState, type AudioConnectionDescriptor } from "../../../src/ui/client/connection-state.js";

const descriptors = {
  "live-smith.suno-website": { pluginId: "live-smith.suno-website", provider: "suno" },
} satisfies Record<string, AudioConnectionDescriptor>;

function initial(): IntegrationConnectionsView {
  return {
    revision: "3",
    connections: [
      {
        id: "audio-one", name: "Music", pluginId: "live-smith.suno-website", enabled: true,
        configuration: { modelId: "music-model" }, configuredSecrets: [],
      },
      {
        id: "mcp-one", name: "Remote tools", enabled: true,
        mcp: { type: "streamable-http", url: "https://example.test/mcp" },
        configuredSecrets: ["token"], artifactInputApproved: false, artifactOutputApproved: false,
      },
    ],
  };
}

test("one confirmed snapshot preserves mixed Connections while audio form edits stay local", () => {
  const source = initial();
  const store = createConnectionState({ initial: source, descriptors });
  assert.equal(store.selectedId, "audio-one");
  assert.equal(store.nonAudioCount, 1);
  const editor = store.savedAudio()!;
  editor.name = "Draft name";
  assert.equal(store.savedAudio()?.name, "Music");
  const snapshot = store.snapshot()!;
  assert.deepEqual(snapshot, source);
  snapshot.connections[1]!.name = "Changed copy";
  source.connections.length = 0;
  assert.deepEqual(store.snapshot(), initial());
});

test("an installed Plugin whose ID matches a prototype key remains a non-audio Connection", () => {
  const source = initial();
  source.connections.push({ id: "plugin-one", name: "Custom tools", pluginId: "constructor",
    enabled: true, configuration: { serverId: "local", pluginDigest: "a".repeat(64) }, configuredSecrets: [] });
  const store = createConnectionState({ initial: source, descriptors });
  assert.equal(store.nonAudioCount, 2);
  assert.deepEqual(store.audioConnections().map((connection) => connection.id), ["audio-one"]);
  assert.deepEqual(store.snapshot(), source);
});

test("a skipped revision cannot rebase an audio draft from only the latest MCP change", () => {
  const store = createConnectionState({ initial: initial(), descriptors });
  const saved = store.savedAudio()!;
  const draft = { connection: { ...saved, name: "Draft music" }, baseConnection: saved,
    expectedRevision: "3", conflict: false };
  store.drafts.set(saved.id, draft);
  const next = initial();
  next.revision = "5";
  next.lastChangeTouchesAudio = false;
  store.adopt(next);
  assert.equal(draft.expectedRevision, "3");
  assert.equal(draft.conflict, true);
  assert.equal(draft.connection.name, "Draft music");
  assert.equal(store.revision, "5");
});
