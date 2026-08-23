import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import { throwIfAborted } from "../../runtime/host.js";
import { ModelConnectionError } from "../connection-error.js";
import {
  cancelStreamBestEffort,
  releaseReaderLockBestEffort,
} from "./stream-cancel.js";

export const MAX_DIRECT_SSE_EVENT_BYTES = 1024 * 1024;

export function assertServerSentEventResponse(
  response: Response,
  label: string,
  signal?: AbortSignal,
): void {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") return;
  cancelStreamBestEffort(response.body, signal?.reason);
  throwIfAborted(signal);
  throw new Error(`${label} returned a non-event-stream response.`);
}

export async function* parseServerSentEventData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingBytes = 0;
  let reachedEnd = false;
  let cancellationStarted = false;
  const cancel = (reason?: unknown): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    cancelStreamBestEffort(reader, reason);
  };
  const onAbort = (): void => {
    cancel(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      throwIfAborted(signal);
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          await Promise.resolve();
          throwIfAborted(signal);
          throw new ModelConnectionError();
        }
        throwIfAborted(signal);
        if (result.done) {
          reachedEnd = true;
          break;
        }
        pendingBytes += result.value.byteLength;
        buffer += decoder.decode(result.value, { stream: true });
        let consumedBoundary = false;
        while (true) {
          const boundary = nextEventBoundary(buffer);
          if (!boundary) break;
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          assertEventWithinLimit(block);
          const data = eventData(block);
          if (data !== undefined) yield data;
          consumedBoundary = true;
        }
        if (consumedBoundary) pendingBytes = Buffer.byteLength(buffer, "utf8");
        if (pendingBytes > MAX_DIRECT_SSE_EVENT_BYTES) throw oversizedEvent();
      }
      buffer += decoder.decode();
      assertEventWithinLimit(buffer);
      const data = eventData(buffer);
      if (data !== undefined) yield data;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!reachedEnd) cancel();
      releaseReaderLockBestEffort(reader);
    }
  } catch (cause) {
    // Let an Abort queued by the final reader turn win before rejection settles.
    await Promise.resolve();
    throwIfAborted(signal);
    throw cause;
  }
  // Apply the same precedence before reporting a clean end-of-stream.
  await Promise.resolve();
  throwIfAborted(signal);
}

function assertEventWithinLimit(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_DIRECT_SSE_EVENT_BYTES) {
    throw oversizedEvent();
  }
}

function oversizedEvent(): Error {
  return new Error("Provider event stream returned an oversized event.");
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
