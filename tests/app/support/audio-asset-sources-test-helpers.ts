import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

import type { AudioAsset } from "../../../src/audio-services/contracts.js";
import type { ManagedSampleSource } from "../../../src/live/sample-source.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { createAudioJob } from "../../../src/storage/audio-jobs.js";
import { createSession } from "../../../src/storage/sessions.js";

export async function assetHarness(t: TestContext, kind: "separation" | "generation" = "separation") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-asset-import-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Stems", projectKey: "project", scope: { kind: "object", identity: "song", label: "Song" },
  });
  const controller = createHostAbortController();
  const job = await createAudioJob(directory, session.id, kind === "generation" ? {
    provider: "elevenlabs", serviceId: "generator", operation: "generate_music",
    connectionFingerprint: "a".repeat(64), stems: [],
  } : {
    provider: "lalal", serviceId: "splitter", operation: "separate_stems",
    connectionFingerprint: "a".repeat(64), stems: ["vocals", "drums"],
  });
  const staged: Array<{ filePath: string; bytes: Uint8Array; fileMode: number; directoryMode: number }> = [];
  const operations: string[] = [];
  const input = {
    context: {
      environment: { tempDirectory: directory },
      resources: {
        async importIntoProject(filePath: string) {
          operations.push("import");
          staged.push({
            filePath, bytes: new Uint8Array(await fs.readFile(filePath)),
            fileMode: (await fs.stat(filePath)).mode & 0o777,
            directoryMode: (await fs.stat(path.dirname(filePath))).mode & 0o777,
          });
          return `/Live Project/Samples/${staged.length}${path.extname(filePath)}`;
        },
      },
    },
    storageDirectory: directory, sessionId: session.id, signal: controller.signal,
  };
  const sources = new Map<string, ManagedSampleSource>();
  async function save(role: AudioAsset["role"] = kind === "generation" ? "music" : "vocals", bytes = waveBytes()) {
    return saveAudioAsset(directory, session.id, {
      jobId: job.id, label: "/untrusted/label.wav", role, bytes,
      origin: kind === "generation" ? { kind: "generated" } : { kind: "arrangement", startBeat: 4, endBeat: 8, tempo: 120 },
      signal: controller.signal,
    });
  }
  return { directory, session, controller, job, staged, operations, sources, save, host: input.context,
    input: { ...input, context: input.context as never } };
}

export function sourceBindings(...sources: ManagedSampleSource[]) {
  return {
    tracks: new Map(), actionTracks: new Map(),
    actionObjects: new Map(sources.map((source, index) => [index, { sampleSource: source }])),
  };
}

export function waveBytes(): Uint8Array {
  const sampleRate = 8_000;
  const bytes = Buffer.alloc(44 + sampleRate);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(sampleRate, 40);
  return bytes;
}

export function mp3Bytes(): Uint8Array {
  const frameBytes = Math.floor(144 * 128_000 / 44_100);
  const frame = new Uint8Array(frameBytes);
  frame.set([0xff, 0xfb, 0x90, 0]);
  const bytes = new Uint8Array(frameBytes * 2);
  bytes.set(frame);
  bytes.set(frame, frameBytes);
  return bytes;
}
