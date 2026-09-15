import { types } from "node:util";

import {
  MAX_AUDIO_ASSET_BYTES,
  MAX_AUDIO_ASSET_DURATION_SECONDS,
  MAX_AUDIO_JOB_OUTPUTS,
  SEPARATION_STEMS,
  type AudioServiceAdapter,
  type RemoteAudioOutput,
  type SeparationStem,
} from "./contracts.js";
import {
  assertLalalActive,
  createLalalHttp,
  lalalError,
  lalalObject,
  lalalOutputUrl,
} from "./lalal-http.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Official protocol: https://www.lalal.ai/api/v1/openapi.json (v1.1.0). */
export function createLalalAudioAdapter(
  apiKey: string,
  options: { fetchImpl?: typeof fetch } = {},
): AudioServiceAdapter {
  const http = createLalalHttp(apiKey, options.fetchImpl);
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" || !UUID_V4.test(value) ||
        value.toLowerCase().includes(apiKey.toLowerCase())) {
      throw lalalError("invalid source, task or idempotency identifier.");
    }
    return value;
  };
  const taskResult = (value: Record<string, unknown>, taskId: string) => {
    const results = lalalObject(value.result);
    if (!Object.hasOwn(results, taskId)) throw lalalError("requested task is absent from response.");
    return lalalObject(results[taskId]);
  };

  return {
    provider: "lalal",
    stems: Object.freeze([...SEPARATION_STEMS]),
    async upload(bytes, mediaType, signal) {
      assertLalalActive(signal);
      if (!types.isUint8Array(bytes) || !bytes.byteLength || bytes.byteLength > MAX_AUDIO_ASSET_BYTES ||
          !["audio/wav", "audio/mpeg"].includes(mediaType)) {
        throw lalalError("upload requires WAV or MP3 bytes within 128 MiB.");
      }
      const value = await http.post("upload/", bytes, signal,
        mediaType === "audio/wav" ? "audio.wav" : "audio.mp3");
      if (typeof value.name !== "string" || value.name.length > 1024 ||
          value.size !== bytes.byteLength || !duration(value.duration) ||
          !Number.isSafeInteger(value.expires) || (value.expires as number) <= 0) {
        throw lalalError("invalid upload metadata.");
      }
      return identifier(value.id);
    },
    async submit(sourceId, stems, idempotencyKey, signal, sourceMediaType = "audio/wav") {
      assertLalalActive(signal);
      const stemList = remoteStems(stems);
      if (sourceMediaType !== "audio/wav" && sourceMediaType !== "audio/mpeg") {
        throw lalalError("source media type is unavailable for output encoding.");
      }
      const value = await http.post("split/multistem/", JSON.stringify({
        source_id: identifier(sourceId),
        // Preserve lossless WAV sources. MP3 sources stay compressed instead of
        // expanding a valid long upload beyond the local per-output byte limit.
        presets: { stem_list: stemList, encoder_format: sourceMediaType === "audio/wav" ? "wav" : "mp3" },
        idempotency_key: identifier(idempotencyKey),
      }), signal);
      return identifier(value.task_id);
    },
    async inspect(taskId, stems, signal) {
      assertLalalActive(signal);
      const stemList = remoteStems(stems);
      const value = taskResult(await http.post("check/", JSON.stringify({
        task_ids: [identifier(taskId)],
      }), signal), taskId);
      if (value.status === "server_error") {
        if (typeof value.error !== "string") throw lalalError("invalid task error response.");
        return { status: "failed", message: "LALAL.AI could not access this processing task." };
      }
      identifier(value.source_id);
      const presets = lalalObject(value.presets);
      if (!Array.isArray(presets.stem_list) || presets.stem_list.length !== stemList.length ||
          new Set(presets.stem_list).size !== stemList.length ||
          !stemList.every((stem) => (presets.stem_list as unknown[]).includes(stem)) ||
          (presets.task_type !== undefined && presets.task_type !== "split") ||
          (presets.label !== undefined && presets.label !== "multistem")) {
        throw lalalError("task presets do not match the requested stems.");
      }
      if (value.status === "progress") {
        if (!Number.isInteger(value.progress) || (value.progress as number) < 0 ||
            (value.progress as number) > 100) throw lalalError("invalid task progress.");
        return { status: "running", progress: value.progress as number };
      }
      if (value.status === "cancelled") return { status: "cancelled" };
      if (value.status === "error") {
        const error = lalalObject(value.error);
        if (typeof error.detail !== "string" ||
            !optionalString(error.code) || !optionalString(error.id)) {
          throw lalalError("invalid task error response.");
        }
        return { status: "failed", message: "LALAL.AI audio processing failed." };
      }
      if (value.status !== "success") throw lalalError("unknown task status.");
      const result = lalalObject(value.result);
      if (!duration(result.duration) || !Array.isArray(result.tracks) ||
          result.tracks.length !== stems.length + 1 || result.tracks.length > MAX_AUDIO_JOB_OUTPUTS) {
        throw lalalError("invalid completed task outputs.");
      }
      const roles = new Set<string>();
      const outputs: RemoteAudioOutput[] = result.tracks.map((item) => {
        const track = lalalObject(item);
        const role = track.type === "back" && track.label === "no_multistem"
          ? "residual"
          : track.type === "stem"
            ? stems.find((stem) => remoteStem(stem) === track.label)
            : undefined;
        if (!role || roles.has(role) || !optionalString(track.name) ||
            !optionalString(track.playlist_file) || !optionalString(track.waveform) ||
            (track.size != null && (!Number.isSafeInteger(track.size) ||
              (track.size as number) <= 0))) {
          throw lalalError("invalid or duplicate output track.");
        }
        // Optional provider metadata must not reject usable sibling outputs.
        // Each download independently enforces the actual response byte limit.
        roles.add(role);
        return { key: `${track.type}:${track.label}`, role, url: lalalOutputUrl(track.url, apiKey) };
      });
      return { status: "completed", outputs };
    },
    async cancel(taskId, signal) {
      assertLalalActive(signal);
      const value = taskResult(await http.post("cancel/", JSON.stringify({
        task_ids: [identifier(taskId)],
      }), signal), taskId);
      if (value.status !== "success") throw lalalError("remote task cancellation was not confirmed.");
    },
    download(output, signal) {
      return http.download(output.url, signal);
    },
  };
}

function remoteStem(stem: SeparationStem): string {
  return stem === "drums" ? "drum" : stem;
}

function remoteStems(stems: readonly SeparationStem[]): string[] {
  if (!Array.isArray(stems) || !stems.length || stems.length > SEPARATION_STEMS.length ||
      new Set(stems).size !== stems.length || !stems.every((stem) => SEPARATION_STEMS.includes(stem))) {
    throw lalalError("select one to six distinct supported stems.");
  }
  return stems.map(remoteStem);
}

function duration(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_AUDIO_ASSET_DURATION_SECONDS;
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}
