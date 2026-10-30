import assert from "node:assert/strict";
import { URL } from "node:url";
import WebSocket, { type ClientOptions } from "ws";

type EventPayload = Record<string, any>;

export interface BridgeEvents {
  socket: WebSocket;
  received: readonly EventPayload[];
  next(): Promise<EventPayload>;
  all(): Promise<EventPayload[]>;
  text(): Promise<string>;
  close(): Promise<void>;
}

/** Connects through the real upgrade and decodes the browser event envelopes. */
export async function openBridgeEvents(input: string | URL, options: ClientOptions = {}): Promise<BridgeEvents> {
  const url = new URL(input);
  const origin = url.origin;
  url.protocol = "ws:";
  const socket = new WebSocket(url, { origin, ...options });
  const pending: EventPayload[] = [];
  const received: EventPayload[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => socket.once("close", () => {
    ended = true;
    wake?.();
    resolve();
  }));
  socket.on("error", (error) => { failure = error; wake?.(); });
  socket.on("message", (data, binary) => {
    assert.equal(binary, false, "Browser events must use text frames");
    const events: EventPayload[] = JSON.parse(data.toString());
    assert.ok(Array.isArray(events));
    pending.push(...events);
    received.push(...events);
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    received,
    async next() {
      while (pending.length === 0) {
        if (failure) throw failure;
        if (ended) throw new Error("Event connection ended before the expected publication.");
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
      return pending.shift()!;
    },
    async all() { await closed; return received; },
    async text() { await closed; return received.map(event => JSON.stringify(event)).join("\n"); },
    async close() { socket.terminate(); await closed; },
  };
}

export async function readEvent(events: BridgeEvents, type?: string, accept: (event: EventPayload) => boolean = () => true): Promise<EventPayload> {
  for (;;) {
    const event = await events.next();
    if ((type === undefined || event.type === type) && accept(event)) return event;
  }
}

export async function readEventsThrough(events: BridgeEvents, type: string): Promise<EventPayload[]> {
  const received: EventPayload[] = [];
  do { received.push(await events.next()); } while (received.at(-1)!.type !== type);
  return received;
}
