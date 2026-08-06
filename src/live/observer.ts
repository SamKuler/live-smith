import {
  AudioClip,
  Clip,
  ClipSlot,
  CuePoint,
  DataModelObject,
  Device,
  DeviceParameter,
  DrumChain,
  MidiClip,
  RackDevice,
  Sample,
  Scene,
  Simpler,
  TakeLane,
  Track,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import type { AgentObservationRequest } from "../agent/actions.js";
import { summarizeMidiNotes } from "./midi-notes.js";
import {
  equalsLoose,
  findDevice,
  resolveArrangementClip,
  resolveTrack,
} from "./resolve.js";
import { trackTypeLabel, type LiveTarget } from "./target.js";
import {
  collectDeviceTree,
  devicePathLabel,
  findDevicePath,
  resolveDevicePath,
  resolveDeviceTarget,
  type DevicePath,
} from "./device-tree.js";
import { audioFileLabel } from "./context.js";

type Api = ExtensionContext<"1.0.0">;

export async function observeLive(
  context: Api,
  request: AgentObservationRequest,
  target: LiveTarget,
): Promise<string> {
  switch (request.type) {
    case "inspect_live_set":
      return summarizeLiveSet(context);
    case "inspect_current_object":
      return summarizeCurrentObject(context, target);
    case "inspect_track": {
      const track = resolveTrack(context, request.trackName, target);
      return summarizeTrackWithDevices(track);
    }
    case "inspect_device": {
      const track = resolveTrack(context, request.trackName, target);
      const device = findDevice(track, request.deviceName, request.deviceIndex);
      return summarizeDevice(
        track.name,
        device.name,
        device.parameters,
        false,
        request.deviceIndex ?? track.devices.indexOf(device),
      );
    }
    case "inspect_device_tree":
      return summarizeDeviceTree(context, request, target);
    case "inspect_mixer": {
      const track = resolveTrack(context, request.trackName, target);
      return summarizeMixer(track);
    }
    case "inspect_clip": {
      if (request.slotIndex !== undefined) {
        const track = resolveTrack(context, request.trackName, target);
        const slot = track.clipSlots[request.slotIndex];
        if (!slot) {
          throw new Error(
            `Could not find Session slotIndex ${request.slotIndex} on track "${track.name}". It has ${track.clipSlots.length} slots.`,
          );
        }
        if (!slot.clip) {
          return `Session slotIndex ${request.slotIndex} on track "${track.name}" is empty.`;
        }
      }
      return summarizeClipDetail(resolveObservedClip(context, request, target));
    }
    case "inspect_midi_clip": {
      const clip = resolveMidiClip(context, request, target);
      return summarizeMidiClip(
        clip,
        request.noteOffset ?? 0,
        request.noteLimit ?? 128,
      );
    }
    case "inspect_song_info":
      return summarizeSongInfo(context);
  }
}

async function summarizeCurrentObject(context: Api, target: LiveTarget): Promise<string> {
  const object = target.object;
  if (!object) {
    throw new Error("No selected Live object is available for this Session.");
  }
  if (object instanceof Track) return summarizeTrackWithDevices(object);
  if (object instanceof Device) {
    const track = resolveTrack(context, undefined, target);
    const path = findDevicePath(track, object);
    if (!path) {
      throw new Error(`Selected device "${object.name}" is no longer inside track "${track.name}".`);
    }
    return summarizeDeviceTree(
      context,
      { type: "inspect_device_tree", deviceName: object.name, devicePath: path },
      target,
    );
  }
  if (object instanceof Clip) return summarizeClipDetail(object);
  if (object instanceof ClipSlot) {
    return object.clip
      ? `Selected Session Clip Slot contains:\n${summarizeClipDetail(object.clip)}`
      : "Selected Session Clip Slot is empty.";
  }
  if (object instanceof Sample) return `Selected Sample: ${audioFileLabel(object.filePath)}`;
  if (object instanceof Scene) {
    return `Selected Scene "${object.name}" tempo=${object.tempo || "-"} signature=${object.signatureNumerator}/${object.signatureDenominator}`;
  }
  if (object instanceof CuePoint) {
    return `Selected Cue Point "${object.name}" at beat ${object.time}.`;
  }
  if (object instanceof TakeLane) {
    return [
      `Selected Take Lane "${object.name}" has ${object.clips.length} clips:`,
      ...object.clips.slice(0, 24).map((clip) => `  - ${summarizeClipReference(clip)}`),
    ].join("\n");
  }
  return `Selected Live object: ${(object as DataModelObject<"1.0.0">).constructor.name}`;
}

async function summarizeDeviceTree(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "inspect_device_tree" }>,
  target: LiveTarget,
): Promise<string> {
  const track = resolveTrack(context, request.trackName, target);
  let rootPath: DevicePath | undefined;
  if (request.devicePath) {
    const resolved = resolveDevicePath(track, request.devicePath);
    if (request.deviceName && !equalsLoose(resolved.device.name, request.deviceName)) {
      throw new Error(
        `${devicePathLabel(request.devicePath)} is "${resolved.device.name}", not "${request.deviceName}".`,
      );
    }
    rootPath = resolved.path;
  } else if (request.deviceName) {
    rootPath = resolveDeviceTarget(track, target, request.deviceName).path;
  } else if (target.object instanceof Device) {
    rootPath = findDevicePath(track, target.object);
  }

  const entries = collectDeviceTree(track).filter(({ path }) =>
    rootPath ? pathStartsWith(path, rootPath) : true
  );
  if (!entries.length) {
    return `Track "${track.name}" has no devices${rootPath ? " at the requested path" : ""}.`;
  }

  const lines = [`Device tree on track "${track.name}":`];
  for (const { device, parent, path, depth } of entries.slice(0, 96)) {
    const details = [
      `type=${deviceTypeName(device)}`,
      `parameters=${device.parameters.length}`,
      ...(parent instanceof DrumChain ? [`receivingNote=${parent.receivingNote}`] : []),
      ...(device instanceof RackDevice ? [`chains=${device.chains.length}`] : []),
      ...(device instanceof Simpler
        ? [`sample=${device.sample ? audioFileLabel(device.sample.filePath) : "none"}`]
        : []),
    ];
    lines.push(
      `${"  ".repeat(depth)}- ${devicePathLabel(path)} Device "${device.name}" ${details.join(" ")}`,
    );
    for (const parameter of device.parameters.slice(0, 18)) {
      lines.push(`${"  ".repeat(depth + 1)}${await describeParameter(parameter)}`);
    }
    if (device.parameters.length > 18) {
      lines.push(`${"  ".repeat(depth + 1)}... ${device.parameters.length - 18} more parameters omitted.`);
    }
  }
  if (entries.length > 96) lines.push(`... ${entries.length - 96} more devices omitted.`);
  return lines.join("\n");
}

