import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createStorageId,
  hasUniqueStorageIds,
  isSafeStorageId,
} from "./id.js";
import { isMissingFileError } from "./errors.js";
import {
  ensurePrivateFile,
  requireActiveStorageTransaction,
  withStorageTransaction,
  writeJsonAtomically,
  type StorageTransactionContext,
} from "./persistence.js";
import type { ConversationScope } from "../model/contracts.js";
import {
  isSafeSkillId,
  MAX_ACTIVE_SKILL_COUNT,
} from "../skills/format.js";

export interface AgentSession {
  id: string;
  title: string;
  projectKey: string;
  scope: ConversationScope;
  originScope?: ConversationScope | undefined;
  archivedAt?: string | undefined;
  activeSkillIds?: string[];
  createdAt: string;
  updatedAt: string;
}

const sessionsFileName = "live-smith-sessions.json";
let memorySessions: AgentSession[] = [];

type CreateSessionInput = Pick<AgentSession, "title" | "projectKey" | "scope"> &
  Partial<Pick<AgentSession, "activeSkillIds">>;
type SessionUpdate = Partial<Pick<AgentSession, "title" | "activeSkillIds">>;

export class SessionStorageCorruptionError extends Error {
  constructor(cause?: unknown) {
    super(
      "Saved Live Smith sessions are invalid. No session changes were written; repair or remove live-smith-sessions.json and try again.",
      { cause },
    );
    this.name = "SessionStorageCorruptionError";
  }
}

export async function createSession(
  storageDirectory: string | undefined,
  input: CreateSessionInput,
): Promise<AgentSession> {
  const activeSkillIds = normalizedOptionalActiveSkillIds(input);
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: createStorageId("session"),
    title: input.title,
    projectKey: input.projectKey,
    scope: cloneConversationScope(input.scope),
    ...(activeSkillIds === undefined ? {} : { activeSkillIds }),
    createdAt: now,
    updatedAt: now,
  };

  return withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memorySessions = [cloneSession(session), ...memorySessions];
      return cloneSession(session);
    }

    const sessions = await loadSessionsUnlocked(storageDirectory);
    await saveSessions(storageDirectory, [session, ...sessions]);
    return cloneSession(session);
  });
}

export async function listSessions(
  storageDirectory: string | undefined,
  projectKey?: string,
): Promise<AgentSession[]> {
  if (!storageDirectory) return filterByProject(memorySessions, projectKey);

  return filterByProject(await loadSessionsUnlocked(storageDirectory), projectKey);
}

export async function listSessionsInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  projectKey?: string,
): Promise<AgentSession[]> {
  requireActiveStorageTransaction(context, storageDirectory);
  const sessions = storageDirectory === undefined
    ? memorySessions
    : await loadSessionsUnlocked(storageDirectory);
  return filterByProject(sessions, projectKey);
}

async function loadSessionsUnlocked(
  storageDirectory: string,
): Promise<AgentSession[]> {
  const target = sessionsPath(storageDirectory);
  try {
    await ensurePrivateFile(target);
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every(isAgentSession) ||
      !hasUniqueStorageIds(parsed)
    ) {
      throw new SessionStorageCorruptionError();
    }
    return parsed.map(cloneSession);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    if (error instanceof SyntaxError) {
      throw new SessionStorageCorruptionError(error);
    }
    throw error;
  }
}

function filterByProject(
  sessions: AgentSession[],
  projectKey: string | undefined,
): AgentSession[] {
  return sessions.filter(
    (session) => projectKey === undefined || session.projectKey === projectKey,
  ).map(cloneSession);
}

export async function updateSession(
  storageDirectory: string | undefined,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  await withStorageTransaction(storageDirectory, (context) =>
    updateSessionInTransaction(context, storageDirectory, sessionId, update)
  );
}

export async function updateSessionInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  requireActiveStorageTransaction(context, storageDirectory);
  const normalizedUpdate = normalizeSessionUpdate(update);
  const sessions = storageDirectory === undefined
    ? memorySessions
    : await loadSessionsUnlocked(storageDirectory);
  if (!sessions.some((session) => session.id === sessionId)) {
    throw new Error(`Session ${sessionId} does not exist.`);
  }
  const updated = sessions.map((session) =>
    session.id === sessionId
      ? { ...session, ...normalizedUpdate, updatedAt: new Date().toISOString() }
      : session,
  );
  if (storageDirectory === undefined) {
    memorySessions = updated.map(cloneSession);
  } else {
    await saveSessions(storageDirectory, updated);
  }
}

export async function restoreSession(
  storageDirectory: string | undefined,
  sessionId: string,
  target: Pick<AgentSession, "projectKey" | "scope">,
): Promise<AgentSession> {
  return withStorageTransaction(storageDirectory, async () => {
    const sessions = storageDirectory
      ? await loadSessionsUnlocked(storageDirectory)
      : memorySessions;
    const existing = sessions.find((session) => session.id === sessionId);
    if (!existing) throw new Error(`Session ${sessionId} does not exist.`);
    if (existing.projectKey === target.projectKey) {
      throw new Error(`Session ${sessionId} is already available in the current Live Set.`);
    }

    const restored: AgentSession = {
      ...existing,
      projectKey: target.projectKey,
      scope: target.scope,
      originScope: existing.originScope ?? existing.scope,
      updatedAt: new Date().toISOString(),
    };
    const updated = sessions.map((session) =>
      session.id === sessionId ? restored : session
    );
    if (storageDirectory) await saveSessions(storageDirectory, updated);
    else memorySessions = updated.map(cloneSession);
    return cloneSession(restored);
  });
}

