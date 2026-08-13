import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  createSession,
  deleteSession,
  listSessions,
  listSessionsInTransaction,
  restoreSession,
  setSessionArchived,
  SessionStorageCorruptionError,
  sessionScopeKey,
  updateSession,
  updateSessionInTransaction,
} from "./sessions.js";
import {
  withStorageTransaction,
  type StorageTransactionContext,
} from "./persistence.js";

test("createSession stores title, projectKey, scope, and timestamps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));

  const session = await createSession(dir, {
    title: "Future Bass ideas",
    projectKey: "set-001",
    scope: { kind: "track", identity: "track-1", label: "Future Bass" },
  });

  const sessions = await listSessions(dir);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], session);
  assert.equal(session.title, "Future Bass ideas");
  assert.equal(session.projectKey, "set-001");
  assert.deepEqual(session.scope, { kind: "track", identity: "track-1", label: "Future Bass" });
  assert.equal(typeof session.createdAt, "string");
  assert.equal(typeof session.updatedAt, "string");
});

test("deleteSession removes a session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Operator ideas",
    projectKey: "set-001",
    scope: { kind: "track", identity: "track-operator", label: "Operator" },
  });

  await deleteSession(dir, session.id);

  assert.deepEqual(await listSessions(dir), []);
});

test("deleteSession removes its approval mode with the Session record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Temporary automatic Session",
    projectKey: "set-001",
    scope: { kind: "track", identity: "track-temporary", label: "Temporary" },
    approvalMode: "everything",
  });

  await deleteSession(dir, session.id);
  const replacement = await createSession(dir, {
    title: "Replacement",
    projectKey: "set-001",
    scope: { kind: "track", identity: "track-replacement", label: "Replacement" },
  });

  assert.deepEqual(await listSessions(dir), [replacement]);
  assert.equal(replacement.approvalMode, undefined);
  const persisted = JSON.parse(
    await fs.readFile(path.join(dir, "live-smith-sessions.json"), "utf8"),
  ) as Array<{ id: string; approvalMode?: string }>;
  assert.deepEqual(persisted.map(({ id }) => id), [replacement.id]);
  assert.equal(Object.hasOwn(persisted[0]!, "approvalMode"), false);
  assert.doesNotMatch(JSON.stringify(persisted), /everything/);
});

test("createSession prepends new sessions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const first = await createSession(dir, {
    title: "First",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  const second = await createSession(dir, {
    title: "Second",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-2", label: "Bars 1-8" },
  });

  const sessions = await listSessions(dir);

  assert.deepEqual(
    sessions.map((session) => session.id),
    [second.id, first.id],
  );
});

test("concurrent createSession calls preserve every session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const titles = Array.from({ length: 24 }, (_, index) => `Session ${index}`);

  await Promise.all(
    titles.map((title, index) =>
      createSession(dir, {
        title,
        projectKey: "set-001",
        scope: {
          kind: "selection",
          identity: `selection-${index}`,
          label: title,
        },
      }),
    ),
  );

  const sessions = await listSessions(dir);
  assert.equal(sessions.length, titles.length);
  assert.deepEqual(
    sessions.map((session) => session.title).sort(),
    titles.sort(),
  );
});

test("session storage keeps an in-memory fallback when storage directory is missing", async () => {
  const session = await createSession(undefined, {
    title: "Memory only",
    projectKey: "set-001",
    scope: { kind: "clip", identity: "clip-1", label: "Bass Clip" },
  });

  assert.equal(session.title, "Memory only");
  assert((await listSessions(undefined)).some((item) => item.id === session.id));
  await deleteSession(undefined, session.id);
  assert(!(await listSessions(undefined)).some((item) => item.id === session.id));
});

test("listSessions can isolate sessions by project key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const first = await createSession(dir, {
    title: "Project A",
    projectKey: "project-a",
    scope: { kind: "selection", identity: "selection-a", label: "A" },
  });
  await createSession(dir, {
    title: "Project B",
    projectKey: "project-b",
    scope: { kind: "selection", identity: "selection-b", label: "B" },
  });

  assert.deepEqual(await listSessions(dir, "project-a"), [first]);
});

test("setSessionArchived adds and removes optional archival metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Old mix review",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "track-old", label: "Mix Bus" },
  });

  const archived = await setSessionArchived(dir, session.id, true);
  assert.equal(typeof archived.archivedAt, "string");
  assert.equal(archived.id, session.id);
  assert.deepEqual((await listSessions(dir))[0], archived);

  const unarchived = await setSessionArchived(dir, session.id, false);
  assert.equal("archivedAt" in unarchived, false);
  assert.equal(unarchived.id, session.id);
  assert.deepEqual((await listSessions(dir))[0], unarchived);
});

