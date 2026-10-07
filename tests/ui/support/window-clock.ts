import type { JSDOM } from "jsdom";

/** Controls delayed browser work while leaving the harness's zero-delay settling intact. */
export function installWindowClock(window: JSDOM["window"]) {
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  const pending = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let id = 1_000_000;
  window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (typeof handler !== "function" || delay <= 0) return set(handler, delay, ...args);
    const handle = id++;
    pending.set(handle, { at: now + delay, run: () => handler(...args) });
    return handle;
  }) as typeof window.setTimeout;
  window.clearTimeout = (handle) => { if (handle === undefined || !pending.delete(handle)) clear(handle); };
  return {
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...pending].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]); now = next[1].at; next[1].run();
      }
      now = target;
    },
    restore() { pending.clear(); window.setTimeout = set; window.clearTimeout = clear; },
  };
}
