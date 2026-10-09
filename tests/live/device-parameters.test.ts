import assert from "node:assert/strict";
import test from "node:test";
import { RackDevice } from "@ableton-extensions/sdk";
import { validateAgentPlan } from "../../src/agent/actions.js";
import { captureParameterDevice, executeParameterWrites, parameterDeviceTargets, resolveParameterDevice } from "../../src/live/device-parameters.js";
import { executeAgentPlanWithProgress, AgentPlanExecutionError } from "../../src/live/executor.js";
import { captureLiveActionPreflightObservation } from "../../src/live/preflight.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { preflightAgentPlan } from "../../src/app/agent-request.js";
import { liveContextPresentationFixture } from "../app/context/support/live-context.test-harness.js";
import { deviceParameterFixture } from "./support/device-parameter-fixture.js";

test("complete capture and bulk writes distinguish duplicate parameter names and exceed 64 parameters", async () => {
  const h = deviceParameterFixture(300);
  const snapshot = await captureParameterDevice(h.context, h.target);
  assert.equal(snapshot.parameters.length, 300); assert.deepEqual(h.writes, []);
  const values = snapshot.parameters.map((parameter) => ({ parameterIndex: parameter.index, parameterName: parameter.name, value: 0.7 }));
  const plan = validateAgentPlan({ message: "Change device", actions: [{ type: "set_device_parameters", trackName: "Lead", deviceName: "Synth", values }] });
  const preview = await captureLiveActionPreflightObservation(h.context, plan.actions[0]!, {}, undefined, true);
  assert.equal(preview.preview?.kind, "device-parameters");
  assert.equal(preview.preview?.kind === "device-parameters" && preview.preview.parameters.length, 300);
  await executeAgentPlanWithProgress(h.context, plan, {});
  assert.equal(h.writes.length, 300); assert.equal(h.parameters[1]!.state.value, 0.7);
});

test("same-name nested devices retain distinct readable locations and exact capture bindings", async () => {
  const h = deviceParameterFixture(); const nested = deviceParameterFixture();
  Object.defineProperty(nested.device, "handle", { value: { id: 5n } });
  nested.parameters[0]!.state.value = 0.6;
  const rack = Object.defineProperties(Object.create(RackDevice.prototype), {
    handle: { value: { id: 4n } }, name: { value: "Rack" }, parameters: { value: [] },
    chains: { value: [{ devices: [nested.device] }] },
  });
  Object.defineProperty(h.track, "devices", { value: [h.device, rack] });
  const targets = parameterDeviceTargets(h.context).filter((entry) => entry.target.deviceName === "Synth");
  assert.deepEqual(targets.map((entry) => entry.target.devicePath), ["1. Synth", "2. Rack [1] / 1. Synth"]);
  assert.equal(resolveParameterDevice(h.context, targets[1]!.target).resolved.device, nested.device);
  const snapshot = await captureParameterDevice(h.context, targets[1]!.target);
  assert.equal(snapshot.parameters[0]!.value, 0.6); assert.equal(snapshot.target.deviceId, "5");
  assert.deepEqual(h.writes, []); assert.deepEqual(nested.writes, []);
});

test("bulk preflight rejects any invalid later parameter before earlier values are written", async () => {
  const h = deviceParameterFixture();
  const values = [{ parameterIndex: 0, parameterName: "Gain", value: 0.5 }, { parameterIndex: 1, parameterName: "Gain", value: 5 }];
  await assert.rejects(executeParameterWrites(h.device, values, { assertCurrent() {} }), /range/);
  assert.deepEqual(h.writes, []);
  assert.throws(() => validateAgentPlan({ message: "Duplicate", actions: [{ type: "set_device_parameters", deviceName: "Synth", values: [values[0], values[0]] }] }), /distinct/);
});

test("later value drift or layout replacement stops a partially completed parameter action", async () => {
  const h = deviceParameterFixture();
  const original = h.parameters[0]!.parameter.setValue;
  h.parameters[0]!.parameter.setValue = async (value) => { await original(value); h.parameters[1]!.state.value = 0.9; };
  const values = [0, 1].map((parameterIndex) => ({ parameterIndex, parameterName: "Gain", value: 0.5 }));
  const plan = validateAgentPlan({ message: "Change", actions: [{ type: "set_device_parameters", trackName: "Lead", deviceName: "Synth", values }] });
  await assert.rejects(executeAgentPlanWithProgress(h.context, plan, {}), (error: unknown) => {
    assert.ok(error instanceof AgentPlanExecutionError); assert.equal(error.completedMutationCount, 1); assert.equal(error.completedActionCount, 0); return true;
  });
  assert.deepEqual(h.writes, [[0, 0.5]]); assert.equal(h.parameters[1]!.state.value, 0.9);
});

