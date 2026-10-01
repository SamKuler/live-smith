import assert from "node:assert/strict";
import test from "node:test";
import { retrievalHarness } from "./support/audio-retrieval-test-helpers.js";
import { loadSessionToolCatalog } from "../../src/app/session-tool-catalog.js";
import type { ChatDialogState } from "../../src/ui/chat-state.js";

test("the directory retains model-only listening only for a verified audio-capable transport", async (t) => {
  const h = await retrievalHarness(t);
  for (const [apiMode, evidence, expected] of [
    ["chat-completions", "supported", true],
    ["chat-completions", "unverified", false],
    ["responses", "supported", false],
  ] as const) {
    const state = {
      settings: { profiles: [{ id: "profile", connection: { kind: "direct-api", apiFamily: "openai", apiMode } }] },
      runtimeProfile: { profile: { id: "profile" }, capabilities: { tools: true, inputs: { audio: true } },
        inputCapabilityEvidence: { audio: evidence } },
    } as unknown as ChatDialogState;
    const catalog = await loadSessionToolCatalog({ storageDirectory: h.directory,
      sessionId: h.session.id, state, signal: h.controller.signal });
    const listening = catalog.groups.flatMap((group) => group.tools).find((tool) => tool.name === "listen_to_audio_asset");
    assert.equal(Boolean(listening), expected);
    if (listening) { assert.equal(listening.audioPanel, undefined); assert.equal(listening.panel, undefined); }
    assert.ok(catalog.groups.flatMap((group) => group.tools).some((tool) => tool.name === "builtin_suno_generate_music" && tool.audioPanel));
  }
});
