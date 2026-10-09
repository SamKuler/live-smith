import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { runParameterApplication } from "../../../src/app/parameters/parameter-application.js";
import { captureParameterArtifact, readParameterArtifactPreview } from "../../../src/app/parameters/parameter-artifacts.js";
import { listDeviceParameterApplications, saveDeviceParameterArtifact, saveDeviceParameterApplication, saveDeviceParameterProgress } from "../../../src/storage/device-parameter-artifacts.js";
import { captureParameterDevice } from "../../../src/live/device-parameters.js";
import { createSession, updateSession } from "../../../src/storage/sessions.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { createLiveSetGuard } from "../../../src/live/set-identity.js";
import { LiveMutationQueue } from "../../../src/app/live-mutation-queue.js";
import { decidePlanApproval } from "../../../src/app/agent-flow.js";
import { publishSessionEditScopesChange } from "../../../src/app/session/session-edit-scope-events.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

async function setup(t: TestContext, count = 3) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-parameter-apply-"); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Parameters", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Set" }, editScopes: ["devices"], approvalMode: "manual" });
  const live = deviceParameterFixture(count); const controller = createHostAbortController();
  const input = { context: live.context, storageDirectory: directory, sessionId: session.id, projectKey: "set", signal: controller.signal, assertLiveSetCurrent: createLiveSetGuard(live.context) };
  const capture = await captureParameterArtifact({ ...input, kind: "capture_device_parameters", target: live.target, label: "Original" });
  const candidate = await saveDeviceParameterArtifact(directory, session.id, { target: capture.target,
    parameters: capture.parameters.map((entry) => ({ ...entry, value: 0.75 })), label: "Variation", source: { kind: "model", profileId: "profile", model: "model" }, revisionOf: capture.id, signal: controller.signal });
  const mutationQueue = new LiveMutationQueue();
  const dependencies = { ...input, mutationQueue,
    interaction: { presentation: liveContextPresentationFixture("Set", "other"), summary: "Set", scope: session.scope, target: {} },
    confirm: (plan: Parameters<typeof decidePlanApproval>[2]) => decidePlanApproval(directory, session.id, plan, async () => true),
  };
  const apply = () => runParameterApplication({ ...dependencies, kind: "apply_device_parameters", artifactId: candidate.id });
  const receipt = async () => (await listDeviceParameterApplications(directory, session.id)).at(-1)!;
  const restore = async () => runParameterApplication({ ...dependencies, kind: "restore_device_parameters", applicationId: (await receipt()).id });
  return { ...live, directory, session, input, capture, candidate, dependencies, apply, restore, receipt, controller };
}

test("capture and preview are read-only; one approved bulk apply and guarded restore persist actual results", async (t) => {
  const h = await setup(t, 70);
  const preview = await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id, baseArtifactId: h.capture.id });
  assert.equal(preview.artifact!.parameters.length, 70); assert.equal(preview.current!.parameters.length, 70);
  assert.equal(preview.comparison!.id, h.capture.id); assert.deepEqual(h.writes, []);
  assert.equal(await h.apply(), "applied");
  const saved = await h.receipt(); assert.equal(saved.status, "applied"); assert.equal(saved.entries.length, 70);
  assert.ok(saved.entries.every((entry) => entry.state === "applied" && entry.after === 0.75 && entry.parameter.value === 0.25));
  assert.equal(await h.restore(), "restored"); assert.ok(h.parameters.every((entry) => entry.state.value === 0.25));
  assert.equal((await h.receipt()).status, "restored");
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.filter((event) => event.kind === "apply_requested").length, 2);
  assert.equal(events.at(-1)!.applyOperation!.status, "applied");
});

test("current Live comparison uses the complete saved version even when its parent file is missing", async (t) => {
  const h = await setup(t);
  await fs.unlink(`${h.directory}/live-smith-device-parameters/${h.session.id}/${h.capture.id}.json`);
  const preview = await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id });
  assert.equal(preview.artifact!.id, h.candidate.id);
  assert.equal(preview.current!.parameters.length, h.candidate.parameters.length);
  assert.equal(preview.comparison, undefined);
  await assert.rejects(readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id, baseArtifactId: h.capture.id }), /unavailable/);
  assert.deepEqual(h.writes, []);
});

test("saving stays available in read-only scope but applying never reaches approval", async (t) => {
  const h = await setup(t); await updateSession(h.directory, h.session.id, { editScopes: [] });
  let approvals = 0;
  h.dependencies.confirm = async (plan) => { approvals++; return decidePlanApproval(h.directory, h.session.id, plan, async () => true); };
  await assert.rejects(h.apply(), /scope/); assert.equal(approvals, 0); assert.deepEqual(h.writes, []);
});

