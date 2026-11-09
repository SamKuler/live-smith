import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

const state = {} as ChatDialogState;
const base = { buildState: async () => state, renderHtml: () => "", handleCommand: async () => state, handleSend: async () => {} };
function route(baseUrl: string, path: string) { const url = new URL(baseUrl); url.pathname = path; return url; }

test("stored media opens only the requested range, HEAD opens no reader, and waveform uses metadata", async t => {
  const opens: unknown[] = []; let waveformReads = 0;
  const bridge = await createChatBridge({ ...base, readAudioAssetExport: async () => ({ fileName: "a.wav", mediaType: "audio/wav", byteLength: 6,
    open: async (_signal, range) => { opens.push(range); return Readable.from([Buffer.from([1, 2, 3, 4, 5, 6]).subarray(range!.offset, range!.offset + range!.length)]); } }),
    readAudioWaveform: async () => { waveformReads++; return { peaks: [0.5], durationSeconds: 1 }; } });
  t.after(() => bridge.close());
  const url = route(bridge.url, "/audio-assets/a"); url.searchParams.set("sessionId", "s");
  const head = await fetch(url, { method: "HEAD", headers: { range: "bytes=1-3" } });
  assert.equal(head.status, 206); assert.equal(head.headers.get("content-length"), "3"); assert.deepEqual(opens, []);
  const partial = await fetch(url, { headers: { range: "bytes=1-3" } }); assert.equal(partial.status, 206);
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [2, 3, 4]); assert.deepEqual(opens, [{ offset: 1, length: 3 }]);
  const invalid = await fetch(url, { headers: { range: "bytes=12-" } }); assert.equal(invalid.status, 416); await invalid.text();
  url.searchParams.set("waveform", "1"); const wave = await fetch(url); assert.deepEqual(await wave.json(), { peaks: [0.5], durationSeconds: 1 });
  assert.equal(waveformReads, 1); assert.equal(opens.length, 1);
  url.searchParams.set("waveform", "yes"); assert.equal((await fetch(url)).status, 400);
});

test("a media reader open failure returns a complete JSON error without media framing", async t => {
  const bridge = await createChatBridge({ ...base, readAudioAssetExport: async () => ({ fileName: "a.wav", mediaType: "audio/wav", byteLength: 6,
    open: async () => { throw new Error("Saved media changed before opening."); } }) });
  t.after(() => bridge.close());
  const url = route(bridge.url, "/audio-assets/a"); url.searchParams.set("sessionId", "s");
  const response = await fetch(url, { headers: { range: "bytes=1-3" } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Saved media changed before opening." });
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("content-disposition"), null);
});

test("history page validates input and preserves the backend result", async t => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({ ...base, readSessionEvents: async input => { calls.push(input); return { sessionId: input.sessionId, events: [], nextBefore: 4 }; } });
  t.after(() => bridge.close()); const url = route(bridge.url, "/session-events");
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const input of [{ sessionId: "s", before: 0 }, { sessionId: "s", before: 3, after: 2 }, { sessionId: "s", anchorEventId: "a", before: 2 }, { sessionId: "s", afterEventId: "a", after: 2 }, { sessionId: "s", extra: true }, { sessionId: "../bad" }]) {
    const response = await post(input); assert.equal(response.status, 400); await response.text();
  }
  assert.deepEqual(calls, []); const response = await post({ sessionId: "s", historyId: "h", before: 5 });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { sessionId: "s", events: [], nextBefore: 4 });
  assert.deepEqual(calls, [{ sessionId: "s", historyId: "h", before: 5 }]);
});

test("interrupted streamed response closes its reader", { timeout: 5000 }, async t => {
  const closed = Promise.withResolvers<void>();
  const bridge = await createChatBridge({ ...base, readAudioAssetExport: async () => ({ fileName: "a.wav", mediaType: "audio/wav", byteLength: 10000000,
    open: async () => { const stream = new Readable({ read() { this.push(Buffer.alloc(65536)); } }); stream.once("close", () => closed.resolve()); return stream; } }) });
  t.after(() => bridge.close()); const url = route(bridge.url, "/audio-assets/a"); url.searchParams.set("sessionId", "s");
  const controller = new AbortController(); const response = await fetch(url, { signal: controller.signal });
  await response.body!.getReader().read(); controller.abort(); await closed.promise;
});

