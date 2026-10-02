import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createChatBridge, ChatBridgeResourceNotFoundError } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

const image = { id: "image-1", kind: "image" as const, mediaType: "image/png" as const,
  fileName: "image.png", byteLength: 3, sha256: "a".repeat(64) };

function resource(url: string, id = image.id, sessionId = "session-a") {
  const target = new URL(url); target.pathname = `/attachments/${id}`;
  target.searchParams.set("sessionId", sessionId);
  return target;
}

test("attachment reads authenticate exact references and return private bytes and HEAD metadata", async (t) => {
  let reads = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => state, handleSend: async () => {},
    readAttachment: async (sessionId, id) => {
      reads++;
      if (sessionId !== "session-a" || id !== image.id) throw new ChatBridgeResourceNotFoundError("Missing attachment");
      return { attachment: image, bytes: new Uint8Array([1, 2, 3]) };
    },
  });
  t.after(() => bridge.close());
  const missingToken = resource(bridge.url); missingToken.searchParams.delete("token");
  const denied = await fetch(missingToken);
  assert.equal(denied.status, 403); await denied.text(); assert.equal(reads, 0);
  for (const target of [
    `${resource(bridge.url)}&sessionId=session-a`,
    `${resource(bridge.url)}&path=/tmp/private`,
    resource(bridge.url, "unsafe%2Fpath"),
  ]) {
    const invalid = await fetch(target);
    assert.equal(invalid.status, 400); await invalid.text();
  }
  assert.equal(reads, 0);
  const missing = await fetch(resource(bridge.url, "missing"));
  assert.equal(missing.status, 404); await missing.text();
  const response = await fetch(resource(bridge.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const head = await fetch(resource(bridge.url), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "3");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("closing the bridge cancels an outstanding attachment read", async () => {
  const entered = Promise.withResolvers<void>();
  let stopped = false;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => state, handleSend: async () => {},
    readAttachment: async (_session, _id, signal) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { stopped = true; reject(signal.reason); }, { once: true });
      });
      throw new Error("Unexpected completion");
    },
  });
  const pending = fetch(resource(bridge.url)).then(async (response) => response.text(), () => "Disconnected");
  await entered.promise;
  await bridge.close();
  await pending;
  assert.equal(stopped, true);
});

test("attachment audio supports byte ranges for native playback and seeking", async (t) => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => state, handleSend: async () => {},
    readAttachment: async () => ({ attachment: {
      id: "audio-1", kind: "audio", fileName: "sample.wav", mediaType: "audio/wav",
      byteLength: 6, sha256: "a".repeat(64), durationSeconds: 1, sampleRate: 32_000, channels: 1,
    }, bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) }),
  });
  t.after(() => bridge.close());
  const response = await fetch(resource(bridge.url, "audio-1"), { headers: { range: "bytes=2-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("content-range"), "bytes 2-4/6");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([3, 4, 5]));
  const invalid = await fetch(resource(bridge.url, "audio-1"), { headers: { range: "bytes=10-" } });
  assert.equal(invalid.status, 416); await invalid.text();
});
