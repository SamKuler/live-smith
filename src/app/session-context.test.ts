import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import { listSessions, type AgentSession } from "../storage/sessions.js";
import {
  getOrCreateDefaultSession,
  isReusableEmptySessionMetadata,
} from "./session-context.js";

test("reusable empty Session metadata excludes persisted user intent", () => {
  const scope = { kind: "track" as const, identity: "track-1", label: "Lead" };
  const base: AgentSession = {
    id: "session-pristine",
    title: "",
    projectKey: "project-a",
    scope,
    approvalMode: "manual",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const { approvalMode: _approvalMode, ...withoutApprovalMode } = base;

  assert.equal(isReusableEmptySessionMetadata(base, "project-a", scope), true);
  assert.equal(
    isReusableEmptySessionMetadata(
      withoutApprovalMode,
      "project-a",
      { ...scope, label: "Renamed Lead" },
    ),
    true,
  );
  for (const session of [
    { ...base, title: "Pinned draft" },
    { ...base, title: "   " },
    { ...base, projectKey: "project-b" },
    { ...base, scope: { ...scope, identity: "track-2" } },
    { ...base, archivedAt: "2026-08-25T00:01:00.000Z" },
    { ...base, originScope: scope },
    { ...base, activeSkillIds: ["arrangement-foundation"] },
    { ...base, approvalMode: "low-risk" as const },
    {
      ...base,
      modelSelection: { profileId: "profile-a", model: "model-a" },
    },
  ]) {
    assert.equal(
      isReusableEmptySessionMetadata(session, "project-a", scope),
      false,
    );
  }
});

test("concurrent default Session resolution creates one scope Session", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-default-session-race-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };

  const resolved = await Promise.all(
    Array.from({ length: 16 }, () =>
      getOrCreateDefaultSession(
        directory,
        interaction,
        "project-a",
      )
    ),
  );

  assert.equal(new Set(resolved.map((session) => session.id)).size, 1);
  assert.equal((await listSessions(directory, "project-a")).length, 1);
});
