import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  createSession,
  deleteSession,
  listSessions,
  restoreSession,
  setSessionArchived,
  SessionStorageCorruptionError,
  sessionScopeKey,
} from "./sessions.js";

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
}
);

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
