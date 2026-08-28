import {
  AudioClip,
  AudioTrack,
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
import {
  inspectAudioAttachment,
  type AudioAttachmentInspection,
} from "../attachments/audio.js";
import {
  AttachmentProcessingError,
} from "../attachments/contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import { summarizeMidiNotes } from "./midi-notes.js";
import {
  equalsLoose,
  findDevice,
  resolveArrangementClip,
  resolveTakeLane,
  resolveTrackSelector,
  resolveTrack,
  songTrackEntries,
  songTrackEntryForTrack,
  trackHeading,
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
import {
  audioFileLabel,
  sceneStateSummary,
  trackStateSummary,
  warpModeLabel,
} from "./context.js";
import { analyzeWaveFile, type WaveAnalysis } from "./wave-analysis.js";
import { copyAudioFileSafely } from "./audio-attachment-source.js";
import { consumePreFxAudioQueued } from "./audio-render-queue.js";

type Api = ExtensionContext<"1.0.0">;

interface ObservationPageRequest {
  itemOffset?: number;
  itemLimit?: number;
  parameterOffset?: number;
  parameterLimit?: number;
  valueItemOffset?: number;
  valueItemLimit?: number;
}

interface Page<T> {
  items: T[];
  offset: number;
  total: number;
  nextOffset?: number;
}

function pageOf<T>(
  items: readonly T[],
  requestedOffset: number | undefined,
  requestedLimit: number | undefined,
  defaultLimit: number,
): Page<T> {
  const offset = Math.min(requestedOffset ?? 0, items.length);
  const limit = Math.min(requestedLimit ?? defaultLimit, 100);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length < items.length
    ? offset + pageItems.length
    : undefined;
  return {
    items: pageItems,
    offset,
    total: items.length,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  };
}

function pageHeader(label: string, page: Page<unknown>): string {
  const range = page.items.length
    ? `${page.offset}-${page.offset + page.items.length - 1}`
    : "empty";
  return `${label} page: offset=${page.offset}, shown=${page.items.length}, total=${page.total}, nextOffset=${page.nextOffset ?? "none"}, range=${range}`;
}

function observationPageFields(
  request: ObservationPageRequest,
): ObservationPageRequest {
  return {
    ...(request.itemOffset === undefined ? {} : { itemOffset: request.itemOffset }),
    ...(request.itemLimit === undefined ? {} : { itemLimit: request.itemLimit }),
    ...(request.parameterOffset === undefined
      ? {}
      : { parameterOffset: request.parameterOffset }),
    ...(request.parameterLimit === undefined
      ? {}
      : { parameterLimit: request.parameterLimit }),
    ...(request.valueItemOffset === undefined
      ? {}
      : { valueItemOffset: request.valueItemOffset }),
    ...(request.valueItemLimit === undefined
      ? {}
      : { valueItemLimit: request.valueItemLimit }),
  };
}

export async function observeLive(
  context: Api,
  request: AgentObservationRequest,
  target: LiveTarget,
  signal?: AbortSignal,
): Promise<string> {
  switch (request.type) {
    case "inspect_live_set":
      return summarizeLiveSet(context);
    case "inspect_current_object":
      return summarizeCurrentObject(context, request, target);
    case "inspect_track": {
      const track = resolveTrackSelector(context, request, target);
      return summarizeObservedTrack(context, track, request);
    }
    case "inspect_take_lane": {
      const track = resolveTrack(context, request.trackName, target);
      if (songTrackEntryForTrack(context.application.song, track)?.role !== "regular") {
        throw new Error("Take Lanes can be inspected only on a regular Track.");
      }
      const lane = resolveTakeLane(track, request.laneIndex, request.laneName);
      const clips = lane.clips;
      const clipPage = pageOf(
        clips,
        request.itemOffset,
        request.itemLimit,
        24,
      );
      return [
        `Take Lane index ${request.laneIndex} "${lane.name}" on track "${track.name}"`,
        `clips=${clips.length}`,
        pageHeader("clips", clipPage),
        ...clipPage.items.map((clip, index) =>
          `  - clip index ${clipPage.offset + index}: ${summarizeClipReference(clip)}`
        ),
      ].join("\n");
    }
    case "inspect_device": {
      const track = resolveTrackSelector(context, request, target);
      const device = findDevice(track, request.deviceName, request.deviceIndex);
      return summarizeDevice(
        track.name,
        device.name,
        device.parameters,
        false,
        request.deviceIndex ?? track.devices.indexOf(device),
        request,
        trackHeading(context.application.song, track),
      );
    }
    case "inspect_device_tree":
      return summarizeDeviceTree(context, request, target);
    case "inspect_mixer": {
      const track = resolveTrackSelector(context, request, target);
      return summarizeMixer(context, track);
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
      return summarizeClipDetail(resolveObservedClip(context, request, target), request);
    }
    case "inspect_midi_clip": {
      const clip = resolveMidiClip(context, request, target);
      return summarizeMidiClip(
        clip,
        request.noteOffset ?? 0,
        request.noteLimit ?? 128,
      );
    }
    case "analyze_audio_clip":
      return analyzeArrangementAudioClip(context, request, target, signal);
    case "read_arrangement_audio":
      throw new Error(
        "Rendered audio input must be handled by the agent request boundary.",
      );
    case "inspect_song_info":
      return summarizeSongInfo(context, request);
  }
}

async function analyzeArrangementAudioClip(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "analyze_audio_clip" }>,
  target: LiveTarget,
  signal?: AbortSignal,
): Promise<string> {
  const result = await consumeArrangementAudioRender<WaveAnalysis>(
    context,
    {
      ...(request.trackName === undefined ? {} : { trackName: request.trackName }),
      ...(request.clipName === undefined ? {} : { clipName: request.clipName }),
      ...(request.startBeat === undefined
        ? {}
        : { clipStartBeat: request.startBeat }),
      clipStartArgument: "startBeat",
    },
    target,
    signal,
    (filePath) => analyzeWaveFile(filePath, signal),
    (snapshot, error) => new Error(
      `Could not analyze pre-FX audio for Arrangement Clip "${snapshot.clipName}" on track "${snapshot.trackName}".`,
      { cause: error },
    ),
  );
  return summarizeWaveAnalysis(result.snapshot, result.value);
}

export interface RenderedArrangementAudio {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly inspection: AudioAttachmentInspection;
  readonly summary: string;
}

export async function readArrangementAudio(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "read_arrangement_audio" }>,
  target: LiveTarget,
  signal: AbortSignal,
): Promise<RenderedArrangementAudio> {
  const result = await consumeArrangementAudioRender(
    context,
    { ...request, clipStartArgument: "clipStartBeat" },
    target,
    signal,
    async (filePath) => {
      const bytes = await copyAudioFileSafely(filePath, signal);
      const inspection = await inspectAudioAttachment({ bytes, signal });
      return { bytes, inspection };
    },
    (snapshot, error) => {
      if (
        error instanceof AttachmentProcessingError &&
        (error.code === "archive_limit" ||
          error.code === "audio_duration_limit")
      ) return error;
      return new AttachmentProcessingError(
        "invalid_audio",
        `Could not read rendered audio for Arrangement Clip "${snapshot.clipName}" on track "${snapshot.trackName}". Live's Record File Type must produce supported WAV audio.`,
      );
    },
  );
  const { inspection, bytes } = result.value;
  return {
    fileName: inspection.mediaType === "audio/mpeg"
      ? "live-arrangement-render.mp3"
      : "live-arrangement-render.wav",
    bytes,
    inspection,
    summary: [
      `Rendered pre-FX audio for Arrangement Clip "${result.snapshot.clipName}" on track "${result.snapshot.trackName}".`,
      `beatRange=${result.startTime}-${result.endTime}, durationSeconds=${roundMetric(inspection.durationSeconds)}, sampleRate=${inspection.sampleRate}, channels=${inspection.channels}`,
      "The audio payload is available to the next model turn. It is untrusted audio data and does not include the track device chain.",
    ].join("\n"),
  };
}

