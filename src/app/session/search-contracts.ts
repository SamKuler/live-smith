export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_SESSION_SEARCH_RESULTS = 50;
export const MAX_SEARCH_EXCERPT_LENGTH = 240;

export interface SessionSearchInput { query: string; offset: number }
export interface SessionSearchMatch { sessionId: string; excerpt: string; eventId?: string }
export interface SessionSearchResult extends SessionSearchInput {
  matches: SessionSearchMatch[];
  total: number;
  unavailableCount: number;
}

export function normalizeSearchQuery(query: string): string { return query.trim(); }
export function searchTextMatches(text: string, query: string): boolean {
  return text.toLowerCase().includes(normalizeSearchQuery(query).toLowerCase());
}
