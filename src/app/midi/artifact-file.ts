import { midiArtifactFileName, readMidiArtifact } from "../../storage/midi-artifacts.js";

export { midiArtifactFileName } from "../../storage/midi-artifacts.js";

export async function readMidiArtifactFile(storageDirectory: string | undefined, sessionId: string,
  artifactRef: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { artifact, bytes } = await readMidiArtifact(storageDirectory, sessionId, artifactRef, signal);
  return { bytes, fileName: midiArtifactFileName(artifact) };
}
