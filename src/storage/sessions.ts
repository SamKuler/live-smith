import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isEditScopes,
  requireEditScopes,
  resolveEditScopes,
  type EditScope,
} from "../agent/edit-scopes.js";
import {
  createStorageId,
  hasUniqueStorageIds,
  isSafeStorageId,
} from "./id.js";
import { isMissingFileError } from "./errors.js";
import {
  canonicalStorageDirectory,
  storageScopeKey,
  type StorageScopeKey,
} from "./scope.js";
import {
  ensurePrivateFile,
  requireActiveStorageTransaction,
  withStorageTransaction,
  writeJsonAtomically,
  type StorageTransactionContext,
} from "./persistence.js";
import type { ConversationScope } from "../model/contracts.js";
import {
  isApprovalMode,
  isModelId,
  isReasoningEffort,
  type ApprovalMode,
  type ReasoningEffort,
} from "../model/profile.js";
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
  approvalMode?: ApprovalMode;
  editScopes?: EditScope[];
  modelSelection?: SessionModelSelection;
  createdAt: string;
  updatedAt: string;
}

export interface SessionModelSelection {
  profileId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

const sessionsFileName = "live-smith-sessions.json";
let memorySessions: AgentSession[] = [];
const transientSessions = new Map<StorageScopeKey, AgentSession[]>();

type CreateSessionInput = Pick<AgentSession, "title" | "projectKey" | "scope"> &
  Partial<
    Pick<AgentSession, "activeSkillIds" | "approvalMode" | "editScopes" | "modelSelection">
  >;
type SessionUpdate = Partial<
  Pick<
    AgentSession,
    "title" | "activeSkillIds" | "approvalMode" | "editScopes" | "modelSelection"
  >
>;

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
  options: { transient?: boolean } = {},
): Promise<AgentSession> {
  const activeSkillIds = normalizedOptionalActiveSkillIds(input);
  const approvalMode = normalizedOptionalApprovalMode(input);
  const editScopes = normalizedOptionalEditScopes(input);
  const modelSelection = normalizedOptionalModelSelection(input);
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: createStorageId("session"),
    title: input.title,
    projectKey: input.projectKey,
    scope: cloneConversationScope(input.scope),
    ...(activeSkillIds === undefined ? {} : { activeSkillIds }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
    ...(editScopes === undefined ? {} : { editScopes }),
    ...(modelSelection === undefined ? {} : { modelSelection }),
    createdAt: now,
    updatedAt: now,
  };

  return withStorageTransaction(storageDirectory, async () => {
    const sessions = await loadSessionsUnlocked(storageDirectory);
    if (options.transient) {
      const key = await transientSessionScopeKey(storageDirectory);
      transientSessions.set(key, [
        cloneSession(session),
        ...(transientSessions.get(key) ?? []),
      ]);
      return cloneSession(session);
    }
    await saveSessions(storageDirectory, [session, ...sessions]);
    return cloneSession(session);
  });
}

export async function listSessions(
  storageDirectory: string | undefined,
  projectKey?: string,
): Promise<AgentSession[]> {
  return filterByProject(await loadSessionsUnlocked(storageDirectory), projectKey);
}

export async function listSessionsInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  projectKey?: string,
): Promise<AgentSession[]> {
  requireActiveStorageTransaction(context, storageDirectory);
  const sessions = await loadSessionsUnlocked(storageDirectory);
  return filterByProject(sessions, projectKey);
}

async function loadSessionsUnlocked(
  storageDirectory: string | undefined,
): Promise<AgentSession[]> {
  const key = await transientSessionScopeKey(storageDirectory);
  // Capture before disk I/O: a concurrent promotion must not disappear from
  // both the old disk snapshot and the now-retired in-memory reservations.
  const drafts = transientSessions.get(key) ?? [];
  const saved = storageDirectory === undefined
    ? memorySessions
    : await loadSavedSessions(storageDirectory);

  // A write may have committed before reporting an unknown outcome. Once its
  // durable record is observed, never let the old reservation shadow/revive it.
  const savedIds = new Set(saved.map((session) => session.id));
  const currentDrafts = transientSessions.get(key);
  if (currentDrafts) {
    const remaining = currentDrafts.filter((session) => !savedIds.has(session.id));
    if (remaining.length) transientSessions.set(key, remaining);
    else transientSessions.delete(key);
  }
  if (!drafts.length) return saved;
  return [...drafts.filter((session) => !savedIds.has(session.id)), ...saved].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
}

