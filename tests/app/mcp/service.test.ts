import { join } from "node:path";
import { attachmentMutationFence } from "../../../src/app/session/session-fences.js";
import { sessionMutationFenceKey } from "../../../src/app/session/session-mutation-fence.js";
import { interceptStoredWrites } from "../../storage/support/sqlite-fault-test-helpers.js";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readMcpResourceBytes } from "../../../src/app/mcp/resources.js";
import { createMcpService } from "../../../src/app/mcp/service.js";
import { LiveMutationQueue } from "../../../src/app/live-mutation-queue.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { updateSession, setSessionArchived, deleteSession } from "../../../src/storage/sessions.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { resolveSampleSource } from "../../../src/live/sample-source.js";
import { addSessionAudioSampleSources } from "../../../src/app/audio/request-audio-sources.js";
import { listPendingSessionAttachments } from "../../../src/storage/attachments.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { consumedAttachmentIds } from "../../../src/app/agent-request.js";
import { createMcpHttpServer } from "../../../src/app/mcp/server.js";
import { waitForPromiseWithSignal } from "../../../src/runtime/host.js";
import { invalidateGlobalState, invalidateSessionState, subscribeSessionStateInvalidations } from "../../../src/app/session/session-state-events.js";
import { sessionNativeTools } from "../../../src/app/tools/tool-runtime.js";
import { readDeviceParameterArtifact } from "../../../src/storage/device-parameter-artifacts.js";
import { updateAudioJob } from "../../../src/storage/audio-jobs.js";
import { isStorageCommitOutcomeUnknownError } from "../../../src/storage/persistence.js";
import { createSessionAudioJob } from "../../../src/app/audio/audio-job-runtime.js";
import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { generationJobCases } from "../../storage/support/audio-storage-test-helpers.js";
import { connectPluginMcpServer } from "../../../src/plugins/mcp/client.js";

async function setup(t: import("node:test").TestContext) {
  const directory = await mkdtemp("/private/tmp/live-smith-service-");
  const h = deviceParameterFixture();
  Object.assign(h.song, { scaleIntervals: [], cuePoints: [], signatureNumerator: 4, signatureDenominator: 4 });
  Object.defineProperty(h.context, "environment", { value: { storageDirectory: directory, tempDirectory: directory } });
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  await saveGlobalSettings(directory, { mcpServer: { enabled: true, port } });
  const opened: string[] = [];
  const liveMutationQueue = new LiveMutationQueue();
  const service = createMcpService({ context: h.context, storageDirectory: directory, liveMutationQueue, openSession: async id => { opened.push(id); } });
  await service.start(); assert.equal((await service.state()).status, "running");
  const grant = await service.createClient("Composer");
  const client = new Client({ name: "integration", version: "1" }, { versionNegotiation: { mode: "auto" } });
  t.after(async () => { await client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
  async function result(name: string, args: Record<string, unknown>) {
    const first = await client.callTool({ name, arguments: args });
    let content = first.structuredContent as Record<string, unknown>;
    const operationId = String(content.operationId ?? content.id);
    for (let attempt = 0; attempt < 100 && ["running", "awaiting_approval"].includes(String(content.status)); attempt++) {
      await delay(20);
      content = (await client.callTool({ name: "livesmith_get_operation", arguments: { operationId } })).structuredContent as Record<string, unknown>;
    }
    return content;
  }
  return { ...h, directory, service, grant, client, result, opened, liveMutationQueue };
}

test("actual MCP service lists full schemas and creates MIDI without a configured model", async t => {
  const h = await setup(t);
  const tools = (await h.client.listTools()).tools;
  for (const tool of sessionNativeTools(true, true)) {
    assert.deepEqual(tools.find(entry => entry.name === tool.function.name)?.inputSchema, tool.function.parameters, tool.function.name);
  }
  for (const name of ["inspect_live_set", "apply_live_actions", "resolve_live_recovery", "save_midi_artifact", "save_device_parameter_artifact", "read_arrangement_audio", "propose_creative_brief"]) assert(tools.some(tool => tool.name === name), name);
  const context = await h.client.callTool({ name: "livesmith_get_context", arguments: {} });
  assert.equal(((context.structuredContent as Record<string, unknown>).session as { id: string }).id, h.grant.client.sessionId);
  const saved = await h.result("save_midi_artifact", { label: "Bass", durationBeats: 4, tracks: [{ name: "Bass", channel: 1, notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 90 }] }] });
  assert.equal(saved.status, "completed", JSON.stringify(saved));
  const resources = (await h.client.listResources()).resources;
  assert.equal(resources.length, 1);
  assert.equal((await h.client.readResource({ uri: resources[0]!.uri })).contents.length, 1);
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    const self = new URL(h.grant.url); self.hostname = hostname;
    await assert.rejects(connectPluginMcpServer({ id: "self", type: "streamable-http", url: self.href, headers: {} },
      undefined, createHostAbortController().signal, { fetchImpl: async () => assert.fail("Self-connections must stop before network access") }), /own outward service/);
  }
  await h.service.revokeClient(h.grant.client.id, h.grant.client.generation);
  assert.equal((await fetch(h.grant.url, { headers: { Authorization: `Bearer ${h.grant.token}` } })).status, 401);
});

