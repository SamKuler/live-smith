import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { MidiTrack } from "@ableton-extensions/sdk";

import type { LiveInteractionContext } from "../live/context.js";
import { saveSessionAttachment } from "../storage/attachments.js";
import { appendSessionEvent } from "../storage/events.js";
import { createSession, listSessions, type AgentSession } from "../storage/sessions.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";

let commandSequence = 0;
const referencePng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1, 8,
]);

function commandHeaders(): Record<string, string> {
  commandSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": `session-lifecycle-${commandSequence}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve,
  };
}

test("New Session reuses a pristine Session but not one with history", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-lifecycle-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const state = async (): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/state"));
          assert.equal(response.status, 200);
          return response.json() as Promise<ChatDialogState>;
        };
        const newSession = async (): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: commandHeaders(),
            body: JSON.stringify({ kind: "new_session" }),
          });
          const body = await response.text();
          assert.equal(response.status, 200, body);
          return JSON.parse(body) as ChatDialogState;
        };

        const initial = await state();
        const repeatedEmpty = await newSession();
        assert.equal(repeatedEmpty.activeSessionId, initial.activeSessionId);
        assert.equal(repeatedEmpty.sessions.length, 1);

        await appendSessionEvent(directory, initial.activeSessionId, {
          kind: "user",
          content: "Persisted history",
        });
        const next = await newSession();
        assert.notEqual(next.activeSessionId, initial.activeSessionId);
        assert.equal(next.sessions.length, 2);

        await saveSessionAttachment(
          directory,
          next.activeSessionId,
          {
            fileName: "reference.png",
            bytes: referencePng,
            claimedMediaType: "image/png",
          },
          { preSavePendingAttachmentRefs: [] },
        );
        const afterAttachment = await newSession();
        assert.notEqual(afterAttachment.activeSessionId, next.activeSessionId);
        assert.equal(afterAttachment.sessions.length, 3);

        const repeatedNext = await newSession();
        assert.equal(repeatedNext.activeSessionId, afterAttachment.activeSessionId);
        assert.equal(repeatedNext.sessions.length, 3);
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
  });

  assert.equal((await listSessions(directory)).length, 3);
  const saved = JSON.parse(await fs.readFile(
    path.join(directory, "live-smith-sessions.json"), "utf8",
  )) as AgentSession[];
  assert.equal(saved.length, 2, "the unused New Session remains transient");
});

test("opening, reopening, and deleting an untouched Session do not save empty history", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-empty-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  let initialId: string | undefined;
  let deleteActive = false;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const chatUrl = new URL(url);
      const endpoint = (route: string) =>
        `${chatUrl.origin}${route}?token=${chatUrl.searchParams.get("token")}`;
      const response = await fetch(endpoint("/state"));
      assert.equal(response.status, 200);
      const state = await response.json() as ChatDialogState;
      assert.equal(state.previousSessions.every((session) => session.hasContent === false), true);
      if (!deleteActive) {
        initialId ??= state.activeSessionId;
        assert.equal(state.activeSessionId, initialId);
      } else {
        assert.notEqual(state.activeSessionId, initialId);
        const deleted = await fetch(endpoint("/command"), {
          method: "POST", headers: commandHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: state.activeSessionId }),
        });
        assert.equal(deleted.status, 200);
        const next = await deleted.json() as ChatDialogState;
        assert.notEqual(next.activeSessionId, state.activeSessionId);
        assert.equal(next.previousSessions.every((session) => session.hasContent === false), true);
      }
    } },
  };
  const open = (activation: typeof context) => runAgentFlow(activation as never, interaction, {
    renderHtml: () => "<html></html>",
  });
  await open(context);
  await open(context);
  deleteActive = true;
  await open({ ...context });
  await assert.rejects(fs.stat(path.join(directory, "live-smith-sessions.json")), { code: "ENOENT" });
});

test("opening different tracks keeps their empty Session summaries separate from content", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-track-empty-list-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let trackNumber = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const chatUrl = new URL(url);
      const response = await fetch(`${chatUrl.origin}/state?token=${chatUrl.searchParams.get("token")}`);
      assert.equal(response.status, 200);
      const state = await response.json() as ChatDialogState;
      assert.equal(state.sessions.length, trackNumber);
      assert.equal(state.sessions.every((session) => session.hasContent === false), true);
      assert.equal(state.sessions.find((session) => session.id === state.activeSessionId)?.scope.identity,
        `track-${trackNumber}`);
    } },
  };
  for (trackNumber = 1; trackNumber <= 3; trackNumber += 1) {
    await runAgentFlow(context as never, {
      summary: `Track ${trackNumber}`, target: {},
      scope: { kind: "track", identity: `track-${trackNumber}`, label: `Track ${trackNumber}` },
    }, { renderHtml: () => "<html></html>" });
  }
  await assert.rejects(fs.stat(path.join(directory, "live-smith-sessions.json")), { code: "ENOENT" });
});

