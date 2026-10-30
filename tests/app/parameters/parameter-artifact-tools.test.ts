import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { createParameterArtifactToolset } from "../../../src/app/parameters/parameter-artifact-tools.js";
import { createSessionArtifactToolset } from "../../../src/app/session/session-artifact-tools.js";
import { artifactGenerationsFromEvents, listSessionArtifacts, readSessionArtifact, selectSessionArtifact } from "../../../src/app/session/session-artifacts.js";
import { readDeviceParameterArtifact, listDeviceParameterArtifacts, saveDeviceParameterArtifact } from "../../../src/storage/device-parameter-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { isSessionArtifactDetail, isSessionArtifacts } from "../../../src/ui/client/wire-contracts/artifacts.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { createChatBridge } from "../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { URL } from "node:url";

async function setup(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-parameter-tools-"); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Read only", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Set" }, editScopes: [] });
  const h = deviceParameterFixture(90);
  const input = { context: h.context, storageDirectory: directory, sessionId: session.id, projectKey: "set", signal: createHostAbortController().signal,
    assertLiveSetCurrent() {}, target: {}, actor: { kind: "model" as const, profileId: "profile", model: "model" } };
  const tools = createParameterArtifactToolset(input);
  const call = (name: string, args: unknown) => tools.callTool({ id: "call", name, arguments: JSON.stringify(args) });
  return { ...h, input, tools, call };
}

test("read-only chat captures, pages and revises complete parameter snapshots without Live writes", async (t) => {
  const h = await setup(t);
  const captured = await h.call("capture_device_parameter_artifact", { label: "Synth", trackName: "Lead", deviceName: "Synth", devicePath: { deviceIndex: 0 } });
  assert.equal(captured.failed, undefined); const id = captured.artifacts![0]!.id;
  const first = JSON.parse((await h.call("inspect_device_parameter_artifact", { artifactRef: id })).content);
  assert.equal(first.parameters.length, 64); assert.equal(first.nextOffset, 64);
  const next = JSON.parse((await h.call("inspect_device_parameter_artifact", { artifactRef: id, offset: 64 })).content);
  assert.equal(next.parameters.length, 26); assert.equal(next.nextOffset, undefined); assert.equal(first.parameters[0].handleId, undefined);
  const revised = await createParameterArtifactToolset({ ...h.input, revisionOf: id }).callTool({ id: "revise", name: "save_device_parameter_artifact",
    arguments: JSON.stringify({ label: "Warm", values: [{ parameterIndex: 1, parameterName: "Gain", value: 0.6 }] }) });
  assert.equal(revised.failed, undefined);
  const version = await readDeviceParameterArtifact(h.input.storageDirectory, h.input.sessionId, revised.artifacts![0]!.id);
  assert.equal(version.version.derivedFromId, id); assert.equal(version.version.number, 2);
  assert.equal(version.parameters.length, 90); assert.equal(version.parameters[0]!.value, 0.25); assert.equal(version.parameters[1]!.value, 0.6);
  assert.deepEqual(version.source, { kind: "model", profileId: "profile", model: "model" }); assert.deepEqual(h.writes, []);
  const catalog = await listSessionArtifacts(h.input); assert.equal(catalog.total, 1); assert.ok(isSessionArtifacts(catalog));
  const detail = await readSessionArtifact({ ...h.input, artifact: { kind: "device-parameters", id } });
  assert.ok(isSessionArtifactDetail(detail)); assert.equal(detail.artifact.deviceParameters!.parameters!.length, 90);
  const listing = await createSessionArtifactToolset(h.input).callTool({ id: "list", name: "list_session_artifacts", arguments: "{}" });
  assert.equal(JSON.parse(listing.content).length, 2);
  await selectSessionArtifact({ ...h.input, selection: { action: "primary", group: { kind: "device-parameters", id }, candidate: { kind: "device-parameters", id } } });
  assert.equal((await listSessionArtifacts(h.input)).artifacts[0]!.ref.id, id);
  const search = await listSessionArtifacts({ ...h.input, query: "AI-proposed" });
  assert.equal(search.artifacts[0]!.ref.id, version.id);
});

