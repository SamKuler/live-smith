import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { EDIT_SCOPES, type EditScope } from "../agent/edit-scopes.js";
import { AttachmentProcessingError } from "../attachments/contracts.js";
import { saveSessionAttachment } from "./attachments.js";
import { appendSessionEvent, loadSessionEvents } from "./events.js";
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
  type AgentSession,
} from "./sessions.js";
import {
  withStorageTransaction,
  type StorageTransactionContext,
} from "./persistence.js";

const emptySessionInput = {
  title: "",
  projectKey: "set-001",
  scope: { kind: "track" as const, identity: "track-1", label: "Lead" },
  approvalMode: "manual" as const,
  editScopes: [...EDIT_SCOPES],
};

async function readPersistedSessions(directory: string): Promise<AgentSession[]> {
  return JSON.parse(await fs.readFile(
    path.join(directory, "live-smith-sessions.json"), "utf8",
  )) as AgentSession[];
}

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

test("transient Sessions remain visible and storage-scoped without creating a Session file", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const firstDir = path.join(dir, "first");
  const secondDir = path.join(dir, "second");
  const first = await createSession(firstDir, emptySessionInput, { transient: true });
  const second = await createSession(secondDir, emptySessionInput, { transient: true });

  assert.deepEqual(await listSessions(firstDir), [first]);
  assert.deepEqual(await listSessions(secondDir), [second]);
  await withStorageTransaction(firstDir, async (transaction) => {
    assert.deepEqual(await listSessionsInTransaction(transaction, firstDir), [first]);
  });
  for (const directory of [firstDir, secondDir]) {
    await assert.rejects(
      fs.readFile(path.join(directory, "live-smith-sessions.json")),
      { code: "ENOENT" },
    );
  }

  await deleteSession(firstDir, first.id);
  assert.deepEqual(await listSessions(firstDir), []);
  assert.deepEqual(await listSessions(secondDir), [second]);
  await assert.rejects(
    fs.readFile(path.join(firstDir, "live-smith-sessions.json")),
    { code: "ENOENT" },
  );
  await deleteSession(secondDir, second.id);
});

test("Session writes persist only their target and preserve other transient Sessions", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const selected = await createSession(dir, emptySessionInput, { transient: true });
  const untouched = await createSession(dir, emptySessionInput, { transient: true });
  const saved = await createSession(dir, { ...emptySessionInput, title: "Saved" });
  assert.deepEqual(await readPersistedSessions(dir), [saved]);

  await updateSession(dir, saved.id, { title: "Renamed" });
  const afterRename = await readPersistedSessions(dir);
  assert.deepEqual(afterRename.map(({ id }) => id), [saved.id]);
  assert.equal(afterRename[0]?.title, "Renamed");

  await updateSession(dir, selected.id, { approvalMode: "manual" });
  const persisted = await readPersistedSessions(dir);
  assert.deepEqual(
    persisted.map(({ id }) => id).sort(),
    [saved.id, selected.id].sort(),
  );
  assert.equal(persisted.find(({ id }) => id === selected.id)?.approvalMode, "manual");
  assert.deepEqual(
    (await listSessions(dir)).map(({ id }) => id).sort(),
    [saved.id, selected.id, untouched.id].sort(),
  );
  await deleteSession(dir, untouched.id);
});

test("transient Session promotion shares identity across a storage directory symlink", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = path.join(dir, "storage");
  const alias = path.join(dir, "alias");
  await fs.mkdir(storage);
  await fs.symlink(storage, alias, "dir");
  const canonical = await fs.realpath(storage);
  const session = await createSession(alias, emptySessionInput, { transient: true });

  assert.deepEqual(await listSessions(canonical), [session]);
  await appendSessionEvent(canonical, session.id, { kind: "user", content: "First prompt" });
  assert.deepEqual(await readPersistedSessions(alias), [session]);
  assert.deepEqual(await listSessions(alias), [session]);

  await deleteSession(alias, session.id);
  assert.deepEqual(await listSessions(canonical), []);
});

test("archival, restoration, events, and attachments promote only the affected transient Session", async (t) => {
  const mutations: Array<{
    name: string;
    apply: (directory: string, session: AgentSession) => Promise<unknown>;
  }> = [
    {
      name: "archive",
      apply: (directory, session) => setSessionArchived(directory, session.id, true),
    },
    {
      name: "restore",
      apply: (directory, session) => restoreSession(directory, session.id, {
        projectKey: "current-activation",
        scope: { kind: "track", identity: "current-track", label: "Current lead" },
      }),
    },
    {
      name: "event",
      apply: async (directory, session) => {
        const event = await appendSessionEvent(directory, session.id, {
          kind: "user", content: "First prompt",
        });
        assert.deepEqual(await loadSessionEvents(directory, session.id), [event]);
      },
    },
    {
      name: "attachment",
      apply: (directory, session) => saveSessionAttachment(directory, session.id, {
        fileName: "reference.png",
        bytes: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
          0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      }, { preSavePendingAttachmentRefs: [] }),
    },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.name, async (subtest) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
      subtest.after(() => fs.rm(dir, { recursive: true, force: true }));
      const selected = await createSession(dir, emptySessionInput, { transient: true });
      const untouched = await createSession(dir, emptySessionInput, { transient: true });

      await mutation.apply(dir, selected);

      const persisted = await readPersistedSessions(dir);
      assert.deepEqual(persisted.map(({ id }) => id), [selected.id]);
      assert.deepEqual(
        persisted[0],
        (await listSessions(dir)).find(({ id }) => id === selected.id),
      );
      await deleteSession(dir, untouched.id);
    });
  }
});

