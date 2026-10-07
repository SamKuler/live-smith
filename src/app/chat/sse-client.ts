import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";

const maxPendingBytes = 4 * 1024 * 1024;
const maxPendingFrames = 4096;
const drainTimeoutMs = 15_000;

/** Owns ordered, bounded writes and socket cleanup for one event stream. */
export function createSseClient(response: ServerResponse, onClose: () => void) {
  const pending: string[] = [];
  let pendingBytes = 0;
  let waitingForDrain = false;
  let closed = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDrainTimer = () => {
    clearTimeout(drainTimer);
    drainTimer = undefined;
  };
  const retire = () => {
    if (closed) return;
    closed = true;
    clearDrainTimer();
    pending.length = 0;
    pendingBytes = 0;
    response.off("drain", flush);
    response.off("close", retire);
    response.off("error", destroy);
    onClose();
  };
  const destroy = () => {
    retire();
    response.destroy();
  };
  const write = (frame: string) => {
    // A false return still accepts the entire frame, including large snapshots.
    // Only subsequent frames belong in our bounded queue.
    if (!response.write(frame)) {
      waitingForDrain = true;
      drainTimer = setTimeout(destroy, drainTimeoutMs);
      drainTimer.unref();
    }
  };
  function flush() {
    clearDrainTimer();
    waitingForDrain = false;
    while (!closed && !waitingForDrain && pending.length > 0) {
      const frame = pending.shift()!;
      pendingBytes -= Buffer.byteLength(frame);
      write(frame);
    }
  }
  response.on("drain", flush);
  response.once("close", retire);
  response.once("error", destroy);

  return {
    send(frame: string) {
      if (closed) return;
      if (response.writableEnded || response.destroyed) { retire(); return; }
      if (!waitingForDrain) { write(frame); return; }
      const bytes = Buffer.byteLength(frame);
      if (pending.length >= maxPendingFrames || bytes > maxPendingBytes - pendingBytes) {
        destroy();
        return;
      }
      pending.push(frame);
      pendingBytes += bytes;
    },
    close() {
      if (closed) return;
      retire();
      response.end();
    },
  };
}