test("parameter authoring rejects wrong names, duplicate indexes, out-of-range values and foreign sources", async (t) => {
  const h = await setup(t);
  const result = await h.call("capture_device_parameter_artifact", { label: "Original", deviceName: "Synth", trackName: "Lead" });
  const source = result.artifacts![0]!.id;
  for (const values of [[{ parameterIndex: 0, parameterName: "Guessed", value: 0.5 }],
    [{ parameterIndex: 0, parameterName: "Gain", value: 9 }],
    [{ parameterIndex: 0, parameterName: "Gain", value: 0.5 }, { parameterIndex: 0, parameterName: "Gain", value: 0.6 }]]) {
    assert.equal((await h.call("save_device_parameter_artifact", { label: "Invalid", revisionOf: source, values })).invalidArguments, true);
  }
  const foreign = await h.call("save_device_parameter_artifact", { label: "Foreign", revisionOf: "foreign", values: [{ parameterIndex: 0, parameterName: "Gain", value: 0.5 }] });
  assert.equal(foreign.failed, true); assert.equal(foreign.content.includes(h.input.storageDirectory), false);
  assert.equal((await listDeviceParameterArtifacts(h.input.storageDirectory, h.input.sessionId)).length, 1); assert.deepEqual(h.writes, []);
});

test("presenting sound choices returns only the chosen saved versions in order without writes", async (t) => {
  const h = await setup(t);
  const captured = await h.call("capture_device_parameter_artifact", { label: "Original", deviceName: "Synth", trackName: "Lead" });
  const original = captured.artifacts![0]!.id;
  const saved = await h.call("save_device_parameter_artifact", { label: "Warm", revisionOf: original,
    values: [{ parameterIndex: 1, parameterName: "Gain", value: 0.6 }] });
  const candidate = saved.artifacts![0]!.id;
  const before = await listDeviceParameterArtifacts(h.input.storageDirectory, h.input.sessionId);
  for (const artifactRefs of [[candidate], [candidate, original]]) {
    const result = await h.call("present_device_parameter_candidates", { artifactRefs });
    assert.equal(result.failed, undefined, result.content);
    assert.deepEqual(result.artifacts, artifactRefs.map(id => ({ kind: "device-parameters", id })));
    assert.deepEqual(JSON.parse(result.content).candidates.map((entry: { artifactRef: string }) => entry.artifactRef), artifactRefs);
    assert.equal(artifactGenerationsFromEvents([
      { id: "present-call", kind: "tool_call", name: "present_device_parameter_candidates", content: JSON.stringify({ artifactRefs }), createdAt: "2026-10-23T00:00:00Z" },
      { id: "present-result", kind: "tool_result", name: "present_device_parameter_candidates", content: result.content, artifacts: result.artifacts!, createdAt: "2026-10-23T00:00:01Z" },
    ]).size, 0, "Presentation must preserve each saved version's generation provenance");
  }
  assert.deepEqual(await listDeviceParameterArtifacts(h.input.storageDirectory, h.input.sessionId), before);
  assert.deepEqual(h.writes, []);
});

