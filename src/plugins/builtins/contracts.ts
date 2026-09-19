import type {
  AudioOperation,
  AudioProvider,
  MusicGenerationOptionField,
} from "../../audio-services/contracts.js";
import type { AudioToolRequest } from "../../agent/audio-tools.js";
import type { AudioServiceChoice } from "../../audio-services/capabilities.js";
import type { ModelFunctionTool } from "../../model/provider.js";

export interface BuiltInAudioToolExtension {
  localToolNames: readonly string[];
  tools(services: readonly AudioServiceChoice[]): ModelFunctionTool[];
  parse(name: string, argumentsJson: string): AudioToolRequest;
}

export interface BuiltInAudioCapabilities {
  label: string;
  operations: readonly AudioOperation[];
  musicDuration?: { minimumSeconds: number; maximumSeconds: number };
  generationOutputCount: number;
  inlineGeneration?: boolean;
  musicPromptCharacters: number;
  sessionImport?: boolean;
  customMusic?: boolean;
  customMusicOptions?: readonly MusicGenerationOptionField[];
  requiredCustomMusicOptions?: readonly MusicGenerationOptionField[];
  musicLibrary?: boolean;
  modelConfigurable?: boolean;
  modelIds?: readonly string[];
  defaultModelId?: string;
  instrumentalUnsupportedModelIds?: readonly string[];
  instrumentalOnlyModelIds?: readonly string[];
  fixedMusicDurationSecondsByModel?: Readonly<Record<string, number>>;
  promptGuidedDurationModelIds?: readonly string[];
}

export interface BuiltInAudioPluginDefinition {
  id: string;
  version: string;
  description: string;
  provider: AudioProvider;
  capabilities: BuiltInAudioCapabilities;
  toolExtension?: BuiltInAudioToolExtension;
}
