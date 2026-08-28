import assert from "node:assert/strict";
import test from "node:test";

import {
  Device,
  Sample,
  Simpler,
  Track,
} from "@ableton-extensions/sdk";

import { resolveDeviceTarget } from "../live/device-tree.js";
import { resolveSampleSource } from "../live/sample-source.js";
import { preflightAgentPlan } from "./agent-request.js";

test("action preflight binds and revalidates a Return target by handle", async () => {
  const original = { name: "A-Reverb", handle: { id: "return-1" }, devices: [] };
  const replacement = { name: "A-Reverb", handle: { id: "return-2" }, devices: [] };
  const mainTrack = { name: "Main", handle: { id: "main" }, devices: [] };
  const returnTracks = [original];
  const context = {
    application: {
      song: { tracks: [], returnTracks, mainTrack },
    },
  } as never;
  const observedTargets: unknown[] = [];
  const guard = await preflightAgentPlan(
    context,
    { target: {} } as never,
    {
      message: "Add Utility to Return A",
      targets: {
        bus: { trackRole: "return", trackIndex: 0, trackName: "A-Reverb" },
      },
      actions: [{
        type: "insert_device",
        trackRef: "bus",
        deviceName: "Utility",
      }],
    },
    new AbortController().signal,
    async (_context, _request, target) => {
      observedTargets.push(target.track);
      return "ok";
    },
    (_context, action, target) => `${action.type}:${target.track?.handle.id}`,
  );

  const bindings = await guard();
  assert.equal(bindings.tracks.get("bus"), original);
  assert.deepEqual(observedTargets, [original, original]);

  returnTracks[0] = replacement;
  await assert.rejects(guard, /track bound to ref "bus" changed/i);
});

test("Return device preflight ignores a Device selected on another track", async () => {
  const regularDevices: Device<"1.0.0">[] = [];
  const returnDevices: Device<"1.0.0">[] = [];
  const regularTrack = Object.defineProperties(Object.create(Track.prototype), {
    name: { enumerable: true, value: "Lead" },
    handle: { enumerable: true, value: { id: "regular-track" } },
    devices: { enumerable: true, value: regularDevices },
  });
  const returnTrack = Object.defineProperties(Object.create(Track.prototype), {
    name: { enumerable: true, value: "A-Reverb" },
    handle: { enumerable: true, value: { id: "return-track" } },
    devices: { enumerable: true, value: returnDevices },
  });
  const selectedDevice = Object.defineProperties(Object.create(Device.prototype), {
    name: { enumerable: true, value: "Utility" },
    handle: { enumerable: true, value: { id: "regular-utility" } },
    parameters: { enumerable: true, value: [] },
    parent: { enumerable: true, value: regularTrack },
  });
  const returnDevice = Object.defineProperties(Object.create(Device.prototype), {
    name: { enumerable: true, value: "Utility" },
    handle: { enumerable: true, value: { id: "return-utility" } },
    parameters: { enumerable: true, value: [] },
    parent: { enumerable: true, value: returnTrack },
  });
  regularDevices.push(selectedDevice);
  returnDevices.push(returnDevice);
  const context = {
    application: {
      song: { tracks: [regularTrack], returnTracks: [returnTrack] },
    },
  } as never;
  const resolvedDeviceIds: string[] = [];
  const resolveReturnDevice = (
    target: Parameters<typeof preflightAgentPlan>[1]["target"],
  ) => {
    assert.ok(target.track);
    assert.equal(target.track, returnTrack);
    assert.equal(target.object, selectedDevice);
    const resolved = resolveDeviceTarget(target.track, target, "Utility");
    resolvedDeviceIds.push(String(resolved.device.handle.id));
  };

  const guard = await preflightAgentPlan(
    context,
    { target: { track: regularTrack, object: selectedDevice } } as never,
    {
      message: "Remove Utility from Return A",
      targets: {
        bus: { trackRole: "return", trackIndex: 0, trackName: "A-Reverb" },
      },
      actions: [{
        type: "delete_device",
        trackRef: "bus",
        deviceName: "Utility",
      }],
    },
    new AbortController().signal,
    async (_context, _request, target) => {
      resolveReturnDevice(target);
      return "ok";
    },
    async (_context, _action, target) => {
      resolveReturnDevice(target);
      return "return-utility";
    },
  );

  await guard();
  assert.deepEqual(resolvedDeviceIds, Array(4).fill("return-utility"));
});

test("cross-track preflight preserves a selected sample source", async () => {
  const sourceTrack = Object.defineProperties(Object.create(Track.prototype), {
    name: { enumerable: true, value: "Source" },
    handle: { enumerable: true, value: { id: "source-track" } },
    devices: { enumerable: true, value: [] },
  });
  const destinationDevices: Device<"1.0.0">[] = [];
  const destinationTrack = Object.defineProperties(Object.create(Track.prototype), {
    name: { enumerable: true, value: "Destination" },
    handle: { enumerable: true, value: { id: "destination-track" } },
    devices: { enumerable: true, value: destinationDevices },
  });
  const sample = Object.defineProperties(Object.create(Sample.prototype), {
    handle: { enumerable: true, value: { id: "selected-sample" } },
    filePath: { enumerable: true, value: "/private/source.wav" },
    parent: { enumerable: true, value: sourceTrack },
  });
  const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Simpler" },
    handle: { enumerable: true, value: { id: "destination-simpler" } },
    parameters: { enumerable: true, value: [] },
    parent: { enumerable: true, value: destinationTrack },
  });
  destinationDevices.push(simpler);
  const context = {
    application: {
      song: {
        tracks: [sourceTrack, destinationTrack],
        returnTracks: [],
      },
    },
  } as never;
  const seenSources: string[] = [];
  const assertSelectedSource = (
    target: Parameters<typeof preflightAgentPlan>[1]["target"],
  ) => {
    assert.ok(target.track);
    assert.equal(target.track, destinationTrack);
    const source = resolveSampleSource(context, { kind: "selected" }, target);
    assert.equal(
      resolveDeviceTarget(target.track, target, "Simpler").device,
      simpler,
    );
    seenSources.push(source.filePath);
  };

  const guard = await preflightAgentPlan(
    context,
    { target: { track: sourceTrack, object: sample } } as never,
    {
      message: "Load the selected sample in Destination",
      actions: [{
        type: "replace_simpler_sample",
        trackName: "Destination",
        simplerName: "Simpler",
        source: { kind: "selected" },
      }],
    },
    new AbortController().signal,
    async (_context, _request, target) => {
      assertSelectedSource(target);
      return "ok";
    },
    async (_context, _action, target) => {
      assertSelectedSource(target);
      return "selected-source";
    },
  );

  await guard();
  assert.deepEqual(seenSources, Array(4).fill("/private/source.wav"));
});
