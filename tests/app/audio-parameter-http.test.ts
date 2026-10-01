import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { audioRecoveryHarness } from "./support/audio-recovery-test-helpers.js";
import { runAgentFlow } from "../../src/app/agent-flow.js";
import { liveContextPresentationFixture } from "./support/live-context.test-harness.js";
import type { LiveInteractionContext } from "../../src/live/context.js";
import type { ChatDialogState } from "../../src/ui/chat-state.js";
import { loadSessionEvents } from "../../src/storage/events.js";

test("audio parameter HTTP commands run in an idle active Session without a model connection", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-one", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: h.storage },
    ui: { showModalDialog: async (url: string) => {
      let sequence = 0;
      const endpoint = (pathname: string) => { const target = new URL(url); target.pathname = pathname; return target; };
      const post = (pathname: string, input: unknown, id = `audio-${++sequence}`) => fetch(endpoint(pathname), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": id }, body: JSON.stringify(input),
      });
      const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
      assert.equal(initial.runtimeProfile, null);
      const discovery = await post("/session-tools", { kind: "load_session_tools", sessionId: initial.activeSessionId });
      assert.equal(discovery.status, 200);
      const state = await discovery.json() as ChatDialogState;
      const panels = state.sessionToolCatalog!.groups.filter((group) => group.kind === "audio").flatMap((group) => group.tools);
      assert.ok(panels.find((tool) => tool.audioPanel?.connectionId === h.connection.id));
      const panel = panels.find((tool) => tool.name === "list_audio_jobs")!.audioPanel!;
      const command = { kind: "run_audio_tool", sessionId: initial.activeSessionId,
        toolName: panel.toolName, signature: panel.signature, arguments: {} };
      assert.equal((await post("/command", { ...command, signature: "b".repeat(64) })).status, 409);
      assert.equal((await post("/command", { ...command, sessionId: "other-session" })).status, 409);
      const executed = await post("/command", command, "only-once");
      const text = await executed.text();
      assert.equal(executed.status, 200, text);
      assert.equal((JSON.parse(text) as ChatDialogState).runtimeProfile, null);
      assert.equal((await post("/command", command, "only-once")).status, 409);
      const events = await loadSessionEvents(h.storage, initial.activeSessionId);
      assert.deepEqual(events.map((event) => event.kind), ["tool_call", "tool_result"]);
      assert.deepEqual(JSON.parse(events[1]!.content), []);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