async function summarizeMixer(track: Track<"1.0.0">): Promise<string> {
  const parameters = [
    track.mixer.volume,
    track.mixer.panning,
    ...track.mixer.sends,
  ];
  return [
    `Mixer on track "${track.name}" has ${parameters.length} parameters:`,
    ...(await Promise.all(parameters.map(describeParameter))),
  ].join("\n");
}

function resolveObservedClip(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "inspect_clip" }>,
  target: LiveTarget,
): Clip<"1.0.0"> {
  if (request.startBeat !== undefined && request.slotIndex !== undefined) {
    throw new Error("inspect_clip uses either startBeat or slotIndex, not both.");
  }
  const hasExplicitLocator = Boolean(
    request.trackName || request.clipName ||
    request.startBeat !== undefined || request.slotIndex !== undefined,
  );
  if (!hasExplicitLocator && target.clip) return target.clip;

  const track = resolveTrack(context, request.trackName, target);
  if (request.slotIndex !== undefined) {
    const slot = track.clipSlots[request.slotIndex];
    if (!slot) {
      throw new Error(
        `Could not find Session slotIndex ${request.slotIndex} on track "${track.name}". It has ${track.clipSlots.length} slots.`,
      );
    }
    if (!slot.clip) {
      throw new Error(`Session slotIndex ${request.slotIndex} on track "${track.name}" is empty.`);
    }
    if (request.clipName && !equalsLoose(slot.clip.name, request.clipName)) {
      throw new Error(
        `Session slotIndex ${request.slotIndex} contains "${slot.clip.name}", not "${request.clipName}".`,
      );
    }
    return slot.clip;
  }

  if (request.startBeat !== undefined) {
    return resolveArrangementClip(track, request.startBeat, request.clipName);
  }

  const clips = [
    ...track.arrangementClips,
    ...track.clipSlots.flatMap((slot) => slot.clip ? [slot.clip] : []),
    ...track.takeLanes.flatMap((lane) => lane.clips),
  ].filter((clip) => request.clipName ? equalsLoose(clip.name, request.clipName) : true);
  if (clips.length === 1) return clips[0]!;
  if (!clips.length) {
    throw new Error(`Could not find Clip${request.clipName ? ` "${request.clipName}"` : ""} on track "${track.name}".`);
  }
  throw new Error(
    `Found ${clips.length} matching Clips on track "${track.name}". Specify startBeat or slotIndex.`,
  );
}

