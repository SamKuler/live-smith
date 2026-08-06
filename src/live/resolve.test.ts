import assert from "node:assert/strict";
import test from "node:test";

import { RackDevice, Simpler } from "@ableton-extensions/sdk";

import {
  findDevice,
  resolveDeviceTarget,
  resolveTrack,
} from "./resolve.js";

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

function fakeTrack(name: string, devices: Array<{ name: string }> = []) {
  return { name, devices } as never;
}

function fakeContext(tracks: Array<{ name: string; devices: unknown[] }>) {
  return { application: { song: { tracks } } } as never;
}

function fakeDevice(name: string) {
  return { name };
}
