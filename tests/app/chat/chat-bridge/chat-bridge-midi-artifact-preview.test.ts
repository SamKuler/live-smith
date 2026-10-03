import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import { runAgentFlow } from "../../../../src/app/agent-flow.js";
import { saveMidiArtifact } from "../../../../src/storage/midi-artifacts.js";
import { createSession, listSessions } from "../../../../src/storage/sessions.js";
import { midiBytes, noteTrack } from "../../../attachments/support/midi-test-helpers.js";
import { audioStorageHarness } from "../../../storage/support/audio-storage-test-helpers.js";
import { liveContextPresentationFixture } from "../../context/support/live-context.test-harness.js";
import type { LiveInteractionContext } from "../../../../src/live/context.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

const state = {} as ChatDialogState;
const input = { sessionId: "session-1", artifactRef: "midi-1", partId: "track-1-channel-2" };
const preview = { ...input, notes: [{ partId: input.partId, pitch: 72, startTime: 4, duration: 1 }], omittedNoteCount: 0 };
const headers = { "Content-Type": "application/json" };
function route(url: string, pathname = "/midi-artifact-preview"): URL {
  const target = new URL(url); target.pathname = pathname; return target;
}

test("MIDI part preview authenticates exact bounded read inputs without foreground events", async () => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => { assert.fail("A preview must not execute a command"); }, handleSend: async () => {},
    readMidiPartPreview: async (request, signal) => { calls.push(request); assert.equal(signal.aborted, false); return preview; },
  });
  const target = route(bridge.url);
  const events = await fetch(route(bridge.url, "/events"));
  const post = (body: string, url: URL = target, requestHeaders = headers) => fetch(url, { method: "POST", headers: requestHeaders, body });
  try {
    for (const token of ["", "incorrect"]) {
      const denied = new URL(target); denied.search = token ? `token=${token}` : "";
      const response = await post(JSON.stringify(input), denied);
      assert.equal(response.status, 403); await response.text();
    }
    for (const suffix of ["&extra=1", `&token=${target.searchParams.get("token")}`]) {
      const response = await post(JSON.stringify(input), new URL(`${target}${suffix}`));
      assert.equal(response.status, 400); await response.text();
    }
    for (const body of ["{", "null", "[]", JSON.stringify({ ...input, path: "/private/midi" }),
      JSON.stringify({ ...input, sessionId: "../other" }), JSON.stringify({ ...input, artifactRef: "../other" }),
      JSON.stringify({ ...input, partId: "" }), JSON.stringify({ ...input, partId: 1 }),
      JSON.stringify({ ...input, partId: "x".repeat(65) }), JSON.stringify({ ...input, partId: undefined }),
      `${JSON.stringify(input)}${" ".repeat(1024 * 1024)}`]) {
      const response = await post(body);
      assert.equal(response.status, 400, body.slice(0, 100)); await response.text();
    }
    const wrongType = await post(JSON.stringify(input), target, { "Content-Type": "text/plain" });
    assert.equal(wrongType.status, 400); await wrongType.text();
    const wrongMethod = await fetch(target);
    assert.equal(wrongMethod.status, 404); await wrongMethod.text();
    assert.deepEqual(calls, []);
    const accepted = await post(JSON.stringify(input));
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get("cache-control")!, /no-store/u);
    assert.deepEqual(await accepted.json(), preview);
    assert.deepEqual(calls, [input]);
    await bridge.close();
    assert.equal(await events.text(), "\n");
  } finally { await bridge.close(); }
});

for (const ending of ["disconnect", "bridge close"] as const) {
  test(`MIDI part preview ${ending} cancels its read and preserves cleanup`, { timeout: 3_000 }, async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    let readSignal: AbortSignal | undefined;
    const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
      handleCommand: async () => state, handleSend: async () => {},
      readMidiPartPreview: async (_request, signal) => {
        readSignal = signal; entered.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted.resolve(); await cleanup.promise; throw signal.reason;
      },
    });
    const controller = new AbortController();
    const pending = fetch(route(bridge.url), { method: "POST", headers, body: JSON.stringify(input), signal: controller.signal })
      .then((response) => ({ response }), (error: unknown) => ({ error }));
    let closing: Promise<void> | undefined;
    try {
      assert.equal(await Promise.race([entered.promise.then(() => "entered"), pending.then(() => "settled")]), "entered");
      const command = await fetch(route(bridge.url, "/command"), { method: "POST",
        headers: { ...headers, "X-Live-Smith-Command-Id": "during-part-preview" }, body: JSON.stringify({ kind: "new_session" }) });
      assert.equal(command.status, 200, "a pending preview does not occupy the foreground command slot"); await command.text();
      let closeSettled = false;
      if (ending === "disconnect") controller.abort();
      else closing = bridge.close().then(() => { closeSettled = true; });
      await aborted.promise;
      assert.equal(readSignal?.aborted, true);
      assert.ok("error" in await pending);
      if (ending === "bridge close") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closeSettled, false);
      } else {
        const response = await fetch(route(bridge.url, "/state"));
        assert.equal(response.status, 200); await response.text();
      }
      cleanup.resolve(); await (closing ?? bridge.close());
    } finally {
      controller.abort(); cleanup.resolve(); await pending; await (closing ?? bridge.close());
    }
  });
}

test("canonical MIDI part reads require the current Session without refreshing Live", async (t) => {
  const h = await audioStorageHarness(t);
  let refreshes = 0;
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Lead"), summary: "Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" } };
  interaction.selectionContext = { refresh: () => { refreshes++; return interaction; } };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: h.storage },
    ui: { showModalDialog: async (url: string) => {
      const stateResponse = await fetch(route(url, "/state"));
      const initial = await stateResponse.json() as ChatDialogState;
      const sessionId = initial.activeSessionId;
      assert.ok(sessionId);
      const saved = await saveMidiArtifact(h.storage, sessionId, { connectionId: "generator", serverId: "midi", toolName: "make",
        label: "Lead", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
      const request = { sessionId, artifactRef: saved.id, partId: "track-0-channel-1" };
      const read = () => fetch(route(url), { method: "POST", headers, body: JSON.stringify(request) });
      const before = refreshes;
      const response = await read();
      assert.equal(response.status, 200);
      assert.equal((await response.json() as typeof preview).notes[0]!.pitch, 60);
      assert.equal(refreshes, before);

      const current = (await listSessions(h.storage)).find((session) => session.id === sessionId)!;
      const other = await createSession(h.storage, { title: "Other", projectKey: current.projectKey, scope: current.scope });
      const selected = await fetch(route(url, "/command"), { method: "POST",
        headers: { ...headers, "X-Live-Smith-Command-Id": "select-preview-session" },
        body: JSON.stringify({ kind: "select_session", sessionId: other.id }) });
      assert.equal(selected.status, 200); await selected.text();
      const stale = await read();
      assert.equal(stale.status, 409);
      assert.match((await stale.json() as { error: string }).error, /active Session/u);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