test("large upload reaches the consumer in bounded chunks", { timeout: 30000 }, async t => {
  const total = 129 * 1024 * 1024; let received = 0; let largest = 0;
  const bridge = await createChatBridge({ ...base, preflightAttachmentUpload: async () => {},
    handleAttachmentStreamUpload: async input => { assert.equal(input.expectedByteLength, total);
      for await (const chunk of input.chunks) { received += chunk.byteLength; largest = Math.max(largest, chunk.byteLength); }
      return state;
    } });
  t.after(() => bridge.close()); const url = route(bridge.url, "/attachments");
  url.searchParams.set("sessionId", "s"); url.searchParams.set("fileName", "large.wav");
  async function* body() { const chunk = Buffer.alloc(1024 * 1024); for (let n = 0; n < 129; n++) yield chunk; }
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(total) }, body: Readable.toWeb(Readable.from(body())) as ReadableStream, duplex: "half" } as RequestInit);
  assert.equal(response.status, 201); await response.json(); assert.equal(received, total); assert.ok(largest <= 1024 * 1024);
});

test("a failed media stream terminates an incomplete HTTP response", async t => {
  const closed = Promise.withResolvers<void>();
  const bridge = await createChatBridge({ ...base, readAudioAssetExport: async () => ({ fileName: "a.wav", mediaType: "audio/wav", byteLength: 100,
    open: async () => { const stream = Readable.from((async function* () { yield Buffer.alloc(10); throw new Error("corrupt media"); })()); stream.once("close", () => closed.resolve()); return stream; } }) });
  t.after(() => bridge.close()); const url = route(bridge.url, "/audio-assets/a"); url.searchParams.set("sessionId", "s");
  await assert.rejects(async () => { const response = await fetch(url); await response.arrayBuffer(); }); await closed.promise;
});

test("receipt lookup validates identity and returns the exact read-only result", async t => {
  const calls: unknown[] = []; const bridge = await createChatBridge({ ...base,
    lookupSendReceipt: async input => { calls.push(input); return { status: "absent" }; } });
  t.after(() => bridge.close()); const url = route(bridge.url, "/send-receipt");
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const input of [ { sessionId: "s", sendId: "bad/", prompt: "x", attachmentIds: [] },
    { sessionId: "s", sendId: "id", prompt: "x", attachmentIds: ["a", "a"] },
    { sessionId: "s", sendId: "id", prompt: "x", attachmentIds: [], extra: true } ]) {
    const response = await post(input); assert.equal(response.status, 400); await response.text();
  }
  const input = { sessionId: "s", sendId: "id:1", prompt: "hello", attachmentIds: ["a"], steerId: "steer-1" };
  const response = await post(input); assert.deepEqual(await response.json(), { status: "absent" }); assert.deepEqual(calls, [input]);
});

test("disconnecting a history request aborts its backend read", { timeout: 5000 }, async t => {
  const started = Promise.withResolvers<void>(); const stopped = Promise.withResolvers<void>();
  const bridge = await createChatBridge({ ...base, readSessionEvents: async (_input, signal) => {
    started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped.resolve(); resolve(); }, { once: true })); return {};
  } });
  t.after(() => bridge.close()); const controller = new AbortController();
  const pending = fetch(route(bridge.url, "/session-events"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s" }), signal: controller.signal }).catch(() => undefined);
  await started.promise; controller.abort(); await stopped.promise; await pending;
});


test("stalled streamed upload returns timeout and frees its permit", { timeout: 5000 }, async t => {
  const bridge = await createChatBridge({ ...base, attachmentBodyReadOptions: { timeoutMs: 30 }, preflightAttachmentUpload: async () => {},
    handleAttachmentStreamUpload: async input => { for await (const _chunk of input.chunks) {} return state; } });
  t.after(() => bridge.close()); const url = route(bridge.url, "/attachments"); url.searchParams.set("sessionId", "s"); url.searchParams.set("fileName", "a.wav");
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": "100" } }, response => { response.resume(); response.on("end", () => { resolve(response.statusCode); req.destroy(); }); });
    req.on("error", reject); req.write(Buffer.alloc(1));
  });
  assert.equal(status, 408);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from([1]) });
  assert.equal(response.status, 201); await response.json();
});

