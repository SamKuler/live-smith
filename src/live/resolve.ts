import {
  type Chain,
  Clip,
  Device,
  MidiClip,
  MidiTrack,
  Track,
  type CuePoint,
  type DeviceParameter,
  type ExtensionContext,
  type Scene,
  type Song,
  type TakeLane,
} from "@ableton-extensions/sdk";

import { trackTypeLabel, type LiveTarget } from "./target.js";
export {
  resolveDeviceTarget,
  type DevicePath,
  type ResolvedDeviceTarget,
} from "./device-tree.js";

type Api = ExtensionContext<"1.0.0">;

export type ExplicitTrackRole = "return" | "main";

export interface TrackSelector {
  trackName?: string;
  trackRole?: ExplicitTrackRole;
  trackIndex?: number;
}

export type SongTrackEntry =
  | { role: "regular"; index: number; track: Track<"1.0.0"> }
  | { role: "return"; index: number; track: Track<"1.0.0"> }
  | { role: "main"; track: Track<"1.0.0"> };

export function songTrackEntries(song: Song<"1.0.0">): SongTrackEntry[] {
  const mainTrack = song.mainTrack;
  return [
    ...(song.tracks ?? []).map((track, index) => ({
      role: "regular" as const,
      index,
      track,
    })),
    ...(song.returnTracks ?? []).map((track, index) => ({
      role: "return" as const,
      index,
      track,
    })),
    ...(mainTrack ? [{ role: "main" as const, track: mainTrack }] : []),
  ];
}

export function songTrackEntryForTrack(
  song: Song<"1.0.0">,
  track: Track<"1.0.0">,
): SongTrackEntry | undefined {
  return songTrackEntries(song).find((entry) => sameTrack(entry.track, track));
}

export function trackHeading(
  song: Song<"1.0.0">,
  track: Track<"1.0.0">,
): string {
  const entry = songTrackEntryForTrack(song, track);
  if (entry?.role === "return") return `Return track index ${entry.index}`;
  if (entry?.role === "main") return "Main track";
  return `${trackTypeLabel(track)} track`;
}

export function resolveTrackSelector(
  context: Api,
  selector: TrackSelector,
  target: LiveTarget,
): Track<"1.0.0"> {
  const song = context.application.song;
  if (selector.trackRole === "return") {
    if (!Number.isSafeInteger(selector.trackIndex) || (selector.trackIndex ?? -1) < 0) {
      throw new Error("Return track selection requires a non-negative trackIndex.");
    }
    const returnTracks = song.returnTracks ?? [];
    const track = returnTracks[selector.trackIndex!];
    if (!track) {
      throw new Error(
        `Could not find Return track index ${selector.trackIndex}. The Live Set has ${returnTracks.length} Return tracks.`,
      );
    }
    assertExpectedTrackName(track, selector.trackName, `Return track index ${selector.trackIndex}`);
    return track;
  }
  if (selector.trackRole === "main") {
    if (selector.trackIndex !== undefined) {
      throw new Error("Main track selection does not use trackIndex.");
    }
    const track = song.mainTrack;
    if (!track) throw new Error("Could not find the Main track.");
    assertExpectedTrackName(track, selector.trackName, "Main track");
    return track;
  }
  if (selector.trackIndex !== undefined) {
    throw new Error("trackIndex is valid only with trackRole return.");
  }
  return resolveTrack(context, selector.trackName, target);
}

export function resolveTrack(
  context: Api,
  trackName: string | undefined,
  target: LiveTarget,
  required?: true,
): Track<"1.0.0">;
export function resolveTrack(
  context: Api,
  trackName: string | undefined,
  target: LiveTarget,
  required: false,
): Track<"1.0.0"> | undefined;
export function resolveTrack(
  context: Api,
  trackName: string | undefined,
  target: LiveTarget,
  required = true,
): Track<"1.0.0"> | undefined {
  if (trackName) {
    const matches = context.application.song.tracks.filter((track) =>
      equalsLoose(track.name, trackName),
    );

    if (matches.length === 1) return matches[0];

    if (matches.length > 1) {
      throw new Error(
        `Found ${matches.length} tracks named "${trackName}". Rename them to make the target unambiguous.`,
      );
    }

    if (required) {
      throw new Error(`Could not find track "${trackName}".`);
    }

    return undefined;
  }

  const track = target.track;

  if (!track && required) {
    throw new Error("No target track is available for this action.");
  }

  return track;
}

