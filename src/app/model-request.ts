import type { ModelConversationMessage, ConversationMessage } from "../model/contracts.js";
import {
  resolveModelCapabilities,
} from "../model/capabilities.js";
import type {
  DiscoveredModelInfo,
  ModelCapabilities,
  ModelInfo,
  ModelTool,
  RuntimeProfile,
  TransportRequest,
} from "../model/provider.js";
import type { DraftProfile, SavedProfile } from "../model/profile.js";
import { transportForProfile } from "../model/registry.js";
import { agentSystemInstructions } from "../agent/system-instructions.js";

export async function requestModelTurn(input: {
  prompt: string;
  liveContext: string;
  runtimeProfile: RuntimeProfile;
  history: ConversationMessage[];
  agentMessages: ModelConversationMessage[];
  tools: ModelTool[];
  signal: AbortSignal;
  onDelta(delta: string): Promise<void> | void;
}) {
  return transportForProfile(input.runtimeProfile.profile).createToolTurn(
    buildModelRequest(input),
  );
}

export function buildModelRequest(input: {
  prompt: string;
  liveContext: string;
  history: ConversationMessage[];
  agentMessages: ModelConversationMessage[];
  runtimeProfile: RuntimeProfile;
  tools: ModelTool[];
  signal?: AbortSignal;
  onDelta?: ((delta: string) => Promise<void> | void) | undefined;
}): TransportRequest {
  const request: TransportRequest = {
    prompt: input.prompt,
    liveContext: input.liveContext,
    systemInstructions: agentSystemInstructions,
    history: input.history,
    agentMessages: input.agentMessages,
    tools: input.tools,
    runtimeProfile: input.runtimeProfile,
  };
  if (input.signal) request.signal = input.signal;
  if (input.onDelta) request.onDelta = input.onDelta;
  return request;
}

export function runtimeProfileForSavedProfile(
  profile: SavedProfile,
  models: DiscoveredModelInfo[] = [],
): RuntimeProfile {
  return {
    profile,
    capabilities: capabilitiesForProfile(profile, models),
  };
}

export function capabilitiesForProfile(
  profile: SavedProfile,
  models: DiscoveredModelInfo[] = [],
): ModelCapabilities {
  const discovered = models.find((model) => model.id === profile.model);
  return resolveModelCapabilities(profile, discovered?.capabilities);
}

export function capabilitiesForProfilePreview(
  profile: DraftProfile,
  models: DiscoveredModelInfo[] = [],
): ModelCapabilities {
  const previewProfile = withoutManualCapabilityOverrides(profile);
  const discovered = models.find((model) => model.id === previewProfile.model);
  return resolveModelCapabilities(previewProfile, discovered?.capabilities);
}

export function resolveDiscoveredModels(
  profile: DraftProfile,
  models: DiscoveredModelInfo[],
): ModelInfo[] {
  const previewProfile = withoutManualCapabilityOverrides(profile);
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    capabilities: resolveModelCapabilities(
      { ...previewProfile, model: model.id },
      model.capabilities,
    ),
  }));
}

function withoutManualCapabilityOverrides(
  profile: DraftProfile,
): DraftProfile {
  const { capabilityOverrides: _ignored, ...advanced } = profile.advanced;
  return { ...profile, advanced };
}
