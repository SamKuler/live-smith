import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { runParameterApplication } from "../../../src/app/parameters/parameter-application.js";
import { captureParameterArtifact, readParameterArtifactPreview } from "../../../src/app/parameters/parameter-artifacts.js";
import { listDeviceParameterApplications, listDeviceParameterArtifacts, readDeviceParameterArtifact, saveDeviceParameterArtifact, saveDeviceParameterApplication, saveDeviceParameterProgress } from "../../../src/storage/device-parameter-artifacts.js";
import { captureParameterDevice, parameterDeviceTargets } from "../../../src/live/device-parameters.js";
import { createSession, updateSession } from "../../../src/storage/sessions.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { createLiveSetGuard } from "../../../src/live/set-identity.js";
import { LiveMutationQueue } from "../../../src/app/live-mutation-queue.js";
import { decidePlanApproval } from "../../../src/app/agent-flow.js";
import { publishSessionEditScopesChange } from "../../../src/app/session/session-edit-scope-events.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
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

async function present(h: Awaited<ReturnType<typeof setup>>, ids = [h.candidate.id]) {
  return appendSessionEvent(h.directory, h.session.id, { kind: "tool_result", name: "present_device_parameter_candidates", outcome: "success",
    content: JSON.stringify({ candidates: ids.map(artifactRef => ({ kind: "device-parameters", artifactRef })) }),
    artifacts: ids.map(id => ({ kind: "device-parameters", id })) });
}

test("clicking a presented candidate confirms manual-mode audition and Original without another prompt", async (t) => {
  const h = await setup(t);
  const shown = await present(h, [h.candidate.id, h.capture.id]);
  h.dependencies.confirm = async () => assert.fail("An explicit sound choice is the user's confirmation");
  const apply = (artifactId: string) => runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId, presentationId: shown.id });
  assert.equal(await apply(h.candidate.id), "applied");
  assert.equal(await apply(h.capture.id), "applied");
  assert.equal(await apply(h.candidate.id), "applied");
  const anotherCard = await present(h, [h.capture.id]);
  assert.equal(await runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: (await h.receipt()).id, presentationId: anotherCard.id }), "restored");
  assert.deepEqual(h.parameters.map(entry => entry.state.value), h.capture.parameters.map(entry => entry.value));
  assert.equal((await loadSessionEvents(h.directory, h.session.id)).some(event => event.kind === "apply_auto_approved"), false);
});

test("direct audition requires a successful presentation in this Session containing the chosen version", async (t) => {
  const h = await setup(t);
  const valid = await present(h, [h.capture.id]);
  const saved = await appendSessionEvent(h.directory, h.session.id, { kind: "tool_result", name: "save_device_parameter_artifact", outcome: "success", content: "Saved", artifacts: [{ kind: "device-parameters", id: h.candidate.id }] });
  const failed = await appendSessionEvent(h.directory, h.session.id, { kind: "tool_result", name: "present_device_parameter_candidates", outcome: "failed", content: "Failed" });
  const foreignSession = await createSession(h.directory, { title: "Other", projectKey: "set", scope: h.session.scope });
  const foreign = await appendSessionEvent(h.directory, foreignSession.id, { kind: "tool_result", name: "present_device_parameter_candidates", outcome: "success", content: "Shown",
    artifacts: [{ kind: "device-parameters", id: h.candidate.id }] });
  h.dependencies.confirm = async () => assert.fail("Invalid direct choices must be rejected before approval");
  for (const presentationId of ["missing", saved.id, failed.id, valid.id, foreign.id]) {
    await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id, presentationId }), /sound choice/);
  }
  assert.deepEqual(h.writes, []);
});

test("Original from a presentation cannot restore a different device", async (t) => {
  const h = await setup(t); await h.apply();
  const other = await saveDeviceParameterArtifact(h.directory, h.session.id, {
    ...h.capture, target: { ...h.capture.target, deviceId: "another-device" }, signal: h.controller.signal,
  });
  const shown = await present(h, [other.id]); const writes = h.writes.length;
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: (await h.receipt()).id, presentationId: shown.id }), /another device/);
  assert.equal(h.writes.length, writes);
});