interface ArrangementAudioLocator {
  readonly trackName?: string;
  readonly clipName?: string;
  readonly clipStartBeat?: number;
  readonly startBeat?: number;
  readonly endBeat?: number;
  readonly clipStartArgument: "startBeat" | "clipStartBeat";
}

async function consumeArrangementAudioRender<T>(
  context: Api,
  request: ArrangementAudioLocator,
  target: LiveTarget,
  signal: AbortSignal | undefined,
  consume: (filePath: string) => Promise<T>,
  mapError: (snapshot: AudioAnalysisSnapshot, error: unknown) => Error,
): Promise<{
  snapshot: AudioAnalysisSnapshot;
  startTime: number;
  endTime: number;
  value: T;
}> {
  const { track, clip } = resolveArrangementAudioTarget(
    context,
    request,
    target,
  );
  const snapshot = captureAudioAnalysisSnapshot(context, track, clip);
  const startTime = request.startBeat ?? snapshot.startTime;
  const endTime = request.endBeat ?? snapshot.endTime;
  if (
    startTime < snapshot.startTime ||
    endTime > snapshot.endTime ||
    endTime <= startTime
  ) {
    throw new Error(
      `Requested beat range ${startTime}-${endTime} must be inside Arrangement Clip "${snapshot.clipName}" at ${snapshot.startTime}-${snapshot.endTime}.`,
    );
  }
  const overlaps = audioAnalysisOverlaps(track, snapshot, startTime, endTime);
  if (overlaps.length) {
    throw new Error(
      `Could not isolate Arrangement Audio Clip "${snapshot.clipName}" because ${overlaps.length} other Clip${overlaps.length === 1 ? "" : "s"} overlap the requested beat range on track "${snapshot.trackName}".`,
    );
  }
  let value: T;
  try {
    value = await consumePreFxAudioQueued(
      context,
      track,
      startTime,
      endTime,
      signal,
      consume,
    );
  } catch (error) {
    throwIfAborted(signal);
    throw mapError(snapshot, error);
  }
  assertAudioAnalysisStateUnchanged(
    context,
    snapshot,
    startTime,
    endTime,
  );
  return { snapshot, startTime, endTime, value };
}

