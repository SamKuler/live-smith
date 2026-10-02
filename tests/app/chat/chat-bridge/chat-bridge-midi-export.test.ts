import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";
import { midiBytes, noteTrack } from "../../../attachments/support/midi-test-helpers.js";
import { parseMidiArtifact } from "../../../../src/storage/midi-artifacts.js";

test("MIDI download tickets serve exact multitrack files with portable filenames and cannot authorize other resources", async (t) => {
  const bytes = midiBytes({ tracks: [noteTrack({ pitch: 64 }), noteTrack({ channel: 2 })] });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "", handleCommand: async () => state,
    handleSend: async () => {}, readMidiArtifact: async (sessionId, artifactRef) => {
      assert.equal(sessionId, "session-a"); assert.equal(artifactRef, "midi-v2");
      return { bytes, fileName: "主歌-v2.mid" };
    }, readAudioAsset: async () => ({ bytes: new Uint8Array([1]), mediaType: "audio/mpeg" }) });
  t.after(() => bridge.close());
  const signal = new AbortController().signal;
  const target = new URL(await bridge.createMidiDownload("session-a", "midi-v2", signal));
  assert.notEqual(target.searchParams.get("token"), new URL(bridge.url).searchParams.get("token"));
  const response = await fetch(target); assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/midi");
  assert.match(response.headers.get("content-disposition")!, /filename\*=UTF-8''%E4%B8%BB%E6%AD%8C-v2.mid/);
  const exported = new Uint8Array(await response.arrayBuffer()); assert.deepEqual(exported, bytes);
  assert.equal(parseMidiArtifact(exported).parts.length, 2);
  for (const route of ["/audio-download", "/state"]) {
    const wrong = new URL(target); wrong.pathname = route;
    const denied = await fetch(wrong); assert.equal(denied.status, 403); await denied.text();
  }
  const audio = new URL(await bridge.createAudioDownload("session-a", "midi-v2", signal)); audio.pathname = "/midi-download";
  const denied = await fetch(audio); assert.equal(denied.status, 403); await denied.text();
  const head = await fetch(target, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length));
  const range = await fetch(target, { headers: { range: "bytes=0-13" } }); assert.equal(range.status, 206);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(0, 14));
  const invalid = await fetch(target, { headers: { range: "bytes=999999-" } }); assert.equal(invalid.status, 416); await invalid.text();
});