test("Original from the active destination presentation restores a rebound candidate", async (t) => {
  const h = await setup(t); const second = deviceParameterFixture();
  Object.defineProperty(second.device, "handle", { value: { id: 4n }, configurable: true });
  second.parameters.forEach((entry, index) => Object.defineProperty(entry.parameter, "handle", { value: { id: BigInt(200 + index) }, configurable: true }));
  Object.defineProperty(h.track, "devices", { value: [h.device, second.device], configurable: true });
  const target = parameterDeviceTargets(h.context).find(entry => entry.target.deviceId === "4")!.target;
  const destination = await captureParameterArtifact({ ...h.input, kind: "capture_device_parameters", target, label: "Destination" });
  const sourceCard = await present(h); const destinationCard = await present(h, [destination.id]);
  h.dependencies.confirm = async () => assert.fail("The card click confirms the rebound audition");
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id, target, presentationId: sourceCard.id });
  const preview = await readParameterArtifactPreview({ ...h.input, artifactId: destination.id });
  assert.equal(preview.current!.target.deviceId, target.deviceId); assert.equal(preview.restoreError, undefined);
  assert.equal(await runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: preview.application!.id, presentationId: destinationCard.id }), "restored");
  assert.deepEqual(second.parameters.map(entry => entry.state.value), destination.parameters.map(entry => entry.value));
  assert.deepEqual(h.writes, []);
});

test("direct choice confirmation retains scope, drift and cancellation checks", async (t) => {
  for (const change of ["scope", "queued-drift", "cancel"] as const) {
    const h = await setup(t); const shown = await present(h);
    h.dependencies.confirm = async () => assert.fail("No redundant prompt");
    if (change === "scope") await updateSession(h.directory, h.session.id, { editScopes: [] });
    if (change === "cancel") h.controller.abort();
    if (change === "queued-drift") {
      const run = h.dependencies.mutationQueue.run.bind(h.dependencies.mutationQueue);
      h.dependencies.mutationQueue.run = (signal, operation) => { h.parameters[0]!.state.value = 0.4; return run(signal, operation); };
    }
    await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id, presentationId: shown.id }));
    assert.deepEqual(h.writes, []);
  }
  const h = await setup(t); const shown = await present(h);
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id, presentationId: shown.id });
  const writes = h.writes.length; h.parameters[1]!.state.value = 0.4;
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: (await h.receipt()).id, presentationId: shown.id }), /changed/);
  assert.equal(h.writes.length, writes);
});

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
  const proposed = events.filter((event) => event.kind === "apply_requested");
  const action = proposed[0]?.applyOperation?.plan?.actions[0];
  assert.ok(action?.type === "set_device_parameters");
  assert.equal(action.values.length, 70);
  assert.ok(action.values.every((parameter) => parameter.value === 0.75));
  const restoration = proposed[1]?.applyOperation?.plan?.actions[0];
  assert.ok(restoration?.type === "set_device_parameters");
  assert.ok(restoration.values.every((parameter) => parameter.value === 0.25));
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

test("device previews expose only the destination's receipt while a different audition blocks switching", async (t) => {
  const h = await setup(t); const second = deviceParameterFixture();
  Object.defineProperty(second.device, "handle", { value: { id: 4n }, configurable: true });
  second.parameters.forEach((entry, index) => Object.defineProperty(entry.parameter, "handle", { value: { id: BigInt(200 + index) }, configurable: true }));
  Object.defineProperty(h.track, "devices", { value: [h.device, second.device], configurable: true });
  const target = parameterDeviceTargets(h.context).find((entry) => entry.target.deviceId === "4")!.target;
  const other = await captureParameterArtifact({ ...h.input, kind: "capture_device_parameters", target, label: "Second device" });
  await h.apply(); const applied = await h.receipt(); const writes = h.writes.length;
  for (const request of [{ artifactId: other.id }, { artifactId: h.candidate.id, target }]) {
    const preview = await readParameterArtifactPreview({ ...h.input, ...request });
    assert.equal(preview.current!.target.deviceId, target.deviceId);
    assert.equal(preview.application, undefined);
    assert.ok(preview.switchError);
    await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", ...request }), /another device/);
  }
  const own = await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id });
  assert.equal(own.application!.id, applied.id); assert.equal(own.switchError, undefined);
  assert.equal(h.writes.length, writes); assert.deepEqual(second.writes, []);
});