function resolveArrangementAudioTarget(
  context: Api,
  request: ArrangementAudioLocator,
  target: LiveTarget,
): {
  track: AudioTrack<"1.0.0">;
  clip: AudioClip<"1.0.0">;
} {
  const track = resolveTrack(context, request.trackName, target);
  if (!(track instanceof AudioTrack)) {
    throw new Error(`Track "${track.name}" is not an audio track.`);
  }
  let candidates = track.arrangementClips.filter(
    (clip): clip is AudioClip<"1.0.0"> =>
      clip instanceof AudioClip &&
      (!request.clipName || equalsLoose(clip.name, request.clipName)) &&
      (request.clipStartBeat === undefined ||
        Math.abs(clip.startTime - request.clipStartBeat) < 0.0001),
  );
  if (
    request.trackName === undefined &&
    request.clipName === undefined &&
    request.clipStartBeat === undefined &&
    target.clip instanceof AudioClip
  ) {
    const targetId = optionalAnalysisHandleId(target.clip);
    const selected = candidates.filter((clip) =>
      optionalAnalysisHandleId(clip) === targetId
    );
    if (!selected.length) {
      throw new Error(
        "The selected Audio Clip is not an Arrangement Clip on the target track.",
      );
    }
    candidates = selected;
  }
  if (candidates.length === 1) return { track, clip: candidates[0]! };
  const available = track.arrangementClips
    .filter((clip): clip is AudioClip<"1.0.0"> => clip instanceof AudioClip)
    .map((clip) => `${clip.name}@${clip.startTime}`)
    .join(", ") || "none";
  if (!candidates.length) {
    throw new Error(
      `Could not find one matching Arrangement Audio Clip on track "${track.name}". Available: ${available}`,
    );
  }
  throw new Error(
    `Found ${candidates.length} matching Arrangement Audio Clips on track "${track.name}". Add ${request.clipStartArgument} to disambiguate: ${available}`,
  );
}