test("manual MCP mutation waits for exact UI approval and rejects state drift", async t => {
  const h = await setup(t);
  const accepted = await h.client.callTool({ name: "apply_live_actions", arguments: { message: "Tempo", actions: [{ type: "set_tempo", tempo: 128 }] } });
  let snapshot = accepted.structuredContent as { id: string; status: string };
  for (let i = 0; i < 100 && snapshot.status === "running"; i++) {
    await delay(20);
    snapshot = (await h.client.callTool({ name: "livesmith_get_operation", arguments: { operationId: snapshot.id } })).structuredContent as typeof snapshot;
  }
  assert.equal(snapshot.status, "awaiting_approval", JSON.stringify(accepted)); assert.equal(h.song.tempo, 120);
  for (let i = 0; i < 100 && !h.opened.length; i++) await delay(20);
  assert.deepEqual(h.opened, [h.grant.client.sessionId]);
  h.song.tempo = 125;
  h.service.resolveApproval(h.grant.client.sessionId, snapshot.id, true);
  for (let i = 0; i < 100 && ["running", "awaiting_approval"].includes((await h.service.operations(h.grant.client.sessionId))[0]?.status ?? ""); i++) await delay(20);
  const result = (await h.client.callTool({ name: "livesmith_get_operation", arguments: { operationId: snapshot.id } })).structuredContent;
  assert.equal((result as Record<string, unknown>)?.status, "failed", JSON.stringify(result)); assert.equal(h.song.tempo, 125);
  await updateSession(h.directory, h.grant.client.sessionId, { approvalMode: "everything" });
  assert.equal((await h.result("apply_live_actions", { message: "Tempo", actions: [{ type: "set_tempo", tempo: 128 }] })).status, "completed");
  assert.equal(h.song.tempo, 128);
});