test("restoreSession rebinds a Session while preserving its original scope", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const previous = await createSession(dir, {
    title: "Bass arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-track-handle", label: "Bass" },
  });

  const restored = await restoreSession(dir, previous.id, {
    projectKey: "current-activation",
    scope: { kind: "track", identity: "current-track-handle", label: "Bass" },
  });

  assert.equal(restored.id, previous.id);
  assert.equal(restored.projectKey, "current-activation");
  assert.deepEqual(restored.scope, {
    kind: "track",
    identity: "current-track-handle",
    label: "Bass",
  });
  assert.deepEqual(restored.originScope, previous.scope);
  assert.notEqual(restored.updatedAt, previous.updatedAt);
  assert.deepEqual(await listSessions(dir, "current-activation"), [restored]);
  assert.deepEqual(await listSessions(dir, "previous-activation"), []);

  const rebound = await restoreSession(dir, previous.id, {
    projectKey: "later-activation",
    scope: { kind: "track", identity: "later-track-handle", label: "Drums" },
  });
  assert.deepEqual(rebound.originScope, previous.scope);
  assert.deepEqual(rebound.scope, {
    kind: "track",
    identity: "later-track-handle",
    label: "Drums",
  });
});

test("activeSkillIds persist as a sorted bounded Session activation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Guided review",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    activeSkillIds: ["vocal-review", "mixing-review"],
  });

  assert.deepEqual(session.activeSkillIds, ["mixing-review", "vocal-review"]);
  assert.deepEqual((await listSessions(dir))[0]?.activeSkillIds, [
    "mixing-review",
    "vocal-review",
  ]);

  await updateSession(dir, session.id, {
    activeSkillIds: ["transient-check", "gain-staging"],
  });
  assert.deepEqual((await listSessions(dir))[0]?.activeSkillIds, [
    "gain-staging",
    "transient-check",
  ]);
});

test("approvalMode persists as a per-Session authorization", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Automatic mix pass",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    approvalMode: "low-risk",
  });

  assert.equal(session.approvalMode, "low-risk");
  assert.equal((await listSessions(dir))[0]?.approvalMode, "low-risk");

  await updateSession(dir, session.id, { approvalMode: "everything" });
  assert.equal((await listSessions(dir))[0]?.approvalMode, "everything");
});

test("approvalMode validation rejects invalid created, updated, and persisted values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  await assert.rejects(
    createSession(dir, {
      title: "Invalid approval",
      projectKey: "set-001",
      scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
      approvalMode: "unsafe",
    } as never),
    /Approval mode is invalid/i,
  );

  const session = await createSession(dir, {
    title: "Valid approval",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    approvalMode: "manual",
  });
  const target = path.join(dir, "live-smith-sessions.json");
  const before = await fs.readFile(target, "utf8");
  await assert.rejects(
    updateSession(dir, session.id, { approvalMode: false } as never),
    /Approval mode is invalid/i,
  );
  assert.equal(await fs.readFile(target, "utf8"), before);

  const persisted = JSON.parse(before) as Array<Record<string, unknown>>;
  persisted[0]!.approvalMode = "unsafe";
  const invalid = JSON.stringify(persisted);
  await fs.writeFile(target, invalid);
  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), invalid);
});

test("legacy Sessions without approvalMode load without being rewritten", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const legacy = JSON.stringify([{
    id: "session-before-approval-mode",
    title: "Manual by default",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }]);
  await fs.writeFile(target, legacy);

  const [session] = await listSessions(dir);
  assert.equal(session?.approvalMode, undefined);
  assert.equal(await fs.readFile(target, "utf8"), legacy);
});

test("activeSkillIds validation rejects unsafe, duplicate, oversized, and non-array updates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Guided review",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    activeSkillIds: ["mixing-review"],
  });
  const before = await fs.readFile(path.join(dir, "live-smith-sessions.json"), "utf8");

  const invalidValues: unknown[] = [
    ["../escape"],
    ["Mixing-Review"],
    ["mixing-review", "mixing-review"],
    ["one", "two", "three", "four", "five"],
    "mixing-review",
  ];
  for (const activeSkillIds of invalidValues) {
    await assert.rejects(
      updateSession(dir, session.id, { activeSkillIds } as never),
      /Skill activation is invalid/i,
    );
    assert.equal(
      await fs.readFile(path.join(dir, "live-smith-sessions.json"), "utf8"),
      before,
    );
  }
});

