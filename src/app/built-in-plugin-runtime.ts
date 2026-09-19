import type { BuiltInAudioHostRuntime } from "../plugins/builtins/contracts.js";
import { providerFetchForStorage } from "./provider-fetch.js";
import { providerWebSocketForStorage } from "./provider-websocket.js";

export function builtInAudioHostRuntime(
  storageDirectory: string | undefined,
  overrides: Partial<BuiltInAudioHostRuntime> = {},
): BuiltInAudioHostRuntime {
  return {
    fetchImpl: providerFetchForStorage(storageDirectory),
    openWebSocket: providerWebSocketForStorage(storageDirectory),
    ...overrides,
  };
}
