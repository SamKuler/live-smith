import assert from "node:assert/strict";
import test from "node:test";

import { RackDevice, Simpler, Track } from "@ableton-extensions/sdk";

import {
  findDevice,
  resolveDeviceTarget,
  resolveTrack,
  resolveTrackSelector,
} from "./resolve.js";
import { resolveRackChainTarget } from "./device-tree.js";

test("resolveTrack never falls back when an explicit name is missing", () => {
  assert.throws(
    () =>
      resolveTrack(
        fakeContext([fakeTrack("Lead")]),
        "Bass",
        { track: fakeTrack("Selected Drums") },
      ),
    /Could not find track "Bass"/,
  );
});

test("resolveTrack rejects duplicate explicit track names", () => {
  assert.throws(
    () =>
      resolveTrack(
        fakeContext([fakeTrack("Bass"), fakeTrack("bass")]),
        "Bass",
        {},
      ),
    /Found 2 tracks named "Bass"/,
  );
});

test("resolveTrackSelector keeps regular, Return, and Main namespaces distinct", () => {
  const regular = { name: "Shared", devices: [] };
  const firstReturn = { name: "Shared", devices: [] };
  const secondReturn = { name: "B-Delay", devices: [] };
  const mainTrack = { name: "Main", devices: [] };
  const context = {
    application: {
      song: {
        tracks: [regular],
        returnTracks: [firstReturn, secondReturn],
        mainTrack,
      },
    },
  } as never;

  assert.equal(
    resolveTrackSelector(context, { trackName: "Shared" }, {}),
    regular,
  );
  assert.equal(
    resolveTrackSelector(
      context,
      { trackRole: "return", trackIndex: 0, trackName: "Shared" },
      {},
    ),
    firstReturn,
  );
  assert.equal(
    resolveTrackSelector(context, { trackRole: "main", trackName: "Main" }, {}),
    mainTrack,
  );
  assert.throws(
    () => resolveTrackSelector(
      context,
      { trackRole: "return", trackIndex: 1, trackName: "Shared" },
      {},
    ),
    /Return track index 1 is "B-Delay", not "Shared"/,
  );
});

test("findDevice requires deviceIndex when duplicate device names exist", () => {
  const track = fakeTrack("Lead", [
    fakeDevice("Operator"),
    fakeDevice("Auto Filter"),
    fakeDevice("Auto Filter"),
  ]);

  assert.throws(
    () => findDevice(track, "Auto Filter"),
    /Specify deviceIndex/,
  );
  assert.equal(findDevice(track, "Auto Filter", 2).name, "Auto Filter");
});

test("findDevice validates that deviceIndex matches the requested name", () => {
  const track = fakeTrack("Lead", [
    fakeDevice("Operator"),
    fakeDevice("Auto Filter"),
  ]);

  assert.throws(
    () => findDevice(track, "Auto Filter", 0),
    /is "Operator", not "Auto Filter"/,
  );
});

test("resolveDeviceTarget follows nested Rack device paths", () => {
  const nestedSimpler = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Nested Simpler" },
    parameters: { enumerable: true, value: [] },
  });
  const innerRack = Object.defineProperties(Object.create(RackDevice.prototype), {
    name: { enumerable: true, value: "Inner Rack" },
    chains: { enumerable: true, value: [{ devices: [nestedSimpler] }] },
  });
  const outerRack = Object.defineProperties(Object.create(RackDevice.prototype), {
    name: { enumerable: true, value: "Outer Rack" },
    chains: { enumerable: true, value: [{ devices: [innerRack] }] },
  });
  const track = fakeTrack("Lead", [outerRack]);

  const resolved = resolveDeviceTarget(
    track,
    {},
    "Nested Simpler",
    {
      deviceIndex: 0,
      nested: [
        { chainIndex: 0, deviceIndex: 0 },
        { chainIndex: 0, deviceIndex: 0 },
      ],
    },
  );

  assert.equal(resolved.device, nestedSimpler);
  assert.equal(resolved.parent, outerRack.chains[0]?.devices[0] === innerRack
    ? innerRack.chains[0]
    : undefined);
});

