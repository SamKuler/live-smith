import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SESSION_SEARCH_RESULTS,
  normalizeSearchQuery,
  type SessionSearchInput,
  type SessionSearchMatch,
  type SessionSearchResult,
} from "../../app/session/search-contracts.js";
import type { ChatBridgeState } from "../chat-state.js";
import { isWireSessionSearchResult } from "./wire-contracts/session-search.js";

interface Dependencies {
  readSessionSearch(input: SessionSearchInput, signal?: AbortSignal): Promise<unknown>;
  onFilterChange(): void;
  onResultsChange(): void;
}

export function createSessionSearch(deps: Dependencies) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let input: HTMLInputElement;
  let status: HTMLElement;
  let controls: HTMLElement;
  let previous: HTMLButtonElement;
  let next: HTMLButtonElement;
  let retry: HTMLButtonElement;
  const t = (text: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(text, values) ?? text;
  let query = "";
  let offset = 0;
  let result: SessionSearchResult | undefined;
  let matches = new Map<string, SessionSearchMatch>();
  let phase: "idle" | "loading" | "ready" | "error" = "idle";
  let timer: number | undefined;
  let controller: AbortController | undefined;
  let revision = 0;
  let composing = false;
  let refreshAfterComposition = false;
  let stateSignature: string | undefined;
  const lastEvents = new Map<string, string>();

  function cancel() {
    revision++;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }

  function render() {
    status.hidden = !query;
    let message = phase === "loading" ? t("Searching sessions…")
      : phase === "error" ? t("Session search failed. Try again.")
        : !result?.total ? t("No matching sessions.")
          : result.total > MAX_SESSION_SEARCH_RESULTS ? t("{start}–{end} of {count} matching sessions", {
            start: String(result.matches.length ? result.offset + 1 : 0),
            end: String(result.offset + result.matches.length),
            count: String(result.total),
          }) : t("{count} matching sessions", { count: String(result.total) });
    if (result?.unavailableCount && phase === "ready") {
      message += " " + t("{count} sessions could not be searched.", { count: String(result.unavailableCount) });
    }
    const text = query ? message : "";
    if (status.textContent !== text) status.textContent = text;
    const paged = Boolean(query && result && (result.total > MAX_SESSION_SEARCH_RESULTS || offset > 0));
    previous.hidden = !paged;
    next.hidden = !paged;
    previous.disabled = phase === "loading" || offset === 0;
    next.disabled = phase === "loading" || !result || offset + result.matches.length >= result.total;
    retry.hidden = phase !== "error";
    controls.hidden = !query || (!paged && retry.hidden);
    const list = element("sessions");
    const busy = String(phase === "loading");
    if (list.getAttribute("aria-busy") !== busy) list.setAttribute("aria-busy", busy);
  }

  async function read(expectedRevision: number) {
    timer = undefined;
    const receipt = { query, offset };
    const requestController = new window.AbortController();
    controller = requestController;
    try {
      const value = await deps.readSessionSearch(receipt, requestController.signal);
      if (revision !== expectedRevision) return;
      if (!isWireSessionSearchResult(value, receipt)) throw new Error("Invalid Session search response");
      if (!value.matches.length && value.total > 0 && offset >= value.total) {
        offset = Math.floor((value.total - 1) / MAX_SESSION_SEARCH_RESULTS) * MAX_SESSION_SEARCH_RESULTS;
        schedule(false);
        return;
      }
      result = value;
      matches = new Map(value.matches.map((match) => [match.sessionId, match]));
      phase = "ready";
    } catch {
      if (revision !== expectedRevision) return;
      phase = "error";
    } finally {
      if (revision === expectedRevision) {
        controller = undefined;
        render();
        deps.onResultsChange();
      }
    }
  }

  function schedule(debounce = true) {
    cancel();
    refreshAfterComposition = false;
    if (!query) return;
    phase = "loading";
    render();
    const expectedRevision = revision;
    if (debounce) timer = window.setTimeout(() => { void read(expectedRevision); }, 180);
    else void read(expectedRevision);
  }

  function invalidate() {
    if (!query) return;
    if (composing) refreshAfterComposition = true;
    else schedule();
  }

  function updateQuery() {
    const nextQuery = normalizeSearchQuery(input.value.slice(0, MAX_SEARCH_QUERY_LENGTH));
    if (nextQuery === query) return;
    cancel();
    query = nextQuery;
    refreshAfterComposition = false;
    offset = 0;
    result = undefined;
    matches.clear();
    phase = query ? "loading" : "idle";
    deps.onFilterChange();
    render();
    if (query) schedule();
    deps.onResultsChange();
  }

  function initialize() {
    input = element<HTMLInputElement>("sessionSearch");
    status = element("sessionSearchStatus");
    controls = element("sessionSearchControls");
    previous = element<HTMLButtonElement>("sessionSearchPrevious");
    next = element<HTMLButtonElement>("sessionSearchNext");
    retry = element<HTMLButtonElement>("sessionSearchRetry");
    previous.addEventListener("click", () => movePage(Math.max(0, offset - MAX_SESSION_SEARCH_RESULTS)));
    next.addEventListener("click", () => movePage(offset + MAX_SESSION_SEARCH_RESULTS));
    retry.addEventListener("click", () => schedule(false));
    input.addEventListener("compositionstart", () => { composing = true; cancel(); });
    input.addEventListener("compositionend", () => {
      composing = false;
      if (normalizeSearchQuery(input.value.slice(0, MAX_SEARCH_QUERY_LENGTH)) === query && query &&
          (phase === "loading" || refreshAfterComposition)) schedule();
      else updateQuery();
    });
    input.addEventListener("input", () => { if (!composing) updateQuery(); });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || composing || !input.value) return;
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      updateQuery();
    });
  }

  function movePage(nextOffset: number) {
    offset = nextOffset;
    matches.clear();
    deps.onFilterChange();
    schedule(false);
    deps.onResultsChange();
  }

  window.addEventListener("pagehide", cancel);

  return {
    get active() { return Boolean(query); },
    getMatch(sessionId: string) { return matches.get(sessionId); },
    includes(sessionId: string) { return !query || matches.has(sessionId); },
    invalidate,
    syncState(state: ChatBridgeState) {
      if (!input) initialize();
      const records = [...state.sessions, ...state.previousSessions, ...state.archivedSessions];
      const ids = new Set(records.map((session) => session.id));
      for (const id of lastEvents.keys()) if (!ids.has(id)) lastEvents.delete(id);
      const lastEventId = state.events.findLast((event) => event.kind === "user" || event.kind === "assistant")?.id ?? "";
      const previousEventId = lastEvents.get(state.activeSessionId);
      lastEvents.set(state.activeSessionId, lastEventId);
      const nextSignature = JSON.stringify(records.map((session) => [session.id, session.title, session.updatedAt]));
      const changed = stateSignature !== undefined && (nextSignature !== stateSignature ||
        previousEventId !== undefined && previousEventId !== lastEventId);
      stateSignature = nextSignature;
      if (changed) invalidate();
      render();
    },
  };
}
