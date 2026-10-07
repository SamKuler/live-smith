import type { ExtensionContext } from "@ableton-extensions/sdk";

/** Retains the Set authority of a runtime or admitted operation across awaits. */
export function createLiveSetGuard(context: ExtensionContext<"1.0.0">): () => void {
  const songId = context.application.song.handle.id;
  return () => {
    if (context.application.song.handle.id !== songId) {
      throw new Error("The Live Set changed. Open Ask Live Smith in the current Set before continuing.");
    }
  };
}