test("confirmed SDK rounding supports repeated selection, candidate switching and original restoration", async (t) => {
  const h = await setup(t);
  for (const entry of h.parameters) {
    const set = entry.parameter.setValue;
    entry.parameter.setValue = async value => set(Math.fround(value));
  }
  for (const value of [0.6, 0.85]) {
    const candidate = await saveDeviceParameterArtifact(h.directory, h.session.id, {
      target: h.capture.target, parameters: h.capture.parameters.map(parameter => parameter.index === 1 ? { ...parameter, value } : parameter),
      label: `Filter ${value}`, source: { kind: "captured" }, revisionOf: h.capture.id, signal: h.controller.signal,
    });
    const command = { ...h.dependencies, kind: "apply_device_parameters" as const, artifactId: candidate.id };
    assert.equal(await runParameterApplication(command), "applied");
    const receipt = await h.receipt();
    assert.equal(receipt.entries[1]!.after, Math.fround(value));
    assert.notEqual(receipt.entries[1]!.after, receipt.entries[1]!.requested);
    const writes = h.writes.length;
    assert.equal(await runParameterApplication(command), "unchanged");
    assert.equal(h.writes.length, writes);
  }
  assert.equal(await h.restore(), "restored");
  assert.deepEqual(h.parameters.map(entry => entry.state.value), h.capture.parameters.map(parameter => parameter.value));
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
  if (restoring) await apply();
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

test("a cancelled approval creates no receipt and auditioning the active version again is unchanged", async (t) => {
  const h = await setup(t);
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => false);
  assert.equal(await h.apply(), "cancelled"); assert.equal(await h.receipt(), undefined); assert.deepEqual(h.writes, []);
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => true);
  await h.apply(); const writes = h.writes.length;
  assert.equal(await h.apply(), "unchanged"); assert.equal(h.writes.length, writes);
});

async function variation(h: Awaited<ReturnType<typeof setup>>, label: string, values: number[]) {
  return saveDeviceParameterArtifact(h.directory, h.session.id, { target: h.capture.target,
    parameters: h.capture.parameters.map((entry, index) => ({ ...entry, value: values[index]! })),
    label, source: { kind: "model", profileId: "profile", model: "model" }, revisionOf: h.capture.id, signal: h.controller.signal });
}

test("A/B/C auditions share a saved original artifact and restore their complete first baseline after reconnect", async (t) => {
  const h = await setup(t);
  const b = await variation(h, "B", [0.25, 0.5, 0.75]);
  const c = await variation(h, "C", [0.9, 0.25, 0.25]);
  h.parameters[2]!.state.value = 0.4;
  await h.apply(); const first = await h.receipt();
  assert.ok(first.baselineArtifactId);
  const baseline = await readDeviceParameterArtifact(h.directory, h.session.id, first.baselineArtifactId);
  assert.deepEqual(baseline.parameters.map((p) => p.value), [0.25, 0.25, 0.4]);
  for (const artifact of [b, c, b]) {
    assert.equal(await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: artifact.id }), "applied");
    const preview = await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id });
    assert.equal(preview.application!.artifactId, artifact.id);
    assert.equal(preview.application!.baselineArtifactId, baseline.id);
    assert.deepEqual(preview.application!.entries.map((p) => p.parameter.value), [0.25, 0.25, 0.4]);
  }
  const last = await h.receipt(); assert.ok(last.previousApplicationId);
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: first.id }), /no longer pending/);
  assert.equal(await h.restore(), "restored");
  assert.deepEqual(h.parameters.map((p) => p.state.value), [0.25, 0.25, 0.4]);
  const finished = await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id });
  assert.equal(finished.application?.status, "restored");
  assert.equal(finished.application?.id, last.id);
  assert.equal((await listDeviceParameterArtifacts(h.directory, h.session.id)).length, 5);
  await h.apply(); assert.notEqual((await h.receipt()).baselineArtifactId, baseline.id);
});

test("keeping B terminates the audition for every candidate and the next audition has a fresh baseline", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.5, 0.6, 0.7]);
  await h.apply(); await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id });
  const chosen = await h.receipt();
  await runParameterApplication({ ...h.dependencies, kind: "keep_device_parameters", applicationId: chosen.id });
  assert.deepEqual(h.parameters.map((p) => p.state.value), [0.5, 0.6, 0.7]);
  assert.equal((await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id })).application?.status, "kept");
  assert.equal((await readDeviceParameterArtifact(h.directory, h.session.id, b.id)).label, "B");
  await h.apply(); await h.restore();
  assert.deepEqual(h.parameters.map((p) => p.state.value), [0.5, 0.6, 0.7]);
});