test("MCP upload, resource download and Session audio locators preserve file isolation", async t => {
  const h = await setup(t), base = h.grant.url.replace(/\/mcp$/u, "");
  const uploadedBytes = waveBytes(80);
  const response = await fetch(`${base}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${h.grant.token}`,
    "Content-Type": "application/octet-stream", "X-Live-Smith-Filename": encodeURIComponent("音乐.wav") }, body: uploadedBytes as BodyInit });
  assert.equal(response.status, 201);
  const uploaded = await response.json() as { attachment: { id: string; kind: string }; resource: string };
  assert.equal(uploaded.attachment.kind, "audio");
  const bytes = await fetch(`${base}/resources?uri=${encodeURIComponent(uploaded.resource)}`, { headers: { Authorization: `Bearer ${h.grant.token}` } });
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), uploadedBytes);
  const descriptor = (await h.client.readResource({ uri: uploaded.resource })).contents[0]!;
  assert("text" in descriptor);
  assert.equal(JSON.parse(descriptor.text).byteLength, uploadedBytes.byteLength);
  await assert.rejects(readMcpResourceBytes(h.directory, h.grant.client, uploaded.resource, createHostAbortController().signal), /inline response limit/);
  const sources = new Map();
  await addSessionAudioSampleSources({ context: h.context, storageDirectory: h.directory, sessionId: h.grant.client.sessionId, signal: createHostAbortController().signal }, sources, [uploaded.attachment.id]);
  const source = resolveSampleSource(h.context, { kind: "session_audio_attachment", attachmentId: uploaded.attachment.id }, {}, sources);
  assert.equal(source.kind, "session_audio_attachment");
  const other = await h.service.createClient("Other");
  assert.equal((await fetch(`${base}/resources?uri=${encodeURIComponent(uploaded.resource)}`, { headers: { Authorization: `Bearer ${other.token}` } })).status, 400);
  const foreignSources = new Map();
  await assert.rejects(addSessionAudioSampleSources({ context: h.context, storageDirectory: h.directory, sessionId: other.client.sessionId, signal: createHostAbortController().signal }, foreignSources, [uploaded.attachment.id]));
  assert.throws(() => resolveSampleSource(h.context, { kind: "session_audio_attachment", attachmentId: uploaded.attachment.id }, {}, foreignSources));
  for (let index = 0; index < 2; index++) {
    const next = await fetch(`${base}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${h.grant.token}`,
      "Content-Type": "application/octet-stream", "X-Live-Smith-Filename": `take-${index}.wav` }, body: waveBytes() as BodyInit });
    assert.equal(next.status, 201, await next.text());
  }
  const events = await loadSessionEvents(h.directory, h.grant.client.sessionId);
  assert.deepEqual(await listPendingSessionAttachments(h.directory, h.grant.client.sessionId, consumedAttachmentIds(events)), []);
});

