import type { ExtensionContext } from "@ableton-extensions/sdk";

/** Supplies the Set identity required by an Extension API to protocol-only fixtures. */
export function agentRequestContext(context: object): ExtensionContext<"1.0.0"> {
  const fixture = context as { application?: { song?: { handle?: { id: bigint } } } };
  fixture.application ??= {};
  fixture.application.song ??= {};
  fixture.application.song.handle ??= { id: 1n };
  return context as ExtensionContext<"1.0.0">;
}
