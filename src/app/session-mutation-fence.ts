import * as path from "node:path";

export class SessionMutationFence {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export function sessionMutationFenceKey(
  storageDirectory: string | undefined,
  sessionId: string,
): string {
  return JSON.stringify([
    storageDirectory === undefined ? null : path.resolve(storageDirectory),
    sessionId,
  ]);
}
