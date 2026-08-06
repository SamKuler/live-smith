import { throwIfAborted } from "../runtime/host.js";

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
      await waitForTurn(previous, signal);
      throwIfAborted(signal);
      return await operation();
    } finally {
      release();
    }
  }
}

async function waitForTurn(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Operation aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