test("rejected mutations leave a transient Session unsaved", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = await createSession(dir, emptySessionInput, { transient: true });

  await assert.rejects(
    updateSession(dir, session.id, { approvalMode: "unsafe" } as never),
    /Approval mode is invalid/,
  );
  await assert.rejects(
    appendSessionEvent(dir, session.id, { kind: "user", content: null } as never),
    /Session event input is invalid/,
  );
  await assert.rejects(
    saveSessionAttachment(dir, session.id, {
      fileName: "unsupported.bin", bytes: new Uint8Array([0]),
    }, { preSavePendingAttachmentRefs: [] }),
    (error: unknown) =>
      error instanceof AttachmentProcessingError && error.code === "invalid_document",
  );
  assert.deepEqual(await listSessions(dir), [session]);
  await assert.rejects(
    fs.readFile(path.join(dir, "live-smith-sessions.json")),
    { code: "ENOENT" },
  );
  await deleteSession(dir, session.id);
});

test("a durable Session supersedes its transient reservation and cannot resurrect after deletion", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = await createSession(dir, emptySessionInput, { transient: true });
  const committed = { ...session, title: "Committed by an uncertain write", approvalMode: "low-risk" };
  await fs.writeFile(
    path.join(dir, "live-smith-sessions.json"), JSON.stringify([committed]),
  );

  assert.deepEqual(await listSessions(dir), [committed]);
  await withStorageTransaction(dir, async (transaction) => {
    assert.deepEqual(await listSessionsInTransaction(transaction, dir), [committed]);
  });
  await deleteSession(dir, session.id);
  assert.deepEqual(await readPersistedSessions(dir), []);
  assert.deepEqual(await listSessions(dir), []);
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

test("edit scopes persist independently and survive Session lifecycle changes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = await createSession(dir, {
    title: "Scoped edits",
    projectKey: "prior-set",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
    editScopes: ["structure", "midi", "mixer"],
    approvalMode: "everything",
    activeSkillIds: ["mixing-review"],
    modelSelection: { profileId: "studio-profile", model: "studio-model" },
  });
  assert.deepEqual(session.editScopes, ["midi", "mixer", "structure"]);

  await updateSession(dir, session.id, { editScopes: [] });
  const [readOnly] = await listSessions(dir);
  assert.deepEqual(readOnly, { ...session, editScopes: [], updatedAt: readOnly?.updatedAt });
  assert.deepEqual(JSON.parse(await fs.readFile(
    path.join(dir, "live-smith-sessions.json"), "utf8",
  ))[0].editScopes, []);

  await updateSession(dir, session.id, { editScopes: ["devices", "audio"] });
  const restored = await restoreSession(dir, session.id, {
    projectKey: "current-set",
    scope: { kind: "track", identity: "track-2", label: "Current lead" },
  });
  const archived = await setSessionArchived(dir, session.id, true);
  const unarchived = await setSessionArchived(dir, session.id, false);
  for (const current of [restored, archived, unarchived, ...(await listSessions(dir))]) {
    assert.deepEqual(current.editScopes, ["audio", "devices"]);
    assert.equal(current.approvalMode, "everything");
  }
});

test("edit scopes reject malformed create, update, and persisted values without rewriting", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = await createSession(dir, {
    title: "Scoped edits",
    projectKey: "set-1",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    editScopes: [...EDIT_SCOPES],
  });
  const target = path.join(dir, "live-smith-sessions.json");
  const original = await fs.readFile(target, "utf8");
  for (const editScopes of [undefined, null, false, "midi", ["unknown"], ["midi", "midi"], [0]]) {
    await assert.rejects(
      createSession(dir, { ...session, editScopes } as never),
      /Edit scopes/i,
    );
    await assert.rejects(
      updateSession(dir, session.id, { editScopes } as never),
      /Edit scopes/i,
    );
    assert.equal(await fs.readFile(target, "utf8"), original);
    if (editScopes === undefined) continue;
    const corrupt = JSON.stringify([{ ...session, editScopes }]);
    await fs.writeFile(target, corrupt);
    await assert.rejects(listSessions(dir), SessionStorageCorruptionError);
    await assert.rejects(
      updateSession(dir, session.id, { title: "Do not overwrite corruption" }),
      SessionStorageCorruptionError,
    );
    assert.equal(await fs.readFile(target, "utf8"), corrupt);
    await fs.writeFile(target, original);
  }
});

