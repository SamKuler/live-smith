import { Blob } from "node:buffer";
import { clearImmediate, setImmediate } from "node:timers";
import { URL } from "node:url";

// Undici's dispatcher modules expect these Node globals, but Ableton's
// extension VM intentionally exposes only a small runtime surface.
export { Blob, clearImmediate, setImmediate, URL };

export function queueMicrotask(callback: () => void): void {
  void Promise.resolve().then(() => {
    callback();
  }).catch((error: unknown) => {
    setImmediate(() => { throw error; });
  });
}