test("MCP writes share the Live queue and re-read Scope after acquiring it", async t => {
  const h = await setup(t);
  await updateSession(h.directory, h.grant.client.sessionId, { approvalMode: "everything" });
  let release!: () => void;
  const blocking = h.liveMutationQueue.run(createHostAbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
  await delay(0);
  const started = await h.client.callTool({ name: "apply_live_actions", arguments: { message: "Tempo", actions: [{ type: "set_tempo", tempo: 130 }] } });
  assert.equal((started.structuredContent as { status: string }).status, "running");
  assert.equal(h.song.tempo, 120);
  await updateSession(h.directory, h.grant.client.sessionId, { editScopes: [] });
  release(); await blocking;
  for (let i = 0; i < 100 && (await h.service.operations(h.grant.client.sessionId))[0]?.status === "running"; i++) await delay(20);
  assert.equal((await h.service.operations(h.grant.client.sessionId))[0]?.status, "failed");
  assert.equal(h.song.tempo, 120);
});

test("accepted calls survive disconnect; changed Live Set keeps history and rejects new edits", async t => {
  const h = await setup(t);
  const started = await h.client.callTool({ name: "apply_live_actions", arguments: { message: "Tempo", actions: [{ type: "set_tempo", tempo: 131 }] } });
  const id = (started.structuredContent as { id: string }).id;
  await h.client.close();
  for (let i = 0; i < 100 && !h.service.approvals(h.grant.client.sessionId).length; i++) await delay(20);
  assert.equal(h.service.approvals(h.grant.client.sessionId)[0]?.operationId, id);
  h.song.handle.id = 2n;
  h.service.resolveApproval(h.grant.client.sessionId, id, true);
  for (let i = 0; i < 100 && ["running", "awaiting_approval"].includes((await h.service.operations(h.grant.client.sessionId))[0]?.status ?? ""); i++) await delay(20);
  assert.equal((await h.service.operations(h.grant.client.sessionId))[0]?.status, "failed");
  assert.equal(h.song.tempo, 120);
});

test("operation query and cancellation stay available while an upstream MCP tool holds authorization", async t => {
  const h = await setup(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const remote = await createMcpHttpServer({ port: 0, authenticate: async () => h.grant.client,
    tools: async () => [{ type: "function", function: { name: "slow", description: "Slow upstream fixture", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    callTool: async (_client, _name, _args, signal) => { entered(); await waitForPromiseWithSignal(gate, signal); return { content: [{ type: "text", text: "finished" }] }; } });
  try {
    await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
      id: "slow-upstream", name: "Slow upstream", enabled: true, mcp: { type: "streamable-http", url: remote.url },
      secrets: { Authorization: "Bearer fixture" }, artifactInputApproved: false, artifactOutputApproved: false,
    } } });
    invalidateGlobalState(h.directory, { source: Symbol("connection-edit"), target: "all" });
    const listed = (await h.client.listTools()).tools;
    const tool = listed.find(entry => entry.description?.includes("Slow upstream fixture"));
    assert(tool, JSON.stringify(listed.map(entry => ({ name: entry.name, description: entry.description?.slice(0, 160) }))));
    const accepted = await h.client.callTool({ name: tool.name, arguments: {} }); await started;
    const id = (accepted.structuredContent as { id: string }).id;
    const queried = await Promise.race([h.client.callTool({ name: "livesmith_get_operation", arguments: { operationId: id } }), delay(1500).then(() => null)]);
    assert(queried, "Operation query must complete before the upstream tool finishes");
    const cancelled = await Promise.race([h.client.callTool({ name: "livesmith_cancel_operation", arguments: { operationId: id } }), delay(1500).then(() => null)]);
    assert(cancelled, "Cancellation must reach the operation while its upstream tool is still waiting");
    for (let i = 0; i < 100 && (await h.service.operations(h.grant.client.sessionId))[0]?.status === "running"; i++) await delay(20);
    assert.equal((await h.service.operations(h.grant.client.sessionId))[0]?.status, "cancelled");
  } finally { release(); await remote.close(); }
});

test("MCP parameter versions and audio listening reuse Session artifacts without a model", async t => {
  const h = await setup(t);
  await updateSession(h.directory, h.grant.client.sessionId, { editScopes: [] });
  const captured = await h.result("capture_device_parameter_artifact", { label: "Synth", trackName: "Lead", deviceName: "Synth" });
  assert.equal(captured.status, "completed", JSON.stringify(captured));
  const capturedOperation = (await h.service.operations(h.grant.client.sessionId)).find(entry => entry.id === (captured.operationId ?? captured.id))!;
  const original = capturedOperation.result!.artifacts![0]!.id;
  const revised = await h.result("save_device_parameter_artifact", { label: "Warm", revisionOf: original,
    values: [{ parameterIndex: 0, parameterName: "Gain", value: 0.6 }] });
  assert.equal(revised.status, "completed", JSON.stringify(revised));
  const revisedOperation = (await h.service.operations(h.grant.client.sessionId)).find(entry => entry.id === (revised.operationId ?? revised.id))!;
  const saved = await readDeviceParameterArtifact(h.directory, h.grant.client.sessionId, revisedOperation.result!.artifacts![0]!.id);
  assert.deepEqual(saved.source, { kind: "mcp", clientId: h.grant.client.id, clientName: "Composer" });
  assert.equal(saved.parameters[0]!.value, 0.6); assert.deepEqual(h.writes, []);
  const presented = await h.result("present_device_parameter_candidates", { artifactRefs: [saved.id] });
  assert.equal(presented.status, "completed", JSON.stringify(presented));
  const presentation = (await h.service.operations(h.grant.client.sessionId)).find(entry => entry.id === (presented.operationId ?? presented.id))!;
  assert.deepEqual(presentation.result!.artifacts, [{ kind: "device-parameters", id: saved.id }]);
  assert.deepEqual(h.writes, []);

  const job = await createSessionAudioJob(h.directory, h.grant.client.sessionId, generationJobCases[0]!.input);
  const asset = await saveAudioAsset(h.directory, h.grant.client.sessionId, { jobId: job.id, role: "music", label: "Music",
    bytes: waveBytes(), origin: { kind: "generated" }, signal: createHostAbortController().signal });
  await updateAudioJob(h.directory, h.grant.client.sessionId, job.id, { outputAssets: [asset] });
  const listened = await h.result("listen_to_audio_asset", { assetRef: asset.id });
  assert.equal(listened.status, "completed", JSON.stringify(listened));
  const response = await h.client.callTool({ name: "livesmith_get_operation", arguments: { operationId: listened.operationId ?? listened.id } });
  const resource = response.content.find(entry => entry.type === "resource_link");
  assert(resource && resource.type === "resource_link");
  const audio = (await h.client.readResource({ uri: resource.uri })).contents[0]!;
  assert("blob" in audio); assert.equal(audio.mimeType, "audio/wav");
  assert.equal(audio.blob, Buffer.from(waveBytes()).toString("base64"));
});

test("MCP forwards upstream content and rejects cached tools after the source is disabled", async t => {
  const h = await setup(t);
  let calls = 0;
  const content = [{ type: "text" as const, text: "Upstream result" }, { type: "resource_link" as const, name: "Reference", uri: "https://example.test/reference" }];
  const remote = await createMcpHttpServer({ port: 0, authenticate: async () => h.grant.client,
    tools: async () => [{ type: "function", function: { name: "inspect", description: "Upstream content fixture", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    callTool: async () => { calls++; return { content, structuredContent: { voices: 3 } }; } });
  const connection = { id: "upstream", name: "Upstream", enabled: true, mcp: { type: "streamable-http" as const, url: remote.url },
    secrets: { Authorization: "Bearer fixture" }, artifactInputApproved: false, artifactOutputApproved: false };
  try {
    await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection } });
    invalidateGlobalState(h.directory, { source: Symbol("connection-edit"), target: "all" });
    const tool = (await h.client.listTools()).tools.find(entry => entry.description?.includes("Upstream content fixture")); assert(tool);
    const completed = await h.result(tool.name, {}); assert.equal(completed.status, "completed", JSON.stringify(completed));
    const response = await h.client.callTool({ name: "livesmith_get_operation", arguments: { operationId: completed.operationId ?? completed.id } });
    assert.deepEqual(response.content, content);
    assert.deepEqual((response.structuredContent as { result: { structuredContent: unknown } }).result.structuredContent, { voices: 3 });
    await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: "1", connection: { ...connection, enabled: false } } });
    invalidateGlobalState(h.directory, { source: Symbol("connection-edit"), target: "all" });
    assert.equal((await h.client.callTool({ name: tool.name, arguments: {} })).isError, true);
    assert.equal(calls, 1);
  } finally { await remote.close(); }
});