for (const restoring of [false, true]) test(`full preparation baseline rejects an unwritten parameter change before approval; restore=${restoring}`, async (t) => {
  const h = await setup(t);
  const candidate = await saveDeviceParameterArtifact(h.directory, h.session.id, {
    target: h.capture.target, parameters: h.capture.parameters.map((parameter) => parameter.index === 0 ? { ...parameter, value: 0.75 } : parameter),
    label: "One changed parameter", source: { kind: "captured" }, revisionOf: h.capture.id, signal: h.controller.signal,
  });
  const apply = () => runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: candidate.id });
  if (restoring) { await apply(); h.parameters[1]!.state.value = 0.6; }
  const initialWrites = h.writes.length;
  let reads = 0, approvals = 0;
  const original = h.parameters[0]!.parameter.getValue;
  h.parameters[0]!.parameter.getValue = async () => {
    if (++reads === 2) h.parameters[1]!.state.value = 0.5;
    return original();
  };
  h.dependencies.confirm = async (plan) => { approvals++; return decidePlanApproval(h.directory, h.session.id, plan, async () => true); };
  await assert.rejects(restoring ? h.restore() : apply(), /changed while preparing/);
  assert.equal(approvals, 0);
  assert.equal(h.writes.length, initialWrites);
  assert.equal(h.parameters[1]!.state.value, 0.5);
  assert.equal((await h.receipt())?.status, restoring ? "applied" : undefined);
  assert.equal((await loadSessionEvents(h.directory, h.session.id)).at(-1)!.applyOperation!.status, "failed");
});

test("state or permissions changed during confirmation reject the whole application", async (t) => {
  for (const change of ["value", "scope", "device"] as const) {
    const h = await setup(t);
    h.dependencies.confirm = async (plan) => {
      if (change === "value") h.parameters[1]!.state.value = 0.5;
      if (change === "scope") await updateSession(h.directory, h.session.id, { editScopes: [] });
      if (change === "device") Object.defineProperty(h.device, "handle", { value: { id: 999n }, configurable: true });
      return decidePlanApproval(h.directory, h.session.id, plan, async () => true);
    };
    await assert.rejects(h.apply()); assert.deepEqual(h.writes, []); assert.equal(await h.receipt(), undefined);
  }
});

test("partial SDK failure retains acknowledged writes and marks the uncertain write in-flight", async (t) => {
  const h = await setup(t);
  h.parameters[1]!.parameter.setValue = async (value) => { h.parameters[1]!.state.value = value; throw new Error("SDK acknowledgement lost"); };
  await assert.rejects(h.apply(), /did not finish reliably/);
  const application = await h.receipt();
  assert.equal(application.status, "partial"); assert.deepEqual(application.entries.map((entry) => entry.state), ["applied", "applying", "pending"]);
  await assert.rejects(h.restore(), /unknown outcome/);
  assert.equal(h.parameters[0]!.state.value, 0.75);
  assert.equal(await runParameterApplication({ ...h.dependencies, kind: "keep_device_parameters", applicationId: application.id }), "kept");
});

test("restore refuses manual edits and does not overwrite even an earlier unchanged parameter", async (t) => {
  const h = await setup(t); await h.apply(); const writes = h.writes.length;
  h.parameters[1]!.state.value = 0.6;
  await assert.rejects(h.restore(), /changed after application/);
  assert.equal(h.writes.length, writes); assert.equal(h.parameters[0]!.state.value, 0.75); assert.equal(h.parameters[1]!.state.value, 0.6);
});

test("latest scope is enforced between parameters and acknowledged values survive Stop", async (t) => {
  for (const mode of ["scope", "stop"] as const) {
    const h = await setup(t); const original = h.parameters[0]!.parameter.setValue;
    h.parameters[0]!.parameter.setValue = async (value) => {
      await original(value);
      if (mode === "stop") h.controller.abort();
      else publishSessionEditScopesChange(h.directory, { sessionId: h.session.id, editScopes: [], updatedAt: new Date().toISOString() });
    };
    await assert.rejects(h.apply(), /did not finish reliably/);
    assert.deepEqual(h.writes, [[0, 0.75]]);
    assert.deepEqual((await h.receipt()).entries.map((entry) => entry.state), ["applied", "pending", "pending"]);
  }
});

