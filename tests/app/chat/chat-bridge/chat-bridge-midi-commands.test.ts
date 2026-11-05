import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

test("MIDI artifact import remains available while retired buffer commands are rejected before dispatch", async () => {
  const state = { activeSessionId: "session-midi" } as ChatDialogState;
  const commands: unknown[] = [];
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleSend: async () => {}, handleCommand: async (input) => { commands.push(input); return state; } });
  try {
    const target = new URL(bridge.url); target.pathname = "/command";
    const imported = { kind: "import_midi_artifact", sessionId: "session-midi", artifactRef: "midi-score",
      trackId: "10", trackName: "Piano", startBeat: 0 };
    const retired = [
      { kind: "load_midi_continuation", sessionId: imported.sessionId },
      { kind: "configure_midi_continuation", sessionId: imported.sessionId, expectedBufferId: null,
        sourceClips: [{ trackId: "10", clipId: "12" }], segmentBeats: 8, capacity: 2, prompt: "Continue", generator: { kind: "model" } },
      { kind: "fill_midi_continuation", sessionId: imported.sessionId, bufferId: "buffer-midi" },
      { ...imported, kind: "import_midi_continuation", bufferId: "buffer-midi" },
    ];
    for (const [index, input] of [...retired, imported].entries()) {
      const response = await fetch(target, { method: "POST", headers: {
        "Content-Type": "application/json", "X-Live-Smith-Command-Id": `midi-command-${index}`,
      }, body: JSON.stringify(input) });
      assert.equal(response.status, index < retired.length ? 400 : 200);
      await response.text();
    }
    assert.deepEqual(commands, [imported]);
  } finally { await bridge.close(); }
});
