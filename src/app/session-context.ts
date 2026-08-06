import type { ExtensionContext } from "@ableton-extensions/sdk";

import type { LiveInteractionContext } from "../live/context.js";
import type { ConversationMessage } from "../model/contracts.js";
import type { SessionEvent } from "../storage/events.js";
import { createStorageId } from "../storage/id.js";
import {
  createSession,
  listSessions,
  sessionScopeKey,
  type AgentSession,
} from "../storage/sessions.js";

type Api = ExtensionContext<"1.0.0">;
const maxConversationMessages = 24;
const activationProjectKeys = new WeakMap<
  object,
  { songHandleId: bigint; projectKey: string }
>();

export async function getOrCreateDefaultSession(
  storageDirectory: string | undefined,
  interaction: LiveInteractionContext,
  prompt: string,
  projectKey: string,
  preferredSessionId?: string | undefined,
): Promise<AgentSession> {
  const sessions = await listSessions(storageDirectory, projectKey);
  const preferred = sessions.find((session) => session.id === preferredSessionId);
  if (preferred) return preferred;

  const scope = interaction.scope;
  const scopeKey = sessionScopeKey(scope);
  const existing = sessions.find(
    (session) => sessionScopeKey(session.scope) === scopeKey,
  );
  if (existing) return existing;

  return createSession(storageDirectory, {
    title: titleForPrompt(prompt, scope.label),
    projectKey,
    scope,
  });
}

export function nextNewChatTitle(
  sessions: AgentSession[],
  projectKey: string,
): string {
  const used = new Set<number>();
  for (const session of sessions) {
    if (session.projectKey !== projectKey) continue;
    if (session.title === "New chat") {
      used.add(1);
      continue;
    }
    const match = /^New chat \((\d+)\)$/.exec(session.title);
    if (match) used.add(Number(match[1]));
  }

  if (!used.has(1)) return "New chat";
  let number = 2;
  while (used.has(number)) number += 1;
  return `New chat (${number})`;
}

export function conversationHistoryFromEvents(
  events: SessionEvent[],
): ConversationMessage[] {
  return events.flatMap((event): ConversationMessage[] => {
    if (event.kind === "user" || event.kind === "assistant") {
      return [{ role: event.kind, content: event.content }];
    }

    return [];
  }).slice(-maxConversationMessages);
}

export function recoverableSessionsForScope(
  sessions: AgentSession[],
  projectKey: string,
  scope: LiveInteractionContext["scope"],
): AgentSession[] {
  const label = normalizedScopeLabel(scope.label);
  return sessions.filter(
    (session) =>
      session.projectKey !== projectKey &&
      session.scope.kind === scope.kind &&
      normalizedScopeLabel(session.scope.label) === label,
  );
}

export function projectKeyForContext(context: Api): string {
  const songHandleId = context.application.song.handle.id;
  const current = activationProjectKeys.get(context);
  if (current?.songHandleId === songHandleId) return current.projectKey;

  const projectKey = createStorageId("project");
  activationProjectKeys.set(context, { songHandleId, projectKey });
  return projectKey;
}

function titleForPrompt(prompt: string, fallback: string): string {
  const title = prompt.split("\n")[0]?.trim() || fallback;
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

function normalizedScopeLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}
