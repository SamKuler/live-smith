import {
  MAX_SEARCH_EXCERPT_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SESSION_SEARCH_RESULTS,
  normalizeSearchQuery,
  type SessionSearchInput,
  type SessionSearchResult,
} from "../../../app/session/search-contracts.js";
import { hasOnlyWireKeys, isSafeInteger, isWireRecord, isWireStorageId } from "./primitives.js";

export function isWireSessionSearchResult(value: unknown, input: SessionSearchInput): value is SessionSearchResult {
  if (!isWireRecord(value) || !hasOnlyWireKeys<SessionSearchResult>(value,
    ["query", "offset", "total", "unavailableCount", "matches"]) ||
    typeof value.query !== "string" || !value.query || value.query.length > MAX_SEARCH_QUERY_LENGTH ||
    value.query !== normalizeSearchQuery(input.query) || value.offset !== input.offset ||
    !isSafeInteger(value.offset) || value.offset < 0 ||
    !isSafeInteger(value.total) || value.total < 0 ||
    !isSafeInteger(value.unavailableCount) || value.unavailableCount < 0 ||
    !Array.isArray(value.matches) ||
    value.matches.length !== Math.min(MAX_SESSION_SEARCH_RESULTS, Math.max(0, value.total - value.offset))) return false;
  const ids = new Set<string>();
  return value.matches.every((match) => {
    if (!isWireRecord(match) || !hasOnlyWireKeys<SessionSearchResult["matches"][number]>(match,
      ["sessionId", "excerpt", "eventId"]) || !isWireStorageId(match.sessionId) ||
      ids.has(match.sessionId) || typeof match.excerpt !== "string" ||
      match.excerpt.length > MAX_SEARCH_EXCERPT_LENGTH ||
      match.eventId !== undefined && !isWireStorageId(match.eventId)) return false;
    ids.add(match.sessionId);
    return true;
  });
}
