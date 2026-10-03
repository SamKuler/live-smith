import { storedAudioArtifactBytes } from "./audio-artifacts.js";
import { storedAudioAssetBytes } from "./audio-assets.js";

/** Both stores consume the same Session budget under the storage transaction. */
export async function storedSessionAudioBytes(storageDirectory: string, sessionId: string): Promise<number> {
  return await storedAudioAssetBytes(storageDirectory, sessionId) + await storedAudioArtifactBytes(storageDirectory, sessionId);
}
