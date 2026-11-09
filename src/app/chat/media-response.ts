import type { ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { pipeline } from "node:stream/promises";
import type { SessionFileExport, FileByteRange } from "../../storage/file-export.js";

interface MediaHeaders { byteLength: number; mediaType: string; fileName?: string }
function responseRange(size: number, rangeHeader: string | undefined): FileByteRange | undefined {
  let start = 0, end = size - 1;
  if (rangeHeader !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) return;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return;
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return;
    }
  }
  return { offset: start, length: end - start + 1 };
}

function prepareResponse(response: ServerResponse, file: MediaHeaders, range: FileByteRange | undefined,
  partial: boolean, head: boolean, download: boolean): void {
  response.setHeader("Content-Type", file.mediaType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Accept-Ranges", "bytes");
  const fallbackName = file.mediaType === "audio/midi" ? "midi-result.mid" : file.mediaType === "audio/wav" ? "audio-result.wav" : file.mediaType === "audio/mpeg" ? "audio-result.mp3" : "attachment";
  const encodedName = file.fileName && encodeURIComponent(file.fileName).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  response.setHeader("Content-Disposition", download
    ? `attachment; filename="${fallbackName}"${encodedName ? `; filename*=UTF-8''${encodedName}` : ""}` : "inline");
  if (!range) { response.writeHead(416, { "Content-Range": `bytes */${file.byteLength}` }).end(); return; }
  if (partial) {
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${file.byteLength}`);
  }
  response.setHeader("Content-Length", range.length);
  if (head) response.end();
}

/** Byte-backed consumers remain bounded by their own processing contracts. */
export function sendMediaAssetResponse(response: ServerResponse,
  file: { bytes: Uint8Array; mediaType: "audio/wav" | "audio/mpeg" | "audio/midi"; fileName?: string },
  rangeHeader: string | undefined, head = false, download = false): void {
  const range = responseRange(file.bytes.byteLength, rangeHeader);
  prepareResponse(response, { ...file, byteLength: file.bytes.byteLength }, range, rangeHeader !== undefined, head, download);
  if (range && !head) response.end(Buffer.from(file.bytes.buffer, file.bytes.byteOffset + range.offset, range.length));
}

/** Reads only the requested file span, with Node streams providing backpressure. */
export async function sendStoredMediaResponse(response: ServerResponse, file: SessionFileExport,
  rangeHeader: string | undefined, signal: AbortSignal, head = false, download = false): Promise<void> {
  const range = responseRange(file.byteLength, rangeHeader);
  if (!range || head) { prepareResponse(response, file, range, rangeHeader !== undefined, head, download); return; }
  const source = await file.open(signal, range);
  prepareResponse(response, file, range, rangeHeader !== undefined, head, download);
  await pipeline(source, response, { signal });
}
