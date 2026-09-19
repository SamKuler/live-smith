import { Blob, Buffer } from "node:buffer";
import process from "node:process";
import { clearImmediate, setImmediate } from "node:timers";
import { URL } from "node:url";

// Bundled network libraries expect these Node globals, but Ableton's
// extension VM intentionally exposes only a small runtime surface.
export { Blob, Buffer, clearImmediate, process, setImmediate, URL };

export function queueMicrotask(callback: () => void): void {
  void Promise.resolve().then(() => {
    callback();
  }).catch((error: unknown) => {
    setImmediate(() => { throw error; });
  });
}
