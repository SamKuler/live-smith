import type { UiMessage } from "../i18n/ui-message.js";

/** Host-owned audio processing contracts, independent of chat providers and Live. */
export const SEPARATION_STEMS = [
  "vocals", "drums", "bass", "piano", "electric_guitar", "acoustic_guitar",
] as const;
export type SeparationStem = (typeof SEPARATION_STEMS)[number];
export const AUDIO_OUTPUT_LABELS = {
  vocals: "Vocals", drums: "Drums", bass: "Bass", piano: "Piano",
  electric_guitar: "Electric guitar", acoustic_guitar: "Acoustic guitar", residual: "Remaining audio",
  music: "Music", music_alternative: "Alternative music", sound_effect: "Sound effect",
} as const;

export const MAX_AUDIO_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_AUDIO_ASSET_DURATION_SECONDS = 15 * 60;
export const MAX_AUDIO_JOB_OUTPUTS = 7;
export const MAX_AUDIO_SESSION_BYTES = 1024 * 1024 * 1024;
export const MAX_AUDIO_SESSION_JOBS = 40;
export const MAX_AUDIO_JOB_TITLE_CHARACTERS = 200;
export const MAX_AUDIO_SERVICES = 20;
export const LEGACY_AUDIO_SERVICE_ID = "audio-service-lalal";
export const AUDIO_PROVIDERS = ["lalal", "elevenlabs", "mureka", "suno-platform", "suno", "sunoapi"] as const;
export type AudioProvider = (typeof AUDIO_PROVIDERS)[number];
export type AudioOperation = "separate_stems" | "generate_music" | "generate_sound_effect" | "extend_music" | "get_whole_song" | "retrieve_music";

export interface AudioServiceConnection {
  id: string;
  name: string;
  provider: AudioProvider;
  enabled: boolean;
  apiKey: string;
  /** A provider model identifier; absent uses the adapter's documented default. */
  modelId?: string;
  /** User-owned public callback endpoint required by task-based providers. */
  callbackUrl?: string;
}

export interface AudioServicesSettings {
  connections: AudioServiceConnection[];
  revision: string;
}

export interface AudioServiceConnectionView extends Omit<AudioServiceConnection, "apiKey"> {
  apiKeyConfigured: boolean;
}

export interface AudioServicesView {
  connections: AudioServiceConnectionView[];
  revision: string;
}

export type AudioServicesSettingsPatch =
  | { action: "upsert"; expectedRevision: string; connection: Omit<AudioServiceConnection, "apiKey"> & { apiKey?: string } }
  | { action: "remove"; expectedRevision: string; serviceId: string };

export interface MusicGenerationOptions {
  mode: "custom";
  title?: string;
  styles?: string;
  negativeStyles?: string;
  weirdness?: number;
  styleInfluence?: number;
  vocalGender?: "male" | "female";
  personaId?: string;
}

export type MusicGenerationOptionField = Exclude<keyof MusicGenerationOptions, "mode">;

export type AudioGenerationRequest =
  | { operation: "generate_music"; prompt: string; durationSeconds?: number; instrumental: boolean; options?: MusicGenerationOptions }
  | { operation: "extend_music"; clipId: string; startSeconds: number; prompt: string; instrumental: boolean; options?: MusicGenerationOptions }
  | { operation: "get_whole_song"; clipId: string }
  | { operation: "generate_sound_effect"; prompt: string; durationSeconds: number; loop: boolean };

export interface GeneratedAudioOutput {
  role: "music" | "music_alternative" | "sound_effect";
  bytes: Uint8Array;
}

export type AudioGenerationSubmission =
  | { kind: "audio"; outputs: GeneratedAudioOutput[] }
  | { kind: "task"; taskId: string; expectedOutputs?: AudioJob["expectedOutputs"] };

/** The adapter knows no paid request was dispatched, unlike a transport failure. */
export class AudioSubmissionNotStartedError extends Error {}

