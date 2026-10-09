import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { handleAgentRequest, type AgentModelTurnRequester } from "../../../src/app/agent-request.js";
import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import { selectSessionArtifact, listSessionArtifacts } from "../../../src/app/session/session-artifacts.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { createSession } from "../../../src/storage/sessions.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { readDeviceParameterArtifact, listDeviceParameterArtifacts } from "../../../src/storage/device-parameter-artifacts.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { modelMessageText } from "../../model/support/model-message-test-helpers.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

test("ordinary chat captures and authors device parameter versions with durable exact source lineage", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-parameter-request-"); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Parameters", projectKey: "set", editScopes: [], scope: { kind: "selection", identity: "set", label: "Set" } });
  const h = deviceParameterFixture(); const signal = createHostAbortController().signal;
  const runtimeProfile = runtimeProfileForSavedProfile({ id: "profile", name: "Profile", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "chat-completions", baseUrl: "https://example.test/v1", apiKey: "fixture-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } }, advanced: {} }],
  });
  const run = (request: AgentModelTurnRequester) => handleAgentRequest(h.context, directory,
    { target: { track: h.track, object: h.device }, summary: "Synth", scope: session.scope, presentation: liveContextPresentationFixture("Synth", "other") },
    "Save a softer version of this device for comparison.", runtimeProfile, "set", session.id,
    { signal, onDelta() {}, onProgress() {}, onSessionEvent() {},
      confirmActions: async () => assert.fail("Saving parameter candidates never requests Live approval"),
      withActionExecutionLock: async () => assert.fail("Saving parameter candidates never enters Live mutation"),
    }, request);
  const call = (name: string, args: unknown) => ({ content: "", toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args) }] });
  let turn = 0, capturedId = "", candidateId = "";
  await run(async (request) => {
    if (++turn === 1) {
      const names = request.tools.filter((tool) => tool.type === "function").map((tool) => tool.function.name);
      for (const name of ["capture_device_parameter_artifact", "inspect_device_parameter_artifact", "save_device_parameter_artifact"]) assert.ok(names.includes(name));
      return call("capture_device_parameter_artifact", { label: "Original", deviceName: "Synth" });
    }
    const result = JSON.parse(modelMessageText(request.agentMessages.at(-1)));
    if (turn === 2) { capturedId = result.artifacts[0].artifactRef; return call("inspect_device_parameter_artifact", { artifactRef: capturedId }); }
    if (turn === 3) {
      assert.equal(result.parameters.length, 3);
      return call("save_device_parameter_artifact", { label: "Soft", revisionOf: capturedId, values: [{ parameterIndex: 1, parameterName: "Gain", value: 0.6 }] });
    }
    candidateId = result.artifacts[0].artifactRef;
    return { content: "Saved for comparison.", toolCalls: [] };
  });
  const first = await readDeviceParameterArtifact(directory, session.id, candidateId);
  assert.equal(first.version.derivedFromId, capturedId); assert.equal(first.parameters[1]!.value, 0.6);
  const input = { storageDirectory: directory, sessionId: session.id, projectKey: "set", signal };
  await selectSessionArtifact({ ...input, selection: { action: "continue", candidate: { kind: "device-parameters", id: capturedId } } });
  let revisionTurn = 0;
  await run(async () => ++revisionTurn === 1
    ? call("save_device_parameter_artifact", { label: "Another", values: [{ parameterIndex: 0, parameterName: "Gain", value: 0.5 }] })
    : { content: "Saved another version.", toolCalls: [] });
  const artifacts = await listDeviceParameterArtifacts(directory, session.id);
  const last = artifacts.find((artifact) => artifact.version.number === 3)!;
  assert.equal(last.version.derivedFromId, capturedId); assert.equal(last.parameters[1]!.value, 0.25);
  const events = await loadSessionEvents(directory, session.id);
  assert.deepEqual(events.findLast((event) => event.kind === "user")!.parentCandidate, { kind: "device-parameters", id: capturedId });
  assert.deepEqual(events.findLast((event) => event.kind === "tool_result")!.artifacts, [{ kind: "device-parameters", id: last.id }]);
  const catalog = await listSessionArtifacts(input);
  assert.equal(catalog.artifacts[0]!.generation!.toolName, "save_device_parameter_artifact"); assert.equal(catalog.artifacts[0]!.version!.number, 3);
  assert.deepEqual(h.writes, []);
});
