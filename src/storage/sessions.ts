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
  withStorageTransaction,
  writeJsonAtomically,
} from "./persistence.js";
import type { ConversationScope } from "../model/contracts.js";

export interface AgentSession {
  id: string;
  title: string;
  projectKey: string;
  scope: ConversationScope;
  createdAt: string;
  updatedAt: string;
}

const sessionsFileName = "live-smith-sessions.json";
let memorySessions: AgentSession[] = [];

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
  input: Pick<AgentSession, "title" | "projectKey" | "scope">,
): Promise<AgentSession> {
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: createStorageId("session"),
    ...input,
    createdAt: now,
    updatedAt: now,
  };

  return withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memorySessions = [session, ...memorySessions];
      return session;
    }

    const sessions = await loadSessionsUnlocked(storageDirectory);
    await saveSessions(storageDirectory, [session, ...sessions]);
    return session;
  });
}

export async function listSessions(
  storageDirectory: string | undefined,
  projectKey?: string,
): Promise<AgentSession[]> {
  if (!storageDirectory) return filterByProject(memorySessions, projectKey);

  return filterByProject(await loadSessionsUnlocked(storageDirectory), projectKey);
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
    return parsed;
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
  );
}

export async function updateSession(
  storageDirectory: string | undefined,
  sessionId: string,
  update: Partial<Pick<AgentSession, "title">>,
): Promise<void> {
  await withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memorySessions = memorySessions.map((session) =>
        session.id === sessionId
          ? { ...session, ...update, updatedAt: new Date().toISOString() }
          : session,
      );
      return;
    }

    const sessions = await loadSessionsUnlocked(storageDirectory);
    await saveSessions(
      storageDirectory,
      sessions.map((session) =>
        session.id === sessionId
          ? { ...session, ...update, updatedAt: new Date().toISOString() }
          : session,
      ),
    );
  });
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
      updatedAt: new Date().toISOString(),
    };
    const updated = sessions.map((session) =>
      session.id === sessionId ? restored : session
    );
    if (storageDirectory) await saveSessions(storageDirectory, updated);
    else memorySessions = updated;
    return restored;
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
  return (
    isSafeStorageId(record.id) &&
    typeof record.title === "string" &&
    typeof record.projectKey === "string" &&
    isConversationScope(record.scope) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isConversationScope(value: unknown): value is ConversationScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "track" ||
      record.kind === "clip" ||
      record.kind === "object" ||
      record.kind === "selection") &&
    typeof record.identity === "string" &&
    typeof record.label === "string"
  );
}