test("MCP catalog ignores ordinary state and operation progress, and scopes availability invalidation", { timeout: 10000 }, async t => {
  const h = await setup(t);
  let discoveries = 0;
  const upstream = await createMcpHttpServer({ port: 0, authenticate: async () => h.grant.client,
    tools: async () => { discoveries++; return [{ type: "function", function: { name: "read", description: "Catalog counter",
      parameters: { type: "object", properties: {}, additionalProperties: false } } }]; },
    callTool: async () => ({ content: [{ type: "text", text: "Read" }] }),
  });
  t.after(() => upstream.close());
  await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
    id: "catalog-counter", name: "Counter", enabled: true, mcp: { type: "streamable-http", url: upstream.url },
    secrets: { Authorization: "Bearer fixture" }, artifactInputApproved: false, artifactOutputApproved: false,
  } } });
  const source = Symbol("catalog-test");
  invalidateGlobalState(h.directory, { source, target: "all" });
  await h.client.listTools();
  const initialDiscoveries = discoveries;
  assert(initialDiscoveries > 0);
  let notifications = 0;
  let onNotification = () => {};
  h.client.setNotificationHandler("notifications/tools/list_changed", () => { notifications++; onNotification(); });
  const subscription = await h.client.listen({ toolsListChanged: true });
  t.after(() => subscription.close());
  await h.client.listTools();
  assert.equal(discoveries, initialDiscoveries);
  invalidateGlobalState(h.directory, { source });
  invalidateSessionState(h.directory, { source, sessionId: h.grant.client.sessionId });
  invalidateSessionState(h.directory, { source, sessionId: "unrelated-session", target: "tools" });
  await updateSession(h.directory, h.grant.client.sessionId, { title: "Renamed", editScopes: [], approvalMode: "everything" });
  invalidateSessionState(h.directory, { source, sessionId: h.grant.client.sessionId });
  await h.client.listTools();
  assert.equal(discoveries, initialDiscoveries, "ordinary state must keep the catalog");

  const observed = await h.result("inspect_live_set", {});
  assert.equal(observed.status, "completed");
  const afterExecution = discoveries;
  assert(afterExecution > initialDiscoveries, "each call still rebuilds and authorizes its execution runtime");
  await h.client.listTools();
  assert.equal(discoveries, afterExecution, "operation progress and receipts must keep the catalog");

  const secondGrant = await h.service.createClient("Second Session");
  const second = new Client({ name: "second", version: "1" }, { versionNegotiation: { mode: "auto" } });
  t.after(() => second.close());
  await second.connect(new StreamableHTTPClientTransport(new URL(secondGrant.url), {
    requestInit: { headers: { Authorization: `Bearer ${secondGrant.token}` } },
  }));
  await second.listTools();
  const bothCached = discoveries;
  const sessionNotice = new Promise<void>(resolve => { onNotification = resolve; });
  invalidateSessionState(h.directory, { source, sessionId: h.grant.client.sessionId, target: "all" });
  await sessionNotice;
  assert.equal(notifications, 1, "only the availability change sends a protocol notification");
  await second.listTools();
  assert.equal(discoveries, bothCached, "another Session must retain its catalog");
  await h.client.listTools();
  assert(discoveries > bothCached, "the affected Session must rediscover");
  const afterSessionChange = discoveries;
  const globalNotice = new Promise<void>(resolve => { onNotification = resolve; });
  invalidateGlobalState(h.directory, { source, target: "all" });
  await globalNotice;
  assert.equal(notifications, 2);
  await second.listTools();
  await h.client.listTools();
  assert.equal(discoveries, afterSessionChange + 2, "global availability changes affect both Sessions");
  const beforeRotation = discoveries;
  await h.service.rotateClient(secondGrant.client.id, secondGrant.client.generation);
  await h.client.listTools();
  assert.equal(discoveries, beforeRotation, "another client's credential rotation must retain this catalog");
  assert.equal(notifications, 2);
});

