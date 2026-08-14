import { TextDecoder } from "node:util";

import { throwIfAborted } from "../../runtime/host.js";

export async function* parseServerSentEventData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEnd = false;
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {
      // The cancellation reason is reported by throwIfAborted below.
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    while (true) {
      const result = await reader.read();
      throwIfAborted(signal);
      if (result.done) {
        reachedEnd = true;
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const boundary = nextEventBoundary(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = eventData(block);
        if (data !== undefined) yield data;
      }
    }
    buffer += decoder.decode();
    const data = eventData(buffer);
    if (data !== undefined) yield data;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the request or consumer error that caused early termination.
      }
    }
    reader.releaseLock();
  }
}

function nextEventBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(value);
  return match?.index === undefined
    ? undefined
    : { index: match.index, length: match[0].length };
}

function eventData(block: string): string | undefined {
  const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== "data") continue;
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    data.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  }
  return data.length ? data.join("\n") : undefined;
}
