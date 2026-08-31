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
  DirectApiModelConfig,
  DirectApiProfile,
  DraftModelConfig,
  DraftProfile,
  ModelConnection,
  OAuthSubscriptionModelConfig,
  OAuthSubscriptionProfile,
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

export type CapabilitySupportEvidenceValue =
  | "supported"
  | "unsupported"
  | "unverified";

export type InputCapabilityEvidenceValue = CapabilitySupportEvidenceValue;

export type InputCapabilityEvidence = {
  [Kind in keyof InputCapabilities]: InputCapabilityEvidenceValue;
};

export type NumericCapabilityEvidenceValue = "verified" | "unverified";

export interface ModelCapabilityEvidence {
  temperature: CapabilitySupportEvidenceValue;
  maxOutputTokens: NumericCapabilityEvidenceValue;
  contextWindowTokens: NumericCapabilityEvidenceValue;
  reasoning: CapabilitySupportEvidenceValue;
  inputs: InputCapabilityEvidence;
}

export interface ModelCapabilities {
  tools: boolean;
  streaming: boolean;
  temperature: "supported" | "unsupported";
  maxOutputTokens?: number;
  contextWindowTokens?: number;
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
  capabilityEvidence: ModelCapabilityEvidence;
}

/** Credential-bearing connection identity without the persisted model collection. */
export interface RuntimeProfileIdentity {
  id: string;
  name: string;
  connection: ModelConnection;
  /** Request-only headers supplied by a credential-owning backend; never persisted. */
  requestHeaders?: Readonly<Record<string, string>>;
}

/** Minimum single-model view needed to resolve capabilities for a draft. */
export interface ModelCapabilitySource {
  profile: RuntimeProfileIdentity;
  model: DraftModelConfig;
}

/** The one configured model selected for a model request or capability decision. */
export type RuntimeModelSource =
  | {
      profile: Pick<DirectApiProfile, "id" | "name" | "connection">;
      model: DirectApiModelConfig;
    }
  | {
      profile: Pick<OAuthSubscriptionProfile, "id" | "name" | "connection">;
      model: OAuthSubscriptionModelConfig;
    };

interface ResolvedRuntimeModelFields {
  capabilities: ModelCapabilities;
  inputCapabilityEvidence: InputCapabilityEvidence;
}

/** The only Profile/model representation accepted by model generation. */
export type RuntimeProfile =
  | (Extract<RuntimeModelSource, {
      profile: { connection: { kind: "direct-api" } };
    }> & ResolvedRuntimeModelFields)
  | (Extract<RuntimeModelSource, {
      profile: { connection: { kind: "oauth-subscription" } };
    }> & ResolvedRuntimeModelFields);

export function isDirectRuntimeModelSource(
  value: RuntimeModelSource | RuntimeProfile,
): value is Extract<RuntimeModelSource, {
  profile: { connection: { kind: "direct-api" } };
}> & Partial<ResolvedRuntimeModelFields> {
  return value.profile.connection.kind === "direct-api";
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
  /** Opaque identity shared only by retries of this logical model request. */
  reconnectState?: object;
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

export type OAuthAuthState =
  | {
      status: "unavailable";
      message: string;
      /** The backend observed a terminal auth result, not an indeterminate read. */
      definitive?: boolean;
      /** Trusted provider page for resolving an account requirement. */
      verificationUrl?: string;
      verificationLabel?: string;
    }
  | { status: "signed-out" }
  | {
      status: "pending";
      verificationUrl: string;
      userCode?: string;
      /** The current attempt remains valid, but the Host browser command failed. */
      browserLaunchFailed?: boolean;
    }
  | {
      status: "signed-in";
      accountLabel: string | null;
      planType: string;
      subscriptionEligible: boolean;
    };

export interface OAuthAuthReadOptions {
  /** Proactively refresh OAuth credentials before reporting readiness. */
  readiness?: boolean;
}

export interface ModelTurnExecutor {
  createToolTurn(request: TransportRequest): Promise<ModelTurn>;
}

/**
 * Provider-neutral execution boundary. Direct API transports are short-lived;
 * OAuth backends retain only credential, login, and refresh state.
 */
interface ModelBackendBase extends ModelTurnExecutor {
  listModels(
    profile: DraftProfile,
    signal?: AbortSignal,
  ): Promise<DiscoveredModelInfo[]>;
  close(): Promise<void>;
}

export interface DirectApiBackend extends ModelBackendBase {
  readonly kind: "direct-api";
}

export interface OAuthSubscriptionBackend extends ModelBackendBase {
  readonly kind: "oauth-subscription";
  readAuthState(
    signal?: AbortSignal,
    options?: OAuthAuthReadOptions,
  ): Promise<OAuthAuthState>;
  beginLogin(signal?: AbortSignal): Promise<OAuthAuthState>;
  setPendingLoginBrowserLaunchFailed?(
    failed: boolean,
    signal?: AbortSignal,
  ): Promise<OAuthAuthState>;
  logout(signal?: AbortSignal): Promise<OAuthAuthState>;
}

export type ModelBackend = DirectApiBackend | OAuthSubscriptionBackend;

export interface TransportFactoryOptions {
  fetchImpl?: typeof fetch;
}