test("activeSkillIds validation applies to Session creation", async () => {
  const invalidValues = [
    ["duplicate", "duplicate"],
    ["unsafe_id"],
    ["one", "two", "three", "four", "five"],
  ];

  for (const activeSkillIds of invalidValues) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
    await assert.rejects(
      createSession(dir, {
        title: "Invalid activation",
        projectKey: "set-001",
        scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
        activeSkillIds,
      }),
      /Skill activation is invalid/i,
    );
    await assert.rejects(
      fs.readFile(path.join(dir, "live-smith-sessions.json")),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
    );
  }
});

test("old Sessions load unchanged and restored Sessions preserve activeSkillIds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const now = new Date().toISOString();
  const legacy = {
    id: "session-legacy",
    title: "Before Skills",
    projectKey: "legacy-set",
    scope: { kind: "selection", identity: "legacy-selection", label: "Live Set" },
    createdAt: now,
    updatedAt: now,
  };
  await fs.writeFile(target, JSON.stringify([legacy]));

  assert.deepEqual(await listSessions(dir), [legacy]);
  await updateSession(dir, legacy.id, {
    activeSkillIds: ["vocal-review", "mixing-review"],
  });
  const restored = await restoreSession(dir, legacy.id, {
    projectKey: "current-set",
    scope: { kind: "selection", identity: "current-selection", label: "Live Set" },
  });

  assert.deepEqual(restored.activeSkillIds, ["mixing-review", "vocal-review"]);
  assert.deepEqual((await listSessions(dir))[0]?.activeSkillIds, restored.activeSkillIds);
});

test("invalid persisted activeSkillIds make Session storage corrupt without rewriting it", async () => {
  const invalidValues: unknown[] = [
    "mixing-review",
    ["../escape"],
    ["mixing-review", "mixing-review"],
    ["z-last", "a-first"],
    ["one", "two", "three", "four", "five"],
  ];
  for (const activeSkillIds of invalidValues) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
    const target = path.join(dir, "live-smith-sessions.json");
    const now = new Date().toISOString();
    const original = JSON.stringify([{
      id: "session-invalid-skills",
      title: "Invalid activation",
      projectKey: "set-001",
      scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
      activeSkillIds,
      createdAt: now,
      updatedAt: now,
    }]);
    await fs.writeFile(target, original);

    await assert.rejects(
      listSessions(dir),
      (error: unknown) => error instanceof SessionStorageCorruptionError,
    );
    assert.equal(await fs.readFile(target, "utf8"), original);
  }
});

test("Session storage rejects unknown fields instead of projecting them into chat state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const now = new Date().toISOString();
  const base = {
    id: "session-unknown-field",
    title: "Strict Session",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    createdAt: now,
    updatedAt: now,
  };

  for (const value of [
    { ...base, skillBody: "PRIVATE SKILL BODY" },
    { ...base, scope: { ...base.scope, privateData: "PRIVATE SKILL BODY" } },
  ]) {
    await fs.writeFile(target, JSON.stringify([value]));
    await assert.rejects(
      listSessions(dir),
      (error: unknown) => error instanceof SessionStorageCorruptionError,
    );
  }
});

test("memory Sessions defensively copy activation arrays, scopes, and returned records", async () => {
  const sourceIds = ["mixing-review"];
  const sourceScope = {
    kind: "selection" as const,
    identity: "memory-selection",
    label: "Memory Set",
  };
  const created = await createSession(undefined, {
    title: "Memory aliases",
    projectKey: "memory-set-original",
    scope: sourceScope,
    activeSkillIds: sourceIds,
  });
  sourceIds[0] = "../unsafe";
  sourceScope.label = "Mutated source";
  created.activeSkillIds?.push("duplicate", "duplicate", "three", "four");
  created.scope.label = "Mutated return";

  const firstRead = (await listSessions(undefined)).find(
    (session) => session.id === created.id,
  );
  assert.deepEqual(firstRead?.activeSkillIds, ["mixing-review"]);
  assert.equal(firstRead?.scope.label, "Memory Set");
  firstRead?.activeSkillIds?.splice(0, 1, "../unsafe");
  if (firstRead) firstRead.scope.label = "Mutated list";

  const updateIds = ["vocal-review"];
  await updateSession(undefined, created.id, { activeSkillIds: updateIds });
  updateIds[0] = "../unsafe";
  const restored = await restoreSession(undefined, created.id, {
    projectKey: "memory-set-restored",
    scope: { kind: "selection", identity: "restored", label: "Restored Set" },
  });
  restored.activeSkillIds?.push("../unsafe");
  restored.scope.label = "Mutated restored return";

  const finalRead = (await listSessions(undefined)).find(
    (session) => session.id === created.id,
  );
  assert.deepEqual(finalRead?.activeSkillIds, ["vocal-review"]);
  assert.equal(finalRead?.scope.label, "Restored Set");
  await deleteSession(undefined, created.id);
});

