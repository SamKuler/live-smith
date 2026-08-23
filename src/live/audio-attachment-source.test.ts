import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  AudioClip,
  MidiClip,
  Sample,
  Simpler,
} from "@ableton-extensions/sdk";

import { AttachmentProcessingError } from "../attachments/contracts.js";
import { createHostAbortController } from "../runtime/host.js";
import { copySelectedAudioAttachmentSource } from "./audio-attachment-source.js";

const execFileAsync = promisify(execFile);

test("selected AudioClip, Sample, and Simpler sources are copied without exposing a path", async () => {
  const directory = await temporaryDirectory("selected-types");
  const sourcePath = path.join(directory, "Kick.wav");
  const sourceBytes = waveBytes({ dataBytes: 8_000 });
  await fs.writeFile(sourcePath, sourceBytes);

  const sources = [
    fakeAudioClip(sourcePath),
    fakeSample(sourcePath, 2n),
    fakeSimpler(fakeSample(sourcePath, 3n)),
  ];
  for (const object of sources) {
    const result = await copySource(object);
    assert.equal(result.fileName, "Kick.wav");
    assert.deepEqual(result.bytes, sourceBytes);
    assert.notEqual(result.bytes.buffer, sourceBytes.buffer);
    assert.deepEqual(result.inspection, {
      mediaType: "audio/wav",
      durationSeconds: 1,
      sampleRate: 8_000,
      channels: 1,
    });
    assert.equal("filePath" in result, false);
    assert.doesNotMatch(JSON.stringify(result.inspection), new RegExp(escapeRegExp(directory)));
  }
});

test("a Windows-style observed leaf never exposes its parent path", async () => {
  const directory = await temporaryDirectory("windows-leaf");
  const sourcePath = path.join(directory, "C:\\private\\samples\\Snare.wav");
  await fs.writeFile(sourcePath, waveBytes());

  const result = await copySource(fakeSample(sourcePath));
  assert.equal(result.fileName, "Snare.wav");
  assert.doesNotMatch(JSON.stringify(result), /private|samples/);
});

test("invalid selected Live targets and unusable source paths fail with a fixed redacted error", async () => {
  const privateDirectory = "/private/secret/project/audio";
  const cases = [
    fakeSimpler(null),
    fakeMidiClip(),
    fakeSample("", 10n),
    fakeSample(path.join(privateDirectory, "missing.wav"), 11n),
  ];
  for (const object of cases) {
    await assert.rejects(copySource(object), redactedSourceError(privateDirectory));
  }
});

test("Live source property failures cannot expose private paths", async () => {
  const privatePath = "/private/secret/source.wav";
  const throwingPath = Object.defineProperties(Object.create(Sample.prototype), {
    handle: { enumerable: true, value: { id: 12n } },
    name: { enumerable: true, value: "Sample" },
    filePath: {
      enumerable: true,
      get: () => {
        throw new Error(`SDK failed at ${privatePath}`);
      },
    },
  }) as Sample<"1.0.0">;
  const throwingHandle = Object.defineProperties(Object.create(Sample.prototype), {
    handle: {
      enumerable: true,
      get: () => {
        throw new Error(`SDK handle failed at ${privatePath}`);
      },
    },
    name: { enumerable: true, value: "Sample" },
    filePath: { enumerable: true, value: privatePath },
  }) as Sample<"1.0.0">;

  for (const object of [throwingPath, throwingHandle]) {
    await assert.rejects(copySource(object), redactedSourceError(privatePath));
  }
});

test("directories, symlinks, and FIFOs are rejected without leaking their locations", async () => {
  const directory = await temporaryDirectory("unsafe-files");
  const targetPath = path.join(directory, "real.wav");
  const symlinkPath = path.join(directory, "link.wav");
  const fifoPath = path.join(directory, "pipe.wav");
  await fs.writeFile(targetPath, waveBytes());
  await fs.symlink(targetPath, symlinkPath);
  await execFileAsync("mkfifo", [fifoPath]);

  for (const sourcePath of [directory, symlinkPath, fifoPath]) {
    await assert.rejects(copySource(fakeSample(sourcePath)), redactedSourceError(directory));
  }
});

test("oversized, unsupported, and over-duration selected audio is rejected safely", async () => {
  const directory = await temporaryDirectory("invalid-audio");
  const oversizedPath = path.join(directory, "oversized.wav");
  const unsupportedPath = path.join(directory, "unsupported.aiff");
  const tooLongPath = path.join(directory, "too-long.wav");
  const oversized = await fs.open(oversizedPath, "w");
  await oversized.truncate(20 * 1024 * 1024 + 1);
  await oversized.close();
  await fs.writeFile(unsupportedPath, "FORM not supported");
  await fs.writeFile(tooLongPath, waveBytes({ dataBytes: 8_000 * 121 }));

  await assert.rejects(
    copySource(fakeSample(oversizedPath)),
    attachmentError("archive_limit", /20 MiB/, directory),
  );
  await assert.rejects(
    copySource(fakeSample(unsupportedPath)),
    attachmentError("invalid_audio", /valid supported audio/, directory),
  );
  await assert.rejects(
    copySource(fakeSample(tooLongPath)),
    attachmentError("audio_duration_limit", /120 seconds/, directory),
  );
});

