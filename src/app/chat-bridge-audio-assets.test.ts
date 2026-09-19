import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createChatBridge, ChatBridgeResourceNotFoundError, ChatBridgeCommandStoppedError } from "./chat-bridge.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { freshEmptyAgentSettings } from "../model/profile.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";

test("audio playback authenticates and serves only validated session references, with seek ranges", async (t) => {
  const reads: string[] = [];
  const state = {} as ChatDialogState;
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const bridge = await createChatBridge({
    buildState: async () => state, renderHtml: () => "", handleCommand: async () => state,
    handleSend: async () => {},
    readAudioAsset: async (sessionId, assetId) => {
      reads.push(`${sessionId}:${assetId}`);
      if (sessionId !== "session-a" || assetId !== "asset-a") throw new ChatBridgeResourceNotFoundError("Unknown asset");
      return { bytes, mediaType: "audio/wav" };
    },
  });
  t.after(() => bridge.close());
  const chat = new URL(bridge.url);
  const endpoint = `${chat.origin}/audio-assets/asset-a?token=${chat.searchParams.get("token")}&sessionId=session-a`;
  const forbidden = await fetch(endpoint.replace(/token=[^&]+/, "token=wrong"));
  assert.equal(forbidden.status, 403); await forbidden.arrayBuffer(); assert.equal(reads.length, 0);
  const wrongSession = await fetch(endpoint.replace("sessionId=session-a", "sessionId=session-b"));
  assert.equal(wrongSession.status, 404); await wrongSession.arrayBuffer();
  const full = await fetch(endpoint);
  assert.equal(full.status, 200); assert.equal(full.headers.get("content-type"), "audio/wav");
  assert.equal(full.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  const partial = await fetch(endpoint, { headers: { range: "bytes=1-3" } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 1-3/5");
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), new Uint8Array([2, 3, 4]));
  const suffix = await fetch(endpoint, { headers: { range: "bytes=-2" } });
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), new Uint8Array([4, 5]));
  const invalid = await fetch(endpoint, { headers: { range: "bytes=8-9" } });
  assert.equal(invalid.status, 416); await invalid.arrayBuffer();
  const extra = await fetch(`${endpoint}&url=https://example.test`);
  assert.equal(extra.status, 400); await extra.arrayBuffer();
});

test("audio service revisions survive stale state reads and unrelated global settings updates", async (t) => {
  const settings = freshEmptyAgentSettings();
  const state: Partial<ChatDialogState> = {
    settings,
    integrationConnections: { connections: [], revision: "0" },
  };
  const bridge = await createChatBridge({
    buildState: async () => state as ChatDialogState, renderHtml: () => "", handleCommand: async () => state as ChatDialogState,
    handleSend: async () => {},
  });
  t.after(() => bridge.close());
  const url = new URL(bridge.url); url.pathname = "/state";
  await (await fetch(url)).json();
  const patch = {
    defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
    showContextUsage: settings.showContextUsage,
    contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
    customInstructions: settings.customInstructions,
    customInstructionsRevision: settings.customInstructionsRevision,
    networkProxy: settings.networkProxy, networkProxyRevision: settings.networkProxyRevision,
    uiLanguage: settings.uiLanguage, uiLanguageRevision: settings.uiLanguageRevision,
    commandId: "save-audio",
  };
  const connection = {
    id: "splitter",
    name: "Stems",
    pluginId: builtInAudioPluginId("lalal"),
    enabled: true,
    configuration: {},
    configuredSecrets: ["apiKey"],
  };
  bridge.publishGlobalSettings({ ...patch, integrationConnections: { connections: [connection], revision: "2" } });
  assert.equal((await (await fetch(url)).json()).integrationConnections.revision, "2");
  bridge.publishGlobalSettings({ ...patch, integrationConnections: { connections: [{ ...connection, enabled: false }], revision: "3" } });
  bridge.publishGlobalSettings({ ...patch, integrationConnections: { connections: [connection], revision: "1" } });
  const latest = await (await fetch(url)).json();
  assert.equal(latest.integrationConnections.revision, "3");
  assert.equal(latest.integrationConnections.connections[0].enabled, false);
});

test("stopped audio commands return their authoritative partial results with the stopped outcome", async (t) => {
  const state = { audioJobs: [{ id: "job", status: "partial", outputs: [{ id: "asset" }] }] } as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => ({} as ChatDialogState), renderHtml: () => "",
    handleCommand: async () => { throw new ChatBridgeCommandStoppedError(state); },
    handleSend: async () => {},
  });
  t.after(() => bridge.close());
  const endpoint = new URL(bridge.url); endpoint.pathname = "/command";
  const response = await fetch(endpoint, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Command-Id": "resume-stop",
  }, body: JSON.stringify({ kind: "resume_audio_job", sessionId: "session", jobId: "job" }) });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.commandOutcome, "stopped");
  assert.deepEqual(result.state.audioJobs, state.audioJobs);
});
