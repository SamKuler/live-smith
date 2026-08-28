import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:process";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { AttachmentProcessingError } from "../attachments/contracts.js";
import { createHostAbortController } from "../runtime/host.js";
import { copyAudioFileSafely } from "./audio-attachment-source.js";

const execFileAsync = promisify(execFile);

test("a stable SDK-rendered audio file is copied into owned bytes", async (t) => {
  const directory = await temporaryDirectory(t, "stable");
  const sourcePath = path.join(directory, "render.wav");
  const sourceBytes = waveBytes({ dataBytes: 8_000 });
  await fs.writeFile(sourcePath, sourceBytes);

  const result = await copyAudioFileSafely(
    sourcePath,
    createHostAbortController().signal,
  );
  assert.deepEqual(result, sourceBytes);
  assert.notEqual(result.buffer, sourceBytes.buffer);
});

test("directories and symlinks are rejected without leaking their paths", async (t) => {
  const directory = await temporaryDirectory(t, "unsafe-files");
  const targetPath = path.join(directory, "real.wav");
  const symlinkPath = path.join(directory, "link.wav");
  await fs.writeFile(targetPath, waveBytes());
  await fs.symlink(targetPath, symlinkPath);

  for (const sourcePath of [directory, symlinkPath]) {
    await assert.rejects(
      copyAudioFileSafely(sourcePath, createHostAbortController().signal),
      redactedSourceError(directory),
    );
  }
});

test("oversized rendered audio is rejected before allocation", async (t) => {
  const directory = await temporaryDirectory(t, "oversized");
  const sourcePath = path.join(directory, "oversized.wav");
  const source = await fs.open(sourcePath, "w");
  await source.truncate(20 * 1024 * 1024 + 1);
  await source.close();

  await assert.rejects(
    copyAudioFileSafely(sourcePath, createHostAbortController().signal),
    attachmentError("archive_limit", /20 MiB/, directory),
  );
});

test("path replacement during a bounded read cannot return accepted bytes", async (t) => {
  const directory = await temporaryDirectory(t, "path-replacement");
  const sourcePath = path.join(directory, "replace.wav");
  const replacementPath = path.join(directory, "replacement.wav");
  await fs.writeFile(sourcePath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));
  await fs.writeFile(replacementPath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));

  let cancellationChecks = 0;
  const replacementSignal = {
    get aborted() {
      cancellationChecks += 1;
      if (cancellationChecks === 3) {
        fsSync.renameSync(sourcePath, path.join(directory, "original.wav"));
        fsSync.renameSync(replacementPath, sourcePath);
      }
      return false;
    },
  } as AbortSignal;
  await assert.rejects(
    copyAudioFileSafely(sourcePath, replacementSignal),
    redactedSourceError(directory),
  );
});

test("a regular file replaced by a FIFO around open fails promptly", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await temporaryDirectory(t, "fifo-race");
  const sourcePath = path.join(directory, "source.wav");
  const fifoPath = path.join(directory, "replacement.pipe");
  await fs.writeFile(sourcePath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));
  await execFileAsync("mkfifo", [fifoPath]);

  let cancellationChecks = 0;
  const replacementSignal = {
    get aborted() {
      cancellationChecks += 1;
      if (cancellationChecks === 2) {
        fsSync.renameSync(sourcePath, path.join(directory, "original.wav"));
        fsSync.renameSync(fifoPath, sourcePath);
      }
      return false;
    },
  } as AbortSignal;
  await assert.rejects(
    settlesWithin(
      copyAudioFileSafely(sourcePath, replacementSignal),
      2_000,
      "FIFO replacement blocked the rendered audio read.",
    ),
    redactedSourceError(directory),
  );
});

test("cancellation never returns partial rendered audio bytes", async (t) => {
  const directory = await temporaryDirectory(t, "cancel");
  const sourcePath = path.join(directory, "large.wav");
  await fs.writeFile(sourcePath, waveBytes({ dataBytes: 16 * 1024 * 1024 }));
  const controller = createHostAbortController();
  const cancellation = new Error("cancel rendered audio read");
  const copying = copyAudioFileSafely(sourcePath, controller.signal);
  setImmediate(() => controller.abort(cancellation));
  await assert.rejects(copying, (error: unknown) => error === cancellation);
});

async function temporaryDirectory(t: TestContext, label: string): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), `live-smith-rendered-audio-${label}-`),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
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
    /^The rendered Live audio file is unavailable or changed while it was being read\.$/,
    privatePath,
  );
}

function attachmentError(
  code: AttachmentProcessingError["code"],
  message: RegExp | undefined,
  privatePath: string,
) {
  return (error: unknown) => {
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
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