test("legacy scope metadata stays absent and valid persisted scopes normalize on read", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const legacy = await createSession(dir, {
    title: "Legacy scopes",
    projectKey: "set-1",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  const target = path.join(dir, "live-smith-sessions.json");
  const original = await fs.readFile(target, "utf8");
  assert.equal(Object.hasOwn((await listSessions(dir))[0]!, "editScopes"), false);
  assert.equal(await fs.readFile(target, "utf8"), original);

  const unordered = JSON.stringify([{ ...legacy, editScopes: ["mixer", "midi"] }]);
  await fs.writeFile(target, unordered);
  assert.deepEqual((await listSessions(dir))[0]?.editScopes, ["midi", "mixer"]);
  assert.equal(await fs.readFile(target, "utf8"), unordered);
});

test("memory edit scopes are copied on create, update, listing, and restore", async (t) => {
  const editScopes: EditScope[] = ["midi", "devices"];
  const created = await createSession(undefined, {
    title: "Memory edit scopes",
    projectKey: "memory-original",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    editScopes,
  });
  t.after(() => deleteSession(undefined, created.id));
  editScopes.splice(0);
  created.editScopes?.splice(0);
  const first = (await listSessions(undefined)).find(({ id }) => id === created.id)!;
  assert.deepEqual(first.editScopes, ["midi", "devices"]);
  first.editScopes?.splice(0);

  const updatedScopes: EditScope[] = ["mixer", "audio"];
  await updateSession(undefined, created.id, { editScopes: updatedScopes });
  updatedScopes.splice(0);
  const restored = await restoreSession(undefined, created.id, {
    projectKey: "memory-restored",
    scope: { kind: "selection", identity: "selection-2", label: "Current Set" },
  });
  assert.deepEqual(restored.editScopes, ["audio", "mixer"]);
  restored.editScopes?.splice(0);
  assert.deepEqual(
    (await listSessions(undefined)).find(({ id }) => id === created.id)?.editScopes,
    ["audio", "mixer"],
  );
});

test("modelSelection persists per Session and is cloned across storage boundaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const selection = {
    profileId: "studio-profile",
    model: "gpt-5.6-sol",
    reasoningEffort: "high" as const,
  };
  const session = await createSession(dir, {
    title: "Model-specific conversation",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    modelSelection: selection,
  });
  selection.model = "mutated-after-create";

  assert.deepEqual(session.modelSelection, {
    profileId: "studio-profile",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  const [loaded] = await listSessions(dir);
  assert(loaded?.modelSelection);
  loaded.modelSelection.model = "mutated-after-read";
  assert.equal(
    (await listSessions(dir))[0]?.modelSelection?.model,
    "gpt-5.6-sol",
  );

  await updateSession(dir, session.id, {
    modelSelection: {
      profileId: "studio-profile",
      model: "claude-sonnet-4-6",
    },
  });
  const restored = await restoreSession(dir, session.id, {
    projectKey: "set-002",
    scope: { kind: "selection", identity: "selection-2", label: "Live Set" },
  });
  assert.deepEqual(restored.modelSelection, {
    profileId: "studio-profile",
    model: "claude-sonnet-4-6",
  });
});

test("modelSelection rejects invalid created and updated values", async () => {
  const invalidValues: unknown[] = [
    null,
    "gpt-5.6-sol",
    { model: "gpt-5.6-sol" },
    { profileId: "../profile", model: "gpt-5.6-sol" },
    { profileId: "studio-profile", model: "" },
    { profileId: "studio-profile", model: " gpt-5.6-sol" },
    { profileId: "studio-profile", model: "bad\u0000model" },
    {
      profileId: "studio-profile",
      model: "gpt-5.6-sol",
      reasoningEffort: "future-effort",
    },
    {
      profileId: "studio-profile",
      model: "gpt-5.6-sol",
      unexpected: true,
    },
  ];
  for (const modelSelection of invalidValues) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
    await assert.rejects(
      createSession(dir, {
        title: "Invalid model selection",
        projectKey: "set-001",
        scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
        modelSelection,
      } as never),
      /Model selection is invalid/,
    );
    const session = await createSession(dir, {
      title: "Valid Session",
      projectKey: "set-001",
      scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    });
    await assert.rejects(
      updateSession(dir, session.id, { modelSelection } as never),
      /Model selection is invalid/,
    );
  }
});

test("invalid persisted modelSelection makes Session storage corrupt without rewriting it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-sessions-"));
  const target = path.join(dir, "live-smith-sessions.json");
  const now = new Date().toISOString();
  const original = JSON.stringify([{
    id: "session-invalid-model",
    title: "Invalid model",
    projectKey: "set-001",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
    modelSelection: {
      profileId: "studio-profile",
      model: "gpt-5.6-sol",
      reasoningEffort: "future-effort",
    },
    createdAt: now,
    updatedAt: now,
  }]);
  await fs.writeFile(target, original);

  await assert.rejects(
    listSessions(dir),
    (error: unknown) => error instanceof SessionStorageCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
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