test("a selected Simpler sample change after copying is rejected", async () => {
  const directory = await temporaryDirectory("sample-drift");
  const firstPath = path.join(directory, "first.wav");
  const secondPath = path.join(directory, "second.wav");
  await fs.writeFile(firstPath, waveBytes());
  await fs.writeFile(secondPath, waveBytes());
  const first = fakeSample(firstPath, 21n);
  const second = fakeSample(secondPath, 22n);
  let reads = 0;
  const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
    handle: { enumerable: true, value: { id: 20n } },
    name: { enumerable: true, value: "Drifting Simpler" },
    sample: {
      enumerable: true,
      get: () => ++reads === 1 ? first : second,
    },
  }) as Simpler<"1.0.0">;

  await assert.rejects(copySource(simpler), redactedSourceError(directory));
});

test("path replacement during a bounded copy cannot produce an accepted attachment", async () => {
  const directory = await temporaryDirectory("path-replacement");
  const sourcePath = path.join(directory, "replace.wav");
  const replacementPath = path.join(directory, "replacement.wav");
  await fs.writeFile(sourcePath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));
  await fs.writeFile(
    replacementPath,
    waveBytes({ dataBytes: 16 * 1024 * 1024 }),
  );

  let cancellationChecks = 0;
  const replacementSignal = {
    get aborted() {
      cancellationChecks += 1;
      // The fourth check is the first bounded-read check after opening the source.
      if (cancellationChecks === 4) {
        fsSync.renameSync(sourcePath, path.join(directory, "original.wav"));
        fsSync.renameSync(replacementPath, sourcePath);
      }
      return false;
    },
  } as AbortSignal;
  const copying = copySource(fakeSample(sourcePath), replacementSignal);
  await assert.rejects(copying, attachmentError("invalid_audio", undefined, directory));
  assert.ok(cancellationChecks >= 4);
});

test("a regular source replaced by a FIFO around open fails promptly", async () => {
  const directory = await temporaryDirectory("fifo-race");
  const sourcePath = path.join(directory, "source.wav");
  const fifoPath = path.join(directory, "replacement.pipe");
  await fs.writeFile(sourcePath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));
  await execFileAsync("mkfifo", [fifoPath]);

  let cancellationChecks = 0;
  const replacementSignal = {
    get aborted() {
      cancellationChecks += 1;
      // The third check occurs after the initial lstat and immediately before open.
      if (cancellationChecks === 3) {
        fsSync.renameSync(sourcePath, path.join(directory, "original.wav"));
        fsSync.renameSync(fifoPath, sourcePath);
      }
      return false;
    },
  } as AbortSignal;
  const copying = copySource(fakeSample(sourcePath), replacementSignal);
  await assert.rejects(
    settlesWithin(copying, 2_000, "FIFO replacement blocked the source copy."),
    redactedSourceError(directory),
  );
  assert.ok(cancellationChecks >= 3);
});

test("selected source copying preserves cancellation and does not return partial bytes", async () => {
  const directory = await temporaryDirectory("cancel");
  const sourcePath = path.join(directory, "large.wav");
  await fs.writeFile(sourcePath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));
  const controller = createHostAbortController();
  const cancellation = new Error("cancel selected source");
  const copying = copySource(fakeSample(sourcePath), controller.signal);
  setImmediate(() => controller.abort(cancellation));
  await assert.rejects(copying, (error: unknown) => error === cancellation);
});

async function copySource(
  object: AudioClip<"1.0.0"> | Sample<"1.0.0"> | Simpler<"1.0.0"> | MidiClip<"1.0.0">,
  signal: AbortSignal = createHostAbortController().signal,
) {
  return copySelectedAudioAttachmentSource({
    context: {} as never,
    target: { object },
    signal,
  });
}

function fakeAudioClip(filePath: string): AudioClip<"1.0.0"> {
  return Object.defineProperties(Object.create(AudioClip.prototype), {
    handle: { enumerable: true, value: { id: 1n } },
    name: { enumerable: true, value: "Audio Clip" },
    filePath: { enumerable: true, value: filePath },
  }) as AudioClip<"1.0.0">;
}

function fakeSample(filePath: string, id = 2n): Sample<"1.0.0"> {
  return Object.defineProperties(Object.create(Sample.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { enumerable: true, value: "Sample" },
    filePath: { enumerable: true, value: filePath },
  }) as Sample<"1.0.0">;
}

function fakeSimpler(sample: Sample<"1.0.0"> | null): Simpler<"1.0.0"> {
  return Object.defineProperties(Object.create(Simpler.prototype), {
    handle: { enumerable: true, value: { id: 3n } },
    name: { enumerable: true, value: "Simpler" },
    sample: { enumerable: true, value: sample },
  }) as Simpler<"1.0.0">;
}

function fakeMidiClip(): MidiClip<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiClip.prototype), {
    handle: { enumerable: true, value: { id: 4n } },
    name: { enumerable: true, value: "MIDI Clip" },
  }) as MidiClip<"1.0.0">;
}

async function temporaryDirectory(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `live-smith-audio-${label}-`));
}

function waveBytes(options: { dataBytes?: number } = {}): Uint8Array {
  const sampleRate = 8_000;
  const dataBytes = options.dataBytes ?? sampleRate;
  const bytes = Buffer.alloc(44 + dataBytes);
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
  bytes.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(bytes);
}

function redactedSourceError(privatePath: string) {
  return attachmentError(
    "invalid_audio",
    /^The selected Live audio source is unavailable or changed while it was being copied\.$/,
    privatePath,
  );
}

function attachmentError(
  code: AttachmentProcessingError["code"],
  message: RegExp | undefined,
  privatePath: string,
) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AttachmentProcessingError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    assert.doesNotMatch(error.message, new RegExp(escapeRegExp(privatePath)));
    return true;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
