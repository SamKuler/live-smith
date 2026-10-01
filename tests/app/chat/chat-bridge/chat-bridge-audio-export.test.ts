import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { URL } from "node:url";
import { createChatBridge, ChatBridgeResourceNotFoundError } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

test("external audio downloads use bounded asset-only tickets, never the dialog control token", async (t) => {
  const state = {} as ChatDialogState;
  const reads: string[] = [];
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => state, handleSend: async () => {},
    readAudioAsset: async (sessionId, assetId) => {
      reads.push(`${sessionId}:${assetId}`);
      if (sessionId !== "session-a" || assetId !== "asset-a") throw new ChatBridgeResourceNotFoundError("Unknown audio");
      return { bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" };
    },
  });
  t.after(() => bridge.close());
  const signal = new AbortController().signal;
  const target = new URL(await bridge.createAudioDownload("session-a", "asset-a", signal));
  const chat = new URL(bridge.url);
  assert.equal(target.pathname, "/audio-download");
  assert.notEqual(target.searchParams.get("token"), chat.searchParams.get("token"));
  assert.deepEqual([...target.searchParams.keys()], ["token"]);
  const wrongSession = bridge.createAudioDownload("session-b", "asset-a", signal);
  await assert.rejects(wrongSession, /Unknown audio/);
  const control = new URL(target); control.pathname = "/state";
  const denied = await fetch(control); assert.equal(denied.status, 403); await denied.text();
  const download = await fetch(target);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="audio-result.mp3"');
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const range = await fetch(target, { headers: { range: "bytes=1-2" } });
  assert.equal(range.status, 206); assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array([2, 3]));
  const extra = await fetch(`${target}&sessionId=session-b`);
  assert.equal(extra.status, 400); await extra.text();
  const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(target, { headers: { host: "untrusted.test" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject); req.end();
  });
  assert.equal(forgedHost, 403);
  const foreignOrigin = await fetch(target, { headers: { origin: "https://untrusted.test" } });
  assert.equal(foreignOrigin.status, 403); await foreignOrigin.text();
  const now = Date.now(); t.mock.method(Date, "now", () => now + 120_001);
  const expired = await fetch(target); assert.equal(expired.status, 403); await expired.text();
  assert.equal(reads.filter(value => value === "session-a:asset-a").length, 3);
});

test("export tickets are bounded, expire, and cannot be minted after cancellation or dialog closure", async (t) => {
  const state = {} as ChatDialogState;
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => state, handleSend: async () => {},
    readAudioAsset: async () => ({ bytes: new Uint8Array([1]), mediaType: "audio/mpeg" }),
  });
  t.after(() => bridge.close());
  const signal = new AbortController().signal;
  for (let index = 0; index < 20; index++) await bridge.createAudioDownload("session-a", "asset-a", signal);
  await assert.rejects(bridge.createAudioDownload("session-a", "asset-a", signal), /Too many pending/);
  now += 120_001;
  const target = await bridge.createAudioDownload("session-a", "asset-a", signal);
  const head = await fetch(target, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "1");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(bridge.createAudioDownload("session-a", "asset-a", cancelled.signal));
  await bridge.close();
  await assert.rejects(bridge.createAudioDownload("session-a", "asset-a", signal), /unavailable/);
});