function summarizeClipDetail(clip: Clip<"1.0.0">): string {
  const lines = [
    `${clip instanceof MidiClip ? "MIDI" : clip instanceof AudioClip ? "Audio" : "Unknown"} Clip "${clip.name}"`,
    `start=${clip.startTime} end=${clip.endTime} duration=${clip.duration}`,
    `looping=${clip.looping} loopStart=${clip.loopStart} loopEnd=${clip.loopEnd}`,
    `muted=${clip.muted} color=${clip.color}`,
  ];
  if (clip instanceof MidiClip) {
    lines.push(summarizeMidiNotes(clip.notes, { offset: 0, limit: 128 }));
  }
  if (clip instanceof AudioClip) {
    lines.push(
      `file=${audioFileLabel(clip.filePath)}`,
      `warping=${clip.warping} warpMode=${clip.warpMode} warpMarkers=${clip.warpMarkers.length}`,
    );
  }
  return lines.join("\n");
}

function pathStartsWith(path: DevicePath, root: DevicePath): boolean {
  if (path.deviceIndex !== root.deviceIndex) return false;
  const pathNested = path.nested ?? [];
  const rootNested = root.nested ?? [];
  if (rootNested.length > pathNested.length) return false;
  return rootNested.every((segment, index) => {
    const candidate = pathNested[index];
    return candidate?.chainIndex === segment.chainIndex &&
      candidate.deviceIndex === segment.deviceIndex;
  });
}

function deviceTypeName(device: Device<"1.0.0">): string {
  if (device instanceof Simpler) return "Simpler";
  if (device instanceof RackDevice) return device.constructor.name;
  return device.constructor.name || "Device";
}

function summarizeSongInfo(context: Api): string {
  const song = context.application.song;
  const cuePoints = song.cuePoints ?? [];
  const lines = [
    `Tempo: ${song.tempo} BPM`,
    `Grid: ${gridLabel(song.gridQuantization)}${song.gridIsTriplet ? " (triplet)" : ""}`,
    `Scale: ${song.scaleMode ? `${song.scaleName} (root=${song.rootNote})` : "Off"}`,
    `Tracks: ${song.tracks.length}`,
    `Scenes: ${song.scenes.length}`,
    `Cue Points: ${cuePoints.length}`,
  ];
  for (const [i, scene] of song.scenes.slice(0, 16).entries()) {
    lines.push(`  Scene index ${i}: "${scene.name}" tempo=${scene.tempo || "-"}`);
  }
  if (song.scenes.length > 16) {
    lines.push(`  ... ${song.scenes.length - 16} more scenes omitted.`);
  }
  for (const cuePoint of cuePoints.slice(0, 32)) {
    lines.push(`  Cue Point beat ${cuePoint.time}: "${cuePoint.name}"`);
  }
  if (cuePoints.length > 32) {
    lines.push(`  ... ${cuePoints.length - 32} more Cue Points omitted.`);
  }
  return lines.join("\n");
}

function gridLabel(q: number): string {
  const names: Record<number, string> = {
    0: "No grid", 1: "8 bars", 2: "4 bars", 3: "2 bars", 4: "1 bar",
    5: "1/2", 6: "1/4", 7: "1/8", 8: "1/16", 9: "1/32",
  };
  return names[q] ?? String(q);
}

function summarizeLiveSet(context: Api): string {
  const tracks = context.application.song.tracks;
  return [
    `Live set has ${tracks.length} tracks.`,
    ...tracks.map((track, index) =>
      [
        `Track ${index + 1}: ${trackTypeLabel(track)} "${track.name}"`,
        `  devices=${track.devices.map((device) => device.name).join(", ") || "none"}`,
      ].join("\n"),
    ),
  ].join("\n");
}

async function summarizeTrackWithDevices(track: Track<"1.0.0">): Promise<string> {
  const takeLanes = safeTakeLanes(track);
  const lines = [
    `${trackTypeLabel(track)} track "${track.name}"`,
    `mute=${track.mute}, solo=${track.solo}, armed=${track.arm}`,
    `arrangement clips=${track.arrangementClips.length}`,
    ...track.arrangementClips
      .slice(0, 12)
      .map((clip) => `  - ${summarizeClipReference(clip)}`),
    `clip slots=${track.clipSlots.length}`,
    ...track.clipSlots
      .slice(0, 12)
      .map((slot, index) =>
        slot.clip
          ? `  - slot index ${index}: ${summarizeClipReference(slot.clip)}`
          : `  - slot index ${index}: empty`,
      ),
    `take lanes=${takeLanes.length}`,
    ...takeLanes
      .slice(0, 16)
      .map((lane, index) =>
        `  - lane index ${index}: "${lane.name}" clips=${lane.clips.length}`,
      ),
    `devices=${track.devices.map((device, index) => `${index}: ${device.name}`).join(", ") || "none"}`,
  ];

  for (const [index, device] of track.devices.entries()) {
    lines.push(await summarizeDevice(track.name, device.name, device.parameters, true, index));
  }

  return lines.join("\n");
}