test("sound presentation validates exact Session references and a shared device layout", async (t) => {
  const h = await setup(t);
  const captured = await h.call("capture_device_parameter_artifact", { label: "Original", deviceName: "Synth", trackName: "Lead" });
  const id = captured.artifacts![0]!.id;
  const original = await readDeviceParameterArtifact(h.input.storageDirectory, h.input.sessionId, id);
  const foreignSession = await createSession(h.input.storageDirectory, { title: "Other", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Set" } });
  const foreign = await saveDeviceParameterArtifact(h.input.storageDirectory, foreignSession.id, { ...original, signal: h.input.signal });
  const otherDevice = await saveDeviceParameterArtifact(h.input.storageDirectory, h.input.sessionId,
    { ...original, signal: h.input.signal, target: { ...original.target, deviceId: "other-device" } });
  const otherLayout = await saveDeviceParameterArtifact(h.input.storageDirectory, h.input.sessionId,
    { ...original, signal: h.input.signal, parameters: original.parameters.map((entry, index) => index === 0 ? { ...entry, name: "Changed" } : entry) });
  for (const args of [{ artifactRefs: [] }, { artifactRefs: [id, id] }, { artifactRefs: ["../escape"] },
    { artifactRefs: [foreign.id] }, { artifactRefs: [id, otherDevice.id] }, { artifactRefs: [id, otherLayout.id] },
    { artifactRefs: [id], values: [] }, { artifactRefs: Array.from({ length: 25 }, (_, index) => `ref_${index}`) }]) {
    const result = await h.call("present_device_parameter_candidates", args);
    assert.equal(result.failed, true, JSON.stringify(args)); assert.equal(result.invalidArguments, true);
    assert.equal(result.artifacts, undefined); assert.equal(result.content.includes(h.input.storageDirectory), false);
  }
  assert.deepEqual(h.writes, []);
});

test("parameter commands use exact references and cannot use binary artifact operations", () => {
  const target = { runtimeId: "runtime", songId: "1", trackId: "2", deviceId: "3" };
  for (const command of [
    { kind: "capture_device_parameters", sessionId: "session", target, label: "Original" },
    { kind: "apply_device_parameters", sessionId: "session", artifactId: "parameters_1" },
    { kind: "apply_device_parameters", sessionId: "session", artifactId: "parameters_1", presentationId: "event_1", target },
    { kind: "restore_device_parameters", sessionId: "session", applicationId: "application" },
    { kind: "restore_device_parameters", sessionId: "session", applicationId: "application", presentationId: "event_1" },
    { kind: "keep_device_parameters", sessionId: "session", applicationId: "application" },
  ]) {
    assert.deepEqual(parseCommandInput(command), command);
    assert.throws(() => parseCommandInput({ ...command, profile: {} }));
  }
  for (const kind of ["attach_artifact", "export_artifact"]) assert.throws(() => parseCommandInput({ kind, sessionId: "session", artifact: { kind: "device-parameters", id: "parameters_1" } }));
  assert.throws(() => parseCommandInput({ kind: "apply_device_parameters", sessionId: "session", artifactId: "../other" }));
  assert.throws(() => parseCommandInput({ kind: "apply_device_parameters", sessionId: "session", artifactId: "parameters_1", presentationId: "../other" }));
  assert.throws(() => parseCommandInput({ kind: "restore_device_parameters", sessionId: "session", applicationId: "application", approved: true }));
});

test("parameter read endpoint authenticates input and keeps reads outside command execution", async () => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({ buildState: async () => ({} as ChatDialogState), renderHtml: () => "", handleSend: async () => {},
    handleCommand: async () => assert.fail("Reads must not execute commands"),
    readDeviceParameters: async (input, signal) => { assert.equal(signal.aborted, false); calls.push(input); return { sessionId: input.sessionId, devices: [] }; },
  });
  const url = new URL(bridge.url); url.pathname = "/device-parameters";
  const post = (value: unknown, address = url) => fetch(address, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  try {
    const denied = new URL(url); denied.search = "";
    assert.equal((await post({ sessionId: "session" }, denied)).status, 403);
    for (const invalid of [{ sessionId: "../other" }, { sessionId: "session", profile: {} }, { sessionId: "session", target: { deviceId: "1" } }, { sessionId: "session", baseArtifactId: "base" }]) {
      assert.equal((await post(invalid)).status, 400);
    }
    const result = await post({ sessionId: "session", artifactId: "parameters_1" });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { sessionId: "session", devices: [] });
    assert.deepEqual(calls, [{ sessionId: "session", artifactId: "parameters_1" }]);
  } finally { await bridge.close(); }
});