test("Session transaction-scoped APIs require a live context bound to the same storage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Scoped transaction",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  let retained: StorageTransactionContext | undefined;

  await withStorageTransaction(dir, async (context) => {
    retained = context;
    assert.equal((await listSessionsInTransaction(context, dir))[0]?.id, session.id);
    await updateSessionInTransaction(context, dir, session.id, {
      activeSkillIds: ["mixing-review"],
    });
    await assert.rejects(
      listSessionsInTransaction(context, otherDir),
      /invalid or no longer active/i,
    );
  });

  assert.ok(retained);
  await assert.rejects(
    listSessionsInTransaction(retained, dir),
    /invalid or no longer active/i,
  );
  assert.deepEqual((await listSessions(dir))[0]?.activeSkillIds, ["mixing-review"]);
});

test("updateSession rejects unknown Sessions and fields without writing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const session = await createSession(dir, {
    title: "Known",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  const target = path.join(dir, "live-smith-sessions.json");
  const before = await fs.readFile(target, "utf8");

  await assert.rejects(
    updateSession(dir, "session-missing", { activeSkillIds: [] }),
    /does not exist/i,
  );
  await assert.rejects(
    updateSession(dir, session.id, { projectKey: "other-set" } as never),
    /Session update is invalid/i,
  );
  assert.equal(await fs.readFile(target, "utf8"), before);
});

test("restoreSession rejects missing and already-current Sessions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const current = await createSession(dir, {
    title: "Current",
    projectKey: "current-activation",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
  });

  await assert.rejects(
    restoreSession(dir, "session-missing", {
      projectKey: "current-activation",
      scope: current.scope,
    }),
    /does not exist/i,
  );
  await assert.rejects(
    restoreSession(dir, current.id, {
      projectKey: "current-activation",
      scope: current.scope,
    }),
    /already.*current/i,
  );
});

test("corrupt session storage blocks reads and mutations without changing bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const original = "{invalid";
  await fs.writeFile(target, original);

  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  await assert.rejects(
    createSession(dir, {
      title: "Must not overwrite",
      projectKey: "set-001",
      scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    }),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("a persisted unsafe session ID makes the session file invalid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  await fs.writeFile(path.join(dir, "live-smith-sessions.json"), JSON.stringify([{
    id: "../live-smith-settings",
    title: "Unsafe",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]));

  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
});

test("one invalid persisted session blocks mutation instead of dropping the item", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const original = JSON.stringify([{
    id: "session-valid",
    title: "Recoverable",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, { id: "session-invalid" }]);
  await fs.writeFile(target, original);

  await assert.rejects(
    deleteSession(dir, "session-valid"),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("a malformed persisted origin scope is rejected without rewriting storage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const original = JSON.stringify([{
    id: "session-invalid-origin",
    title: "Invalid origin",
    projectKey: "set-001",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
    originScope: { kind: "track", label: "Missing identity" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]);
  await fs.writeFile(target, original);

  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("a malformed persisted archive timestamp is rejected without rewriting storage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const original = JSON.stringify([{
    id: "session-invalid-archive",
    title: "Invalid archive",
    projectKey: "set-001",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
    archivedAt: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]);
  await fs.writeFile(target, original);

  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("duplicate persisted session IDs block reads and mutations without changing bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const now = new Date().toISOString();
  const original = JSON.stringify([
    {
      id: "session-duplicate",
      title: "Project A",
      projectKey: "project-a",
      scope: { kind: "selection", identity: "selection-a", label: "A" },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "session-duplicate",
      title: "Project B",
      projectKey: "project-b",
      scope: { kind: "selection", identity: "selection-b", label: "B" },
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await fs.writeFile(target, original);

  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  await assert.rejects(
    createSession(dir, {
      title: "Must not overwrite",
      projectKey: "project-a",
      scope: { kind: "selection", identity: "selection-c", label: "C" },
    }),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("sessionScopeKey uses stable identity instead of display label", () => {
  assert.equal(
    sessionScopeKey({ kind: "track", identity: "handle-42", label: "Renamed Bass" }),
    "track:handle-42",
  );
});
