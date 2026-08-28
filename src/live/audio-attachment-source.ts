import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";

import {
  AttachmentProcessingError,
  MAX_AUDIO_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { safeRegularFileOpenFlags } from "./safe-file-read.js";

const audioSourceUnavailableMessage =
  "The rendered Live audio file is unavailable or changed while it was being read.";
const readChunkBytes = 256 * 1024;

export async function copyAudioFileSafely(
  filePath: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    const beforeOpen = await lstat(filePath, { bigint: true });
    throwIfAborted(signal);
    assertSafeRegularFile(beforeOpen);

    handle = await open(
      filePath,
      safeRegularFileOpenFlags(constants),
    );
    const beforeRead = await handle.stat({ bigint: true });
    assertSameFileSnapshot(beforeOpen, beforeRead);
    assertSafeRegularFile(beforeRead);

    const size = Number(beforeRead.size);
    const owned = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      throwIfAborted(signal);
      const length = Math.min(readChunkBytes, size - offset);
      const result = await handle.read(owned, offset, length, offset);
      if (result.bytesRead <= 0) throw unavailableAudioSource();
      offset += result.bytesRead;
      await yieldToHost(signal);
    }

    const growthProbe = new Uint8Array(1);
    if ((await handle.read(growthProbe, 0, 1, size)).bytesRead !== 0) {
      throw unavailableAudioSource();
    }
    const afterRead = await handle.stat({ bigint: true });
    assertSameFileSnapshot(beforeRead, afterRead);
    const afterPath = await lstat(filePath, { bigint: true });
    assertSafeRegularFile(afterPath);
    assertSameFileSnapshot(afterRead, afterPath);
    throwIfAborted(signal);
    return owned;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AttachmentProcessingError) throw error;
    throw unavailableAudioSource();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The safe public error is selected by the primary operation above.
      }
    }
  }
}

interface BigIntFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function assertSafeRegularFile(snapshot: BigIntFileSnapshot): void {
  if (snapshot.isSymbolicLink() || !snapshot.isFile() || snapshot.size <= 0n) {
    throw unavailableAudioSource();
  }
  if (snapshot.size > BigInt(MAX_AUDIO_ATTACHMENT_BYTES)) {
    throw new AttachmentProcessingError(
      "archive_limit",
      "Audio attachments may not exceed 20 MiB.",
    );
  }
}

function assertSameFileSnapshot(
  expected: BigIntFileSnapshot,
  actual: BigIntFileSnapshot,
): void {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs ||
    actual.ctimeNs !== expected.ctimeNs
  ) {
    throw unavailableAudioSource();
  }
}

function unavailableAudioSource(): AttachmentProcessingError {
  return new AttachmentProcessingError(
    "invalid_audio",
    audioSourceUnavailableMessage,
  );
}
