import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import type {
  DirectApiModelConfig,
  DraftProfile,
} from "../profile.js";
import type {
  RuntimeProfile,
  TransportRequest,
} from "../provider.js";

type DirectOAuthCredential = Exclude<OAuthCredential, { provider: "google" }>;

const defaultOutputTokens: Record<DirectOAuthCredential["provider"], number> = {
  openai: 128_000,
  anthropic: 64_000,
};

export function oauthRequestAsDirect(
  request: TransportRequest,
  credential: OAuthCredential,
): TransportRequest {
  const provider = request.runtimeProfile.profile.connection.kind === "oauth-subscription"
    ? request.runtimeProfile.profile.connection.provider
    : undefined;
  if (credential.provider === "google") {
    throw new Error("Google OAuth uses the Antigravity protocol.");
  }
  if (provider !== credential.provider) {
    throw new Error("OAuth request provider does not match its credential.");
  }
  const runtime = directRuntimeProfile(request.runtimeProfile, credential);
  return {
    ...request,
    runtimeProfile: runtime,
    ...(provider === "anthropic"
      ? {
          systemInstructions: [
            "You are Claude Code, Anthropic's official CLI for Claude.",
            request.systemInstructions,
          ].join("\n\n"),
        }
      : {}),
  };
}

export function oauthDraftAsDirect(
  profile: DraftProfile,
  credential: OAuthCredential,
): DraftProfile & { requestHeaders: Readonly<Record<string, string>> } {
  if (credential.provider === "google") {
    throw new Error("Google OAuth uses the Antigravity protocol.");
  }
  if (profile.connection.kind !== "oauth-subscription" ||
    profile.connection.provider !== credential.provider) {
    throw new Error("OAuth discovery provider does not match its credential.");
  }
  return {
    ...profile,
    connection: directConnection(credential),
    requestHeaders: requestHeaders(credential),
    models: profile.models.map((model) => ({
      ...model,
      parameters: {
        maxOutputTokens: defaultOutputTokens[credential.provider],
        reasoning: model.parameters.reasoning,
      },
      advanced: {},
    })),
  };
}

function directRuntimeProfile(
  runtime: RuntimeProfile,
  credential: DirectOAuthCredential,
): RuntimeProfile {
  const model: DirectApiModelConfig = {
    model: runtime.model.model,
    parameters: {
      maxOutputTokens: runtime.capabilities.maxOutputTokens ??
        defaultOutputTokens[credential.provider],
      reasoning: runtime.model.parameters.reasoning,
    },
    advanced: {},
  };
  return {
    profile: {
      id: runtime.profile.id,
      name: runtime.profile.name,
      connection: directConnection(credential),
      requestHeaders: requestHeaders(credential),
    },
    model,
    capabilities: runtime.capabilities,
    inputCapabilityEvidence: runtime.inputCapabilityEvidence,
  } as RuntimeProfile;
}

function directConnection(
  credential: DirectOAuthCredential,
) {
  if (credential.provider === "openai") {
    return {
      kind: "direct-api" as const,
      apiFamily: "openai" as const,
      apiMode: "responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: credential.accessToken,
    };
  }
  return {
    kind: "direct-api" as const,
    apiFamily: "anthropic" as const,
    apiMode: "messages" as const,
    baseUrl: "https://api.anthropic.com",
    apiKey: credential.accessToken,
  };
}

function requestHeaders(
  credential: DirectOAuthCredential,
): Readonly<Record<string, string>> {
  if (credential.provider === "openai") {
    return {
      "chatgpt-account-id": credential.accountId,
      "openai-beta": "responses=experimental",
      originator: "live-smith",
      "user-agent": "live-smith/0.2",
    };
  }
  return {
    authorization: `Bearer ${credential.accessToken}`,
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "user-agent": "claude-cli/2.1",
    "x-app": "cli",
  };
}
