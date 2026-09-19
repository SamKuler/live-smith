import { Buffer } from "node:buffer";
import type { Agent } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket, { type RawData } from "ws";

import type { NetworkProxySettings } from "../model/profile.js";
import { throwIfAborted } from "./host.js";
import { NetworkProxyError } from "./network-proxy-error.js";
import { resolveNetworkRoute } from "./proxy-fetch.js";

const CLOSE_TIMEOUT_MS = 1_000;
const MAX_QUEUED_MESSAGES = 4;

export interface ProviderWebSocketConnection {
  sendText(value: string): Promise<void>;
  receiveText(signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
  terminate(): void;
}

export interface OpenProviderWebSocketOptions {
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  handshakeTimeoutMs: number;
  maximumMessageBytes: number;
}

export type OpenProviderWebSocket = (
  url: string,
  options: OpenProviderWebSocketOptions,
) => Promise<ProviderWebSocketConnection>;

/** Creates one WebSocket opener that resolves the current proxy selection per connection. */
export function createProxyAwareWebSocket(
  loadSelection: () => Promise<NetworkProxySettings>,
): OpenProviderWebSocket {
  return async (rawUrl, options) => {
    throwIfAborted(options.signal);
    const target = websocketUrl(rawUrl);
    if (!Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs < 1 ||
        !Number.isSafeInteger(options.maximumMessageBytes) || options.maximumMessageBytes < 1) {
      throw new TypeError("WebSocket limits are invalid.");
    }
    const route = await resolveNetworkRoute(loadSelection, options.signal);
    throwIfAborted(options.signal);
    const proxyUrl = route.selectProxy(target);
    let agent: Agent | undefined;
    try {
      agent = proxyUrl === null ? undefined : webSocketProxyAgent(proxyUrl);
    } catch {
      throw new NetworkProxyError(route.proxyFailureMessage ?? "The selected proxy is invalid.");
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(target, {
        headers: { ...options.headers },
        ...(agent ? { agent } : {}),
        followRedirects: false,
        handshakeTimeout: options.handshakeTimeoutMs,
        maxPayload: options.maximumMessageBytes,
        perMessageDeflate: false,
      });
    } catch {
      agent?.destroy();
      throw websocketOpenError(route.proxyFailureMessage, proxyUrl !== null);
    }

    return await waitForOpen(socket, agent, options.signal, route.proxyFailureMessage, proxyUrl !== null,
      options.maximumMessageBytes);
  };
}

function websocketUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error();
    }
    return url;
  } catch {
    throw new TypeError("WebSocket URL is invalid.");
  }
}

function webSocketProxyAgent(value: string): Agent {
  const proxy = new URL(value);
  if (proxy.protocol === "http:" || proxy.protocol === "https:") {
    return new HttpsProxyAgent(proxy);
  }
  if (proxy.protocol === "socks:" || proxy.protocol === "socks5:") {
    return new SocksProxyAgent(proxy);
  }
  throw new Error();
}

function waitForOpen(
  socket: WebSocket,
  agent: Agent | undefined,
  signal: AbortSignal,
  proxyFailureMessage: string | undefined,
  proxied: boolean,
  maximumMessageBytes: number,
): Promise<ProviderWebSocketConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("unexpected-response", onUnexpectedResponse);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.terminate();
      agent?.destroy();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
        return;
      }
      reject(websocketOpenError(proxyFailureMessage, proxied));
    };
    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(new WebSocketSession(socket, agent, maximumMessageBytes, signal));
    };
    const onError = (): void => fail();
    const onClose = (): void => fail();
    const onUnexpectedResponse = (_request: unknown, response: { destroy(): void }): void => {
      response.destroy();
      fail();
    };
    const onAbort = (): void => fail();
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("unexpected-response", onUnexpectedResponse);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) fail();
  });
}

function websocketOpenError(proxyFailureMessage: string | undefined, proxied: boolean): Error {
  return proxied && proxyFailureMessage
    ? new NetworkProxyError(proxyFailureMessage)
    : new Error("WebSocket connection failed.");
}

class WebSocketSession implements ProviderWebSocketConnection {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly queued: Array<{ text: string; bytes: number }> = [];
  private readonly waiters: Array<{
    resolve(value: string): void;
    reject(error: unknown): void;
    cleanup(): void;
  }> = [];
  private failure: Error | undefined;
  private queuedBytes = 0;
  private disposed = false;
  private readonly abortSignal: AbortSignal;

  constructor(
    private readonly socket: WebSocket,
    private readonly agent: Agent | undefined,
    private readonly maximumMessageBytes: number,
    signal: AbortSignal,
  ) {
    this.abortSignal = signal;
    socket.on("message", this.onMessage);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  sendText(value: string): Promise<void> {
    if (this.failure || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.failure ?? new Error("WebSocket connection is closed."));
    }
    return new Promise((resolve, reject) => {
      this.socket.send(value, { binary: false, compress: false }, (error) => {
        if (error) reject(new Error("WebSocket send failed."));
        else resolve();
      });
    });
  }

  receiveText(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const queued = this.queued.shift();
    if (queued) {
      this.queuedBytes -= queued.bytes;
      if (!this.queued.length && this.socket.isPaused) this.socket.resume();
      return Promise.resolve(queued.text);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiters.length) return Promise.reject(new Error("Concurrent WebSocket receives are not supported."));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        try { throwIfAborted(signal); } catch (error) { reject(error); }
      };
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const waiter = { resolve: (value: string) => { cleanup(); resolve(value); },
        reject: (error: unknown) => { cleanup(); reject(error); }, cleanup };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.dispose();
      return;
    }
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
    const completed = await Promise.race([
      closed.then(() => true),
      delay(CLOSE_TIMEOUT_MS, false, { ref: false }),
    ]);
    if (!completed) this.socket.terminate();
    this.dispose();
  }

  terminate(): void {
    this.fail(new Error("WebSocket connection closed."));
  }

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    try {
      if (isBinary) throw new Error();
      const bytes = rawDataBytes(data);
      if (bytes.byteLength > this.maximumMessageBytes) throw new Error();
      const text = this.decoder.decode(bytes);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(text);
        return;
      }
      if (this.queued.length >= MAX_QUEUED_MESSAGES ||
          this.queuedBytes + bytes.byteLength > this.maximumMessageBytes * MAX_QUEUED_MESSAGES) throw new Error();
      this.queued.push({ text, bytes: bytes.byteLength });
      this.queuedBytes += bytes.byteLength;
      this.socket.pause();
    } catch {
      this.fail(new Error("WebSocket returned an invalid message."));
    }
  };

  private readonly onError = (): void => this.fail(new Error("WebSocket connection failed."));
  private readonly onClose = (): void => this.fail(new Error("WebSocket connection closed."));
  private readonly onAbort = (): void => this.terminate();

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    this.socket.terminate();
    this.dispose();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.off("message", this.onMessage);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.abortSignal.removeEventListener("abort", this.onAbort);
    this.agent?.destroy();
  }
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.concat(data);
}
