import {
  AudioClip,
  Sample,
  Simpler,
  type DataModelObject,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import type { SampleSource } from "../agent/action-schema.js";
import { audioFileLabel } from "./context.js";
import { resolveDeviceTarget } from "./device-tree.js";
import { equalsLoose, resolveArrangementClip, resolveTrack } from "./resolve.js";
import type { LiveTarget } from "./target.js";

type Api = ExtensionContext<"1.0.0">;

export interface RequestAudioSampleSource {
  readonly kind: "request_audio_attachment";
  readonly requestId: string;
  readonly audioIndex: number;
  readonly filePath: string;
  readonly label: string;
  readonly identity: string;
  prepare(beforeImport?: () => void): Promise<boolean>;
}

export type RequestAudioSampleSources = ReadonlyMap<
  string,
  RequestAudioSampleSource
>;

export interface ResolvedLiveSampleSource {
  readonly kind: "live";
  readonly filePath: string;
  readonly label: string;
  readonly identity: string;
  readonly object: DataModelObject<"1.0.0">;
}

export type ResolvedSampleSource =
  | ResolvedLiveSampleSource
  | RequestAudioSampleSource;

export function resolveSampleSource(
  context: Api,
  source: Extract<SampleSource, { kind: "request_audio_attachment" }>,
  target: LiveTarget,
  requestAudioSources?: RequestAudioSampleSources,
): RequestAudioSampleSource;
export function resolveSampleSource(
  context: Api,
  source: Exclude<SampleSource, { kind: "request_audio_attachment" }>,
  target: LiveTarget,
  requestAudioSources?: RequestAudioSampleSources,
): ResolvedLiveSampleSource;
export function resolveSampleSource(
  context: Api,
  source: SampleSource,
  target: LiveTarget,
  requestAudioSources?: RequestAudioSampleSources,
): ResolvedSampleSource;
export function resolveSampleSource(
  context: Api,
  source: SampleSource,
  target: LiveTarget,
  requestAudioSources?: RequestAudioSampleSources,
): ResolvedSampleSource {
  switch (source.kind) {
    case "selected":
      return resolveSelectedSource(target);
    case "request_audio_attachment": {
      const resolved = requestAudioSources?.get(
        requestAudioSampleSourceKey(source.requestId, source.audioIndex),
      );
      if (!resolved) {
        throw new Error(
          "The requested audio attachment is not available as a SampleSource in this request. Use an exact current-request locator from the supplied context.",
        );
      }
      return resolved;
    }
    case "arrangement_audio_clip": {
      const track = resolveTrack(context, source.trackName, {});
      const clip = resolveArrangementClip(track, source.startBeat, source.clipName);
      if (!(clip instanceof AudioClip)) {
        throw new Error(
          `Clip "${clip.name}" on track "${track.name}" is not an audio clip.`,
        );
      }
      return resolved(clip.filePath, clip);
    }
    case "session_audio_clip": {
      const track = resolveTrack(context, source.trackName, {});
      const slot = track.clipSlots[source.slotIndex];
      if (!slot) {
        throw new Error(
          `Could not find Session slot ${source.slotIndex} on track "${track.name}".`,
        );
      }
      const clip = slot.clip;
      if (!clip) {
        throw new Error(
          `Session slot ${source.slotIndex} on track "${track.name}" is empty.`,
        );
      }
      if (source.clipName && !equalsLoose(clip.name, source.clipName)) {
        throw new Error(
          `Session slot ${source.slotIndex} on track "${track.name}" contains "${clip.name}", not "${source.clipName}".`,
        );
      }
      if (!(clip instanceof AudioClip)) {
        throw new Error(
          `Clip "${clip.name}" in Session slot ${source.slotIndex} on track "${track.name}" is not an audio clip.`,
        );
      }
      return resolved(clip.filePath, clip);
    }
    case "simpler": {
      const track = resolveTrack(context, source.trackName, {});
      const { device } = resolveDeviceTarget(
        track,
        {},
        source.deviceName,
        source.devicePath,
        source.deviceIndex,
      );
      if (!(device instanceof Simpler)) {
        throw new Error(
          `Device "${device.name}" on track "${track.name}" is not Simpler.`,
        );
      }
      if (!device.sample) {
        throw new Error(
          `Simpler "${device.name}" on track "${track.name}" has no loaded sample.`,
        );
      }
      return resolved(device.sample.filePath, device.sample);
    }
  }
}

export function requestAudioSampleSourceKey(
  requestId: string,
  audioIndex: number,
): string {
  return `${requestId}:${audioIndex}`;
}

function resolveSelectedSource(target: LiveTarget): ResolvedSampleSource {
  const selected = target.object;
  if (selected instanceof Sample) return resolved(selected.filePath, selected);
  if (selected instanceof AudioClip) return resolved(selected.filePath, selected);
  if (selected instanceof Simpler) {
    const sample = selected.sample;
    if (!sample) {
      throw new Error(`Selected Simpler "${selected.name}" has no loaded sample.`);
    }
    return resolved(sample.filePath, sample);
  }
  throw new Error(
    "The selected Live object is not an Audio Clip, Sample, or Simpler with a loaded sample.",
  );
}

function resolved(
  filePath: string,
  object: DataModelObject<"1.0.0">,
): ResolvedLiveSampleSource {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("The observed Live sample source has no usable audio file.");
  }
  const handleId = object.handle?.id;
  if (handleId === undefined || handleId === null) {
    throw new Error("The observed Live sample source has no stable identity.");
  }
  return {
    kind: "live",
    filePath,
    label: audioFileLabel(filePath),
    identity: `live:${String(handleId)}`,
    object,
  };
}
