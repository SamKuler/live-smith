import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import { runAgentFlow } from "../../../../src/app/agent-flow.js";
import type { MidiArtifactDiff } from "../../../../src/app/midi/midi-artifact-diff.js";
import type { SessionArtifactDetail } from "../../../../src/app/session/session-artifacts.js";
import { saveMidiArtifact } from "../../../../src/storage/midi-artifacts.js";
import { createSession, listSessions } from "../../../../src/storage/sessions.js";
import { isSessionArtifactDetail } from "../../../../src/ui/client/wire-contracts/artifacts.js";
import { isMidiArtifactDiff } from "../../../../src/ui/client/wire-contracts/midi-artifact-diff.js";
import { midiBytes, noteTrack } from "../../../attachments/support/midi-test-helpers.js";
import { audioStorageHarness } from "../../../storage/support/audio-storage-test-helpers.js";
import { liveContextPresentationFixture } from "../../context/support/live-context.test-harness.js";
import type { LiveInteractionContext } from "../../../../src/live/context.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

const state = {} as ChatDialogState;
const headers = { "Content-Type": "application/json" };
const detail: SessionArtifactDetail = { sessionId: "session", artifact: { ref: { kind: "audio", id: "audio-1" },
  label: "Track", createdAt: "2026-10-03", sourceLabel: "Generator", audio: { jobId: "job", durationSeconds: 4, mediaType: "audio/wav" } } };
const diff: MidiArtifactDiff = { sessionId: "session", artifactRef: "midi-2", baseArtifactRef: "midi-1", baseVersion: 1,
  version: 2, beforeDurationBeats: 4, afterDurationBeats: 4, added: 0, removed: 0, modified: 0, unchanged: 0, parts: [] };
const cases = [
  { path: "/session-artifact", input: { sessionId: "session", artifact: { kind: "midi", id: "midi-1" } }, result: detail,
    invalid: [{ artifact: { kind: "midi", id: "../foreign" } }, { artifact: { kind: "other", id: "midi-1" } },
      { artifact: { kind: "midi", id: "midi-1", path: "/private/midi" } }, { artifact: undefined }] },
  { path: "/midi-artifact-diff", input: { sessionId: "session", artifactRef: "midi-2" }, result: diff,
    invalid: [{ artifactRef: "../foreign" }, { artifactRef: undefined }] },
];
function route(url: string, pathname: string): URL { const target = new URL(url); target.pathname = pathname; return target; }

for (const entry of cases) {
  test(`${entry.path} authenticates exact bounded inputs and emits no foreground events`, async () => {
    const calls: unknown[] = [];
    const read = async (input: unknown, signal: AbortSignal) => { calls.push(input); assert.equal(signal.aborted, false); };
    const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
      handleCommand: async () => assert.fail("Read endpoints must not run commands"), handleSend: async () => {},
      readSessionArtifact: async (input, signal) => { await read(input, signal); return detail; },
      readMidiArtifactDiff: async (input, signal) => { await read(input, signal); return diff; },
    });
    const target = route(bridge.url, entry.path);
    const events = await fetch(route(bridge.url, "/events"));
    const post = (body: string, url = target, requestHeaders = headers) => fetch(url, { method: "POST", headers: requestHeaders, body });
    try {
      for (const token of ["", "incorrect"]) {
        const denied = new URL(target); denied.search = token ? `token=${token}` : "";
        const response = await post(JSON.stringify(entry.input), denied); assert.equal(response.status, 403); await response.text();
      }
      for (const suffix of ["&extra=1", `&token=${target.searchParams.get("token")}`]) {
        const response = await post(JSON.stringify(entry.input), new URL(`${target}${suffix}`)); assert.equal(response.status, 400); await response.text();
      }
      for (const body of ["{", "null", "[]", ...[{ path: "/private/midi" }, { sessionId: "../other" }, ...entry.invalid]
        .map((patch) => JSON.stringify({ ...entry.input, ...patch })), `${JSON.stringify(entry.input)}${" ".repeat(1024 * 1024)}`]) {
        const response = await post(body); assert.equal(response.status, 400, body.slice(0, 120)); await response.text();
      }
      const wrongType = await post(JSON.stringify(entry.input), target, { "Content-Type": "text/plain" });
      assert.equal(wrongType.status, 400); await wrongType.text();
      const wrongMethod = await fetch(target); assert.equal(wrongMethod.status, 404); await wrongMethod.text();
      assert.deepEqual(calls, []);
      const accepted = await post(JSON.stringify(entry.input));
      assert.equal(accepted.status, 200); assert.match(accepted.headers.get("cache-control")!, /no-store/u);
      assert.deepEqual(await accepted.json(), entry.result); assert.deepEqual(calls, [entry.input]);
      await bridge.close(); assert.equal(await events.text(), "\n");
    } finally { await bridge.close(); }
  });

  for (const ending of ["disconnect", "bridge close"] as const) {
    test(`${entry.path} ${ending} cancels only the read and waits for cleanup`, { timeout: 3_000 }, async () => {
      const entered = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
      const read = async (_input: unknown, signal: AbortSignal): Promise<never> => {
        entered.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted.resolve(); await cleanup.promise; throw signal.reason;
      };
      const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
        handleCommand: async () => state, handleSend: async () => {}, readSessionArtifact: read, readMidiArtifactDiff: read });
      const controller = new AbortController();
      const pending = fetch(route(bridge.url, entry.path), { method: "POST", headers, body: JSON.stringify(entry.input), signal: controller.signal })
        .then((response) => ({ response }), (error: unknown) => ({ error }));
      let closing: Promise<void> | undefined;
      try {
        assert.equal(await Promise.race([entered.promise.then(() => "entered"), pending.then(() => "settled")]), "entered");
        const command = await fetch(route(bridge.url, "/command"), { method: "POST", headers: { ...headers, "X-Live-Smith-Command-Id": "during-artifact-read" },
          body: JSON.stringify({ kind: "new_session" }) });
        assert.equal(command.status, 200); await command.text();
        let closeSettled = false;
        if (ending === "disconnect") controller.abort(); else closing = bridge.close().then(() => { closeSettled = true; });
        await aborted.promise; assert.ok("error" in await pending);
        if (ending === "bridge close") { await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(closeSettled, false); }
        else { const response = await fetch(route(bridge.url, "/state")); assert.equal(response.status, 200); await response.text(); }
        cleanup.resolve(); await (closing ?? bridge.close());
      } finally { controller.abort(); cleanup.resolve(); await pending; await (closing ?? bridge.close()); }
    });
  }
}