function summarizeWaveAnalysis(
  snapshot: AudioAnalysisSnapshot,
  analysis: WaveAnalysis,
): string {
  return [
    `Pre-FX Arrangement audio analysis for Clip "${snapshot.clipName}" on track "${snapshot.trackName}"`,
    `beatRange=${snapshot.startTime}-${snapshot.endTime}, durationSeconds=${roundMetric(analysis.durationSeconds)}, sampleRate=${analysis.sampleRate}, channels=${analysis.channels}`,
    `samplePeak=${roundMetric(analysis.samplePeak)}, peakDbfs=${dbLabel(analysis.peakDbfs)}`,
    `rms=${roundMetric(analysis.rms)}, rmsDbfs=${dbLabel(analysis.rmsDbfs)}, crestFactorDb=${dbLabel(analysis.crestFactorDb)}`,
    `dcOffsetByChannel=[${analysis.dcOffsetByChannel.map(roundMetric).join(",")}], maxAbsoluteDcOffset=${roundMetric(analysis.maxAbsoluteDcOffset)}`,
    `silentFrameRatio=${roundMetric(analysis.silentFrameRatio)} at amplitude<${roundMetric(analysis.silenceThreshold)}, clippedSampleRatio=${roundMetric(analysis.clippedSampleRatio)}`,
    "Scope: rendered pre-effects track audio for this Arrangement beat range; metrics are objective sample statistics, not realtime listening or integrated LUFS.",
  ].join("\n");
}

interface AudioAnalysisSnapshot {
  readonly trackId: string;
  readonly trackName: string;
  readonly tempo: number;
  readonly clipId: string;
  readonly clipName: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly startMarker: number;
  readonly endMarker: number;
  readonly looping: boolean;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly muted: boolean;
  readonly filePath: string;
  readonly warping: boolean;
  readonly warpMode: unknown;
  readonly warpMarkers: readonly { sampleTime: number; beatTime: number }[];
}

function captureAudioAnalysisSnapshot(
  context: Api,
  track: AudioTrack<"1.0.0">,
  clip: AudioClip<"1.0.0">,
): AudioAnalysisSnapshot {
  return {
    trackId: requiredAnalysisHandleId(track),
    trackName: track.name,
    tempo: context.application.song.tempo,
    clipId: requiredAnalysisHandleId(clip),
    clipName: clip.name,
    startTime: clip.startTime,
    endTime: clip.endTime,
    duration: clip.duration,
    startMarker: clip.startMarker,
    endMarker: clip.endMarker,
    looping: clip.looping,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
    muted: clip.muted,
    filePath: clip.filePath,
    warping: clip.warping,
    warpMode: clip.warpMode,
    warpMarkers: clip.warpMarkers.map((marker) => ({
      sampleTime: marker.sampleTime,
      beatTime: marker.beatTime,
    })),
  };
}

function assertAudioAnalysisStateUnchanged(
  context: Api,
  expected: AudioAnalysisSnapshot,
  startTime = expected.startTime,
  endTime = expected.endTime,
): void {
  try {
    const track = context.application.song.tracks.find(
      (candidate) => optionalAnalysisHandleId(candidate) === expected.trackId,
    );
    if (!(track instanceof AudioTrack)) throw audioAnalysisStateChanged();
    const clip = track.arrangementClips.find(
      (candidate): candidate is AudioClip<"1.0.0"> =>
        candidate instanceof AudioClip &&
        optionalAnalysisHandleId(candidate) === expected.clipId,
    );
    if (!clip) throw audioAnalysisStateChanged();
    const current = captureAudioAnalysisSnapshot(context, track, clip);
    if (
      JSON.stringify(current) !== JSON.stringify(expected) ||
      audioAnalysisOverlaps(track, expected, startTime, endTime).length
    ) {
      throw audioAnalysisStateChanged();
    }
  } catch {
    throw audioAnalysisStateChanged();
  }
}

