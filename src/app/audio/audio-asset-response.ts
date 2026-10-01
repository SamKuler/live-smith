import type { ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

/** Serve verified, owned audio bytes; no provider URL or filesystem path reaches the WebView. */
export function sendAudioAssetResponse(
  response: ServerResponse,
  audio: { bytes: Uint8Array; mediaType: "audio/wav" | "audio/mpeg" },
  rangeHeader: string | undefined,
  head = false,
  download = false,
): void {
  const size = audio.bytes.byteLength;
  response.setHeader("Content-Type", audio.mediaType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Disposition", download
    ? `attachment; filename="audio-result.${audio.mediaType === "audio/wav" ? "wav" : "mp3"}"`
    : "inline");
  let start = 0;
  let end = size - 1;
  if (rangeHeader !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) return unsatisfiable(response, size);
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return unsatisfiable(response, size);
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return unsatisfiable(response, size);
    }
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  response.setHeader("Content-Length", end - start + 1);
  response.end(head ? undefined : Buffer.from(audio.bytes.buffer, audio.bytes.byteOffset + start, end - start + 1));
}

function unsatisfiable(response: ServerResponse, size: number): void {
  response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
}
