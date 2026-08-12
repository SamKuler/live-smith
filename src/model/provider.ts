import type {
  ConversationMessage,
  ModelHostedWebSearch,
  ModelInputPart,
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

export interface InputCapabilities {
  image: boolean;
  audio: boolean;
  pdf: boolean;
}

export type InputCapabilityEvidenceValue =
  | "supported"
  | "unsupported"
  | "unverified";

export type InputCapabilityEvidence = {
  [Kind in keyof InputCapabilities]: InputCapabilityEvidenceValue;
};

export interface ModelCapabilities {
  tools: boolean;
  streaming: boolean;
  temperature: "supported" | "unsupported";
  maxOutputTokens?: number;
  reasoning: ReasoningCapabilities;
  inputs: InputCapabilities;
}

export type ModelCapabilityHints = Omit<
  Partial<ModelCapabilities>,
  "reasoning" | "inputs"
> & {
  reasoning?: Partial<ReasoningCapabilities>;
  inputs?: Partial<InputCapabilities>;
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
  /** Present on production Runtime Profiles; optional for narrow transport fixtures. */
  inputCapabilityEvidence?: InputCapabilityEvidence;
}

/** Raw provider metadata. Resolve it with policy and manual overrides at use time. */
export interface DiscoveredModelInfo {
  id: string;
  displayName: string;
  capabilities: ModelCapabilityHints;
}

export interface ModelFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ModelHostedWebSearchTool {
  type: "hosted_web_search";
  maxUses: number;
}

export type ModelTool = ModelFunctionTool | ModelHostedWebSearchTool;

export interface TransportRequest {
  runtimeProfile: RuntimeProfile;
  currentUserContent: ModelInputPart[];
  systemInstructions: string;
  history: ConversationMessage[];
  agentMessages: ModelConversationMessage[];
  tools: ModelTool[];
  signal?: AbortSignal;
  onDelta?: ((delta: string) => Promise<void> | void) | undefined;
  onHostedWebSearch?: ((
    update: ModelHostedWebSearch,
  ) => Promise<void> | void) | undefined;
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