function audioAnalysisOverlaps(
  track: AudioTrack<"1.0.0">,
  snapshot: AudioAnalysisSnapshot,
  startTime = snapshot.startTime,
  endTime = snapshot.endTime,
): Clip<"1.0.0">[] {
  return track.arrangementClips.filter(
    (candidate) => optionalAnalysisHandleId(candidate) !== snapshot.clipId &&
      candidate.startTime < endTime &&
      candidate.endTime > startTime,
  );
}

function requiredAnalysisHandleId(value: { handle?: { id?: unknown } }): string {
  const id = optionalAnalysisHandleId(value);
  if (!id) throw new Error("Could not verify Live object identity for audio analysis.");
  return id;
}

function optionalAnalysisHandleId(
  value: { handle?: { id?: unknown } },
): string | undefined {
  const id = value.handle?.id;
  return id === undefined || id === null ? undefined : String(id);
}

function audioAnalysisStateChanged(): Error {
  return new Error(
    "Live state changed during audio rendering. Inspect the current Arrangement Audio Clip and try again.",
  );
}

function roundMetric(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function dbLabel(value: number | null): string {
  return value === null ? "-infinity" : roundMetric(value);
}

async function summarizeCurrentObject(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "inspect_current_object" }>,
  target: LiveTarget,
): Promise<string> {
  const object = target.object;
  if (!object) {
    throw new Error("No selected Live object is available for this Session.");
  }
  if (object instanceof Track) return summarizeObservedTrack(context, object, request);
  if (object instanceof Device) {
    const track = resolveTrack(context, undefined, target);
    const path = findDevicePath(track, object);
    if (!path) {
      throw new Error(`Selected device "${object.name}" is no longer inside track "${track.name}".`);
    }
    return summarizeDeviceTree(
      context,
      {
        type: "inspect_device_tree",
        deviceName: object.name,
        devicePath: path,
        ...observationPageFields(request),
      },
      target,
    );
  }
  if (object instanceof Clip) return summarizeClipDetail(object, request);
  if (object instanceof ClipSlot) {
    return object.clip
      ? `Selected Session Clip Slot contains:\n${summarizeClipDetail(object.clip, request)}`
      : "Selected Session Clip Slot is empty.";
  }
  if (object instanceof Sample) return `Selected Sample: ${audioFileLabel(object.filePath)}`;
  if (object instanceof Scene) {
    return `Selected Scene ${sceneStateSummary(object)}`;
  }
  if (object instanceof CuePoint) {
    return `Selected Cue Point "${object.name}" at beat ${object.time}.`;
  }
  if (object instanceof TakeLane) {
    const page = pageOf(object.clips, request.itemOffset, request.itemLimit, 24);
    return [
      `Selected Take Lane "${object.name}" has ${object.clips.length} clips:`,
      pageHeader("clips", page),
      ...page.items.map((clip) => `  - ${summarizeClipReference(clip)}`),
    ].join("\n");
  }
  return `Selected Live object: ${(object as DataModelObject<"1.0.0">).constructor.name}`;
}

async function summarizeDeviceTree(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "inspect_device_tree" }>,
  target: LiveTarget,
): Promise<string> {
  const track = resolveTrackSelector(context, request, target);
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

  const devicePage = pageOf(entries, request.itemOffset, request.itemLimit, 96);
  const lines = [
    `Device tree on ${trackHeading(context.application.song, track)} "${track.name}":`,
    pageHeader("devices", devicePage),
  ];
  for (const { device, parent, path, depth } of devicePage.items) {
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
    const parameterPage = pageOf(
      device.parameters,
      request.parameterOffset,
      request.parameterLimit,
      18,
    );
    lines.push(
      `${"  ".repeat(depth + 1)}${pageHeader("parameters", parameterPage)}`,
    );
    for (const [index, parameter] of parameterPage.items.entries()) {
      lines.push(
        `${"  ".repeat(depth + 1)}${await describeParameter(
          parameter,
          parameterPage.offset + index,
          request.valueItemOffset,
          request.valueItemLimit,
        )}`,
      );
    }
  }
  return lines.join("\n");
}