test("Session content summaries ignore timestamps and permission settings without deleting data", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-legacy-empty-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = {
    title: "", projectKey: "previous-activation",
    scope: { kind: "track" as const, identity: "track-1", label: "Lead" },
  };
  const empty = await createSession(directory, input);
  const configured = await createSession(directory, { ...input, editScopes: ["midi"] });
  const conversation = await createSession(directory, input);
  await appendSessionEvent(directory, conversation.id, { kind: "user", content: "Keep my conversation" });
  const attached = await createSession(directory, input);
  await saveSessionAttachment(directory, attached.id, {
    fileName: "reference.png", bytes: referencePng,
    claimedMediaType: "image/png",
  }, { preSavePendingAttachmentRefs: [] });
  const unreadable = await createSession(directory, input);
  await fs.writeFile(
    path.join(directory, "live-smith-events", `${unreadable.id}.json`), "invalid JSON",
  );
  const modified = await createSession(directory, input);
  const sessionFile = path.join(directory, "live-smith-sessions.json");
  const metadata = await listSessions(directory);
  const modifiedRecord = metadata.find((session) => session.id === modified.id)!;
  modifiedRecord.updatedAt = new Date(Date.parse(modifiedRecord.createdAt) + 1).toISOString();
  await fs.writeFile(sessionFile, JSON.stringify(metadata));
  const before = await fs.readFile(sessionFile, "utf8");
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const chatUrl = new URL(url);
      const response = await fetch(`${chatUrl.origin}/state?token=${chatUrl.searchParams.get("token")}`);
      assert.equal(response.status, 200);
      const state = await response.json() as ChatDialogState;
      assert.deepEqual(new Map(state.previousSessions.map((session) => [session.id, session.hasContent])),
        new Map([
          [empty.id, false], [configured.id, false], [modified.id, false],
          [conversation.id, true], [attached.id, true], [unreadable.id, true],
        ]));
    } },
  };
  await runAgentFlow(context as never, { summary: "Track: Lead", target: {}, scope: input.scope }, {
    renderHtml: () => "<html></html>",
  });
  assert.equal(await fs.readFile(sessionFile, "utf8"), before);
});

test("Continue and archive lifecycle never persist the unused fallback Session", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-session-fallback-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = await createSession(directory, {
    title: "Kept conversation", projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-track", label: "Lead" },
  });
  const track = Object.setPrototypeOf({
    handle: { id: 20n }, name: "Lead", mute: false, solo: false, arm: false,
    arrangementClips: [], takeLanes: [], clipSlots: [], devices: [],
  }, MidiTrack.prototype);
  let reopened = false;
  const context = {
    application: { song: { handle: { id: 1n }, tracks: [track], scenes: [] } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const chatUrl = new URL(url);
      const endpoint = (route: string) =>
        `${chatUrl.origin}${route}?token=${chatUrl.searchParams.get("token")}`;
      const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
      assert.deepEqual(initial.previousSessions.filter((session) => session.hasContent)
        .map((session) => session.id), [previous.id]);
      if (reopened) return;
      const command = async (kind: string, sessionId: string) => {
        const response = await fetch(endpoint("/command"), {
          method: "POST", headers: commandHeaders(), body: JSON.stringify({ kind, sessionId }),
        });
        assert.equal(response.status, 200);
        const saved = JSON.parse(await fs.readFile(
          path.join(directory, "live-smith-sessions.json"), "utf8",
        )) as AgentSession[];
        assert.deepEqual(saved.map((session) => session.id), [previous.id]);
        return response.json() as Promise<ChatDialogState>;
      };
      const restored = await command("restore_session", previous.id);
      assert.equal(restored.activeSessionId, previous.id);
      const archived = await command("archive_session", previous.id);
      assert.notEqual(archived.activeSessionId, previous.id);
      assert.deepEqual(archived.archivedSessions.map((session) => session.id), [previous.id]);
      await command("unarchive_session", previous.id);
      const deleted = await command("delete_session", archived.activeSessionId);
      assert.notEqual(deleted.activeSessionId, archived.activeSessionId);
    } },
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "20", label: "Lead" },
  };
  await runAgentFlow(context as never, interaction, { renderHtml: () => "<html></html>" });
  reopened = true;
  await runAgentFlow({ ...context } as never, interaction, { renderHtml: () => "<html></html>" });
});