/** Holds the connection lifecycle boundary through one authorized paid request. */
export type AudioServiceAuthorization = <T>(signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
export type AudioDownloadAuthorization = AudioServiceAuthorization;

export interface AudioGenerationAdapter {
  readonly provider: "elevenlabs" | "mureka" | "suno-platform" | "suno" | "sunoapi";
  /** Read-only validation and challenge preflight, before the paid submission boundary. */
  prepare?(request: AudioGenerationRequest, signal: AbortSignal): Promise<void>;
  submit(request: AudioGenerationRequest, signal: AbortSignal): Promise<AudioGenerationSubmission>;
  inspect?(taskId: string, signal: AbortSignal, expectedOutputs?: AudioJob["expectedOutputs"]): Promise<RemoteAudioStatus>;
  download?(output: RemoteAudioOutput, signal: AbortSignal): Promise<Uint8Array>;
  /** Freshly validate and collect only this observed output, without sibling dependencies or caller URLs. */
  downloadSelected?(output: Pick<RemoteAudioOutput, "key" | "role">, signal: AbortSignal,
    authorization: AudioDownloadAuthorization): Promise<Uint8Array>;
  cancel?(taskId: string, signal: AbortSignal): Promise<void>;
}

export interface AudioOrigin {
  kind: "attachment" | "arrangement" | "asset" | "generated";
  /** Arrangement position of the rendered snapshot, not a live target binding. */
  startBeat?: number;
  endBeat?: number;
  tempo?: number;
  sourceAssetId?: string;
}

export interface AudioAsset {
  id: string;
  sessionId: string;
  jobId: string;
  label: string;
  role: SeparationStem | "residual" | "source" | GeneratedAudioOutput["role"];
  mediaType: "audio/wav" | "audio/mpeg";
  byteLength: number;
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  origin: AudioOrigin;
}

/** Protocol-owned locator. Never projected into model messages or browser state. */
export interface RemoteAudioOutput {
  key: string;
  role: SeparationStem | "residual" | GeneratedAudioOutput["role"];
  url: string;
}

export type RemoteAudioStatus =
  | { status: "running"; progress?: number }
  | { status: "completed"; outputs: RemoteAudioOutput[]; failedOutputKeys?: string[] }
  | { status: "failed"; message: string }
  | { status: "cancelled" };

/** Only methods supported by the implemented asynchronous service are required. */
export interface AudioServiceAdapter {
  readonly provider: "lalal";
  readonly stems: readonly SeparationStem[];
  upload(bytes: Uint8Array, mediaType: AudioAsset["mediaType"], signal: AbortSignal): Promise<string>;
  submit(sourceId: string, stems: readonly SeparationStem[], idempotencyKey: string, signal: AbortSignal,
    sourceMediaType?: AudioAsset["mediaType"]): Promise<string>;
  inspect(taskId: string, stems: readonly SeparationStem[], signal: AbortSignal): Promise<RemoteAudioStatus>;
  cancel?(taskId: string, signal: AbortSignal): Promise<void>;
  download(output: RemoteAudioOutput, signal: AbortSignal): Promise<Uint8Array>;
}

export type AudioJobStatus =
  | "preparing" | "submitting" | "running" | "collecting" | "ready"
  | "completed" | "partial" | "failed" | "interrupted" | "unknown" | "cancelled";

export interface AudioJob {
  id: string;
  sessionId: string;
  provider: AudioProvider;
  serviceId: string;
  modelId?: string;
  /** Optional user-authored display title; never lyrics or provider diagnostics. */
  title?: string;
  /** Credential owner fingerprint; Suno binds the verified account, not its rotating Cookie. */
  connectionFingerprint: string;
  operation: AudioOperation;
  stems: SeparationStem[];
  status: AudioJobStatus;
  createdAt: string;
  updatedAt: string;
  sourceAssetId?: string;
  remoteSourceId?: string;
  remoteTaskId?: string;
  /** Immutable remote identities acknowledged before collection; never include URLs. */
  expectedOutputs?: Array<{ key: string; role: GeneratedAudioOutput["role"] }>;
  /** Observed successful Suno outputs, a URL-free subset of the immutable manifest. */
  remoteOutputs?: Array<{ key: string; role: GeneratedAudioOutput["role"] }>;
  /** Terminal provider state for the whole accepted remote task. */
  remoteTaskTerminal?: "failed" | "cancelled";
  /** Terminally failed output identities from an otherwise completed remote task. */
  failedOutputKeys?: string[];
  /** Historical result shape, used only when the original remote identities were not saved. */
  expectedOutputRoles?: GeneratedAudioOutput["role"][];
  outputAssets: AudioAsset[];
  message?: UiMessage;
}

export interface AudioJobView {
  id: string;
  provider: AudioProvider;
  serviceId: string;
  operation: AudioOperation;
  modelId?: string;
  title?: string;
  status: AudioJobStatus;
  stems: SeparationStem[];
  createdAt: string;
  outputs: AudioAsset[];
  remoteOutputs?: Array<{ key: string; role: GeneratedAudioOutput["role"] }>;
  message?: UiMessage;
  /** Remote generation/retrieval outcome, independent of chosen local downloads. */
  remoteOutcome?: "completed" | "partial" | "failed" | "cancelled";
  resumable: boolean;
}

export function audioJobView(job: AudioJob): AudioJobView {
  return {
    id: job.id, status: job.status, stems: [...job.stems], createdAt: job.createdAt,
    provider: job.provider, serviceId: job.serviceId, operation: job.operation,
    ...(job.modelId ? { modelId: job.modelId } : {}),
    ...(job.title ? { title: job.title } : {}),
    outputs: job.outputAssets.map((asset) => ({ ...asset, origin: { ...asset.origin } })),
    ...(job.remoteOutputs ? { remoteOutputs: job.remoteOutputs.map(({ key, role }) => ({ key, role })) } : {}),
    ...(job.message ? { message: job.message } : {}),
    ...(job.remoteOutputs !== undefined && audioJobRemoteSettled(job) ? {
      remoteOutcome: job.remoteTaskTerminal || job.failedOutputKeys?.length
        ? job.remoteOutputs.length ? "partial" as const : job.remoteTaskTerminal === "cancelled" ? "cancelled" as const : "failed" as const
        : "completed" as const,
    } : {}),
    resumable: Boolean(job.remoteTaskId) && job.status !== "completed" && job.status !== "cancelled" &&
      !audioJobRemoteSettled(job),
  };
}

/** True when another provider status read cannot reveal a new successful output. */
export function audioJobRemoteSettled(job: Pick<AudioJob,
  "remoteTaskTerminal" | "expectedOutputs" | "remoteOutputs" | "failedOutputKeys"
>): boolean {
  if (job.remoteTaskTerminal !== undefined) return true;
  if (!job.expectedOutputs?.length) return false;
  const accounted = new Set([
    ...(job.remoteOutputs?.map((output) => output.key) ?? []),
    ...(job.failedOutputKeys ?? []),
  ]);
  return job.expectedOutputs.every((output) => accounted.has(output.key));
}
