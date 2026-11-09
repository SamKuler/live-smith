import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import { previewWaveformRange } from "../attachments/audio.js";
import { throwIfAborted } from "../runtime/host.js";
import { openStoredRangeReader, STORAGE_CHUNK_BYTES } from "./sqlite.js";

export interface FileByteRange { offset: number; length: number }
export interface SessionFileExport {
  fileName: string;
  mediaType: string;
  byteLength: number;
  open(signal: AbortSignal, range?: FileByteRange): Promise<Readable>;
}

export function audioArtifactFileName(artifact: { id: string; label: string; mediaType: string }): string {
  const label = Buffer.from(artifact.label, "utf8").toString("utf8").normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const name = [...label].slice(0, 20).join("") || "Audio";
  return `${name}-${artifact.id}.${artifact.mediaType === "audio/wav" ? "wav" : "mp3"}`;
}

/** Exported content stays bound to its immutable metadata and storage revision. */
export async function openVerifiedStoredStream(input: {
  storageDirectory: string; key: string; byteLength: number; sha256: string;
  signal: AbortSignal; range?: FileByteRange; assertCurrent(): Promise<void>;
}): Promise<Readable> {
  throwIfAborted(input.signal);
  await input.assertCurrent();
  const reader = await openStoredRangeReader(input.storageDirectory, input.key);
  let handedOff = false;
  try {
    if (reader.entry.byteLength !== input.byteLength || reader.entry.sha256 !== input.sha256) {
      throw new Error("Stored file integrity check failed.");
    }
    const range = input.range ?? { offset: 0, length: input.byteLength };
    if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 ||
        range.length < 0 || range.offset + range.length > input.byteLength) throw new Error("Stored file range is invalid.");
    async function* chunks(offset: number, length: number) {
      for (let remaining = length; remaining > 0;) {
        throwIfAborted(input.signal);
        const chunk = await reader.readRange(offset, Math.min(STORAGE_CHUNK_BYTES, remaining));
        if (!chunk.length) throw new Error("Stored file ended before its recorded length.");
        offset += chunk.length;
        remaining -= chunk.length;
        yield chunk;
      }
    }
    const assertStable = async () => {
      throwIfAborted(input.signal);
      await input.assertCurrent();
      await reader.readRange(0, 0);
    };
    // Standalone exports validate before creating the visible copy. HTTP range
    // consumers read only the requested bytes and retain identity checks.
    if (input.range === undefined) {
      const verified = createHash("sha256");
      for await (const chunk of chunks(0, input.byteLength)) verified.update(chunk);
      if (verified.digest("hex") !== input.sha256) throw new Error("Stored file integrity check failed.");
    }
    await assertStable();
    const complete = range.offset === 0 && range.length === input.byteLength;
    const stream = Readable.from((async function* () {
      const hash = complete ? createHash("sha256") : undefined;
      let last: Buffer | undefined;
      try {
        for await (const chunk of chunks(range.offset, range.length)) {
          hash?.update(chunk);
          if (last) yield last;
          last = chunk;
        }
        await assertStable();
        if (hash && hash.digest("hex") !== input.sha256) throw new Error("Stored file changed during export.");
        if (last) yield last;
      } finally { await reader.close(); }
    })(), { highWaterMark: STORAGE_CHUNK_BYTES, objectMode: false });
    stream.once("close", () => { void reader.close().catch(() => {}); });
    addAbortSignal(input.signal, stream);
    handedOff = true;
    return stream;
  } finally { if (!handedOff) await reader.close(); }
}

/** Sample a preview from bounded ranges while retaining the saved owner/version. */
export async function readStoredWaveform(input: {
  storageDirectory: string; key: string; byteLength: number; sha256: string;
  signal?: AbortSignal; assertCurrent(): Promise<void>;
}): Promise<{ peaks: number[]; durationSeconds: number } | undefined> {
  throwIfAborted(input.signal);
  await input.assertCurrent();
  const reader = await openStoredRangeReader(input.storageDirectory, input.key);
  try {
    if (reader.entry.byteLength !== input.byteLength || reader.entry.sha256 !== input.sha256) throw new Error("Stored file integrity check failed.");
    const result = await previewWaveformRange({ byteLength: input.byteLength, readRange: reader.readRange,
      ...(input.signal ? { signal: input.signal } : {}) });
    await input.assertCurrent();
    await reader.readRange(0, 0);
    return result;
  } finally { await reader.close(); }
}
