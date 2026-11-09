import { throwIfAborted } from "../../runtime/host.js";
import { loadSessionEventSummaries, searchSessionEvents } from "../../storage/events.js";
import { listSessions } from "../../storage/sessions.js";
import { sessionActivityAt } from "./session-activity.js";
import { MAX_SEARCH_EXCERPT_LENGTH, MAX_SEARCH_QUERY_LENGTH, MAX_SESSION_SEARCH_RESULTS,
  normalizeSearchQuery, searchTextMatches, type SessionSearchInput, type SessionSearchMatch,
  type SessionSearchResult } from "./search-contracts.js";

function excerpt(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, start + MAX_SEARCH_EXCERPT_LENGTH - 2);
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ")}${end < text.length ? "…" : ""}`;
}

/** Searches the same local Session collection exposed by Current, History and Archived. */
export async function searchSessions(input: SessionSearchInput & {
  storageDirectory: string | undefined; signal: AbortSignal;
}): Promise<SessionSearchResult> {
  throwIfAborted(input.signal);
  if (typeof input.query !== "string" || input.query.length > MAX_SEARCH_QUERY_LENGTH ||
      !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error("Session search query or page is invalid.");
  const query = normalizeSearchQuery(input.query);
  if (!query) return { query, offset: 0, matches: [], total: 0, unavailableCount: 0 };
  const sessions = await listSessions(input.storageDirectory);
  const summaries = await loadSessionEventSummaries(input.storageDirectory, sessions.map(session => session.id), input.signal);
  throwIfAborted(input.signal);
  const matches: { match: SessionSearchMatch; activityAt: string }[] = [];
  let unavailableCount = 0;
  for (const session of sessions) {
    throwIfAborted(input.signal);
    const title = session.title || session.scope.label;
    let match: SessionSearchMatch | undefined = searchTextMatches(title, query)
      ? { sessionId: session.id, excerpt: excerpt(title, query) } : undefined;
    let activityAt = sessionActivityAt(session);
    try {
      const summary = summaries.get(session.id);
      if (!summary || summary instanceof Error) throw summary ?? new Error("Session summary is unavailable.");
      throwIfAborted(input.signal);
      const lastMessageAt = summary.lastMessageAt;
      activityAt = sessionActivityAt({ ...session, ...(lastMessageAt === undefined ? {} : { lastMessageAt }) });
      if (!match) {
        const event = await searchSessionEvents(input.storageDirectory, session.id, query);
        throwIfAborted(input.signal);
        if (event) match = { sessionId: session.id, eventId: event.id, excerpt: excerpt(event.content, query) };
      }
    } catch {
      throwIfAborted(input.signal);
      unavailableCount++;
    }
    if (match) matches.push({ match, activityAt });
  }
  // A deletion during history reads must not leave a navigable stale result.
  const currentIds = new Set((await listSessions(input.storageDirectory)).map(session => session.id));
  throwIfAborted(input.signal);
  const current = matches.filter(({ match }) => currentIds.has(match.sessionId))
    .sort((a, b) => b.activityAt.localeCompare(a.activityAt) || a.match.sessionId.localeCompare(b.match.sessionId));
  return { query, offset: input.offset, total: current.length, unavailableCount,
    matches: current.slice(input.offset, input.offset + MAX_SESSION_SEARCH_RESULTS).map(({ match }) => match) };
}