test("parameter writes recheck cancellation after receipt persistence and read back before stopping", async () => {
  const h = deviceParameterFixture(); const controller = createHostAbortController();
  await assert.rejects(executeParameterWrites(h.device, [{ parameterIndex: 0, parameterName: "Gain", value: 0.5 }], {
    signal: controller.signal, assertCurrent() {}, beforeWrite: async () => { controller.abort(); },
  }));
  assert.deepEqual(h.writes, []);
  await assert.rejects(resolveBinding());
  async function resolveBinding() { resolveParameterDevice(deviceParameterFixture().context, h.target); }
});

test("Stop, authorization and parameter replacement are checked after the final awaited value read", async () => {
  for (const change of ["stop", "scope", "identity"] as const) {
    const h = deviceParameterFixture(1); const controller = createHostAbortController();
    let lastRead = false, allowed = true;
    h.parameters[0]!.parameter.getValue = async () => {
      if (lastRead) {
        if (change === "stop") controller.abort();
        if (change === "scope") allowed = false;
        if (change === "identity") Object.defineProperty(h.parameters[0]!.parameter, "handle", { value: { id: 900n }, configurable: true });
      }
      return 0.25;
    };
    await assert.rejects(executeParameterWrites(h.device, [{ parameterIndex: 0, parameterName: "Gain", value: 0.8 }], {
      signal: controller.signal, assertCurrent() { if (!allowed) throw new Error("Scope revoked"); }, beforeWrite: async () => { lastRead = true; },
    }));
    assert.deepEqual(h.writes, [], change);
  }
});

test("ordinary bulk execution preserves the preflight baseline across the guard-to-executor gap", async () => {
  const h = deviceParameterFixture(); const signal = createHostAbortController().signal;
  const plan = validateAgentPlan({ message: "Change", actions: [{ type: "set_device_parameters", trackName: "Lead", deviceName: "Synth",
    values: [{ parameterIndex: 0, parameterName: "Gain", value: 0.75 }] }] });
  const guard = await preflightAgentPlan(h.context, { target: {}, summary: "Set", scope: { kind: "selection", identity: "set", label: "Set" }, presentation: liveContextPresentationFixture("Set", "other") }, plan, signal);
  const bindings = await guard(); h.parameters[0]!.state.value = 0.5;
  await assert.rejects(executeAgentPlanWithProgress(h.context, plan, {}, signal, bindings), /changed after preflight/);
  assert.deepEqual(h.writes, []); assert.equal(h.parameters[0]!.state.value, 0.5);
});

test("ordered parameter actions inherit verified earlier writes without accepting external drift", async () => {
  for (const firstKind of ["bulk", "single"] as const) {
    const h = deviceParameterFixture(); const signal = createHostAbortController().signal;
    const first = firstKind === "bulk"
      ? { type: "set_device_parameters", trackName: "Lead", deviceName: "Synth", values: [{ parameterIndex: 2, parameterName: "Parameter 2", value: 0.7 }] }
      : { type: "set_device_parameter", trackName: "Lead", deviceName: "Synth", parameterName: "Parameter 2", value: 0.7 };
    const plan = validateAgentPlan({ message: "Ordered parameter edits", actions: [first,
      { type: "set_device_parameters", trackName: "Lead", deviceName: "Synth", values: [{ parameterIndex: 0, parameterName: "Gain", value: 0.8 }] }] });
    const interaction = { target: {}, summary: "Set", scope: { kind: "selection" as const, identity: "set", label: "Set" }, presentation: liveContextPresentationFixture("Set", "other") };
    const guard = await preflightAgentPlan(h.context, interaction, plan, signal);
    await executeAgentPlanWithProgress(h.context, plan, {}, signal, await guard());
    assert.deepEqual(h.writes, [[2, 0.7], [0, 0.8]], firstKind);
  }
  const h = deviceParameterFixture(); const signal = createHostAbortController().signal;
  const firstSet = h.parameters[2]!.parameter.setValue;
  h.parameters[2]!.parameter.setValue = async (value) => { await firstSet(value); h.parameters[1]!.state.value = 0.4; };
  const plan = validateAgentPlan({ message: "Ordered edits", actions: [
    { type: "set_device_parameters", trackName: "Lead", deviceName: "Synth", values: [{ parameterIndex: 2, parameterName: "Parameter 2", value: 0.7 }] },
    { type: "set_device_parameters", trackName: "Lead", deviceName: "Synth", values: [{ parameterIndex: 0, parameterName: "Gain", value: 0.8 }] },
  ] });
  const guard = await preflightAgentPlan(h.context, { target: {}, summary: "Set", scope: { kind: "selection", identity: "set", label: "Set" }, presentation: liveContextPresentationFixture("Set", "other") }, plan, signal);
  await assert.rejects(executeAgentPlanWithProgress(h.context, plan, {}, signal, await guard()), /changed after preflight/);
  assert.deepEqual(h.writes, [[2, 0.7]]); assert.equal(h.parameters[1]!.state.value, 0.4);
});
