import type { ChatBridgeState, ChatSessionEvent, ChatSessionEventPage } from "../chat-state.js";

interface HistoryRequest { sessionId: string; historyId: string; before?: number; after?: number; afterEventId?: string; anchorEventId?: string }
type ForwardCursor = { after: number } | { afterEventId: string };

interface Dependencies {
  getState(): ChatBridgeState;
  readPage(input: HistoryRequest, signal: AbortSignal): Promise<ChatSessionEventPage>;
}

/** Owns only the displayed history; operational projections remain in the current state. */
export function createSessionHistory({ getState, readPage }: Dependencies) {
  let owner = "";
  let events: ChatSessionEvent[] = [];
  let nextBefore: number | undefined;
  let nextAfter: ForwardCursor | undefined;
  let anchored = false;
  let observed: ChatSessionEvent[] | undefined;
  let request: AbortController | undefined;
  let generation = 0;

  function sync() {
    const state = getState();
    const key = JSON.stringify([state.activeSessionId, state.eventHistory?.historyId]);
    if (owner !== key) {
      request?.abort(); request = undefined; generation++;
      owner = key; observed = undefined; events = []; anchored = false;
    }
    if (observed !== state.events) {
      if (!observed || !state.eventHistory) {
        events = state.events; nextBefore = state.eventHistory?.nextBefore; nextAfter = undefined;
      } else if (!anchored) {
        const ids = new Set(events.map(event => event.id));
        const overlap = state.events.some(event => ids.has(event.id));
        if (overlap || !events.length) {
          events = [...events, ...state.events.filter(event => !ids.has(event.id))];
        } else {
          // A disconnected tail remains separate from the displayed activity run.
          anchored = true;
          nextAfter = { afterEventId: events.at(-1)!.id };
        }
      }
      observed = state.events;
    }
    return { events, nextBefore, nextAfter, anchored, loading: Boolean(request) };
  }

  async function load(anchorEventId?: string, newer = false, isCurrent = () => true) {
    sync();
    const state = getState();
    if (!state.eventHistory || (!anchorEventId && (newer ? nextAfter : nextBefore) === undefined)) return false;
    request?.abort();
    const controller = new window.AbortController(); request = controller;
    const token = ++generation;
    const key = owner;
    const before = nextBefore;
    const forwardCursor = nextAfter;
    const after = forwardCursor && "after" in forwardCursor ? forwardCursor.after : undefined;
    try {
      const page = await readPage({ sessionId: state.activeSessionId, historyId: state.eventHistory.historyId,
        ...(anchorEventId ? { anchorEventId } : newer ? forwardCursor! : { before: before! }) }, controller.signal);
      sync();
      if (controller.signal.aborted || token !== generation || key !== owner || !isCurrent()) return false;
      if (page.sessionId !== state.activeSessionId || page.historyId !== state.eventHistory.historyId ||
          (!anchorEventId && newer && after !== undefined && page.nextAfter !== undefined && page.nextAfter <= after) ||
          (!anchorEventId && !newer && page.nextBefore !== undefined && page.nextBefore >= before!) ||
          (anchorEventId && !page.events.some(event => event.id === anchorEventId))) {
        throw new Error("Session history is unavailable. Try again.");
      }
      if (anchorEventId) { events = page.events; anchored = true; nextBefore = page.nextBefore; nextAfter = page.nextAfter === undefined ? undefined : { after: page.nextAfter }; }
      else {
        const ids = new Set(events.map(event => event.id));
        const additions = page.events.filter(event => !ids.has(event.id));
        events = newer ? [...events, ...additions] : [...additions, ...events];
        if (newer) nextAfter = page.nextAfter === undefined ? undefined : { after: page.nextAfter };
        else nextBefore = page.nextBefore;
      }
      return true;
    } finally {
      if (request === controller) request = undefined;
    }
  }

  function latest() {
    request?.abort(); request = undefined; generation++;
    observed = undefined; anchored = false;
    return sync();
  }
  return { sync, load, latest };
}