test("MCP invalidation during discovery cannot repopulate the cache with obsolete tools", { timeout: 10000 }, async t => {
  const h = await setup(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let generation = 0;
  let discoveries = 0;
  const upstream = await createMcpHttpServer({ port: 0, authenticate: async () => h.grant.client,
    tools: async () => {
      discoveries++;
      const version = generation;
      if (version === 0) { enter(); await gate; }
      return [{ type: "function", function: { name: `read_${version}`, description: `Generation ${version}`,
        parameters: { type: "object", properties: {}, additionalProperties: false } } }];
    }, callTool: async () => ({ content: [] }),
  });
  t.after(() => { release(); return upstream.close(); });
  await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
    id: "changing-catalog", name: "Changing catalog", enabled: true, mcp: { type: "streamable-http", url: upstream.url },
    secrets: { Authorization: "Bearer fixture" }, artifactInputApproved: false, artifactOutputApproved: false,
  } } });
  const pending = h.client.listTools();
  await entered;
  generation = 1;
  invalidateGlobalState(h.directory, { source: Symbol("configuration"), target: "all" });
  release();
  assert((await pending).tools.some(tool => tool.description?.includes("Generation 0")));
  assert((await h.client.listTools()).tools.some(tool => tool.description?.includes("Generation 1")));
  await h.client.listTools();
  assert.equal(discoveries, 2);
});

test("first saved audio job adds recovery tools; subsequent jobs and updates keep the catalog", async t => {
  const h = await setup(t);
  assert(!(await h.client.listTools()).tools.some(tool => tool.name === "list_audio_jobs"));
  const notices: string[] = [];
  t.after(subscribeSessionStateInvalidations(h.directory, change => { notices.push(change.target ?? "state"); }));
  const first = await createSessionAudioJob(h.directory, h.grant.client.sessionId, generationJobCases[0]!.input);
  assert.deepEqual(notices, ["tools"]);
  assert((await h.client.listTools()).tools.some(tool => tool.name === "list_audio_jobs"));
  await createSessionAudioJob(h.directory, h.grant.client.sessionId, generationJobCases[0]!.input);
  await updateAudioJob(h.directory, h.grant.client.sessionId, first.id, { status: "running" });
  assert.deepEqual(notices, ["tools"]);
});