export function resolveMidiTrack(
  context: Api,
  trackName: string | undefined,
  target: LiveTarget,
): MidiTrack<"1.0.0"> {
  const existing = resolveTrack(context, trackName, target, false);
  if (existing instanceof MidiTrack) return existing;

  if (existing) {
    throw new Error(`Track "${existing.name}" is not a MIDI track.`);
  }

  throw new Error(
    trackName
      ? `Could not find MIDI track "${trackName}". Add create_midi_track before create_midi_clip.`
      : "No target MIDI track is selected. Add create_midi_track before create_midi_clip.",
  );
}

export function findReusableMidiClip(
  clips: readonly Clip<"1.0.0">[],
  name: string,
  startBeat: number,
  durationBeats: number,
): MidiClip<"1.0.0"> | undefined {
  return clips.find(
    (clip): clip is MidiClip<"1.0.0"> =>
      clip instanceof MidiClip &&
      equalsLoose(clip.name, name) &&
      Math.abs(clip.startTime - startBeat) < 0.0001 &&
      Math.abs(clip.duration - durationBeats) < 0.0001,
  );
}

export function resolveArrangementClip(
  track: Track<"1.0.0">,
  startBeat: number,
  clipName?: string,
): Clip<"1.0.0"> {
  const clips = track.arrangementClips;
  const matching = clips.filter((clip) => {
    const nameOk = clipName ? equalsLoose(clip.name, clipName) : true;
    const startOk = Math.abs(clip.startTime - startBeat) < 0.0001;
    return nameOk && startOk;
  });
  if (matching.length === 1) return matching[0]!;
  if (!matching.length) {
    throw new Error(
      `Could not find clip${clipName ? ` "${clipName}"` : ""} on track "${track.name}". Available: ${clips.map((clip) => `${clip.name}@${clip.startTime}`).join(", ") || "none"}`,
    );
  }
  throw new Error(
    `Found ${matching.length} matching clips at beat ${startBeat} on track "${track.name}". Add clipName to disambiguate: ${matching.map((clip) => `${clip.name}@${clip.startTime}`).join(", ")}`,
  );
}

export function resolveSessionClip(
  track: Track<"1.0.0">,
  slotIndex: number,
  clipName?: string,
): Clip<"1.0.0"> {
  const slot = track.clipSlots[slotIndex];
  if (!slot) {
    throw new Error(
      `Could not find Session slot ${slotIndex} on track "${track.name}".`,
    );
  }
  const clip = slot.clip;
  if (!clip) {
    throw new Error(
      `Session slot ${slotIndex} on track "${track.name}" is empty.`,
    );
  }
  if (clipName && !equalsLoose(clip.name, clipName)) {
    throw new Error(
      `Session slot ${slotIndex} on track "${track.name}" contains "${clip.name}", not "${clipName}".`,
    );
  }
  return clip;
}

export function resolveClipLocator(
  track: Track<"1.0.0">,
  locator: { clipName?: string; startBeat?: number; slotIndex?: number },
): Clip<"1.0.0"> {
  if (locator.slotIndex !== undefined) {
    return resolveSessionClip(track, locator.slotIndex, locator.clipName);
  }
  if (locator.startBeat !== undefined) {
    return resolveArrangementClip(track, locator.startBeat, locator.clipName);
  }
  throw new Error("Clip locator requires startBeat or slotIndex.");
}

