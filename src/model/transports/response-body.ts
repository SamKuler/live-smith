import { TextDecoder } from "node:util";

import { throwIfAborted } from "../../runtime/host.js";
import { ModelConnectionError } from "../connection-error.js";
import {
  cancelStreamBestEffort,
  releaseReaderLockBestEffort,
} from "./stream-cancel.js";

export const MAX_DIRECT_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

interface JsonResponseOptions {
  label: string;
  signal?: AbortSignal;
  maximumBytes?: number;
  connectionFailureOnRead?: boolean;
}

export async function readBoundedJsonResponse(
  response: Response,
  options: JsonResponseOptions,
): Promise<unknown> {
  const maximumBytes = options.maximumBytes ?? MAX_DIRECT_JSON_RESPONSE_BYTES;
  const declaredLength = response.headers?.get("content-length");
  if (
    declaredLength !== null &&
    declaredLength !== undefined &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    cancelStreamBestEffort(response.body, options.signal?.reason);
    throwIfAborted(options.signal);
    throw oversizedJsonResponse(options.label, response.status, maximumBytes);
  }
  if (!response.body) {
    throwIfAborted(options.signal);
    throw new Error(
      `${options.label} returned invalid JSON (HTTP ${response.status}).`,
    );
  }

  let text: string;
  try {
    text = await readBoundedText(
      response.body,
      maximumBytes,
      options.signal,
      options.connectionFailureOnRead ?? false,
      () => oversizedJsonResponse(options.label, response.status, maximumBytes),
    );
  } catch (cause) {
    throwIfAborted(options.signal);
    throw cause;
  }
  throwIfAborted(options.signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof SyntaxError) {
      throw new Error(
        `${options.label} returned invalid JSON (HTTP ${response.status}).`,
      );
    }
    throw cause;
  }
}

async function readBoundedText(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  connectionFailureOnRead: boolean,
  tooLarge: () => Error,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteLength = 0;
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
    throwIfAborted(signal);
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        await Promise.resolve();
        throwIfAborted(signal);
        if (connectionFailureOnRead) throw new ModelConnectionError();
        throw cause;
      }
      throwIfAborted(signal);
      if (result.done) {
        reachedEnd = true;
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) throw tooLarge();
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!reachedEnd) cancel();
    releaseReaderLockBestEffort(reader);
  }
}

function oversizedJsonResponse(
  label: string,
  status: number,
  maximumBytes: number,
): Error {
  return new Error(
    `${label} returned a JSON response larger than ${maximumBytes} bytes ` +
      `(HTTP ${status}).`,
  );
}
