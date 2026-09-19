import {
  SEPARATION_STEMS,
  type MusicGenerationOptions,
  type SeparationStem,
} from "../audio-services/contracts.js";
import { exceedsAudioPromptLimit } from "../audio-services/prompt.js";
import { isSafeStorageId } from "../storage/id.js";
import {
  parseMusicOptions,
  parseMusicServiceRequest,
  type MusicServiceRequest,
} from "./music-tools.js";

export type AudioProcessingSource =
  | { kind: "request_audio_attachment"; requestId: string; audioIndex: number }
  | { kind: "audio_asset"; assetRef: string }
  | {
      kind: "arrangement_audio";
      trackName?: string;
      clipName?: string;
      clipStartBeat?: number;
      startBeat: number;
      endBeat: number;
    };

export type AudioToolRequest =
  | MusicServiceRequest
  | { kind: "separate_stems"; connectionId: string; source: AudioProcessingSource; stems: SeparationStem[] }
  | { kind: "generate_music"; connectionId: string; prompt: string; durationSeconds?: number; instrumental: boolean; options?: MusicGenerationOptions }
  | { kind: "generate_lyrics"; connectionId: string; prompt: string }
  | { kind: "generate_song_from_lyrics"; connectionId: string; lyrics: string; prompt?: string; gender?: "female" | "male" }
  | { kind: "generate_sound_effect"; connectionId: string; prompt: string; durationSeconds: number; loop: boolean }
  | { kind: "listen_to_audio_asset"; assetRef: string }
  | { kind: "list_audio_jobs" }
  | { kind: "resume_audio_job"; jobId: string };

export function parseAudioToolRequest(name: string, argumentsJson: string): AudioToolRequest {
  const args: unknown = JSON.parse(argumentsJson || "{}");
  if (["inspect_music_service", "extend_music", "get_whole_song", "retrieve_music"].includes(name)) {
    return parseMusicServiceRequest(name, args);
  }
  if (name === "listen_to_audio_asset") {
    const value = record(args);
    only(value, ["assetRef"]);
    return { kind: name, assetRef: id(value.assetRef) };
  }
  if (name === "list_audio_jobs") {
    const value = record(args);
    only(value, []);
    return { kind: name };
  }
  if (name === "resume_audio_job") {
    const value = record(args);
    only(value, ["jobId"]);
    return { kind: name, jobId: id(value.jobId) };
  }
  if (name === "generate_music" || name === "generate_sound_effect") {
    const value = record(args);
    const music = name === "generate_music";
    only(value, [
      "connectionId",
      "prompt",
      "durationSeconds",
      music ? "instrumental" : "loop",
      ...(music ? ["options"] : []),
    ]);
    const options = music && value.options !== undefined
      ? parseMusicOptions(value.options)
      : undefined;
    if (
      typeof value.prompt !== "string" ||
      (!value.prompt.trim() && !(options && value.instrumental === true)) ||
      exceedsAudioPromptLimit(value.prompt, options ? 5000 : 4100) ||
      value.prompt.includes("\0")
    ) {
      throw new Error("Invalid audio generation prompt.");
    }
    const option = music ? value.instrumental : value.loop;
    if (typeof option !== "boolean") throw new Error("Invalid audio generation option.");
    const duration = value.durationSeconds === undefined && music
      ? undefined
      : finiteNumber(value.durationSeconds);
    if (
      duration !== undefined &&
      (duration < (music ? 3 : 0.5) || duration > (music ? 600 : 30))
    ) {
      throw new Error("Audio generation duration is outside the supported range.");
    }
    return music
      ? {
          kind: name,
          connectionId: id(value.connectionId),
          prompt: value.prompt,
          ...(duration === undefined ? {} : { durationSeconds: duration }),
          instrumental: option,
          ...(options ? { options } : {}),
        }
      : {
          kind: name,
          connectionId: id(value.connectionId),
          prompt: value.prompt,
          durationSeconds: duration!,
          loop: option,
        };
  }
  if (name !== "separate_stems") throw new Error("Unknown audio tool.");
  const value = record(args);
  only(value, ["connectionId", "source", "stems"]);
  if (
    !Array.isArray(value.stems) ||
    value.stems.length < 1 ||
    value.stems.length > SEPARATION_STEMS.length ||
    new Set(value.stems).size !== value.stems.length ||
    value.stems.some((stem) => !SEPARATION_STEMS.includes(stem))
  ) {
    throw new Error("stems must be a non-empty unique selection of the available stems.");
  }
  return {
    kind: name,
    connectionId: id(value.connectionId),
    stems: value.stems as SeparationStem[],
    source: parseSource(value.source),
  };
}

function parseSource(input: unknown): AudioProcessingSource {
  const source = record(input);
  if (source.kind === "audio_asset") {
    only(source, ["kind", "assetRef"]);
    return { kind: source.kind, assetRef: id(source.assetRef) };
  }
  if (source.kind === "request_audio_attachment") {
    only(source, ["kind", "requestId", "audioIndex"]);
    if (
      !Number.isInteger(source.audioIndex) ||
      (source.audioIndex as number) < 0 ||
      (source.audioIndex as number) > 1
    ) {
      throw new Error("Invalid audio attachment index.");
    }
    return {
      kind: source.kind,
      requestId: id(source.requestId),
      audioIndex: source.audioIndex as number,
    };
  }
  if (source.kind !== "arrangement_audio") throw new Error("Invalid audio source kind.");
  only(source, ["kind", "trackName", "clipName", "clipStartBeat", "startBeat", "endBeat"]);
  const startBeat = finiteNumber(source.startBeat);
  const endBeat = finiteNumber(source.endBeat);
  if (endBeat <= startBeat) throw new Error("Audio endBeat must be greater than startBeat.");
  return {
    kind: source.kind,
    startBeat,
    endBeat,
    ...(source.trackName === undefined ? {} : { trackName: text(source.trackName) }),
    ...(source.clipName === undefined ? {} : { clipName: text(source.clipName) }),
    ...(source.clipStartBeat === undefined
      ? {}
      : { clipStartBeat: finiteNumber(source.clipStartBeat) }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Audio tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Audio tool arguments contain unsupported fields.");
  }
}

function id(value: unknown): string {
  if (!isSafeStorageId(value)) throw new Error("Invalid audio reference.");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new Error("Invalid audio target name.");
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Audio beat positions must be finite numbers.");
  }
  return value;
}
