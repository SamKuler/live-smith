interface CancellableStream {
  cancel(reason?: unknown): Promise<void>;
}

interface ReleasableStreamReader {
  releaseLock(): void;
}

export function cancelStreamBestEffort(
  stream: CancellableStream | null | undefined,
  reason?: unknown,
): void {
  if (!stream) return;
  try {
    void stream.cancel(reason).catch(() => undefined);
  } catch {
    // Stream cleanup must not replace or delay the transport outcome.
  }
}

export function releaseReaderLockBestEffort(
  reader: ReleasableStreamReader,
): void {
  try {
    reader.releaseLock();
  } catch {
    // Stream cleanup must not replace the transport or consumer outcome.
  }
}
