import type { BuiltInAudioHostRuntime } from "../../plugins/builtins/contracts.js";
import { providerFetchForStorage } from "../model/provider-fetch.js";
import { providerWebSocketForStorage } from "../model/provider-websocket.js";

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