test("resolveDeviceTarget uses the exact selected nested Device", () => {
  const selected = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Selected Simpler" },
    parameters: { enumerable: true, value: [] },
  });
  const rack = Object.defineProperties(Object.create(RackDevice.prototype), {
    name: { enumerable: true, value: "Rack" },
    chains: { enumerable: true, value: [{ devices: [selected] }] },
  });
  const track = fakeTrack("Lead", [rack]);

  const resolved = resolveDeviceTarget(
    track,
    { track, object: selected },
    "Selected Simpler",
  );

  assert.equal(resolved.device, selected);
});

test("an explicit deviceIndex takes precedence over the selected Device", () => {
  const selected = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Simpler" },
  });
  const indexed = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Simpler" },
  });
  const track = fakeTrack("Lead", [selected, indexed]);

  const resolved = resolveDeviceTarget(
    track,
    { track, object: selected },
    "Simpler",
    undefined,
    1,
  );

  assert.equal(resolved.device, indexed);
});

test("an explicit Track ignores a Device selected on another Track", () => {
  const selectedTrack = Object.defineProperties(Object.create(Track.prototype), {
    name: { enumerable: true, value: "Lead" },
    devices: { enumerable: true, value: [] },
  });
  const returnTrack = Object.defineProperties(Object.create(Track.prototype), {
    name: { enumerable: true, value: "A-Reverb" },
    devices: { enumerable: true, value: [] },
  });
  const selected = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Utility" },
    parent: { enumerable: true, value: selectedTrack },
  });
  const explicit = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Utility" },
    parent: { enumerable: true, value: returnTrack },
  });
  selectedTrack.devices.push(selected);
  returnTrack.devices.push(explicit);

  const resolved = resolveDeviceTarget(
    returnTrack as never,
    { track: selectedTrack as never, object: selected },
    "Utility",
  );

  assert.equal(resolved.device, explicit);
});

test("resolveDeviceTarget rejects a mismatched nested Device name", () => {
  const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
    name: { enumerable: true, value: "Actual Simpler" },
  });
  const rack = Object.defineProperties(Object.create(RackDevice.prototype), {
    name: { enumerable: true, value: "Rack" },
    chains: { enumerable: true, value: [{ devices: [simpler] }] },
  });
  const track = fakeTrack("Lead", [rack]);

  assert.throws(
    () => resolveDeviceTarget(
      track,
      {},
      "Wrong Simpler",
      { deviceIndex: 0, nested: [{ chainIndex: 0, deviceIndex: 0 }] },
    ),
    /is "Actual Simpler", not "Wrong Simpler"/,
  );
});

test("resolveRackChainTarget resolves an exact existing empty Chain", () => {
  const chain = { handle: { id: "chain-1" }, devices: [] };
  const rack = Object.defineProperties(Object.create(RackDevice.prototype), {
    name: { enumerable: true, value: "Instrument Rack" },
    chains: { enumerable: true, value: [chain] },
  });
  const track = fakeTrack("Lead", [rack]);

  const resolved = resolveRackChainTarget(
    track,
    {},
    "Instrument Rack",
    { deviceIndex: 0 },
    0,
  );

  assert.equal(resolved.rackTarget.device, rack);
  assert.equal(resolved.chain, chain);
  assert.throws(
    () => resolveRackChainTarget(
      track,
      {},
      "Instrument Rack",
      { deviceIndex: 0 },
      1,
    ),
    /has 1 chains; chain 1 does not exist/i,
  );
});

function fakeTrack(name: string, devices: Array<{ name: string }> = []) {
  return { name, devices } as never;
}

function fakeContext(tracks: Array<{ name: string; devices: unknown[] }>) {
  return { application: { song: { tracks } } } as never;
}

function fakeDevice(name: string) {
  return { name };
}
