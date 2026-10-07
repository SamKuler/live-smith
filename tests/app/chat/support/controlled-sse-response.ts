import { Writable } from "node:stream";
import type { ServerResponse } from "node:http";

/** A real Writable whose downstream consumer explicitly releases each write. */
export function controlledSseResponse() {
  const frames: string[] = [];
  let release: (() => void) | undefined;
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      frames.push(String(chunk));
      release = callback;
    },
  });
  return {
    frames, stream, response: stream as unknown as ServerResponse,
    drain() { const done = release; release = undefined; done?.(); },
  };
}