for (const permission of [
  {
    label: "approval",
    hook: "beforeSessionApprovalCommit",
    command: { kind: "set_session_approval_mode", approvalMode: "low-risk" },
  },
  {
    label: "edit scope",
    hook: "beforeSessionEditScopesCommit",
    command: { kind: "set_session_edit_scopes", editScopes: [] },
  },
] as const) {
test(`concurrent dialogs serialize pristine Session creation and ${permission.label} intent`, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-lifecycle-race-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstDialog = deferred<string>();
  const secondDialog = deferred<string>();
  const closeFirst = deferred<void>();
  const closeSecond = deferred<void>();
  const approvalCommitStarted = deferred<void>();
  const releaseApprovalCommit = deferred<void>();
  let holdApprovalCommit = false;
  let dialogCount = 0;
  const context = {
    application: { song: { handle: { id: 2n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const index = dialogCount;
        dialogCount += 1;
        (index === 0 ? firstDialog : secondDialog).resolve(url);
        await (index === 0 ? closeFirst.promise : closeSecond.promise);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  const firstFlow = runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    [permission.hook]: async () => {
      if (!holdApprovalCommit) return;
      holdApprovalCommit = false;
      approvalCommitStarted.resolve();
      await releaseApprovalCommit.promise;
    },
  });
  let secondFlow: Promise<void> | undefined;
  try {
    const firstUrl = new URL(await firstDialog.promise);
    const firstToken = firstUrl.searchParams.get("token");
    const endpoint = (url: URL, token: string | null, pathname: string) =>
      `${url.origin}${pathname}?token=${token}`;
    const firstState = await (
      await fetch(endpoint(firstUrl, firstToken, "/state"))
    ).json() as ChatDialogState;

    secondFlow = runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
    });
    const secondUrl = new URL(await secondDialog.promise);
    const secondToken = secondUrl.searchParams.get("token");
    const secondState = await (
      await fetch(endpoint(secondUrl, secondToken, "/state"))
    ).json() as ChatDialogState;
    assert.equal(secondState.activeSessionId, firstState.activeSessionId);

    await appendSessionEvent(directory, firstState.activeSessionId, {
      kind: "user",
      content: "Existing conversation",
    });
    const create = (url: URL, token: string | null) =>
      fetch(endpoint(url, token, "/command"), {
        method: "POST",
        headers: commandHeaders(),
        body: JSON.stringify({ kind: "new_session" }),
      });
    const [firstResponse, secondResponse] = await Promise.all([
      create(firstUrl, firstToken),
      create(secondUrl, secondToken),
    ]);
    const firstBody = await firstResponse.text();
    const secondBody = await secondResponse.text();
    assert.equal(firstResponse.status, 200, firstBody);
    assert.equal(secondResponse.status, 200, secondBody);
    const first = JSON.parse(firstBody) as ChatDialogState;
    const second = JSON.parse(secondBody) as ChatDialogState;
    assert.notEqual(first.activeSessionId, firstState.activeSessionId);
    assert.equal(second.activeSessionId, first.activeSessionId);
    assert.equal((await listSessions(directory)).length, 2);

    holdApprovalCommit = true;
    const approval = fetch(endpoint(firstUrl, firstToken, "/command"), {
      method: "POST",
      headers: commandHeaders(),
      body: JSON.stringify({
        ...permission.command,
        sessionId: first.activeSessionId,
      }),
    });
    await approvalCommitStarted.promise;
    const newDuringApproval = create(secondUrl, secondToken);
    releaseApprovalCommit.resolve();
    const approvalResponse = await approval;
    assert.equal(approvalResponse.status, 200);
    const approvalState = await approvalResponse.json() as ChatDialogState;
    assert.equal(approvalState.status, undefined);
    const afterApprovalResponse = await newDuringApproval;
    const afterApprovalBody = await afterApprovalResponse.text();
    assert.equal(afterApprovalResponse.status, 200, afterApprovalBody);
    const afterApproval = JSON.parse(afterApprovalBody) as ChatDialogState;
    assert.notEqual(afterApproval.activeSessionId, first.activeSessionId);
    assert.equal((await listSessions(directory)).length, 3);
  } finally {
    releaseApprovalCommit.resolve();
    closeFirst.resolve();
    closeSecond.resolve();
    await Promise.allSettled([
      firstFlow,
      ...(secondFlow ? [secondFlow] : []),
    ]);
  }
});
}
