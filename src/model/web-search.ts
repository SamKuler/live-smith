import type {
  ModelHostedWebSearch,
  ModelHostedWebSearchAction,
} from "./contracts.js";
import { isModelCitation, normalizeModelCitations } from "./citations.js";

export const MAX_MODEL_WEB_SEARCH_ID_CODE_POINTS = 128;
export const MAX_MODEL_WEB_SEARCH_QUERY_COUNT = 8;
export const MAX_MODEL_WEB_SEARCH_QUERY_CODE_POINTS = 512;

const actions = new Set<ModelHostedWebSearchAction>([
  "search",
  "open_page",
  "find_in_page",
]);

export function normalizeModelHostedWebSearch(
  value: unknown,
): ModelHostedWebSearch | undefined {
  if (!isRecord(value)) return undefined;
  const id = normalizeSearchId(value.id);
  const status = value.status === "searching" ||
      value.status === "completed" ||
      value.status === "failed"
    ? value.status
    : undefined;
  const action = typeof value.action === "string" &&
      actions.has(value.action as ModelHostedWebSearchAction)
    ? value.action as ModelHostedWebSearchAction
    : undefined;
  if (!id || !status || !action) return undefined;

  const queries = normalizeSearchQueries(value.queries);
  const sources = status === "failed"
    ? []
    : normalizeModelCitations(
        Array.isArray(value.sources) ? value.sources : [],
      );
  return {
    id,
    status,
    action,
    queries,
    sources,
  };
}

export function isModelHostedWebSearch(
  value: unknown,
): value is ModelHostedWebSearch {
  const normalized = normalizeModelHostedWebSearch(value);
  if (!normalized || !isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["id", "status", "action", "queries", "sources"].includes(key))) {
    return false;
  }
  return value.id === normalized.id &&
    value.status === normalized.status &&
    value.action === normalized.action &&
    Array.isArray(value.queries) &&
    value.queries.length === normalized.queries.length &&
    value.queries.every((query, index) => query === normalized.queries[index]) &&
    Array.isArray(value.sources) &&
    value.sources.length === normalized.sources.length &&
    value.sources.every((source, index) =>
      isModelCitation(source) &&
      source.url === normalized.sources[index]?.url &&
      source.title === normalized.sources[index]?.title
    );
}

function normalizeSearchQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (queries.length >= MAX_MODEL_WEB_SEARCH_QUERY_COUNT) break;
    const query = normalizeSearchQuery(candidate);
    if (!query || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
  }
  return queries;
}

export function safeModelWebSearchId(
  value: unknown,
  fallback: string,
): string {
  return normalizeSearchId(value) ?? fallback;
}

function normalizeSearchId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    [...trimmed].length > MAX_MODEL_WEB_SEARCH_ID_CODE_POINTS ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(trimmed)
  ) return undefined;
  return trimmed;
}

function normalizeSearchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    [...trimmed].length > MAX_MODEL_WEB_SEARCH_QUERY_CODE_POINTS ||
    /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(trimmed)
  ) return undefined;
  const tokens = trimmed.split(/[\t ]+/u);
  if (!tokens.some(isInternalSearchQueryToken)) return trimmed;
  const visibleQuery = tokens.filter((token, index) =>
    !isInternalSearchQueryToken(token) &&
    !(
      isDecorativeSearchQuerySeparator(token) &&
      (
        isInternalSearchQueryToken(tokens[index - 1] ?? "") ||
        isInternalSearchQueryToken(tokens[index + 1] ?? "")
      )
    )
  ).join(" ");
  return visibleQuery || undefined;
}

function isInternalSearchQueryToken(value: string): boolean {
  return /^ws_call_id=[A-Za-z0-9._:-]{1,256}$/u.test(value);
}

function isDecorativeSearchQuerySeparator(value: string): boolean {
  return value === "·" || value === "•" || value === "|" || value === "—" || value === "–";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