test("canonical artifact detail and differences read exact Session versions without observing Live", async (t) => {
  const h = await audioStorageHarness(t); let refreshes = 0;
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Lead"), summary: "Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" } };
  interaction.selectionContext = { refresh: () => { refreshes++; return interaction; } };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: h.storage },
    ui: { showModalDialog: async (url: string) => {
      const initial = await (await fetch(route(url, "/state"))).json() as ChatDialogState; const sessionId = initial.activeSessionId!;
      const save = (pitch: number, revisionOf?: string) => saveMidiArtifact(h.storage, sessionId, { connectionId: "generator", serverId: "midi", toolName: "make",
        label: "Lead", bytes: midiBytes({ tracks: [noteTrack({ pitch })] }), ...(revisionOf ? { revisionOf } : {}), signal: h.signal });
      const original = await save(60); const revision = await save(72, original.id);
      const reads = [{ pathname: "/session-artifact", body: { sessionId, artifact: { kind: "midi", id: original.id } } },
        { pathname: "/midi-artifact-diff", body: { sessionId, artifactRef: revision.id } }];
      const before = refreshes;
      for (const request of reads) {
        const response = await fetch(route(url, request.pathname), { method: "POST", headers, body: JSON.stringify(request.body) });
        assert.equal(response.status, 200); const result = await response.json();
        if (isSessionArtifactDetail(result)) { assert.equal(result.artifact.ref.id, original.id); assert.equal(result.artifact.versions!.length, 2); }
        else {
          assert.ok(isMidiArtifactDiff(result)); assert.equal(result.baseArtifactRef, original.id); assert.equal(result.modified, 1);
          assert.equal(result.parts[0]!.transposeSemitones, 12);
          assert.deepEqual(result.parts[0]!.properties, { pitch: 1, startTime: 0, duration: 0, velocity: 0 });
        }
      }
      assert.equal(refreshes, before);
      const current = (await listSessions(h.storage)).find((session) => session.id === sessionId)!;
      const other = await createSession(h.storage, { title: "Other", projectKey: current.projectKey, scope: current.scope });
      const selected = await fetch(route(url, "/command"), { method: "POST", headers: { ...headers, "X-Live-Smith-Command-Id": "select-artifact-session" },
        body: JSON.stringify({ kind: "select_session", sessionId: other.id }) });
      assert.equal(selected.status, 200); await selected.text();
      for (const request of reads) {
        const response = await fetch(route(url, request.pathname), { method: "POST", headers, body: JSON.stringify(request.body) });
        assert.equal(response.status, 409); assert.match((await response.json() as { error: string }).error, /active Session/u);
      }
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
