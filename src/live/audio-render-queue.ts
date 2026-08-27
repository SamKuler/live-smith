import type { AudioTrack, ExtensionContext } from "@ableton-extensions/sdk";

import {
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";

type Api = ExtensionContext<"1.0.0">;

const renderQueues = new WeakMap<object, AudioRenderQueue>();

export function consumePreFxAudioQueued<T>(
  context: Api,
  track: AudioTrack<"1.0.0">,
  startBeat: number,
  endBeat: number,
  signal: AbortSignal | undefined,
  consume: (filePath: string) => Promise<T>,
): Promise<T> {
  const owner = context as object;
  let queue = renderQueues.get(owner);
  if (!queue) {
    queue = new AudioRenderQueue();
    renderQueues.set(owner, queue);
  }
  return queue.run(
    signal,
    async () => {
      const filePath = await context.resources.renderPreFxAudio(
        track,
        startBeat,
        endBeat,
      );
      throwIfAborted(signal);
      return consume(filePath);
    },
  );
}

class AudioRenderQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(
    signal: AbortSignal | undefined,
    start: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const ownTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(
      () => ownTurn,
      () => ownTurn,
    );

    try {
      await waitForPromiseWithSignal(previous, signal);
      throwIfAborted(signal);
    } catch (error) {
      release();
      throw error;
    }

    let operation: Promise<T>;
    try {
      operation = start();
    } catch (error) {
      release();
      throw error;
    }
    void operation.then(release, release);
    return waitForPromiseWithSignal(operation, signal);
  }
}