test("an uncertain first audio-job commit still invalidates the cached recovery tools", async t => {
  const h = await setup(t);
  assert(!(await h.client.listTools()).tools.some(tool => tool.name === "list_audio_jobs"));
  let failed = false;
  interceptStoredWrites(t, { afterCommit: writes => {
    if (!failed && writes.some(write => write.key.endsWith(".job.json"))) {
      failed = true;
      throw new Error("Injected audio job commit acknowledgement failure");
    }
  } });
  await assert.rejects(createSessionAudioJob(h.directory, h.grant.client.sessionId, generationJobCases[0]!.input), isStorageCommitOutcomeUnknownError);
  assert(failed);
  assert((await h.client.listTools()).tools.some(tool => tool.name === "list_audio_jobs"));
});

test("cached catalogs still require an active bound Session", async t => {
  const h = await setup(t);
  const initial = await h.client.listTools();
  await setSessionArchived(h.directory, h.grant.client.sessionId, true);
  await assert.rejects(h.client.listTools());
  await setSessionArchived(h.directory, h.grant.client.sessionId, false);
  assert.deepEqual(await h.client.listTools(), initial);
  await deleteSession(h.directory, h.grant.client.sessionId);
  await assert.rejects(h.client.listTools());
});


test("MCP partial uploads release the Session fence and revalidate ownership before publication", async t => {
  const h = await setup(t);
  const url = new URL(h.grant.url);
  const bytes = waveBytes(); const partialLength = Math.floor(bytes.byteLength/2);
  const socket = connect(Number(url.port),url.hostname);
  const chunks: Buffer[] = [];
  socket.on("data",chunk => chunks.push(chunk));
  const closed = new Promise<void>((resolve,reject) => {socket.once("end",resolve);socket.once("error",reject);});
  try {
    await new Promise<void>((resolve,reject) => {socket.once("connect",resolve);socket.once("error",reject);});
    socket.write(["POST /attachments HTTP/1.1",`Host: ${url.host}`,`Authorization: Bearer ${h.grant.token}`,
      "Content-Type: application/octet-stream","X-Live-Smith-Filename: partial.wav",`Content-Length: ${bytes.byteLength}`,
      "Connection: close","",""].join("\r\n"));
    socket.write(bytes.subarray(0,partialLength));
    const mediaDirectory = join(h.directory,"live-smith-media");
    let observed = false;
    for(let attempt=0;attempt<200;attempt++) {
      const names = await readdir(mediaDirectory).catch(() => [] as string[]);
      for(const name of names.filter(name => name.startsWith(".staging-"))) {
        if ((await stat(join(mediaDirectory,name))).size === partialLength) observed = true;
      }
      if(observed) break;
      await delay(10);
    }
    assert.ok(observed,"The partial body must reach staging before Session deletion.");
    const controller = createHostAbortController();
    const deletion = attachmentMutationFence.run(sessionMutationFenceKey(h.directory,h.grant.client.sessionId),controller.signal,
      () => deleteSession(h.directory,h.grant.client.sessionId));
    const timer = setTimeout(() => controller.abort(),2000);
    try { await deletion; } finally { clearTimeout(timer); }
    socket.write(bytes.subarray(partialLength));
    await closed;
    assert.match(Buffer.concat(chunks).toString("utf8").split("\r\n",1)[0]!,/^HTTP\/1\.1 400 /);
    assert.deepEqual((await readdir(mediaDirectory)).filter(name => name.startsWith(".staging-")),[]);
    assert.deepEqual(await listPendingSessionAttachments(h.directory,h.grant.client.sessionId,[]),[]);
  } finally {socket.destroy();}
});
