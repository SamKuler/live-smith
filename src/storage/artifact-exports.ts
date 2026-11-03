import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { throwIfAborted } from "../runtime/host.js";
import type { SessionFileExport } from "./file-export.js";

/** Exported copies remain independent of Session deletion and native-window lifetime. */
export async function materializeArtifactExport(storageDirectory: string, file: SessionFileExport, signal: AbortSignal): Promise<{ filePath: string; discard(): Promise<void> }> {
  throwIfAborted(signal);
  const extension = file.mediaType === "audio/midi" ? "mid" : file.mediaType === "audio/wav" ? "wav" : file.mediaType === "audio/mpeg" ? "mp3" : undefined;
  if (!extension) throw new Error("This artifact format cannot be dragged out.");
  const root = path.join(storageDirectory, "live-smith-exports");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The export folder is unavailable.");
  await fs.chmod(root, 0o700);
  const directory = await fs.mkdtemp(path.join(root, "export-"));
  try {
    await fs.chmod(directory, 0o700);
    const label = file.fileName.normalize("NFC").replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").trim().replace(/^\.+/u, "")
      .replace(/\.(?:mid|midi|wav|mp3)$/iu, "");
    const fileName = `${[...label].slice(0, 100).join("").trim() || "Artifact"}.${extension}`;
    const target = path.join(directory, fileName);
    const source = await file.open(signal);
    await pipeline(source, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
    throwIfAborted(signal);
    return { filePath: target, discard: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
