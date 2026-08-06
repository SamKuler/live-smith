import type {
  ModelTransport,
  TransportFactoryOptions,
} from "./provider.js";
import {
  isValidApiModePair,
  type DraftProfile,
  type SavedProfile,
} from "./profile.js";
import { createAnthropicMessagesTransport } from "./transports/anthropic-messages.js";
import { createOpenAIChatTransport } from "./transports/openai-chat.js";
import { createOpenAIResponsesTransport } from "./transports/openai-responses.js";

export function transportForProfile(
  profile: DraftProfile | SavedProfile,
  options: TransportFactoryOptions = {},
): ModelTransport {
  if (!isValidApiModePair(profile.apiFamily, profile.apiMode)) {
    throw new Error(
      `Unsupported API family/mode combination: ${profile.apiFamily}/${profile.apiMode}.`,
    );
  }
  if (profile.apiFamily === "anthropic") {
    return createAnthropicMessagesTransport(options);
  }
  return profile.apiMode === "responses"
    ? createOpenAIResponsesTransport(options)
    : createOpenAIChatTransport(options);
}