export async function setSessionArchived(
  storageDirectory: string | undefined,
  sessionId: string,
  archived: boolean,
): Promise<AgentSession> {
  return withStorageTransaction(storageDirectory, async () => {
    const sessions = storageDirectory
      ? await loadSessionsUnlocked(storageDirectory)
      : memorySessions;
    const existing = sessions.find((session) => session.id === sessionId);
    if (!existing) throw new Error(`Session ${sessionId} does not exist.`);

    const now = new Date().toISOString();
    let updated: AgentSession;
    if (archived) {
      updated = {
        ...existing,
        archivedAt: existing.archivedAt ?? now,
        updatedAt: now,
      };
    } else {
      const { archivedAt: _archivedAt, ...unarchived } = existing;
      updated = { ...unarchived, updatedAt: now };
    }
    const nextSessions = sessions.map((session) =>
      session.id === sessionId ? updated : session
    );
    if (storageDirectory) await saveSessions(storageDirectory, nextSessions);
    else memorySessions = nextSessions.map(cloneSession);
    return cloneSession(updated);
  });
}

export async function deleteSession(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  await withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memorySessions = memorySessions.filter((session) => session.id !== sessionId);
      return;
    }

    const sessions = await loadSessionsUnlocked(storageDirectory);
    await saveSessions(
      storageDirectory,
      sessions.filter((session) => session.id !== sessionId),
    );
  });
}

export function sessionScopeKey(scope: ConversationScope): string {
  return `${scope.kind}:${scope.identity}`;
}

async function saveSessions(
  storageDirectory: string,
  sessions: AgentSession[],
): Promise<void> {
  await writeJsonAtomically(sessionsPath(storageDirectory), sessions);
}

function sessionsPath(storageDirectory: string): string {
  return path.join(storageDirectory, sessionsFileName);
}

function isAgentSession(value: unknown): value is AgentSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "id",
    "title",
    "projectKey",
    "scope",
    "originScope",
    "archivedAt",
    "activeSkillIds",
    "createdAt",
    "updatedAt",
  ]);
  return (
    Object.keys(record).every((key) => allowedKeys.has(key)) &&
    isSafeStorageId(record.id) &&
    typeof record.title === "string" &&
    typeof record.projectKey === "string" &&
    isConversationScope(record.scope) &&
    (record.originScope === undefined ||
      isConversationScope(record.originScope)) &&
    (record.archivedAt === undefined || typeof record.archivedAt === "string") &&
    (record.activeSkillIds === undefined ||
      isPersistedActiveSkillIds(record.activeSkillIds)) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function normalizeSessionUpdate(update: SessionUpdate): SessionUpdate {
  if (typeof update !== "object" || update === null || Array.isArray(update)) {
    throw new Error("Session update is invalid.");
  }
  const record = update as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "title" && key !== "activeSkillIds",
    ) ||
    (Object.hasOwn(record, "title") && typeof record.title !== "string")
  ) {
    throw new Error("Session update is invalid.");
  }

  return {
    ...(Object.hasOwn(record, "title") ? { title: record.title as string } : {}),
    ...(Object.hasOwn(record, "activeSkillIds")
      ? { activeSkillIds: normalizeActiveSkillIds(record.activeSkillIds) }
      : {}),
  };
}

function normalizedOptionalActiveSkillIds(
  value: Pick<AgentSession, "activeSkillIds">,
): string[] | undefined {
  if (!Object.hasOwn(value, "activeSkillIds")) return undefined;
  return normalizeActiveSkillIds(value.activeSkillIds);
}

function normalizeActiveSkillIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ACTIVE_SKILL_COUNT ||
    !value.every(isSafeSkillId) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Skill activation is invalid.");
  }
  return [...value].sort();
}

function isPersistedActiveSkillIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ACTIVE_SKILL_COUNT &&
    value.every(isSafeSkillId) &&
    value.every((skillId, index) => index === 0 || value[index - 1]! < skillId)
  );
}

function isConversationScope(value: unknown): value is ConversationScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(
      (key) => key === "kind" || key === "identity" || key === "label",
    ) &&
    (record.kind === "track" ||
      record.kind === "clip" ||
      record.kind === "object" ||
      record.kind === "selection") &&
    typeof record.identity === "string" &&
    typeof record.label === "string"
  );
}

function cloneSession(session: AgentSession): AgentSession {
  return {
    id: session.id,
    title: session.title,
    projectKey: session.projectKey,
    scope: cloneConversationScope(session.scope),
    ...(session.originScope === undefined
      ? {}
      : { originScope: cloneConversationScope(session.originScope) }),
    ...(session.archivedAt === undefined
      ? {}
      : { archivedAt: session.archivedAt }),
    ...(session.activeSkillIds === undefined
      ? {}
      : { activeSkillIds: [...session.activeSkillIds] }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function cloneConversationScope(scope: ConversationScope): ConversationScope {
  return {
    kind: scope.kind,
    identity: scope.identity,
    label: scope.label,
  };
}
