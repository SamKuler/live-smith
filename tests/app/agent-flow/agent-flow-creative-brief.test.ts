import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { StorageCommitOutcomeUnknownError } from "../../../src/storage/persistence.js";
import { listSessions, updateSessionInTransaction } from "../../../src/storage/sessions.js";
import { subscribeSessionStateInvalidations } from "../../../src/app/session/session-state-events.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

let sequence = 0;
function endpoint(url: string, pathname: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${pathname}?token=${parsed.searchParams.get("token")}`;
}
async function command(url: string, body: unknown) {
  return fetch(endpoint(url, "/command"), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Command-Id": `brief-command-${++sequence}`,
  }, body: JSON.stringify(body) });
}

test("peer brief commits use compare-and-set, invalidate peer state, and prevent empty Session reuse", async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-brief-flow-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Bass"),
    summary: "Bass, tempo 123, meter 7/8", target: {}, scope: { kind: "track", identity: "bass", label: "Bass" } };
  interaction.selectionContext = { refresh: () => interaction };
  const invalidations: string[] = [];
  const unsubscribe = subscribeSessionStateInvalidations(directory, ({ sessionId }) => invalidations.push(sessionId));
  t.after(unsubscribe);
  const context = { application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (_url: string) => {} } };
  const open = (showModalDialog: (url: string) => Promise<void>) => {
    context.ui.showModalDialog = showModalDialog;
    return runAgentFlow(context as never, interaction, { renderHtml: () => "<html></html>" });
  };
  await open(async (firstUrl) => {
    const initial = await (await fetch(endpoint(firstUrl, "/state"))).json() as ChatDialogState;
    const sessionId = initial.activeSessionId;
    assert.equal(initial.sessions.find((session) => session.id === sessionId)?.creativeBrief, undefined);
    await open(async (peerUrl) => {
      const selected = await command(peerUrl, { kind: "select_session", sessionId });
      assert.equal(selected.status, 200, await selected.clone().text());
      const peer = await selected.json() as ChatDialogState;
      assert.equal(peer.activeSessionId, sessionId);
      const base = { kind: "set_session_creative_brief", sessionId, expectedCreativeBrief: "" };
      const responses = await Promise.all([
        command(firstUrl, { ...base, creativeBrief: "Keep bass; sparse percussion" }),
        command(peerUrl, { ...base, creativeBrief: "Keep bass; driving percussion" }),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      await Promise.all(responses.map((response) => response.text()));
      const saved = (await listSessions(directory)).find((entry) => entry.id === sessionId)!;
      assert.ok(saved.creativeBrief);
      assert.ok(saved.creativeBrief.includes("Keep bass;"));
      assert.equal(saved.creativeBrief.includes("123"), false);
      assert.equal(saved.creativeBrief.includes("7/8"), false);
      assert.ok(invalidations.includes(sessionId));
      const refreshed = await (await fetch(endpoint(peerUrl, "/state"))).json() as ChatDialogState;
      assert.equal(refreshed.sessions.find((entry) => entry.id === sessionId)?.creativeBrief, saved.creativeBrief);
      assert.equal(refreshed.sessions.find((entry) => entry.id === sessionId)?.hasContent, true);
      const fresh = await command(firstUrl, { kind: "new_session" });
      assert.equal(fresh.status, 200);
      const next = await fresh.json() as ChatDialogState;
      assert.notEqual(next.activeSessionId, sessionId);
      assert.equal(next.sessions.find((entry) => entry.id === next.activeSessionId)?.creativeBrief, undefined);
      // A background target keeps its own brief without selecting it in this dialog.
      const background = await command(firstUrl, { ...base, expectedCreativeBrief: saved.creativeBrief, creativeBrief: "Keep original bass" });
      assert.equal(background.status, 200, await background.clone().text());
      const state = await background.json() as ChatDialogState;
      assert.equal(state.activeSessionId, next.activeSessionId);
      assert.equal(state.sessions.find((entry) => entry.id === sessionId)?.creativeBrief, "Keep original bass");
      const staleProposal = await command(peerUrl, { ...base, creativeBrief: "Old model suggestion" });
      assert.equal(staleProposal.status, 409, await staleProposal.text());
      assert.equal((await listSessions(directory)).find((entry) => entry.id === sessionId)?.creativeBrief, "Keep original bass");
    });
  });
});


test("unknown brief commits invalidate peers and reconcile the durable value; stopped commands never save", async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-brief-unknown-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const invalidations: string[] = [];
  t.after(subscribeSessionStateInvalidations(directory, ({ sessionId }) => invalidations.push(sessionId)));
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Bass"), summary: "Bass", target: {},
    scope: { kind: "track", identity: "bass", label: "Bass" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const initial = await (await fetch(endpoint(url, "/state"))).json() as ChatDialogState;
      const sessionId = initial.activeSessionId;
      const response = await command(url, { kind: "set_session_creative_brief", sessionId, creativeBrief: "Keep bass", expectedCreativeBrief: "" });
      assert.equal(response.status, 500);
      const outcome = await response.json() as { commandOutcome: string };
      assert.equal(outcome.commandOutcome, "unknown");
      assert.ok(invalidations.includes(sessionId));
      const state = await (await fetch(endpoint(url, "/state"))).json() as ChatDialogState;
      assert.equal(state.sessions.find((entry) => entry.id === sessionId)?.creativeBrief, "Keep bass");
      const commandId = `brief-stop-${++sequence}`;
      const headers = { "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId };
      const stop = await fetch(endpoint(url, "/stop"), { method: "POST", headers, body: "{}" });
      assert.equal(stop.status, 200, await stop.text());
      const stopped = await fetch(endpoint(url, "/command"), { method: "POST", headers,
        body: JSON.stringify({ kind: "set_session_creative_brief", sessionId, creativeBrief: "Discard", expectedCreativeBrief: "Keep bass" }) });
      assert.equal(stopped.status, 409);
      assert.equal((await stopped.json() as { commandOutcome: string }).commandOutcome, "stopped");
      assert.equal((await listSessions(directory))[0]?.creativeBrief, "Keep bass");
    } },
  } as never, interaction, { renderHtml: () => "<html></html>", updateSessionInTransaction: async (...args) => {
    await updateSessionInTransaction(...args);
    throw new StorageCommitOutcomeUnknownError(new Error("Injected brief durability uncertainty"));
  } });
});