test("an adopted sound can be restored after reconnect through a new receipt while its decision stays immutable", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.5, 0.6, 0.7]);
  await h.apply(); await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id });
  const chosen = await h.receipt();
  await runParameterApplication({ ...h.dependencies, kind: "keep_device_parameters", applicationId: chosen.id });
  const resultPath = `${h.directory}/live-smith-device-parameters/${h.session.id}/applications/${chosen.id}/result.json`;
  const originalDecision = await fs.readFile(resultPath, "utf8");
  assert.equal((await readParameterArtifactPreview({ ...h.input, artifactId: b.id })).restoreError, undefined);
  assert.equal(await runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: chosen.id }), "restored");
  const restored = await h.receipt();
  assert.notEqual(restored.id, chosen.id); assert.equal(restored.previousApplicationId, chosen.id);
  assert.equal(restored.baselineArtifactId, chosen.baselineArtifactId); assert.equal(restored.status, "restored");
  assert.deepEqual(h.parameters.map((p) => p.state.value), [0.25, 0.25, 0.25]);
  assert.equal(await fs.readFile(resultPath, "utf8"), originalDecision);
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: chosen.id }), /no longer pending/);
});

test("restoring an adopted sound checks manual edits, newer auditions and current scope", async (t) => {
  for (const change of ["manual", "newer", "scope"] as const) {
    const h = await setup(t); await h.apply(); const chosen = await h.receipt();
    await runParameterApplication({ ...h.dependencies, kind: "keep_device_parameters", applicationId: chosen.id });
    if (change === "manual") h.parameters[1]!.state.value = 0.6;
    if (change === "scope") await updateSession(h.directory, h.session.id, { editScopes: [] });
    if (change === "newer") {
      const b = await variation(h, "B", [0.5, 0.5, 0.5]);
      await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id });
    }
    const before = h.writes.length; const history = await listDeviceParameterApplications(h.directory, h.session.id);
    await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: chosen.id }), change === "manual" ? /changed/ : change === "scope" ? /scope/ : /no longer pending/);
    if (change === "manual") assert.ok((await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id })).restoreError);
    assert.equal(h.writes.length, before); assert.deepEqual(await listDeviceParameterApplications(h.directory, h.session.id), history);
  }
});

test("cancelling or stopping restoration of an adopted sound preserves its recovery history", async (t) => {
  const h = await setup(t); await h.apply(); const chosen = await h.receipt();
  await runParameterApplication({ ...h.dependencies, kind: "keep_device_parameters", applicationId: chosen.id });
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => false);
  assert.equal(await h.restore(), "cancelled"); assert.equal((await h.receipt()).id, chosen.id);
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => true);
  const write = h.parameters[0]!.parameter.setValue;
  h.parameters[0]!.parameter.setValue = async (value) => { await write(value); h.controller.abort(); };
  await assert.rejects(h.restore(), /did not finish reliably/);
  const partial = await h.receipt(); assert.equal(partial.previousApplicationId, chosen.id); assert.equal(partial.status, "partial");
  assert.equal((await listDeviceParameterApplications(h.directory, h.session.id)).find((entry) => entry.id === chosen.id)!.status, "kept");
  h.parameters[0]!.parameter.setValue = write;
  const resumed = { ...h.dependencies, signal: createHostAbortController().signal };
  await runParameterApplication({ ...resumed, kind: "keep_device_parameters", applicationId: partial.id });
  await runParameterApplication({ ...resumed, kind: "restore_device_parameters", applicationId: partial.id });
  assert.deepEqual((await h.receipt()).restorationBaseline!.map((entry) => entry.value), [0.25, 0.75, 0.75]);
  assert.ok(h.parameters.every((entry) => entry.state.value === 0.25));
});

