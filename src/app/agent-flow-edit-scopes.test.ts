import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import test from "node:test";

import { EDIT_SCOPES } from "../agent/edit-scopes.js";
import { StorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import { canonicalStorageDirectory } from "../storage/scope.js";
import { updateSessionInTransaction } from "../storage/sessions.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import {
  subscribeSessionEditScopesChanges,
  subscribeSessionEditScopesInvalidations,
  type SessionEditScopesChange,
} from "./session-edit-scope-events.js";

for (const outcome of ["committed", "unknown-readable", "unknown-unreadable"] as const) {
  test(`Session scope command handles ${outcome} writes without broadening permission`, async (t) => {
    const directory = await canonicalStorageDirectory(
      await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-scope-command-")),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const changes: SessionEditScopesChange[] = [];
    const invalidations: string[] = [];
    const notifications: string[] = [];
    t.after(subscribeSessionEditScopesChanges(directory, (change) => {
      changes.push(change);
      notifications.push("committed");
    }));
    t.after(subscribeSessionEditScopesInvalidations(directory, (sessionId) => {
      invalidations.push(sessionId);
      notifications.push("unavailable");
    }));
    const sessionsFile = path.join(directory, "live-smith-sessions.json");
    let restoreContents: string | undefined;
    let commandId = 0;
    const context = {
      application: { song: { handle: { id: 1n } } },
      environment: { storageDirectory: directory },
      ui: {
        showModalDialog: async (rawUrl: string) => {
          const url = new URL(rawUrl);
          const endpoint = (pathname: string) => `${url.origin}${pathname}?token=${url.searchParams.get("token")}`;
          const command = (body: object) => fetch(endpoint("/command"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Live-Smith-Command-Id": `scope-command-${++commandId}`,
            },
            body: JSON.stringify(body),
          });
          const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
          const sessionId = initial.activeSessionId;
          assert.deepEqual(initial.sessions.find((session) => session.id === sessionId)?.editScopes, EDIT_SCOPES);
          const approval = await command({ kind: "set_session_approval_mode", sessionId, approvalMode: "everything" });
          assert.equal(approval.status, 200);
          const response = await command({ kind: "set_session_edit_scopes", sessionId, editScopes: [] });
          const body = await response.text();
          assert.equal(response.status, outcome === "committed" ? 200 : 500, body);
          if (outcome === "unknown-unreadable") {
            assert.deepEqual(invalidations, [sessionId]);
            assert.deepEqual(changes, []);
            assert.deepEqual(notifications, ["unavailable"]);
            await fs.writeFile(sessionsFile, restoreContents!);
          } else {
            assert.equal(changes.length, 1);
            assert.equal(changes[0]?.sessionId, sessionId);
            assert.deepEqual(changes[0]?.editScopes, []);
            assert.deepEqual(invalidations, outcome === "committed" ? [] : [sessionId]);
            assert.deepEqual(notifications, outcome === "committed"
              ? ["committed"]
              : ["unavailable", "committed"]);
          }
          const current = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
          assert.equal(current.approvalMode, "everything");
          assert.deepEqual(current.sessions.find((session) => session.id === sessionId)?.editScopes, []);
          const nextResponse = await command({ kind: "new_session" });
          assert.equal(nextResponse.status, 200);
          const next = await nextResponse.json() as ChatDialogState;
          assert.notEqual(next.activeSessionId, sessionId);
          assert.deepEqual(next.sessions.find((session) => session.id === next.activeSessionId)?.editScopes, EDIT_SCOPES);
        },
      },
    };
    try {
      await runAgentFlow(context as never, {
        summary: "Lead",
        target: {},
        scope: { kind: "track", identity: "track-1", label: "Lead" },
      }, {
        renderHtml: () => "<html></html>",
        updateSessionInTransaction: async (...args) => {
          const updated = await updateSessionInTransaction(...args);
          if (outcome === "committed" || !Object.hasOwn(args[3], "editScopes")) return updated;
          if (outcome === "unknown-unreadable") {
            restoreContents = await fs.readFile(sessionsFile, "utf8");
            await fs.writeFile(sessionsFile, "invalid session storage");
          }
          throw new StorageCommitOutcomeUnknownError(new Error("Injected scope durability uncertainty"));
        },
      });
    } finally {
      if (restoreContents !== undefined) await fs.writeFile(sessionsFile, restoreContents);
    }
  });
}
