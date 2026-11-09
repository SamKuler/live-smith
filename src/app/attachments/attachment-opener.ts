import { pipeline } from "node:stream/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ATTACHMENT_FORMATS } from "../../attachments/contracts.js";
import { createHostAbortController, throwIfAborted } from "../../runtime/host.js";
import { createSystemOpener, type SystemOpenerOptions } from "../../runtime/system-open.js";
import type { ReadSessionAttachmentResult, SessionAttachmentRef } from "../../storage/attachments.js";
import type { SessionFileExport } from "../../storage/file-export.js";
import { createStorageId } from "../../storage/id.js";

export interface AttachmentOpenerOptions extends SystemOpenerOptions {
  temporaryDirectory?: string;
}

export type AttachmentOpenValue = ReadSessionAttachmentResult | { attachment: SessionAttachmentRef; file: SessionFileExport };

export interface AttachmentOpener {
  open(value: AttachmentOpenValue, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/** The bridge serializes opens; verified bytes are copied before OS dispatch. */
export function createAttachmentOpener(
  options: AttachmentOpenerOptions = {},
): AttachmentOpener {
  const openSystem = createSystemOpener("attachment", options);
  const temporaryRoot = options.temporaryDirectory ?? tmpdir();
  const copies = new Map<string, string>();
  let directory: string | undefined;
  let closed = false;

  function active(signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (closed) throw new Error("The attachment opener is closed.");
  }

  async function createDirectory(): Promise<string> {
    const target = await fs.mkdtemp(path.join(temporaryRoot, "live-smith-open-attachments-"));
    try {
      await fs.chmod(target, 0o700);
      return target;
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function createCopy(value: AttachmentOpenValue, extension: string, signal?: AbortSignal): Promise<string> {
    let target: string | undefined;
    let created = false;
    try {
      directory ??= await createDirectory();
      target = path.join(directory, `${createStorageId("attachment")}.${extension}`);
      if ("file" in value) {
        if (value.file.byteLength !== value.attachment.byteLength || value.file.mediaType !== value.attachment.mediaType || value.file.fileName !== value.attachment.fileName) throw new Error("Attachment identity mismatch.");
        const stream = await value.file.open(signal ?? createHostAbortController().signal);
        let handle;
        try { handle = await fs.open(target, "wx", 0o600); }
        catch (error) { stream.destroy(); throw error; }
        created = true;
        const destination = handle.createWriteStream();
        if (signal) await pipeline(stream, destination, { signal });
        else await pipeline(stream, destination);
      } else {
        const handle = await fs.open(target, "wx", 0o600);
        created = true;
        try { await handle.writeFile(value.bytes); } finally { await handle.close(); }
      }
      return target;
    } catch {
      if (created && target !== undefined) await fs.rm(target, { force: true }).catch(() => {});
      throw new Error("The attachment could not be opened.");
    }
  }

  return {
    async open(value, signal) {
      active(signal);
      const format = ATTACHMENT_FORMATS.find((candidate) =>
        candidate.kind === value.attachment.kind &&
        candidate.mediaType === value.attachment.mediaType
      );
      if (format === undefined) {
        throw new Error("This saved attachment format cannot be opened locally.");
      }
      const key = JSON.stringify([
        value.attachment.id,
        value.attachment.sha256,
        value.attachment.mediaType,
      ]);
      let target = copies.get(key);
      let created = false;
      let dispatched = false;
      try {
        if (target === undefined) {
          target = await createCopy(value, format.extensions[0], signal);
          created = true;
        }
        active(signal);
        // Dispatch may succeed before reporting failure or cancellation.
        dispatched = true;
        copies.set(key, target);
        await openSystem(target, signal);
      } catch (error) {
        active(signal);
        throw error;
      } finally {
        if (created && !dispatched && target !== undefined) {
          await fs.rm(target, { force: true }).catch(() => {});
        }
      }
    },
    close() {
      closed = true;
      // External applications may keep reading or editing their exported copy.
      copies.clear();
    },
  };
}
