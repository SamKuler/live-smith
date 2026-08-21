import type {
  ModelTransport,
  TransportFactoryOptions,
} from "./provider.js";
import {
  isValidApiModePair,
  requireDirectApiConnection,
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
  const connection = requireDirectApiConnection(profile);
  if (!isValidApiModePair(connection.apiFamily, connection.apiMode)) {
    throw new Error(
      `Unsupported API family/mode combination: ${connection.apiFamily}/${connection.apiMode}.`,
    );
  }
  if (connection.apiFamily === "anthropic") {
    return createAnthropicMessagesTransport(options);
  }
  return connection.apiMode === "responses"
    ? createOpenAIResponsesTransport(options)
    : createOpenAIChatTransport(options);
}