async function loadSavedSessions(
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
  await withStorageTransaction(storageDirectory, async (context) => {
    await updateSessionInTransaction(context, storageDirectory, sessionId, update);
  });
}

export async function updateSessionInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  sessionId: string,
  update: SessionUpdate,
): Promise<AgentSession> {
  requireActiveStorageTransaction(context, storageDirectory);
  const normalizedUpdate = normalizeSessionUpdate(update);
  const sessions = await loadSessionsUnlocked(storageDirectory);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} does not exist.`);
  }
  const updatedSession: AgentSession = {
    ...session,
    ...normalizedUpdate,
    updatedAt: new Date().toISOString(),
  };
  const updated = sessions.map((candidate) =>
    candidate.id === sessionId ? updatedSession : candidate
  );
  await saveSessions(storageDirectory, updated, sessionId);
  return cloneSession(updatedSession);
}

export async function restoreSession(
  storageDirectory: string | undefined,
  sessionId: string,
  target: Pick<AgentSession, "projectKey" | "scope">,
): Promise<AgentSession> {
  return withStorageTransaction(storageDirectory, async () => {
    const sessions = await loadSessionsUnlocked(storageDirectory);
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
    await saveSessions(storageDirectory, updated, sessionId);
    return cloneSession(restored);
  });
}

export async function setSessionArchived(
  storageDirectory: string | undefined,
  sessionId: string,
  archived: boolean,
): Promise<AgentSession> {
  return withStorageTransaction(storageDirectory, async () => {
    const sessions = await loadSessionsUnlocked(storageDirectory);
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
    await saveSessions(storageDirectory, nextSessions, sessionId);
    return cloneSession(updated);
  });
}

export async function deleteSession(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  await withStorageTransaction(storageDirectory, async () => {
    const sessions = await loadSessionsUnlocked(storageDirectory);
    const key = await transientSessionScopeKey(storageDirectory);
    if (transientSessions.get(key)?.some((session) => session.id === sessionId)) {
      removeTransientSession(key, sessionId);
      return;
    }
    await saveSessions(
      storageDirectory,
      sessions.filter((session) => session.id !== sessionId),
    );
  });
}

export async function persistTransientSessionInTransaction(
  context: StorageTransactionContext,
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  requireActiveStorageTransaction(context, storageDirectory);
  const key = await transientSessionScopeKey(storageDirectory);
  if (!transientSessions.get(key)?.some((session) => session.id === sessionId)) return;
  const sessions = await loadSessionsUnlocked(storageDirectory);
  if (!transientSessions.get(key)?.some((session) => session.id === sessionId)) return;
  await saveSessions(storageDirectory, sessions, sessionId);
}

export function sessionScopeKey(scope: ConversationScope): string {
  return `${scope.kind}:${scope.identity}`;
}

async function saveSessions(
  storageDirectory: string | undefined,
  sessions: AgentSession[],
  persistSessionId?: string,
): Promise<void> {
  const key = await transientSessionScopeKey(storageDirectory);
  const draftIds = new Set(transientSessions.get(key)?.map((session) => session.id));
  const saved = sessions.filter((session) =>
    session.id === persistSessionId || !draftIds.has(session.id)
  );
  if (storageDirectory === undefined) memorySessions = saved.map(cloneSession);
  else await writeJsonAtomically(sessionsPath(storageDirectory), saved);
  if (persistSessionId !== undefined) removeTransientSession(key, persistSessionId);
}

function removeTransientSession(key: StorageScopeKey, sessionId: string): void {
  const remaining = transientSessions.get(key)?.filter((session) => session.id !== sessionId);
  if (remaining?.length) transientSessions.set(key, remaining);
  else transientSessions.delete(key);
}

async function transientSessionScopeKey(
  storageDirectory: string | undefined,
): Promise<StorageScopeKey> {
  return storageScopeKey(storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(storageDirectory));
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
    "approvalMode",
    "editScopes",
    "modelSelection",
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
    (record.approvalMode === undefined || isApprovalMode(record.approvalMode)) &&
    (record.editScopes === undefined || isEditScopes(record.editScopes)) &&
    (record.modelSelection === undefined ||
      isPersistedModelSelection(record.modelSelection)) &&
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
      (key) =>
        key !== "title" && key !== "activeSkillIds" &&
        key !== "approvalMode" && key !== "editScopes" &&
        key !== "modelSelection",
    ) ||
    (Object.hasOwn(record, "title") && typeof record.title !== "string") ||
    (Object.hasOwn(record, "approvalMode") &&
      !isApprovalMode(record.approvalMode)) ||
    (Object.hasOwn(record, "modelSelection") &&
      !isPersistedModelSelection(record.modelSelection))
  ) {
    throw new Error(
      Object.hasOwn(record, "approvalMode")
        ? "Approval mode is invalid."
        : Object.hasOwn(record, "modelSelection")
          ? "Model selection is invalid."
          : "Session update is invalid.",
    );
  }

  return {
    ...(Object.hasOwn(record, "title") ? { title: record.title as string } : {}),
    ...(Object.hasOwn(record, "activeSkillIds")
      ? { activeSkillIds: normalizeActiveSkillIds(record.activeSkillIds) }
      : {}),
    ...(Object.hasOwn(record, "approvalMode")
      ? { approvalMode: record.approvalMode as ApprovalMode }
      : {}),
    ...(Object.hasOwn(record, "editScopes")
      ? { editScopes: requireEditScopes(record.editScopes) }
      : {}),
    ...(Object.hasOwn(record, "modelSelection")
      ? {
          modelSelection: cloneModelSelection(
            record.modelSelection as SessionModelSelection,
          ),
        }
      : {}),
  };
}

function normalizedOptionalApprovalMode(
  value: Pick<AgentSession, "approvalMode">,
): ApprovalMode | undefined {
  if (!Object.hasOwn(value, "approvalMode")) return undefined;
  if (!isApprovalMode(value.approvalMode)) {
    throw new Error("Approval mode is invalid.");
  }
  return value.approvalMode;
}

function normalizedOptionalEditScopes(
  value: Pick<AgentSession, "editScopes">,
): EditScope[] | undefined {
  if (!Object.hasOwn(value, "editScopes")) return undefined;
  return requireEditScopes(value.editScopes);
}

function normalizedOptionalModelSelection(
  value: Pick<AgentSession, "modelSelection">,
): SessionModelSelection | undefined {
  if (!Object.hasOwn(value, "modelSelection")) return undefined;
  if (!isPersistedModelSelection(value.modelSelection)) {
    throw new Error("Model selection is invalid.");
  }
  return cloneModelSelection(value.modelSelection);
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

function isPersistedModelSelection(
  value: unknown,
): value is SessionModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(
    (key) => key === "profileId" || key === "model" || key === "reasoningEffort",
  ) &&
    isSafeStorageId(record.profileId) &&
    isModelId(record.model) &&
    (record.reasoningEffort === undefined ||
      isReasoningEffort(record.reasoningEffort));
}

function cloneModelSelection(
  selection: SessionModelSelection,
): SessionModelSelection {
  return {
    profileId: selection.profileId,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  };
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
    ...(session.approvalMode === undefined
      ? {}
      : { approvalMode: session.approvalMode }),
    ...(session.editScopes === undefined
      ? {}
      : { editScopes: resolveEditScopes(session.editScopes) }),
    ...(session.modelSelection === undefined
      ? {}
      : { modelSelection: cloneModelSelection(session.modelSelection) }),
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
