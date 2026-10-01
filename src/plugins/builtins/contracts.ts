import type {
  AudioGenerationAdapter,
  AudioGenerationRequest,
  AudioOperation,
  AudioProvider,
  AudioServiceAdapter,
  MusicGenerationOptionField,
  LyricWritingRequest,
  LyricWritingResult,
  LyricModelCatalog,
  MusicServiceQuery,
  MusicServiceQueryResult,
  AudioCredentialRefreshHandler,
} from "../../audio-services/contracts.js";
import type { AudioTextToolRequest, AudioToolRequest } from "../../agent/audio-tool-parser.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import type { OpenProviderWebSocket } from "../../runtime/proxy-websocket.js";
import type { StoredSunoSession } from "../../storage/suno-sessions.js";

export interface BuiltInIntegrationConnectionChoice {
  id: string;
  name: string;
  pluginId: string;
  provider: AudioProvider;
  modelId?: string;
}

export interface BuiltInAudioToolExtension {
  localToolNames: readonly string[];
  tools(services: readonly BuiltInIntegrationConnectionChoice[]): ModelFunctionTool[];
  parse(
    name: string,
    argumentsJson: string,
    services: readonly BuiltInIntegrationConnectionChoice[],
  ): AudioToolRequest;
}

export interface BuiltInIntegrationConnectionDescriptor {
  label: string;
  authentication: "api-key" | "suno-session";
  callbackUrl?: true;
  modelConfigurable?: boolean;
  modelIds?: readonly string[];
  defaultModelId?: string;
}

export interface BuiltInAudioToolContract {
  operations: readonly AudioOperation[];
  musicDuration?: { minimumSeconds: number; maximumSeconds: number };
  generationOutputCount: number;
  inlineGeneration?: boolean;
  outputCollection?: "explicit";
  musicPromptCharacters: number;
  customMusic?: boolean;
  customMusicOptions?: readonly MusicGenerationOptionField[];
  requiredCustomMusicOptions?: readonly MusicGenerationOptionField[];
  musicLibrary?: boolean;
  instrumentalUnsupportedModelIds?: readonly string[];
  instrumentalOnlyModelIds?: readonly string[];
  fixedMusicDurationSecondsByModel?: Readonly<Record<string, number>>;
  promptGuidedDurationModelIds?: readonly string[];
}

export interface BuiltInAudioConnectionRuntime {
  id: string;
  name: string;
  pluginId: string;
  provider: AudioProvider;
  apiKey: string;
  modelId?: string;
  callbackUrl?: string;
  sunoSession?: Readonly<StoredSunoSession>;
}

export interface BuiltInAudioHostRuntime {
  fetchImpl: typeof fetch;
  openWebSocket: OpenProviderWebSocket;
  onCredentialRefresh?: AudioCredentialRefreshHandler;
  createGenerationAdapter?(
    connection: BuiltInAudioConnectionRuntime,
    authorizeDownloads: boolean,
  ): AudioGenerationAdapter;
}

/** The host owns connection revalidation and paid allowance authorization. */
export interface BuiltInAudioTextToolInvocation {
  kind: "read" | "paid";
  run(
    connection: BuiltInAudioConnectionRuntime,
    signal: AbortSignal,
    runtime: BuiltInAudioHostRuntime,
  ): Promise<object>;
}

export interface BuiltInAudioPluginDefinition {
  id: string;
  version: string;
  description: string;
  provider: AudioProvider;
  connection: BuiltInIntegrationConnectionDescriptor;
  audio: BuiltInAudioToolContract;
  tools: BuiltInAudioToolExtension;
  textTool?(request: AudioTextToolRequest): BuiltInAudioTextToolInvocation | undefined;
  validateGenerationRequest?(
    connection: BuiltInAudioConnectionRuntime,
    request: AudioGenerationRequest,
  ): void;
  generationModelId?(
    connection: BuiltInAudioConnectionRuntime,
    request: AudioGenerationRequest,
  ): string | undefined;
  inspectMusicService?(
    connection: BuiltInAudioConnectionRuntime,
    query: MusicServiceQuery,
    signal: AbortSignal,
    runtime: BuiltInAudioHostRuntime,
  ): Promise<MusicServiceQueryResult>;
  createGenerationAdapter?(
    connection: BuiltInAudioConnectionRuntime,
    runtime: BuiltInAudioHostRuntime,
    authorizeDownloads: boolean,
  ): AudioGenerationAdapter;
  createProcessingAdapter?(
    connection: BuiltInAudioConnectionRuntime,
    runtime: BuiltInAudioHostRuntime,
  ): AudioServiceAdapter;
  generateLyrics?(
    connection: BuiltInAudioConnectionRuntime,
    prompt: string,
    signal: AbortSignal,
    runtime: BuiltInAudioHostRuntime,
  ): Promise<{ title: string; lyrics: string }>;
  writeLyrics?(
    connection: BuiltInAudioConnectionRuntime, request: LyricWritingRequest, signal: AbortSignal, runtime: BuiltInAudioHostRuntime,
  ): Promise<LyricWritingResult>;
  inspectLyricModels?(
    connection: BuiltInAudioConnectionRuntime, signal: AbortSignal, runtime: BuiltInAudioHostRuntime,
  ): Promise<LyricModelCatalog>;
}
