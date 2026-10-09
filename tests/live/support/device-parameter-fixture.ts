import { Device, DeviceParameter, MidiTrack, type ExtensionContext } from "@ableton-extensions/sdk";
import { parameterDeviceTargets } from "../../../src/live/device-parameters.js";

function host<T extends object>(prototype: T, properties: Record<string, unknown>): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { value, writable: true, configurable: true }])));
}
export function deviceParameterFixture(count = 3) {
  const writes: number[][] = [];
  const parameters = Array.from({ length: count }, (_, index) => {
    const state = { value: 0.25 };
    const parameter = host(DeviceParameter.prototype, { handle: { id: BigInt(100 + index) }, name: index < 2 ? "Gain" : `Parameter ${index}`,
      min: 0, max: 1, defaultValue: 0.25, isQuantized: false, valueItems: [],
      getValue: async () => state.value,
      setValue: async (value: number) => { writes.push([index, value]); state.value = value; },
    }) as DeviceParameter<"1.0.0">;
    return { parameter, state };
  });
  const device = host(Device.prototype, { handle: { id: 3n }, name: "Synth", parameters: parameters.map((entry) => entry.parameter) }) as Device<"1.0.0">;
  const track = host(MidiTrack.prototype, { handle: { id: 2n }, name: "Lead", devices: [device], arrangementClips: [], clipSlots: [], takeLanes: [],
    mute: false, solo: false, arm: false, mutedViaSolo: false, groupTrack: null, isGrouped: false, isFoldable: false, color: 0,
  }) as MidiTrack<"1.0.0">;
  const song = { handle: { id: 1n }, tempo: 120, tracks: [track], returnTracks: [], scenes: [] };
  const context = { application: { song } } as unknown as ExtensionContext<"1.0.0">;
  const target = parameterDeviceTargets(context)[0]!.target;
  return { context, song, track, device, target, parameters, writes };
}