function safeTakeLanes(track: Track<"1.0.0">): TakeLane<"1.0.0">[] {
  try {
    return track.takeLanes;
  } catch {
    return [];
  }
}

function resolveMidiClip(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "inspect_midi_clip" }>,
  target: LiveTarget,
): MidiClip<"1.0.0"> {
  if (
    !request.trackName &&
    !request.clipName &&
    request.startBeat === undefined &&
    target.clip instanceof MidiClip
  ) {
    return target.clip;
  }

  const track = resolveTrack(context, request.trackName, target);
  const candidates = midiClipsOnTrack(track);
  const matching = candidates.filter((clip) => {
    const nameMatches = request.clipName ? equalsLoose(clip.name, request.clipName) : true;
    const startMatches =
      request.startBeat === undefined ||
      Math.abs(clip.startTime - request.startBeat) < 0.0001;
    return nameMatches && startMatches;
  });

  if (matching.length === 1) return matching[0]!;

  if (!matching.length) {
    throw new Error(
      [
        `Could not find MIDI clip${request.clipName ? ` "${request.clipName}"` : ""} on track "${track.name}".`,
        "Available MIDI clips:",
        ...candidates.map((clip) => `- ${clip.name} start=${clip.startTime} duration=${clip.duration}`),
      ].join("\n"),
    );
  }

  throw new Error(
    [
      `Found ${matching.length} matching MIDI clips on track "${track.name}". Add startBeat to disambiguate.`,
      ...matching.map((clip) => `- ${clip.name} start=${clip.startTime} duration=${clip.duration}`),
    ].join("\n"),
  );
}

function midiClipsOnTrack(track: Track<"1.0.0">): MidiClip<"1.0.0">[] {
  return [
    ...track.arrangementClips.filter((clip): clip is MidiClip<"1.0.0"> => clip instanceof MidiClip),
    ...track.takeLanes
      .flatMap((takeLane) => takeLane.clips)
      .filter((clip): clip is MidiClip<"1.0.0"> => clip instanceof MidiClip),
    ...track.clipSlots
      .map((slot) => slot.clip)
      .filter((clip): clip is MidiClip<"1.0.0"> => clip instanceof MidiClip),
  ];
}

function summarizeMidiClip(
  clip: MidiClip<"1.0.0">,
  noteOffset: number,
  noteLimit: number,
): string {
  return [
    `MIDI clip "${clip.name}"`,
    `start=${clip.startTime}, end=${clip.endTime}, duration=${clip.duration}`,
    `looping=${clip.looping}, muted=${clip.muted}`,
    summarizeMidiNotes(clip.notes, { offset: noteOffset, limit: noteLimit }),
  ].join("\n");
}

function summarizeClipReference(clip: Clip<"1.0.0">): string {
  const kind = clip instanceof MidiClip ? "MIDI" : "Audio";
  const suffix = clip instanceof MidiClip ? `, notes=${clip.notes.length}` : "";
  return `${kind} clip "${clip.name}" start=${clip.startTime} duration=${clip.duration}${suffix}`;
}

async function summarizeDevice(
  trackName: string,
  deviceName: string,
  parameters: DeviceParameter<"1.0.0">[],
  compact = false,
  deviceIndex?: number,
): Promise<string> {
  const limit = compact ? 18 : 80;
  const shown = parameters.slice(0, limit);
  const lines = [
    `Device "${deviceName}"${deviceIndex !== undefined ? ` at deviceIndex ${deviceIndex}` : ""} on track "${trackName}" has ${parameters.length} parameters:`,
    ...(await Promise.all(shown.map(describeParameter))),
  ];

  if (parameters.length > shown.length) {
    lines.push(`... ${parameters.length - shown.length} more parameters omitted.`);
  }

  return lines.join("\n");
}

async function describeParameter(parameter: DeviceParameter<"1.0.0">): Promise<string> {
  const value = await parameter.getValue().catch(() => undefined);
  const valueText = value === undefined ? "unknown" : String(value);
  const valueItems = parameter.valueItems
    .slice(0, 12)
    .map((item) => item.name)
    .join(", ");
  return [
    `  - ${parameter.name}`,
    `min=${parameter.min}`,
    `max=${parameter.max}`,
    `current=${valueText}`,
    `default=${parameter.defaultValue}`,
    `quantized=${parameter.isQuantized}`,
    valueItems ? `items=${valueItems}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