export function findDevice(
  track: Track<"1.0.0">,
  deviceName: string,
  deviceIndex?: number,
): Device<"1.0.0"> {
  if (deviceIndex !== undefined) {
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex >= track.devices.length) {
      throw new Error(
        `Could not find deviceIndex ${deviceIndex} on track "${track.name}". Available devices: ${deviceList(track)}`,
      );
    }
    const device = track.devices[deviceIndex]!;
    if (!equalsLoose(device.name, deviceName)) {
      throw new Error(
        `Device at index ${deviceIndex} on track "${track.name}" is "${device.name}", not "${deviceName}". Available devices: ${deviceList(track)}`,
      );
    }
    return device;
  }

  const matches = track.devices
    .map((device, index) => ({ device, index }))
    .filter((item) => equalsLoose(item.device.name, deviceName));

  if (!matches.length) {
    const available = track.devices.map((item) => item.name).join(", ") || "none";
    throw new Error(
      `Could not find device "${deviceName}" on track "${track.name}". Available devices: ${available}`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} devices named "${deviceName}" on track "${track.name}". Specify deviceIndex. Available devices: ${deviceList(track)}`,
    );
  }

  return matches[0]!.device;
}

export function equalsLoose(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function assertExpectedTrackName(
  track: Track<"1.0.0">,
  expectedName: string | undefined,
  locator: string,
): void {
  if (expectedName && !equalsLoose(track.name, expectedName)) {
    throw new Error(`${locator} is "${track.name}", not "${expectedName}".`);
  }
}

function sameTrack(left: Track<"1.0.0">, right: Track<"1.0.0">): boolean {
  if (left === right) return true;
  const leftId = left.handle?.id;
  const rightId = right.handle?.id;
  return leftId !== undefined && leftId !== null &&
    rightId !== undefined && rightId !== null &&
    String(leftId) === String(rightId);
}

export function resolveTrackMixerParameter(
  track: Track<"1.0.0">,
  kind: "volume" | "panning" | "send",
  sendIndex?: number,
): DeviceParameter<"1.0.0"> {
  return resolveMixerParameter(
    track.mixer,
    kind,
    sendIndex,
    `Track "${track.name}"`,
  );
}

export function resolveChainMixerParameter(
  chain: Chain<"1.0.0">,
  kind: "volume" | "panning" | "send",
  sendIndex?: number,
): DeviceParameter<"1.0.0"> {
  return resolveMixerParameter(chain.mixer, kind, sendIndex, "Rack Chain");
}

function resolveMixerParameter(
  mixer: {
    volume: DeviceParameter<"1.0.0">;
    panning: DeviceParameter<"1.0.0">;
    sends: DeviceParameter<"1.0.0">[];
  },
  kind: "volume" | "panning" | "send",
  sendIndex: number | undefined,
  owner: string,
): DeviceParameter<"1.0.0"> {
  if (kind === "volume") return mixer.volume;
  if (kind === "panning") return mixer.panning;
  if (sendIndex === undefined) {
    throw new Error("Mixer send actions require sendIndex.");
  }
  const sends = mixer.sends;
  const parameter = sends[sendIndex];
  if (!parameter) {
    throw new Error(
      `${owner} has ${sends.length} sends; send ${sendIndex} does not exist.`,
    );
  }
  return parameter;
}

export function resolveScene(
  song: Song<"1.0.0">,
  sceneIndex: number,
  expectedName?: string,
): Scene<"1.0.0"> {
  const scene = song.scenes[sceneIndex];
  if (!scene) {
    throw new Error(
      `Could not find Scene ${sceneIndex}. The Live Set has ${song.scenes.length} Scenes.`,
    );
  }
  if (expectedName && !equalsLoose(scene.name, expectedName)) {
    throw new Error(
      `Scene ${sceneIndex} is "${scene.name}", not "${expectedName}".`,
    );
  }
  return scene;
}

export function resolveCuePoint(
  song: Song<"1.0.0">,
  timeBeat: number,
  expectedName?: string,
): CuePoint<"1.0.0"> {
  const matches = song.cuePoints.filter(
    (cue) =>
      Math.abs(cue.time - timeBeat) < 0.0001 &&
      (!expectedName || equalsLoose(cue.name, expectedName)),
  );
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    throw new Error(
      `Could not find Cue Point${expectedName ? ` "${expectedName}"` : ""} at beat ${timeBeat}.`,
    );
  }
  throw new Error(
    `Found ${matches.length} Cue Points at beat ${timeBeat}. Provide cueName to disambiguate.`,
  );
}

export function resolveTakeLane(
  track: Track<"1.0.0">,
  laneIndex: number,
  expectedName?: string,
): TakeLane<"1.0.0"> {
  const lane = track.takeLanes[laneIndex];
  if (!lane) {
    throw new Error(
      `Could not find Take Lane ${laneIndex} on track "${track.name}". It has ${track.takeLanes.length} Take Lanes.`,
    );
  }
  if (expectedName && !equalsLoose(lane.name, expectedName)) {
    throw new Error(
      `Take Lane ${laneIndex} on track "${track.name}" is "${lane.name}", not "${expectedName}".`,
    );
  }
  return lane;
}

function deviceList(track: Track<"1.0.0">): string {
  return track.devices
    .map((device, index) => `${index}: ${device.name}`)
    .join(", ") || "none";
}