test("streamed upload permits progress and storage backpressure beyond the idle timeout", { timeout: 5000 }, async t => {
  let received = 0;
  const bridge = await createChatBridge({ ...base, attachmentBodyReadOptions: { timeoutMs: 100 }, preflightAttachmentUpload: async () => {},
    handleAttachmentStreamUpload: async input => { for await (const chunk of input.chunks) { received += chunk.byteLength; await new Promise(resolve => setTimeout(resolve, 130)); } return state; } });
  t.after(() => bridge.close()); const url = route(bridge.url, "/attachments"); url.searchParams.set("sessionId", "s"); url.searchParams.set("fileName", "a.wav");
  async function* body() { for (let i = 0; i < 8; i++) { yield Buffer.alloc(1024); await new Promise(resolve => setTimeout(resolve, 10)); } }
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": "8192" }, body: Readable.toWeb(Readable.from(body())) as ReadableStream, duplex: "half" } as RequestInit);
  assert.equal(response.status, 201); await response.json(); assert.equal(received, 8192); assert.ok(Date.now() - started > 100);
});


test("absent receipt stays uncertain while its send admission is pending", { timeout: 5000 }, async t => {
  let status: "absent" | "accepted" = "absent";
  const bridge = await createChatBridge({ ...base, lookupSendReceipt: async () => status === "absent" ? { status } : { status, event: {} as never } });
  t.after(() => bridge.close()); const send = route(bridge.url, "/send");
  const req = request(send, { method: "POST", headers: { "content-type": "application/json", "x-live-smith-send-id": "id-1", "content-length": "100" } });
  req.on("error", () => {}); req.write('{"sessionId":"s"');
  await new Promise(resolve => setTimeout(resolve, 30));
  const receipt = await fetch(route(bridge.url, "/send-receipt"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", sendId: "id-1", prompt: "x", attachmentIds: [] }) });
  assert.equal(receipt.status, 409); await receipt.text();
  status = "accepted";
  const accepted = await fetch(route(bridge.url, "/send-receipt"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", sendId: "id-1", prompt: "x", attachmentIds: [] }) });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json() as { status: string }).status, "accepted"); req.destroy();
});


test("2 GiB HTTP upload keeps memory bounded throughout streaming", { timeout: 60000 }, async () => {
  const probe = fileURLToPath(new URL("./support/bridge-upload-memory-probe.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", probe], { timeout: 55000 });
  const result = JSON.parse(stdout) as { status: number; received: number; rssGrowth: number };
  assert.equal(result.status, 201); assert.equal(result.received, 2 * 1024 * 1024 * 1024);
  assert.ok(result.rssGrowth < 256 * 1024 * 1024, `RSS grew ${(result.rssGrowth / 1024 / 1024).toFixed(0)} MiB`);
});

test("closing the bridge interrupts a stalled streamed upload and releases its permit", { timeout: 5000 }, async () => {
  const started = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
  const options = { ...base, preflightAttachmentUpload: async () => {},
    handleAttachmentStreamUpload: async (input: { chunks: AsyncIterable<Uint8Array> }, signal: AbortSignal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true }); started.resolve();
      for await (const _chunk of input.chunks) {} return state;
    } };
  const bridge = await createChatBridge(options); const target = route(bridge.url, "/attachments");
  target.searchParams.set("sessionId", "s"); target.searchParams.set("fileName", "a.wav");
  const req = request(target, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": "100" } });
  req.on("error", () => {}); req.write(Buffer.from([1]));
  await started.promise; const closing = bridge.close(); await aborted.promise; await closing; req.destroy();
  const next = await createChatBridge(options);
  try {
    const url = route(next.url, "/attachments"); url.searchParams.set("sessionId", "s"); url.searchParams.set("fileName", "a.wav");
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from([1]) });
    assert.equal(response.status, 201); await response.json();
  } finally { await next.close(); }
});