test("another runtime requires explicit rebinding and a matching layout", async (t) => {
  const h = await setup(t); const next = deviceParameterFixture();
  const dependencies = { ...h.dependencies, context: next.context, assertLiveSetCurrent: createLiveSetGuard(next.context) };
  await assert.rejects(runParameterApplication({ ...dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id }), /another Live runtime/);
  assert.equal(await runParameterApplication({ ...dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id,
    target: { runtimeId: next.target.runtimeId, songId: next.target.songId, trackId: next.target.trackId, deviceId: next.target.deviceId } }), "applied");
  assert.equal(next.writes.length, 3); assert.equal(h.writes.length, 0);
});

test("one unresolved receipt blocks another apply; a cancelled approval creates no receipt", async (t) => {
  const h = await setup(t);
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => false);
  assert.equal(await h.apply(), "cancelled"); assert.equal(await h.receipt(), undefined); assert.deepEqual(h.writes, []);
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => true);
  await h.apply(); await assert.rejects(h.apply(), /previous parameter application/);
});

test("parameter side effects on initially matching values are recorded as conflicts", async (t) => {
  const h = await setup(t);
  const candidate = await saveDeviceParameterArtifact(h.directory, h.session.id, { target: h.capture.target, source: { kind: "model", profileId: "p", model: "m" },
    label: "One change", revisionOf: h.capture.id, signal: h.controller.signal, parameters: h.capture.parameters.map((parameter) => parameter.index === 0 ? { ...parameter, value: 0.75 } : parameter) });
  const original = h.parameters[0]!.parameter.setValue;
  h.parameters[0]!.parameter.setValue = async (value) => { await original(value); h.parameters[1]!.state.value = 0.6; };
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: candidate.id }), /did not finish reliably/);
  const receipt = await h.receipt();
  assert.equal(receipt.status, "partial"); assert.equal(receipt.entries.length, 3);
  assert.equal(receipt.entries[1]!.state, "conflict"); assert.equal(receipt.entries[1]!.parameter.value, 0.25); assert.equal(receipt.entries[1]!.after, 0.6);
  await assert.rejects(h.restore(), /outside confirmed writes/);
  assert.deepEqual(h.writes, [[0, 0.75]]);
});

test("restore side effects preserve the complete pre-restore state and never claim complete restoration", async (t) => {
  const h = await setup(t);
  const candidate = await saveDeviceParameterArtifact(h.directory, h.session.id, { target: h.capture.target, source: { kind: "model", profileId: "p", model: "m" },
    label: "One change", revisionOf: h.capture.id, signal: h.controller.signal, parameters: h.capture.parameters.map((parameter) => parameter.index === 0 ? { ...parameter, value: 0.75 } : parameter) });
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: candidate.id });
  h.parameters[1]!.state.value = 0.61;
  const original = h.parameters[0]!.parameter.setValue;
  h.parameters[0]!.parameter.setValue = async (value) => { await original(value); h.parameters[1]!.state.value = 0.5; };
  await assert.rejects(h.restore(), /did not finish reliably/);
  const receipt = await h.receipt();
  assert.equal(receipt.status, "partial"); assert.equal(receipt.entries[1]!.state, "conflict");
  assert.equal(receipt.restorationBaseline![1]!.value, 0.61);
  assert.equal(receipt.entries[1]!.after, 0.5);
});

test("interrupted restoration checks its saved baseline before retrying an empty remainder", async (t) => {
  const h = await setup(t);
  const candidate = await saveDeviceParameterArtifact(h.directory, h.session.id, { target: h.capture.target, source: { kind: "model", profileId: "p", model: "m" },
    label: "One change", revisionOf: h.capture.id, signal: h.controller.signal, parameters: h.capture.parameters.map((parameter) => parameter.index === 0 ? { ...parameter, value: 0.75 } : parameter) });
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: candidate.id });
  h.parameters[1]!.state.value = 0.61;
  const receipt = await h.receipt();
  receipt.restorationBaseline = (await captureParameterDevice(h.context, h.target)).parameters;
  receipt.status = "restoring"; await saveDeviceParameterApplication(h.directory, receipt);
  h.parameters[0]!.state.value = 0.25; h.parameters[1]!.state.value = 0.5;
  await saveDeviceParameterProgress(h.directory, h.session.id, receipt.id, { index: 0, state: "restored", after: 0.75 });
  const before = h.writes.length;
  await assert.rejects(h.restore(), /unfinished application or restore/);
  const saved = await h.receipt();
  assert.equal(saved.status, "restoring"); assert.equal(saved.restorationBaseline![1]!.value, 0.61);
  assert.equal(h.writes.length, before); assert.equal(h.parameters[1]!.state.value, 0.5);
});