test("restoring a legacy adopted receipt saves its original artifact without changing the completed receipt", async (t) => {
  const h = await setup(t);
  h.parameters.forEach((entry) => entry.state.value = 0.75);
  const legacy = { id: "legacy_kept", sessionId: h.session.id, artifactId: h.candidate.id, artifactLabel: h.candidate.label,
    artifactVersion: h.candidate.version.number, target: h.target, createdAt: new Date().toISOString(), status: "kept" as const,
    entries: h.capture.parameters.map((parameter) => ({ parameter, requested: 0.75, state: "applied" as const, after: 0.75 })) };
  await saveDeviceParameterApplication(h.directory, legacy);
  await runParameterApplication({ ...h.dependencies, kind: "restore_device_parameters", applicationId: legacy.id });
  const restored = await h.receipt(); assert.equal(restored.previousApplicationId, legacy.id); assert.ok(restored.baselineArtifactId);
  assert.deepEqual((await readDeviceParameterArtifact(h.directory, h.session.id, restored.baselineArtifactId)).parameters.map((p) => p.value), [0.25, 0.25, 0.25]);
  assert.deepEqual((await listDeviceParameterApplications(h.directory, h.session.id)).find((entry) => entry.id === legacy.id), legacy);
});

test("cancelled switching leaves A active with its original baseline and no extra artifacts", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.5, 0.5, 0.5]);
  await h.apply(); const first = await h.receipt();
  h.dependencies.confirm = (plan) => decidePlanApproval(h.directory, h.session.id, plan, async () => false);
  assert.equal(await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id }), "cancelled");
  assert.deepEqual(await h.receipt(), first);
  assert.deepEqual(h.parameters.map((p) => p.state.value), [0.75, 0.75, 0.75]);
  assert.equal((await listDeviceParameterArtifacts(h.directory, h.session.id)).length, 4);
});

test("same-value candidates still select the exact saved version without SDK writes", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.75, 0.75, 0.75]);
  await h.apply(); const before = h.writes.length;
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id });
  assert.equal((await h.receipt()).artifactId, b.id); assert.equal(h.writes.length, before);
  await h.restore(); assert.ok(h.parameters.every((p) => p.state.value === 0.25));
});

test("switching rejects manual changes to the entire device including parameters A did not write", async (t) => {
  const h = await setup(t); const a = await variation(h, "A", [0.5, 0.25, 0.25]);
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: a.id });
  h.parameters[2]!.state.value = 0.6; const before = h.writes.length;
  await assert.rejects(h.apply(), /changed after application/);
  await assert.rejects(h.restore(), /changed/);
  assert.equal(h.writes.length, before); assert.equal((await h.receipt()).artifactId, a.id);
});

test("switches revalidate values, scope and destination after approval without replacing the active receipt", async (t) => {
  for (const change of ["value", "scope", "device"] as const) {
    const h = await setup(t); const b = await variation(h, "B", [0.5, 0.5, 0.5]);
    await h.apply(); const first = await h.receipt(); const before = h.writes.length;
    h.dependencies.confirm = async () => {
      if (change === "value") h.parameters[2]!.state.value = 0.8;
      if (change === "scope") await updateSession(h.directory, h.session.id, { editScopes: [] });
      if (change === "device") Object.defineProperty(h.device, "handle", { value: { id: 999n }, configurable: true });
      return { confirmed: true, source: "user", mode: "manual" };
    };
    await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id }));
    assert.deepEqual(await h.receipt(), first); assert.equal(h.writes.length, before);
  }
});

test("a stopped switch restores confirmed A and B writes to the first baseline", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.5, 0.5, 0.5]);
  await h.apply(); const write = h.parameters[0]!.parameter.setValue;
  h.parameters[0]!.parameter.setValue = async (value) => { await write(value); h.controller.abort(); };
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id }), /did not finish reliably/);
  assert.deepEqual((await h.receipt()).entries.map((p) => p.after), [0.5, 0.75, 0.75]);
  h.parameters[0]!.parameter.setValue = write;
  assert.equal(await runParameterApplication({ ...h.dependencies, signal: createHostAbortController().signal, kind: "restore_device_parameters", applicationId: (await h.receipt()).id }), "restored");
  assert.deepEqual(h.parameters.map((p) => p.state.value), [0.25, 0.25, 0.25]);
});

test("rebound candidates follow the chosen device throughout an audition and after completion", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.5, 0.5, 0.5]); const next = deviceParameterFixture();
  const dependencies = { ...h.dependencies, context: next.context, assertLiveSetCurrent: createLiveSetGuard(next.context) };
  await runParameterApplication({ ...dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id, target: next.target });
  await runParameterApplication({ ...dependencies, kind: "apply_device_parameters", artifactId: b.id });
  assert.deepEqual(next.parameters.map((p) => p.state.value), [0.5, 0.5, 0.5]); assert.deepEqual(h.writes, []);
  const current = await readParameterArtifactPreview({ ...dependencies, artifactId: h.candidate.id });
  assert.equal(current.current!.target.runtimeId, next.target.runtimeId); assert.equal(current.switchError, undefined);
  await runParameterApplication({ ...dependencies, kind: "restore_device_parameters", applicationId: current.application!.id });
  const restored = await readParameterArtifactPreview({ ...dependencies, artifactId: h.candidate.id });
  assert.equal(restored.application?.status, "restored");
});

