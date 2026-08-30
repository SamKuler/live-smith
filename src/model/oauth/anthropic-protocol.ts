import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import { createAnthropicMessagesTransport } from "../transports/anthropic-messages.js";
import type { TransportFactoryOptions } from "../provider.js";
import {
  oauthDraftAsDirect,
  oauthRequestAsDirect,
} from "./direct-transport-adapter.js";
import type { OAuthModelProtocol } from "./protocol.js";

export function createAnthropicOAuthProtocol(
  options: TransportFactoryOptions = {},
): OAuthModelProtocol {
  const transport = createAnthropicMessagesTransport(options);
  return {
    listModels(profile, credential, signal) {
      requireProvider(credential, "anthropic");
      return transport.listModels(oauthDraftAsDirect(profile, credential), signal);
    },
    createToolTurn(request, credential) {
      requireProvider(credential, "anthropic");
      return transport.createToolTurn(oauthRequestAsDirect(request, credential));
    },
  };
}

function requireProvider(
  credential: OAuthCredential,
  provider: "anthropic",
): void {
  if (credential.provider !== provider) {
    throw new Error("OAuth protocol received another provider's credential.");
  }
}
