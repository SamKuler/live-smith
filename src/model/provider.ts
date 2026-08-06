import type {
  ConversationMessage,
  ModelConversationMessage,
  ModelTurn,
} from "./contracts.js";
import type {
  ApiFamily,
  ApiMode,
  DraftProfile,
  SavedProfile,
  ReasoningEffort,
  ReasoningStrategy,
} from "./profile.js";

export interface ReasoningCapabilities {
  supported: boolean;
  canDisable: boolean;
  efforts: ReasoningEffort[];
  budgetTokens: boolean;
  strategy: ReasoningStrategy;
}

export interface ModelCapabilities {
  tools: boolean;
  streaming: boolean;
  temperature: "supported" | "unsupported";
  maxOutputTokens?: number;
  reasoning: ReasoningCapabilities;
}

export type ModelCapabilityHints = Omit<
  Partial<ModelCapabilities>,
  "reasoning"
> & {
  reasoning?: Partial<ReasoningCapabilities>;
};

export interface ModelInfo {
  id: string;
  displayName: string;
  capabilities: ModelCapabilities;
}

/** The only Profile representation accepted by model generation. */
export interface RuntimeProfile {
  profile: SavedProfile;
  capabilities: ModelCapabilities;
}

/** Raw provider metadata. Resolve it with policy and manual overrides at use time. */
export interface DiscoveredModelInfo {
  id: string;
  displayName: string;
  capabilities: ModelCapabilityHints;
}

export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

export interface TransportRequest {
  runtimeProfile: RuntimeProfile;
  prompt: string;
  liveContext: string;
  systemInstructions: string;
  history: ConversationMessage[];
  agentMessages: ModelConversationMessage[];
  tools: ModelTool[];
  signal?: AbortSignal;
  onDelta?: ((delta: string) => Promise<void> | void) | undefined;
}

export interface ModelTransport {
  readonly apiFamily: ApiFamily;
  readonly apiMode: ApiMode;
  listModels(
    profile: DraftProfile,
    signal?: AbortSignal,
  ): Promise<DiscoveredModelInfo[]>;
  createToolTurn(request: TransportRequest): Promise<ModelTurn>;
}

export interface TransportFactoryOptions {
  fetchImpl?: typeof fetch;
}
