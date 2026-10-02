import { Buffer } from "node:buffer";
import { midiArtifactVersion, readMidiArtifact, type MidiArtifact } from "../../storage/midi-artifacts.js";

export function midiArtifactFileName(artifact: MidiArtifact): string {
  const label = Buffer.from(artifact.label, "utf8").toString("utf8").normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").replace(/\s+/gu, " ").trim();
  const name = [...label].slice(0, 30).join("") || "MIDI";
  return `${name}-v${midiArtifactVersion(artifact).number}-${artifact.id.slice(-8)}.mid`;
}

export async function readMidiArtifactFile(storageDirectory: string | undefined, sessionId: string,
  artifactRef: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { artifact, bytes } = await readMidiArtifact(storageDirectory, sessionId, artifactRef, signal);
  return { bytes, fileName: midiArtifactFileName(artifact) };
}
