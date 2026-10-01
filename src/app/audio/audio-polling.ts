import { setTimeout as delay } from "node:timers/promises";

import type { AudioProvider } from "../../audio-services/contracts.js";
import { throwIfAborted } from "../../runtime/host.js";
import { SessionMutationFence } from "../session/session-mutation-fence.js";

const MINIMUM_POLL_INTERVAL_MS: Partial<Record<AudioProvider, number>> = {
  // LALAL.AI publishes a 30 requests/minute limit for /check/. Leave a small
  // margin so two Session jobs sharing one key cannot sit on the boundary.
  lalal: 2_100,
};

export class AudioPollScheduler {
  private readonly fence = new SessionMutationFence();
  private readonly nextPollAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: {
    now?: () => number;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  }

  async wait(provider: AudioProvider, ownerKey: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const interval = MINIMUM_POLL_INTERVAL_MS[provider];
    if (!interval) return;
    const key = `${provider}:${ownerKey}`;
    await this.fence.run(key, signal, async () => {
      const remaining = Math.max(0, (this.nextPollAt.get(key) ?? 0) - this.now());
      if (remaining) await this.sleep(remaining, signal);
      throwIfAborted(signal);
      this.nextPollAt.set(key, this.now() + interval);
    });
  }
}

export const audioPollScheduler = new AudioPollScheduler();
