import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { EDIT_SCOPES } from "../agent/edit-scopes.js";
import type { LiveInteractionContext } from "../live/context.js";
import { listSessions, updateSession, type AgentSession } from "../storage/sessions.js";
import {
  getOrCreateDefaultSession,
  isReusableEmptySessionMetadata,
} from "./session-context.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

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
    isReusableEmptySessionMetadata({ ...base, editScopes: [...EDIT_SCOPES] }, "project-a", scope),
    true,
  );
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
    { ...base, editScopes: [] },
    { ...base, editScopes: ["midi" as const] },
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

test("concurrent default Session resolution shares one transient scope Session", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-default-session-race-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
  assert.deepEqual((await listSessions(directory, "project-a"))[0]?.editScopes, EDIT_SCOPES);
  await assert.rejects(
    fs.stat(path.join(directory, "live-smith-sessions.json")),
    { code: "ENOENT" },
  );
});

test("default resolution keeps its preferred Session during transient promotion", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-promotion-race-"),
  );
  const captured = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  t.after(async () => {
    resume.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  const session = await getOrCreateDefaultSession(directory, interaction, "project-a");
  const target = path.join(directory, "live-smith-sessions.json");
  await fs.writeFile(target, "[]");
  const readFile = fs.readFile;
  let paused = false;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof readFile>) => {
    const contents = await readFile(...args);
    if (!paused && args[0] === target) {
      paused = true;
      captured.resolve();
      await resume.promise;
    }
    return contents;
  });
  syncBuiltinESMExports();

  const resolving = getOrCreateDefaultSession(
    directory, interaction, "project-a", session.id,
  );
  await captured.promise;
  try {
    await updateSession(directory, session.id, { title: "Saved during state read" });
  } finally {
    resume.resolve();
  }

  assert.equal((await resolving).id, session.id);
  assert.deepEqual(
    (await listSessions(directory)).map(({ id, title }) => ({ id, title })),
    [{ id: session.id, title: "Saved during state read" }],
  );
});
