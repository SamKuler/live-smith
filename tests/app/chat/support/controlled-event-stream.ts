import { Writable } from "node:stream";

/** A real Writable whose downstream consumer explicitly releases each write. */
export function controlledEventStream() {
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
    frames, stream,
    drain() { const done = release; release = undefined; done?.(); },
  };
}
