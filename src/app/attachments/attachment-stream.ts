import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { throwIfAborted } from "../../runtime/host.js";
import {
  AttachmentStorageCorruptionError, readSessionAttachment, readSessionAttachmentMetadata,
  sessionAttachmentExport, sessionAttachmentRefFromStored, type SessionAttachmentRef,
} from "../../storage/attachments.js";

/** Open content only while the saved reference still matches the admitted reference. */
export async function openVerifiedAttachmentForUse(
  storageDirectory: string | undefined, sessionId: string, ref: SessionAttachmentRef, signal: AbortSignal,
): Promise<Readable> {
  throwIfAborted(signal);
  if (!storageDirectory) {
    const result = await readSessionAttachment(storageDirectory, sessionId, ref.id, { expectedRef: ref, signal });
    return Readable.from([result.bytes], { objectMode: false });
  }
  const check = async () => {
    const actual = sessionAttachmentRefFromStored(await readSessionAttachmentMetadata(storageDirectory, sessionId, ref.id));
    if (!isDeepStrictEqual(actual, ref)) throw new AttachmentStorageCorruptionError();
  };
  await check();
  const file = await sessionAttachmentExport(storageDirectory, sessionId, ref.id);
  const stream = await file.open(signal);
  try {
    await check();
    throwIfAborted(signal);
    return stream;
  } catch (error) { stream.destroy(); throw error; }
}
