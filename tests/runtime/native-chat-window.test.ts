import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { createNativeChatHost } from "../../src/runtime/native-chat-window.js";

const capsule = JSON.stringify({ version: 1, files: ["Contents/MacOS/NativeChat", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"].map(path => {
  const bytes = Buffer.from(path); return { path, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}) });
const url = "http://127.0.0.1:54321/chat?token=private-window-token";
function processFixture(ready = true) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { child.killed = true; queueMicrotask(() => child.emit("close", 0)); return true; } });
  const messages: Array<Record<string, unknown>> = [];
  child.stdin.on("data", chunk => {
    for (const line of String(chunk).trim().split("\n")) messages.push(JSON.parse(line));
    if (messages.length === 1 && ready) child.stdout.write('{"type":"ready"}\n');
  });
  return { child, messages, send(value: unknown) { child.stdout.write(JSON.stringify(value) + "\n"); } };
}
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) { const value = read(); if (value) return value; await delay(5); }
  throw new Error("Native protocol response did not arrive");
}
const input = { sessionId: "session-one", artifact: { kind: "midi" as const, id: "midi-one" } };

test("native preparation reuses one copy and keeps a claimed file after chat shutdown", async t => {
  const directory = await fs.mkdtemp("/private/tmp/native-chat-runtime-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const p = processFixture(); let prepared = 0; let discarded = 0; let executable = "";
  const host = createNativeChatHost({ platform: "darwin", osRelease: "23.0.0", capsule, launch: file => { executable = file; return p.child as unknown as ChildProcessWithoutNullStreams; } });
  const window = await host.open({ url, prepareArtifact: async (actual, signal) => {
    assert.deepEqual(actual, input); assert.equal(signal.aborted, false); prepared++;
    const filePath = path.join(directory, "phrase.mid"); await fs.writeFile(filePath, Buffer.from([1, 2, 3]));
    return { filePath, discard: async () => { discarded++; await fs.rm(filePath); } };
  } });
  p.send({ type: "prepare", id: "prepare-one", ...input });
  const first = await waitFor(() => p.messages.find(message => message.type === "prepared"));
  p.send({ type: "prepare", id: "prepare-two", ...input });
  const second = await waitFor(() => p.messages.find(message => message.id === "prepare-two"));
  assert.equal(first.token, second.token); assert.equal(prepared, 1);
  p.send({ type: "claim", id: "drag-one", token: first.token });
  await waitFor(() => p.messages.find(message => message.type === "claimed"));
  window.close(); await window.closed;
  assert.equal(discarded, 0); assert.deepEqual(await fs.readFile(first.filePath as string), Buffer.from([1, 2, 3]));
  await assert.rejects(fs.stat(executable));
});

test("closing native chat cancels in-flight preparation and discards every unclaimed copy", async () => {
  const p = processFixture(); let discarded = 0; let aborted = false;
  const host = createNativeChatHost({ platform: "darwin", osRelease: "23.0.0", capsule, launch: () => p.child as unknown as ChildProcessWithoutNullStreams });
  const window = await host.open({ url, prepareArtifact: async ({ artifact }, signal) => {
    if (artifact.id === "pending") return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
    return { filePath: "/private/tmp/unused.mid", discard: async () => { discarded++; } };
  } });
  p.send({ type: "prepare", id: "ready", ...input });
  await waitFor(() => p.messages.find(message => message.type === "prepared"));
  p.send({ type: "prepare", id: "pending", ...input, artifact: { kind: "midi", id: "pending" } });
  await delay(0); window.close(); await window.closed;
  assert.equal(discarded, 1); assert.equal(aborted, true);
});

test("native preparation failures stay path-free and retry the same artifact", async () => {
  const p = processFixture(); let calls = 0;
  const host = createNativeChatHost({ platform: "darwin", osRelease: "23.0.0", capsule, launch: () => p.child as unknown as ChildProcessWithoutNullStreams });
  const window = await host.open({ url, prepareArtifact: async () => {
    if (++calls === 1) throw new Error("/private/canary/secret");
    return { filePath: "/private/tmp/ready.mid", discard: async () => {} };
  } });
  p.send({ type: "prepare", id: "first", ...input });
  const failed = await waitFor(() => p.messages.find(message => message.type === "prepare_failed"));
  assert.deepEqual(failed, { type: "prepare_failed", id: "first" });
  p.send({ type: "prepare", id: "second", ...input });
  await waitFor(() => p.messages.find(message => message.type === "prepared")); assert.equal(calls, 2);
  window.close(); await window.closed;
});

test("native host rejects external navigation targets and unsupported platforms before launch", async () => {
  let calls = 0;
  const options = { platform: "darwin" as const, osRelease: "23.0.0", capsule, launch: () => { calls++; return processFixture().child as unknown as ChildProcessWithoutNullStreams; } };
  const prepareArtifact = async () => ({ filePath: "/private/tmp/file.mid", discard: async () => {} });
  for (const url of ["https://example.com/chat?token=x", "http://127.0.0.1:80/other?token=x", "http://127.0.0.1:80/chat"]) {
    await assert.rejects(createNativeChatHost(options).open({ url, prepareArtifact }));
  }
  await assert.rejects(createNativeChatHost({ ...options, platform: "win32" }).open({ url, prepareArtifact }));
  assert.equal(calls, 0);
});

test("a valid preparation can arrive while the native document is finishing its first load", async () => {
  const p = processFixture(false);
  let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
  const host = createNativeChatHost({ platform: "darwin", osRelease: "23.0.0", capsule, launch: () => { launched(); return p.child as unknown as ChildProcessWithoutNullStreams; } });
  const opening = host.open({ url, prepareArtifact: async () => ({ filePath: "/private/tmp/ready.mid", discard: async () => {} }) });
  await started;
  p.send({ type: "prepare", id: "before-ready", ...input });
  await waitFor(() => p.messages.find(message => message.type === "prepared"));
  assert.equal(p.child.killed, false);
  p.send({ type: "ready" });
  const window = await opening; window.close(); await window.closed;
});

test("native startup cancellation and invalid protocol stop the process without leaking the URL", async () => {
  for (const abort of [false, true]) {
    const p = processFixture(false); const controller = new AbortController();
    let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
    const host = createNativeChatHost({ platform: "darwin", osRelease: "23.0.0", capsule, launch: () => { launched(); return p.child as unknown as ChildProcessWithoutNullStreams; } });
    const opening = host.open({ url, signal: controller.signal, prepareArtifact: async () => { throw new Error("not expected"); } });
    const rejected = assert.rejects(opening, error => {
      assert.equal(String(error).includes("private-window-token"), false); return true;
    });
    await started;
    if (abort) controller.abort(); else p.send({ type: "unknown-private-canary" });
    await rejected; assert.equal(p.child.killed, true);
  }
});

test("user cancellation before native readiness completes cleanup before reporting cancellation", async () => {
  const p = processFixture(false);
  let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
  let discarded!: () => void; const discarding = new Promise<void>(resolve => { discarded = resolve; });
  let release!: () => void; const cleanupGate = new Promise<void>(resolve => { release = resolve; });
  let executable = "";
  const host = createNativeChatHost({ platform: "darwin", osRelease: "23.0.0", capsule, launch: file => {
    executable = file; launched(); return p.child as unknown as ChildProcessWithoutNullStreams;
  } });
  const opening = host.open({ url, prepareArtifact: async () => ({ filePath: "/private/tmp/unclaimed.mid", discard: async () => {
    discarded(); await cleanupGate;
  } }) });
  let settled = false;
  void opening.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(opening, { name: "NativeChatCancelledError" });
  try {
    await started;
    p.send({ type: "prepare", id: "cancelled-preparation", ...input });
    await waitFor(() => p.messages.find(message => message.type === "prepared"));
    p.child.stdout.write('{"type":"cancelled"}\n{"type":"ready"}\n');
    await discarding;
    assert.equal(settled, false);
  } finally { release(); await rejected; }
  assert.equal(p.child.killed, true);
  await assert.rejects(fs.stat(executable));
});
