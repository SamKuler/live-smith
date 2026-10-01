import type { ExtensionContext } from "@ableton-extensions/sdk";

import type { AudioAsset } from "../../audio-services/contracts.js";
import type {
  AudioAssetSampleSource,
  ManagedSampleSource,
  ManagedSampleSources,
} from "../../live/sample-source.js";
import { throwIfAborted } from "../../runtime/host.js";
import { readExpectedAudioAsset } from "../../storage/audio-assets.js";
import { createManagedSampleImport } from "./request-audio-sources.js";

export async function addAudioAssetSampleSources(
  input: {
    context: ExtensionContext<"1.0.0">;
    storageDirectory: string | undefined;
    sessionId: string;
    signal: AbortSignal;
  },
  sources: Map<string, ManagedSampleSource>,
  assets: readonly AudioAsset[],
): Promise<void> {
  throwIfAborted(input.signal);
  if (assets.length && !input.storageDirectory) {
    throw new Error("Persistent storage is required for audio asset SampleSources.");
  }
  for (const asset of assets) {
    if (asset.sessionId !== input.sessionId) {
      throw new Error("The audio asset does not belong to this Session.");
    }
    const expected: AudioAsset = { ...asset, origin: { ...asset.origin } };
    const identity = `audio-asset:${expected.id}:${expected.sha256}`;
    const existing = sources.get(expected.id);
    if (existing) {
      if (existing.kind !== "audio_asset" || existing.assetRef !== expected.id ||
        existing.identity !== identity) {
        throw new Error("The audio asset reference changed during this send.");
      }
      // Preserve a completed import when a job is listed or resumed again.
      continue;
    }
    const prepared = createManagedSampleImport({
      ...input,
      mediaType: expected.mediaType,
      failureMessage: "Live Smith could not import the audio asset into the Live project.",
      async readBytes() {
        return readExpectedAudioAsset(
          input.storageDirectory, input.sessionId, expected, input.signal,
        );
      },
    });
    const source: AudioAssetSampleSource = {
      kind: "audio_asset",
      assetRef: expected.id,
      label: `Audio asset ${expected.id}`,
      identity,
      get filePath() { return prepared.filePath; },
      prepare: prepared.prepare,
    };
    sources.set(expected.id, source);
  }
}

export function audioAssetSampleSourceInstructions(sources: ManagedSampleSources): string {
  const assets = [...sources.values()].filter((source) => source.kind === "audio_asset");
  if (!assets.length) return "";
  return [
    "The host has made the following persisted audio assets from this Session available as SampleSource values for this send only.",
    "Use only an exact supplied assetRef. Historical references must be supplied again by the host in this send. Asset references authorize source resolution only; Live changes still require observation, validation, Edit Scope, and the configured approval policy.",
    ...assets.map((source) => JSON.stringify({ kind: source.kind, assetRef: source.assetRef })),
  ].join("\n");
}
