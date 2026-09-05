import {
  Chain, ClipSlot, Device, DeviceParameter, MidiClip, MidiTrack, RackDevice,
  type ExtensionContext, type NoteDescription,
} from "@ableton-extensions/sdk";

export function midiPreviewFixture(notes: NoteDescription[] = [], session = false) {
  let noteReads = 0;
  let writes = 0;
  let currentNotes = notes;
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: 10n }, name: "Bass", arrangementClips: [], clipSlots: [],
    takeLanes: [], devices: [], mute: false, solo: false, arm: false,
    mutedViaSolo: false, groupTrack: null,
  });
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    handle: { id: 11n }, parent: track,
  });
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: 12n }, name: "Phrase", startTime: session ? 0 : 32,
    endTime: session ? 8 : 40, duration: 8, startMarker: 0, endMarker: 8,
    looping: false, loopStart: 0, loopEnd: 8, color: 0, muted: false,
    parent: session ? slot : track,
  });
  Object.defineProperty(clip, "notes", {
    get: () => { noteReads += 1; return currentNotes; },
    set: (value: NoteDescription[]) => { writes += 1; currentNotes = value; },
  });
  Object.defineProperty(slot, "clip", { value: clip });
  Object.defineProperty(track, session ? "clipSlots" : "arrangementClips", {
    value: session ? [slot] : [clip],
  });
  const context = {
    application: { song: { handle: { id: 1n }, tracks: [track], scenes: [] } },
  } as unknown as ExtensionContext<"1.0.0">;
  return {
    context, track, clip,
    get noteReads() { return noteReads; },
    get writes() { return writes; },
    get notes() { return currentNotes; },
    set notes(value: NoteDescription[]) { currentNotes = value; },
  };
}

export function parameterPreviewFixture() {
  const midi = midiPreviewFixture();
  let value = 10;
  let valueReads = 0;
  let writes = 0;
  const metadata = { isQuantized: false, valueItems: [] as { name: string; shortName: string }[] };
  const parameter = sdkObject<DeviceParameter<"1.0.0">>(DeviceParameter.prototype, {
    handle: { id: 20n }, name: "Amount", min: 10, max: 20,
    getValue: async () => { valueReads += 1; return value; },
    setValue: async (next: number) => { writes += 1; value = next; },
  });
  Object.defineProperties(parameter, {
    isQuantized: { configurable: true, get: () => metadata.isQuantized },
    valueItems: { configurable: true, get: () => metadata.valueItems },
  });
  const device = sdkObject<Device<"1.0.0">>(Device.prototype, {
    handle: { id: 21n }, name: "Filter", parameters: [parameter], parent: midi.track,
  });
  const mixer = { volume: parameter, panning: parameter, sends: [parameter] };
  const chain = sdkObject<Chain<"1.0.0">>(Chain.prototype, {
    handle: { id: 22n }, mixer, devices: [],
  });
  const rack = sdkObject<RackDevice<"1.0.0">>(RackDevice.prototype, {
    handle: { id: 23n }, name: "Rack", chains: [chain], parameters: [], parent: midi.track,
  });
  Object.defineProperties(midi.track, { devices: { value: [device, rack] }, mixer: { value: mixer } });
  return {
    context: midi.context, track: midi.track, parameter, metadata,
    get valueReads() { return valueReads; },
    get writes() { return writes; },
    get value() { return value; },
    set value(next: number) { value = next; },
  };
}

function sdkObject<T>(prototype: object, values: Record<string, unknown>): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value, writable: true, configurable: true }]),
  )) as T;
}
