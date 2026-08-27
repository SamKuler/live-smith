import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";

import type { ExtensionContext } from "@ableton-extensions/sdk";

import {
  inspectAudioAttachment,
  type AudioAttachmentInspection,
} from "../attachments/audio.js";
import {
  AttachmentProcessingError,
  MAX_AUDIO_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { audioFileLabel } from "./context.js";
import { resolveSampleSource } from "./sample-source.js";
import type { LiveTarget } from "./target.js";

type Api = ExtensionContext<"1.0.0">;

const audioSourceUnavailableMessage =
  "The selected Live audio source is unavailable or changed while it was being copied.";
const readChunkBytes = 256 * 1024;

export interface CopiedAudioAttachmentSource {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly inspection: AudioAttachmentInspection;
}

export async function copySelectedAudioAttachmentSource(input: {
  context: Api;
  target: LiveTarget;
  signal: AbortSignal;
}): Promise<CopiedAudioAttachmentSource> {
  throwIfAborted(input.signal);
  const initialSource = resolveSelectedSourceSafely(
    input.context,
    input.target,
    input.signal,
  );
  const fileName = audioFileLabel(initialSource.filePath);
  if (!sourcePathHasLeaf(initialSource.filePath)) {
    throw unavailableAudioSource();
  }

  const bytes = await copyAudioFileSafely(initialSource.filePath, input.signal);
  const finalSource = resolveSelectedSourceSafely(
    input.context,
    input.target,
    input.signal,
  );
  if (
    finalSource.filePath !== initialSource.filePath ||
    finalSource.objectId !== initialSource.objectId
  ) {
    throw unavailableAudioSource();
  }

  throwIfAborted(input.signal);
  const inspection = await inspectAudioAttachment({
    bytes,
    signal: input.signal,
  });
  return { fileName, bytes, inspection };
}

function resolveSelectedSourceSafely(
  context: Api,
  target: LiveTarget,
  signal: AbortSignal,
): { filePath: string; objectId: bigint } {
  try {
    throwIfAborted(signal);
    const source = resolveSampleSource(context, { kind: "selected" }, target);
    const filePath = source.filePath;
    const objectId = source.object.handle.id;
    if (typeof filePath !== "string" || typeof objectId !== "bigint") {
      throw unavailableAudioSource();
    }
    return { filePath, objectId };
  } catch {
    throwIfAborted(signal);
    throw unavailableAudioSource();
  }
}

export async function copyAudioFileSafely(
  filePath: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    throw unavailableAudioSource();
  }

  let handle: FileHandle | undefined;
  try {
    const beforeOpen = await lstat(filePath, { bigint: true });
    throwIfAborted(signal);
    assertSafeRegularFile(beforeOpen);

    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
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

function sourcePathHasLeaf(filePath: string): boolean {
  return filePath.trim().replaceAll("\\", "/").split("/").some(Boolean);
}
