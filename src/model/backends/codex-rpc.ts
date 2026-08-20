import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";

import packageMetadata from "../../../package.json" with { type: "json" };
import { throwIfAborted } from "../../runtime/host.js";
import { ModelBackendShutdownError } from "../provider.js";
import {
  type CodexChildProcess,
  type CodexSpawnImplementation,
  spawnCodexAppServer,
} from "../../runtime/process-host.js";
import { MAX_CODEX_RPC_LINE_BYTES } from "./codex-limits.js";

const maximumLineBytes = MAX_CODEX_RPC_LINE_BYTES;
const defaultRequestTimeoutMs = 30_000;
const closeGracePeriodMs = 250;
const maximumIgnoredResponseIds = 256;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const invalidProtocolMessage =
  "Codex App Server returned invalid protocol data.";
const connectionClosedMessage = "Codex App Server connection closed.";
const executableUnavailableMessage = "Codex executable unavailable.";
const clientClosedMessage = "Codex App Server client is closed.";

export interface CodexRpcOptions {
  storageDirectory: string;
  spawnImpl?: CodexSpawnImplementation;
  requestTimeoutMs?: number;
}

export interface CodexRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type NotificationListener = (params: unknown) => void;
type ConnectionFailureListener = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

export class CodexRpcClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<NotificationListener>>();
  private readonly connectionFailureListeners = new Set<ConnectionFailureListener>();
  private readonly ignoredResponseIds = new Set<number>();
  private readonly ignoredResponseIdOrder: number[] = [];
  private readonly exitPromise: Promise<void>;
  private readonly defaultTimeoutMs: number;
  private pendingLineChunks: Buffer[] = [];
  private pendingLineBytes = 0;
  private nextRequestId = 1;
  private resolveExit!: () => void;
  private exited = false;
  private closing = false;
  private closed = false;
  private terminalError: Error | undefined;
  private closePromise: Promise<void> | undefined;

  static async start(options: CodexRpcOptions): Promise<CodexRpcClient> {
    const defaultTimeoutMs = validTimeout(
      options.requestTimeoutMs ?? defaultRequestTimeoutMs,
    );
    const child = options.spawnImpl === undefined
      ? await spawnCodexAppServer(options.storageDirectory)
      : await spawnCodexAppServer(options.storageDirectory, options.spawnImpl);
    const client = new CodexRpcClient(child, defaultTimeoutMs);
    try {
      const response = await client.request<unknown>("initialize", {
        clientInfo: {
          name: "live-smith",
          title: "Live Smith",
          version: packageMetadata.version,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      if (!isSupportedInitializeResponse(response)) {
        throw new Error(
          "Live Smith requires Codex CLI version 0.148.x.",
        );
      }
      let codexHomeMatches = false;
      if (typeof response.codexHome === "string") {
        try {
          const expectedCodexHome = await fs.realpath(path.join(
            path.resolve(options.storageDirectory),
            "codex-subscription",
          ));
          codexHomeMatches = await fs.realpath(response.codexHome) ===
            expectedCodexHome;
        } catch {
          codexHomeMatches = false;
        }
      }
      if (!codexHomeMatches) {
        throw new Error(
          "Codex App Server did not use Live Smith's isolated credential directory.",
        );
      }
      client.writeMessage({ method: "initialized" });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private constructor(
    private readonly child: CodexChildProcess,
    defaultTimeoutMs: number,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stdout.on("data", (chunk: unknown) => this.receiveChunk(chunk));
    child.stdout.once("end", () => {
      if (!this.closing) this.failConnection(new Error(connectionClosedMessage));
    });
    child.stdout.once("error", () => {
      this.failConnection(new Error(connectionClosedMessage));
    });
    child.stdin.on("error", () => {
      this.failConnection(new Error(connectionClosedMessage));
    });
    child.stderr.on("data", () => undefined);
    child.stderr.on("error", () => undefined);
    child.once("error", (...args: unknown[]) => {
      this.failConnection(new Error(
        isExecutableUnavailableError(args[0])
          ? executableUnavailableMessage
          : connectionClosedMessage,
      ));
    });
    const observeChildTermination = (): void => {
      if (this.exited) return;
      this.exited = true;
      this.resolveExit();
      if (!this.closing) this.failConnection(new Error(connectionClosedMessage));
    };
    child.once("exit", observeChildTermination);
    child.once("close", observeChildTermination);
  }

  request<T>(
    method: string,
    params: unknown,
    options: CodexRpcRequestOptions = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.terminalError ?? new Error(clientClosedMessage));
    }
    try {
      throwIfAborted(options.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    let timeoutMs: number;
    try {
      timeoutMs = validTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextRequestId++;
    let encoded: string;
    try {
      encoded = encodeMessage({ id, method, params });
    } catch {
      return Promise.reject(
        new Error("Codex App Server request could not be encoded."),
      );
    }

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      const onAbort = (): void => {
        const pending = this.takePending(id);
        if (pending === undefined) return;
        this.rememberIgnoredResponseId(id);
        pending.reject(abortReason(signal));
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup,
      });
      timer = setTimeout(() => {
        const pending = this.takePending(id);
        if (pending === undefined) return;
        this.rememberIgnoredResponseId(id);
        pending.reject(new Error("Codex App Server request timed out."));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.child.stdin.write(`${encoded}\n`);
      } catch {
        const pending = this.takePending(id);
        pending?.reject(new Error(connectionClosedMessage));
        this.failConnection(new Error(connectionClosedMessage));
      }
    });
  }

  onNotification(method: string, listener: NotificationListener): () => void {
    let methodListeners = this.listeners.get(method);
    if (methodListeners === undefined) {
      methodListeners = new Set();
      this.listeners.set(method, methodListeners);
    }
    methodListeners.add(listener);
    return () => {
      methodListeners?.delete(listener);
      if (methodListeners?.size === 0) this.listeners.delete(method);
    };
  }

  onConnectionFailure(listener: ConnectionFailureListener): () => void {
    if (this.terminalError) {
      try {
        listener(this.terminalError);
      } catch {
        // Match live failure delivery: consumer callbacks cannot escape here.
      }
      return () => undefined;
    }
    this.connectionFailureListeners.add(listener);
    return () => this.connectionFailureListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.closed = true;
    const closeError = this.terminalError ?? new Error(clientClosedMessage);
    this.terminalError = closeError;
    this.notifyConnectionFailure(closeError);
    this.rejectAllPending(closeError);
    let processStopped = this.exited;
    if (!processStopped) {
      try {
        this.child.stdin.end();
      } catch {
        // Continue to the bounded TERM/KILL sequence below.
      }
      processStopped = await this.waitForExit(closeGracePeriodMs);
      if (!processStopped) {
        this.killChild("SIGTERM");
        processStopped = await this.waitForExit(closeGracePeriodMs);
      }
      if (!processStopped) {
        this.killChild("SIGKILL");
        processStopped = await this.waitForExit(closeGracePeriodMs);
      }
    }

    let auxiliaryResourcesStopped = true;
    try {
      await this.child.closeAuxiliaryResources();
    } catch {
      auxiliaryResourcesStopped = false;
    }
    if (!processStopped || !auxiliaryResourcesStopped) {
      throw new ModelBackendShutdownError(
        "Codex App Server resources could not be stopped.",
      );
    }
  }

  private receiveChunk(chunk: unknown): void {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : undefined;
    if (bytes === undefined) {
      this.failProtocol();
      return;
    }

    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) {
        this.appendPending(bytes.subarray(offset));
        return;
      }
      const segment = bytes.subarray(offset, newline);
      if (this.pendingLineBytes + segment.length > maximumLineBytes) {
        this.failProtocol();
        return;
      }
      const line = this.pendingLineBytes === 0
        ? segment
        : Buffer.concat(
            [...this.pendingLineChunks, segment],
            this.pendingLineBytes + segment.length,
          );
      this.pendingLineChunks = [];
      this.pendingLineBytes = 0;
      this.receiveLine(line);
      if (this.closed) return;
      offset = newline + 1;
    }
  }

  private appendPending(segment: Buffer): void {
    if (this.pendingLineBytes + segment.length > maximumLineBytes) {
      this.failProtocol();
      return;
    }
    this.pendingLineChunks.push(segment);
    this.pendingLineBytes += segment.length;
  }

  private receiveLine(rawLine: Buffer): void {
    const line = rawLine.at(-1) === 0x0d
      ? rawLine.subarray(0, rawLine.length - 1)
      : rawLine;
    let message: unknown;
    try {
      message = JSON.parse(utf8Decoder.decode(line));
    } catch {
      this.failProtocol();
      return;
    }
    if (!isRecord(message)) {
      this.failProtocol();
      return;
    }

    if ("id" in message) {
      if ("method" in message || !Number.isSafeInteger(message.id)) {
        this.failProtocol();
        return;
      }
      const id = message.id as number;
      const pending = this.takePending(id);
      if (pending === undefined) {
        if (this.ignoredResponseIds.delete(id)) return;
        this.failProtocol();
        return;
      }
      const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
      const hasError = Object.prototype.hasOwnProperty.call(message, "error");
      if (hasResult === hasError) {
        pending.reject(new Error(invalidProtocolMessage));
        this.failProtocol();
      } else if (hasError) {
        pending.reject(new Error("Codex App Server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") {
      this.failProtocol();
      return;
    }
    const methodListeners = this.listeners.get(message.method);
    if (methodListeners === undefined) return;
    for (const listener of [...methodListeners]) {
      try {
        listener(message.params);
      } catch {
        // A consumer callback cannot corrupt the protocol reader.
      }
    }
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    this.pending.delete(id);
    pending.cleanup();
    return pending;
  }

  private rememberIgnoredResponseId(id: number): void {
    this.ignoredResponseIds.add(id);
    this.ignoredResponseIdOrder.push(id);
    if (this.ignoredResponseIdOrder.length <= maximumIgnoredResponseIds) return;
    const expired = this.ignoredResponseIdOrder.shift();
    if (expired !== undefined) this.ignoredResponseIds.delete(expired);
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (this.closed) throw this.terminalError ?? new Error(clientClosedMessage);
    let encoded: string;
    try {
      encoded = encodeMessage(message);
      this.child.stdin.write(`${encoded}\n`);
    } catch {
      this.failConnection(new Error(connectionClosedMessage));
      throw new Error(connectionClosedMessage);
    }
  }

  private failProtocol(): void {
    this.failConnection(new Error(invalidProtocolMessage));
  }

  private failConnection(error: Error): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    this.closed = true;
    this.pendingLineChunks = [];
    this.pendingLineBytes = 0;
    this.notifyConnectionFailure(error);
    this.rejectAllPending(error);
    void this.close().catch(() => undefined);
  }

  private rejectAllPending(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.takePending(id)?.reject(error);
    }
  }

  private notifyConnectionFailure(error: Error): void {
    for (const listener of [...this.connectionFailureListeners]) {
      try {
        listener(error);
      } catch {
        // Connection teardown cannot be blocked by a consumer callback.
      }
    }
    this.connectionFailureListeners.clear();
  }

  private killChild(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // Closing is best-effort after the protocol has already been isolated.
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function encodeMessage(message: Record<string, unknown>): string {
  const encoded = JSON.stringify(message);
  if (encoded === undefined) throw new TypeError("Message is not JSON serializable.");
  return encoded;
}

function validTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("Codex App Server timeout must be positive.");
  }
  return value;
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal !== undefined && "reason" in signal && signal.reason !== undefined) {
    return signal.reason;
  }
  return new Error("Operation aborted.");
}

function isExecutableUnavailableError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedInitializeResponse(
  value: unknown,
): value is Record<string, unknown> & { userAgent: string } {
  if (!isRecord(value) || typeof value.userAgent !== "string") return false;
  const match = /(?:^|\s)[^\s/]+\/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?=$|[\s;(])/u
    .exec(value.userAgent);
  return match?.[1] === "0" && match[2] === "148";
}