async function summarizeMixer(
  context: Api,
  track: Track<"1.0.0">,
): Promise<string> {
  const parameters = [
    track.mixer.volume,
    track.mixer.panning,
    ...track.mixer.sends,
  ];
  return [
    `Mixer on ${trackHeading(context.application.song, track)} "${track.name}" has ${parameters.length} parameters:`,
    ...(await Promise.all(parameters.map((parameter, index) =>
      describeParameter(parameter, index)
    ))),
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

function summarizeClipDetail(
  clip: Clip<"1.0.0">,
  request: ObservationPageRequest = {},
): string {
  const lines = [
    `${clip instanceof MidiClip ? "MIDI" : clip instanceof AudioClip ? "Audio" : "Unknown"} Clip "${clip.name}"`,
    `start=${clip.startTime} end=${clip.endTime} duration=${clip.duration}`,
    `startMarker=${clip.startMarker} endMarker=${clip.endMarker}`,
    `looping=${clip.looping} loopStart=${clip.loopStart} loopEnd=${clip.loopEnd}`,
    `muted=${clip.muted} color=${clip.color}`,
  ];
  if (clip instanceof MidiClip) {
    lines.push(summarizeMidiNotes(clip.notes, { offset: 0, limit: 128 }));
  }
  if (clip instanceof AudioClip) {
    const warpMarkerPage = pageOf(
      clip.warpMarkers,
      request.itemOffset,
      request.itemLimit,
      64,
    );
    lines.push(
      `file=${audioFileLabel(clip.filePath)}`,
      `warping=${clip.warping} warpMode=${warpModeLabel(clip.warpMode)} warpMarkers=${clip.warpMarkers.length}`,
      pageHeader("warp markers", warpMarkerPage),
      ...warpMarkerPage.items.map((marker, index) =>
        `  marker index ${warpMarkerPage.offset + index}: sampleTime=${marker.sampleTime} beatTime=${marker.beatTime}`
      ),
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

function summarizeSongInfo(
  context: Api,
  request: Extract<AgentObservationRequest, { type: "inspect_song_info" }>,
): string {
  const song = context.application.song;
  const cuePoints = song.cuePoints ?? [];
  const scenePage = pageOf(song.scenes, request.itemOffset, request.itemLimit, 16);
  const cuePointPage = pageOf(cuePoints, request.itemOffset, request.itemLimit, 32);
  const lines = [
    `Tempo: ${song.tempo} BPM`,
    `Grid: ${gridLabel(song.gridQuantization)}${song.gridIsTriplet ? " (triplet)" : ""}`,
    `Scale: mode=${song.scaleMode} name="${song.scaleName}" rootNote=${song.rootNote} intervals=[${song.scaleIntervals.join(",")}]`,
    `Tracks: ${song.tracks.length}`,
    `Scenes: ${song.scenes.length}`,
    `Cue Points: ${cuePoints.length}`,
    pageHeader("scenes", scenePage),
  ];
  for (const [i, scene] of scenePage.items.entries()) {
    lines.push(`  Scene index ${scenePage.offset + i}: ${sceneStateSummary(scene)}`);
  }
  lines.push(pageHeader("Cue Points", cuePointPage));
  for (const cuePoint of cuePointPage.items) {
    lines.push(`  Cue Point beat ${cuePoint.time}: "${cuePoint.name}"`);
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
  const song = context.application.song;
  const entries = songTrackEntries(song);
  const regularCount = entries.filter((entry) => entry.role === "regular").length;
  const returnCount = entries.filter((entry) => entry.role === "return").length;
  const hasMain = entries.some((entry) => entry.role === "main");
  return [
    `Live set has ${regularCount} regular tracks, ${returnCount} Return tracks${hasMain ? ", and a Main track" : ""}.`,
    ...entries.map((entry) => {
      const label = entry.role === "regular"
        ? `Regular track index ${entry.index}: ${trackTypeLabel(entry.track)} "${entry.track.name}"`
        : entry.role === "return"
          ? `Return track index ${entry.index}: "${entry.track.name}"`
          : `Main track: "${entry.track.name}"`;
      return [
        label,
        ...(entry.role === "regular" ? [`  ${trackStateSummary(entry.track)}`] : []),
        `  devices=${entry.track.devices.map((device) => device.name).join(", ") || "none"}`,
      ].join("\n");
    }),
  ].join("\n");
}

async function summarizeObservedTrack(
  context: Api,
  track: Track<"1.0.0">,
  request: ObservationPageRequest,
): Promise<string> {
  const entry = songTrackEntryForTrack(context.application.song, track);
  return entry?.role === "return" || entry?.role === "main"
    ? summarizeSpecialTrackWithDevices(context, track, request)
    : summarizeRegularTrackWithDevices(track, request);
}

async function summarizeSpecialTrackWithDevices(
  context: Api,
  track: Track<"1.0.0">,
  request: ObservationPageRequest,
): Promise<string> {
  const devicePage = pageOf(track.devices, request.itemOffset, request.itemLimit, 24);
  const lines = [
    `${trackHeading(context.application.song, track)} "${track.name}"`,
    pageHeader("devices", devicePage),
    `devices=${devicePage.items.map((device, index) => `${devicePage.offset + index}: ${device.name}`).join(", ") || "none"}`,
  ];
  for (const [index, device] of devicePage.items.entries()) {
    lines.push(await summarizeDevice(
      track.name,
      device.name,
      device.parameters,
      true,
      devicePage.offset + index,
      request,
      trackHeading(context.application.song, track),
    ));
  }
  return lines.join("\n");
}

async function summarizeRegularTrackWithDevices(
  track: Track<"1.0.0">,
  request: ObservationPageRequest,
): Promise<string> {
  const arrangementPage = pageOf(
    track.arrangementClips,
    request.itemOffset,
    request.itemLimit,
    12,
  );
  const slotPage = pageOf(track.clipSlots, request.itemOffset, request.itemLimit, 12);
  const takeLaneResult = safeTakeLanes(track);
  const takeLanePage = takeLaneResult.available
    ? pageOf(takeLaneResult.items, request.itemOffset, request.itemLimit, 16)
    : undefined;
  const devicePage = pageOf(track.devices, request.itemOffset, request.itemLimit, 24);
  const lines = [
    `${trackTypeLabel(track)} track "${track.name}"`,
    trackStateSummary(track),
    `arrangement clips=${track.arrangementClips.length}`,
    pageHeader("arrangement clips", arrangementPage),
    ...arrangementPage.items
      .map((clip) => `  - ${summarizeClipReference(clip)}`),
    `clip slots=${track.clipSlots.length}`,
    pageHeader("clip slots", slotPage),
    ...slotPage.items
      .map((slot, index) =>
        slot.clip
          ? `  - slot index ${slotPage.offset + index}: ${summarizeClipReference(slot.clip)}`
          : `  - slot index ${slotPage.offset + index}: empty`,
      ),
    takeLaneResult.available
      ? `take lanes=${takeLaneResult.items.length}`
      : "take lanes=unavailable (Live did not expose this collection)",
    ...(takeLanePage
      ? [
          pageHeader("take lanes", takeLanePage),
          ...takeLanePage.items.map((lane, index) =>
            `  - lane index ${takeLanePage.offset + index}: "${lane.name}" clips=${lane.clips.length}`
          ),
        ]
      : []),
    pageHeader("devices", devicePage),
    `devices=${devicePage.items.map((device, index) => `${devicePage.offset + index}: ${device.name}`).join(", ") || "none in this page"}`,
  ];

  for (const [index, device] of devicePage.items.entries()) {
    lines.push(await summarizeDevice(
      track.name,
      device.name,
      device.parameters,
      true,
      devicePage.offset + index,
      request,
    ));
  }

  return lines.join("\n");
}

function safeTakeLanes(track: Track<"1.0.0">):
  | { available: true; items: TakeLane<"1.0.0">[] }
  | { available: false } {
  try {
    return { available: true, items: track.takeLanes };
  } catch {
    return { available: false };
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
    request.slotIndex === undefined &&
    target.clip instanceof MidiClip
  ) {
    return target.clip;
  }

  const track = resolveTrack(context, request.trackName, target);
  if (request.slotIndex !== undefined) {
    const slot = track.clipSlots[request.slotIndex];
    if (!slot) {
      throw new Error(
        `Could not find Session slotIndex ${request.slotIndex} on track "${track.name}".`,
      );
    }
    if (!(slot.clip instanceof MidiClip)) {
      throw new Error(
        `Session slotIndex ${request.slotIndex} on track "${track.name}" does not contain a MIDI clip.`,
      );
    }
    if (request.clipName && !equalsLoose(slot.clip.name, request.clipName)) {
      throw new Error(
        `Session slotIndex ${request.slotIndex} contains "${slot.clip.name}", not "${request.clipName}".`,
      );
    }
    return slot.clip;
  }
  const candidates = request.startBeat === undefined
    ? midiClipsOnTrack(track)
    : track.arrangementClips.filter(
      (clip): clip is MidiClip<"1.0.0"> => clip instanceof MidiClip,
    );
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
      `Found ${matching.length} matching MIDI clips on track "${track.name}". ${request.startBeat === undefined ? "Add startBeat or slotIndex to disambiguate." : "Add clipName to disambiguate Arrangement Clips at this beat."}`,
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
    `startMarker=${clip.startMarker}, endMarker=${clip.endMarker}`,
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
  request: ObservationPageRequest = {},
  trackLabel = "track",
): Promise<string> {
  const parameterPage = pageOf(
    parameters,
    request.parameterOffset,
    request.parameterLimit,
    compact ? 18 : 80,
  );
  const lines = [
    `Device "${deviceName}"${deviceIndex !== undefined ? ` at deviceIndex ${deviceIndex}` : ""} on ${trackLabel} "${trackName}" has ${parameters.length} parameters:`,
    pageHeader("parameters", parameterPage),
    ...(await Promise.all(parameterPage.items.map((parameter, index) =>
      describeParameter(
        parameter,
        parameterPage.offset + index,
        request.valueItemOffset,
        request.valueItemLimit,
      )
    ))),
  ];

  return lines.join("\n");
}

async function describeParameter(
  parameter: DeviceParameter<"1.0.0">,
  parameterIndex?: number,
  valueItemOffset?: number,
  valueItemLimit?: number,
): Promise<string> {
  const value = await parameter.getValue().catch(() => undefined);
  const valueText = value === undefined ? "unknown" : String(value);
  const valueItemPage = pageOf(
    parameter.valueItems,
    valueItemOffset,
    valueItemLimit,
    12,
  );
  const valueItems = valueItemPage.items
    .map((item, index) => `[${valueItemPage.offset + index}] ${item.name}`)
    .join(", ");
  return [
    `  - ${parameterIndex === undefined ? "" : `[${parameterIndex}] `}${parameter.name}`,
    `min=${parameter.min}`,
    `max=${parameter.max}`,
    `current=${valueText}`,
    `default=${parameter.defaultValue}`,
    `quantized=${parameter.isQuantized}`,
    valueItemPage.total > 0 || valueItemOffset !== undefined
      ? `items(offset=${valueItemPage.offset}, total=${valueItemPage.total}, nextOffset=${valueItemPage.nextOffset ?? "none"})=${valueItems || "none in this page"}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
}
