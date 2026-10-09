import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { createHostAbortController } from "../../src/runtime/host.js";
import { createSession } from "../../src/storage/sessions.js";
import { listDeviceParameterArtifacts, readDeviceParameterArtifact, saveDeviceParameterArtifact, listDeviceParameterApplications,
  saveDeviceParameterApplication, saveDeviceParameterProgress, deleteSessionDeviceParameters } from "../../src/storage/device-parameter-artifacts.js";
import { captureParameterDevice } from "../../src/live/device-parameters.js";
import { deviceParameterFixture } from "../live/support/device-parameter-fixture.js";

async function setup(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-parameters-storage-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Parameters", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Live Set" } });
  const fixture = deviceParameterFixture();
  const snapshot = await captureParameterDevice(fixture.context, fixture.target);
  const controller = createHostAbortController();
  const save = (revisionOf?: string) => saveDeviceParameterArtifact(directory, session.id, { ...snapshot, label: "Synth", source: { kind: "captured" }, signal: controller.signal, ...(revisionOf ? { revisionOf } : {}) });
  return { directory, session, fixture, snapshot, save, controller };
}

test("parameter snapshots round-trip all values and allocate immutable concurrent revisions", async (t) => {
  const h = await setup(t);
  const base = await h.save();
  const revisions = await Promise.all([h.save(base.id), h.save(base.id)]);
  assert.deepEqual(revisions.map((entry) => entry.version.number).sort(), [2, 3]);
  assert.deepEqual(await readDeviceParameterArtifact(h.directory, h.session.id, base.id), base);
  assert.equal((await listDeviceParameterArtifacts(h.directory, h.session.id)).length, 3);
  h.snapshot.parameters[0]!.value = 0.9;
  assert.equal((await readDeviceParameterArtifact(h.directory, h.session.id, base.id)).parameters[0]!.value, 0.25);
  await assert.rejects(readDeviceParameterArtifact(h.directory, "another-session", base.id), /Session/);
});

test("parameter storage rejects malformed values, duplicate handles, wrong layouts and cancelled saves", async (t) => {
  const h = await setup(t); const base = await h.save();
  for (const value of [NaN, Infinity, -0.1, 1.1]) {
    h.snapshot.parameters[0]!.value = value; await assert.rejects(h.save(), /invalid/);
  }
  h.snapshot.parameters[0]!.value = 0.25;
  h.snapshot.parameters[0]!.handleId = h.snapshot.parameters[1]!.handleId;
  await assert.rejects(h.save(), /invalid/);
  h.snapshot.parameters[0]!.handleId = "100";
  h.snapshot.parameters[0]!.name = "Different";
  await assert.rejects(h.save(base.id), /layout/);
  h.controller.abort(); await assert.rejects(h.save());
  assert.equal((await listDeviceParameterArtifacts(h.directory, h.session.id)).length, 1);
});

test("corrupt or symlinked parameter data cannot be read or silently replaced", async (t) => {
  const h = await setup(t); const base = await h.save();
  const file = path.join(h.directory, "live-smith-device-parameters", h.session.id, `${base.id}.json`);
  await fs.writeFile(file, "{}");
  await assert.rejects(h.save(), /invalid/);
  assert.equal(await fs.readFile(file, "utf8"), "{}");
  await fs.unlink(file); const outside = path.join(h.directory, "outside.json");
  await fs.writeFile(outside, JSON.stringify(base)); await fs.symlink(outside, file);
  await assert.rejects(readDeviceParameterArtifact(h.directory, h.session.id, base.id));
});

test("application receipts preserve in-flight and actual readback states independently of artifacts", async (t) => {
  const h = await setup(t); const artifact = await h.save();
  const receipt = { id: "parameter_apply_test", sessionId: h.session.id, artifactId: artifact.id, createdAt: new Date().toISOString(), target: h.snapshot.target,
    artifactLabel: artifact.label, artifactVersion: artifact.version.number,
    status: "applying" as const, entries: [{ parameter: h.snapshot.parameters[0]!, requested: 0.8, state: "applying" as const }] };
  await saveDeviceParameterApplication(h.directory, receipt);
  assert.equal((await listDeviceParameterApplications(h.directory, h.session.id))[0]!.entries[0]!.state, "applying");
  await saveDeviceParameterApplication(h.directory, { ...receipt, status: "applied", entries: [{ ...receipt.entries[0]!, state: "applied", after: 0.79 }] });
  assert.equal((await listDeviceParameterApplications(h.directory, h.session.id))[0]!.entries[0]!.after, 0.79);
  assert.deepEqual((await readDeviceParameterArtifact(h.directory, h.session.id, artifact.id)).parameters, artifact.parameters);
  await deleteSessionDeviceParameters(h.directory, h.session.id);
  assert.deepEqual(await listDeviceParameterArtifacts(h.directory, h.session.id), []);
});

test("per-write progress stays small and leaves the complete baseline file untouched", async (t) => {
  const h = await setup(t); const artifact = await h.save();
  const receipt = { id: "parameter_apply_progress", sessionId: h.session.id, artifactId: artifact.id, createdAt: new Date().toISOString(), target: h.snapshot.target,
    artifactLabel: artifact.label, artifactVersion: artifact.version.number,
    status: "applying" as const, entries: h.snapshot.parameters.map((parameter) => ({ parameter, requested: 0.8, state: "pending" as const })) };
  await saveDeviceParameterApplication(h.directory, receipt);
  const root = path.join(h.directory, "live-smith-device-parameters", h.session.id, "applications");
  const baseline = path.join(root, `${receipt.id}.json`);
  const initial = await fs.stat(baseline, { bigint: true });
  await saveDeviceParameterProgress(h.directory, h.session.id, receipt.id, { index: 1, state: "applying" });
  await saveDeviceParameterProgress(h.directory, h.session.id, receipt.id, { index: 1, state: "applied", after: 0.8 });
  assert.equal((await fs.stat(baseline, { bigint: true })).mtimeNs, initial.mtimeNs);
  assert.ok((await fs.stat(path.join(root, receipt.id, "parameter-1.json"))).size < 128);
  const loaded = (await listDeviceParameterApplications(h.directory, h.session.id))[0]!;
  assert.deepEqual(loaded.entries.map((entry) => entry.state), ["pending", "applied", "pending"]);
  assert.deepEqual(loaded.entries[0]!.parameter, h.snapshot.parameters[0]);
});
