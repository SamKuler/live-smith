import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import { saveSessionAttachment } from "../storage/attachments.js";
import { appendSessionEvent } from "../storage/events.js";
import { listSessions } from "../storage/sessions.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";

let commandSequence = 0;

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
            bytes: new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
              0, 0, 0, 1, 0, 0, 0, 1, 8,
            ]),
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
});

test("concurrent dialogs serialize pristine Session creation and approval intent", async (t) => {
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
    beforeSessionApprovalCommit: async () => {
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
        kind: "set_session_approval_mode",
        sessionId: first.activeSessionId,
        approvalMode: "low-risk",
      }),
    });
    await approvalCommitStarted.promise;
    const newDuringApproval = create(secondUrl, secondToken);
    releaseApprovalCommit.resolve();
    assert.equal((await approval).status, 200);
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
