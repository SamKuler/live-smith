import type { AgentSession } from "../../storage/sessions.js";
import type { SessionEvent } from "../../storage/events.js";

export function lastSessionMessageAt(events: readonly SessionEvent[]): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if ((event.kind === "user" || event.kind === "assistant") &&
        (latest === undefined || event.createdAt > latest)) latest = event.createdAt;
  }
  return latest;
}

/** Chat activity and metadata edits share a display clock, without changing the metadata revision. */
export function sessionActivityAt(session: Pick<AgentSession, "createdAt" | "updatedAt"> & { lastMessageAt?: string }): string {
  const metadata = session.updatedAt || session.createdAt;
  return session.lastMessageAt && session.lastMessageAt > metadata ? session.lastMessageAt : metadata;
}
