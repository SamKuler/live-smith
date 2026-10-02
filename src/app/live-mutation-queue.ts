import { throwIfAborted, waitForPromiseWithSignal } from "../runtime/host.js";

/**
 * Model turns and Live observations may overlap, but Live mutations must not.
 * Each queued operation performs its own preflight revalidation after it owns
 * this lock, immediately before it writes to Live.
 */
export class LiveMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
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
      return await operation();
    } finally {
      release();
    }
  }
}
