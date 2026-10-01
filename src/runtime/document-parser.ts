import { clearTimeout, setTimeout } from "node:timers";
import type { URL } from "node:url";
import { Worker } from "node:worker_threads";

import { AttachmentProcessingError } from "../attachments/contracts.js";
import type { ExtractedDocumentText } from "../attachments/document-text.js";
import { throwIfAborted } from "./host.js";

const MAX_ACTIVE_PARSERS = 2;
const PARSE_TIMEOUT_MS = 30_000;
let activeParsers = 0;
const waiting = new Set<() => void>();

interface ParserResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  limit?: boolean;
}

/** Runs only an owned parser script; document bytes are always separate data. */
export async function runDocumentParserWorker(input: {
  source: string | URL;
  job: unknown;
  signal?: AbortSignal;
  /** Test seam for exercising deadlines without a thirty-second wait. */
  timeoutMs?: number;
}): Promise<ExtractedDocumentText> {
  throwIfAborted(input.signal);
  await acquireParser(input.signal);
  try {
    throwIfAborted(input.signal);
    let worker: Worker;
    try {
      worker = new Worker(input.source, {
        eval: typeof input.source === "string",
        workerData: input.job,
        execArgv: [],
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
    } catch {
      throw parserError("The document parser could not start in this extension host.");
    }
    // Third-party diagnostics are private to the worker and never enter the host log.
    worker.stdout.resume();
    worker.stderr.resume();
    try {
      return await new Promise<ExtractedDocumentText>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new AttachmentProcessingError("archive_limit", "Document parsing exceeded the 30-second limit."));
        }, input.timeoutMs ?? PARSE_TIMEOUT_MS);
        const onAbort = (): void => {
          try { throwIfAborted(input.signal); } catch (error) { reject(error); }
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        const cleanup = (): void => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
        };
        worker.once("message", (result: ParserResult) => {
          cleanup();
          if (result.ok && typeof result.text === "string" && typeof result.truncated === "boolean") {
            resolve({ text: result.text, truncated: result.truncated });
          } else {
            reject(new AttachmentProcessingError(result.limit ? "archive_limit" : "invalid_document",
              result.limit ? "The document exceeds the safe extraction limit." : "The document parser could not read this attachment."));
          }
        });
        worker.once("error", (error: Error & { code?: string }) => {
          cleanup();
          reject(error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new AttachmentProcessingError("archive_limit", "The document exceeds the parser's memory limit.")
            : parserError("The document parser stopped before completing this attachment."));
        });
        worker.once("exit", () => { cleanup(); reject(parserError("The document parser stopped before completing this attachment.")); });
      });
    } finally {
      await worker.terminate();
    }
  } finally {
    activeParsers -= 1;
    const next = waiting.values().next().value;
    next?.();
  }
}

async function acquireParser(signal?: AbortSignal): Promise<void> {
  while (activeParsers >= MAX_ACTIVE_PARSERS) {
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => { cleanup(); resolve(); };
      const aborted = (): void => {
        cleanup();
        try { throwIfAborted(signal); } catch (error) { reject(error); }
      };
      const cleanup = (): void => { waiting.delete(ready); signal?.removeEventListener("abort", aborted); };
      waiting.add(ready);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    throwIfAborted(signal);
  }
  activeParsers += 1;
}

function parserError(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_document", message);
}
