import { Blob, Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import process from "node:process";
import { TransformStream } from "node:stream/web";
import { clearImmediate, setImmediate } from "node:timers";
import { URL } from "node:url";

// Bundled network libraries expect these Node globals, but Ableton's
// extension VM intentionally exposes only a small runtime surface.
const global = globalThis;
if (globalThis.crypto === undefined) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}

export { Blob, Buffer, clearImmediate, global, process, setImmediate, TransformStream, URL };

export function queueMicrotask(callback: () => void): void {
  void Promise.resolve().then(() => {
    callback();
  }).catch((error: unknown) => {
    setImmediate(() => { throw error; });
  });
}
