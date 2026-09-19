import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

import { LEGACY_AUDIO_SERVICE_ID, type AudioAsset } from "../audio-services/contracts.js";
import { createHostAbortController } from "../runtime/host.js";
import { saveAudioAsset } from "./audio-assets.js";
import { createAudioJob } from "./audio-jobs.js";
import { createSession } from "./sessions.js";

export const fingerprint = createHash("sha256").update("audio-storage-test-connection").digest("hex");
type AudioJobInput = Parameters<typeof createAudioJob>[2];
export const separationJobInput: AudioJobInput = {
  provider: "lalal", serviceId: LEGACY_AUDIO_SERVICE_ID, operation: "separate_stems",
  connectionFingerprint: fingerprint, stems: ["vocals", "drums"],
};
export const generationJobCases: { input: AudioJobInput; roles: AudioAsset["role"][] }[] = [
  { input: { provider: "elevenlabs", serviceId: "eleven-music", operation: "generate_music",
    connectionFingerprint: fingerprint, stems: [], modelId: "music_v2" }, roles: ["music"] },
  { input: { provider: "elevenlabs", serviceId: "eleven-effects", operation: "generate_sound_effect",
    connectionFingerprint: fingerprint, stems: [] }, roles: ["sound_effect"] },
  { input: { provider: "google-lyria", serviceId: "google-music", operation: "generate_music",
    connectionFingerprint: fingerprint, stems: [], modelId: "lyria-3.5" }, roles: ["music"] },
  { input: { provider: "mureka", serviceId: "mureka-lyrics", operation: "generate_song_from_lyrics",
    connectionFingerprint: fingerprint, stems: [], modelId: "mureka-9.5" }, roles: ["music"] },
  { input: { provider: "sunoapi", serviceId: "suno-music", operation: "generate_music",
    connectionFingerprint: fingerprint, stems: [] }, roles: ["music", "music_alternative"] },
  { input: { provider: "suno-platform", serviceId: "suno-platform", operation: "generate_music",
    connectionFingerprint: fingerprint, stems: [] }, roles: ["music"] },
];
export const sessionInput = {
  title: "Audio storage", projectKey: "test-project",
  scope: { kind: "track" as const, identity: "track-1", label: "Audio" },
};

export async function audioStorageHarness(t: TestContext, input: AudioJobInput = separationJobInput) {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-audio-storage-test-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const session = await createSession(storage, sessionInput);
  const job = await createAudioJob(storage, session.id, input);
  const directory = path.join(storage, "live-smith-audio", session.id);
  const signal = createHostAbortController().signal;
  const save = (role: AudioAsset["role"] = "source", bytes = waveBytes()) => saveAudioAsset(storage, session.id, {
    jobId: job.id, role, label: role, bytes,
    origin: { kind: job.operation === "separate_stems" ? "attachment" : "generated" }, signal,
  });
  return { storage, session, job, directory, signal, save };
}

export function waveBytes(seconds = 1, dataSize = seconds * 8000): Uint8Array {
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  return new Uint8Array(bytes);
}

export function mp3Bytes(): Uint8Array {
  const frameSize = Math.floor(144 * 128000 / 44100);
  const bytes = new Uint8Array(frameSize * 2);
  bytes.set([0xff, 0xfb, 0x90, 0]);
  bytes.set([0xff, 0xfb, 0x90, 0], frameSize);
  return bytes;
}

export async function overwriteJson(target: string, value: unknown): Promise<void> {
  await fs.writeFile(target, JSON.stringify(value));
}