for (const finish of ["keep_device_parameters", "restore_device_parameters"] as const) test(`preview and a new audition share the completed explicit binding after ${finish}`, async (t) => {
  const h = await setup(t); const second = deviceParameterFixture();
  Object.defineProperty(second.device, "handle", { value: { id: 4n }, configurable: true });
  second.parameters.forEach((entry, index) => Object.defineProperty(entry.parameter, "handle", { value: { id: BigInt(200 + index) }, configurable: true }));
  Object.defineProperty(h.track, "devices", { value: [h.device, second.device], configurable: true });
  const target = parameterDeviceTargets(h.context).find((entry) => entry.target.deviceId === "4")!.target;
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.candidate.id, target });
  await runParameterApplication({ ...h.dependencies, kind: finish, applicationId: (await h.receipt()).id });
  const preview = await readParameterArtifactPreview({ ...h.input, artifactId: h.candidate.id });
  assert.equal(preview.current!.target.deviceId, target.deviceId);
  await h.apply();
  assert.equal((await h.receipt()).target.deviceId, preview.current!.target.deviceId);
  assert.deepEqual(h.writes, []);
});

test("first no-op audition and legacy receipt continuation preserve full original snapshots", async (t) => {
  const h = await setup(t);
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.capture.id });
  assert.deepEqual(h.writes, []); assert.ok((await h.receipt()).baselineArtifactId);
  await h.restore();
  h.parameters.forEach((entry) => entry.state.value = 0.75);
  await saveDeviceParameterApplication(h.directory, { id: "legacy_application", sessionId: h.session.id, artifactId: h.candidate.id,
    artifactLabel: h.candidate.label, artifactVersion: h.candidate.version.number, target: h.target, createdAt: new Date().toISOString(), status: "applied",
    entries: h.capture.parameters.map((parameter) => ({ parameter, requested: 0.75, state: "applied", after: 0.75 })) });
  await runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: h.capture.id });
  const next = await h.receipt(); assert.equal(next.previousApplicationId, "legacy_application"); assert.ok(next.baselineArtifactId);
  assert.deepEqual((await readDeviceParameterArtifact(h.directory, h.session.id, next.baselineArtifactId)).parameters.map((p) => p.value), [0.25, 0.25, 0.25]);
  await h.restore(); assert.deepEqual(h.parameters.map((p) => p.state.value), [0.25, 0.25, 0.25]);
});

test("an interrupted B retains the original baseline and blocks further switching", async (t) => {
  const h = await setup(t); const b = await variation(h, "B", [0.5, 0.5, 0.5]);
  await h.apply(); const first = await h.receipt();
  h.parameters[1]!.parameter.setValue = async (value) => { h.parameters[1]!.state.value = value; throw new Error("lost acknowledgement"); };
  await assert.rejects(runParameterApplication({ ...h.dependencies, kind: "apply_device_parameters", artifactId: b.id }), /did not finish reliably/);
  const partial = await h.receipt();
  assert.equal(partial.status, "partial"); assert.equal(partial.baselineArtifactId, first.baselineArtifactId);
  assert.deepEqual(partial.entries.map((p) => p.state), ["applied", "applying", "applied"]);
  assert.deepEqual(partial.entries.map((p) => p.parameter.value), [0.25, 0.25, 0.25]);
  await assert.rejects(h.apply(), /previous parameter application/);
  await assert.rejects(h.restore(), /unknown outcome/);
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
  const original = h.parameters[0]!.parameter.setValue;
  h.parameters[0]!.parameter.setValue = async (value) => { await original(value); h.parameters[1]!.state.value = 0.5; };
  await assert.rejects(h.restore(), /did not finish reliably/);
  const receipt = await h.receipt();
  assert.equal(receipt.status, "partial"); assert.equal(receipt.entries[1]!.state, "conflict");
  assert.equal(receipt.restorationBaseline![1]!.value, 0.25);
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
