import { canonicalAudioOutputRole, legacyAudioOutputRole, type LegacyAudioOutputRole } from "./audio-output-compatibility.js";

/** Musical meaning is independent of the provider's immutable output key. */
export interface AudioOutputDescriptor {
  kind: "audio" | "music" | "sound_effect" | "stem" | "source" | "uploaded_audio";
  label: string;
  part?: string;
  alternative?: true;
}
const stemLabels = {
  vocals: "Lead vocals", backing_vocals: "Backing vocals", drums: "Drums", bass: "Bass",
  guitar: "Guitar", keyboard: "Keyboards", percussion: "Percussion", strings: "Strings",
  synth: "Synth", fx: "Effects", brass: "Brass", woodwinds: "Woodwinds",
} as const;
export type AudioStemPart = keyof typeof stemLabels;
export type AudioStemBaseRole = `stem_${AudioStemPart}`;
export type AudioStemRole = AudioStemBaseRole | `${AudioStemBaseRole}_alternative`;
export const AUDIO_STEM_BASE_ROLES = Object.keys(stemLabels).map((part) => `stem_${part}` as AudioStemBaseRole);
export const AUDIO_STEM_ROLES: readonly AudioStemRole[] = [
  ...AUDIO_STEM_BASE_ROLES, ...AUDIO_STEM_BASE_ROLES.map((role) => `${role}_alternative` as const),
];
const basicOutputs = {
  vocals: { kind: "stem", part: "vocals", label: "Vocals" },
  drums: { kind: "stem", part: "drums", label: "Drums" },
  bass: { kind: "stem", part: "bass", label: "Bass" },
  piano: { kind: "stem", part: "piano", label: "Piano" },
  electric_guitar: { kind: "stem", part: "electric_guitar", label: "Electric guitar" },
  acoustic_guitar: { kind: "stem", part: "acoustic_guitar", label: "Acoustic guitar" },
  residual: { kind: "stem", part: "residual", label: "Remaining audio" },
  music: { kind: "music", label: "Music" },
  music_alternative: { kind: "music", label: "Alternative music", alternative: true },
  sound_effect: { kind: "sound_effect", label: "Sound effect" },
  sound_effect_alternative: { kind: "sound_effect", label: "Alternative sound effect", alternative: true },
  uploaded_audio: { kind: "uploaded_audio", label: "Uploaded audio" },
  source: { kind: "source", label: "Source audio" },
} as const satisfies Record<string, AudioOutputDescriptor>;
export type AudioOutputRole = keyof typeof basicOutputs | AudioStemRole | LegacyAudioOutputRole;
export type GeneratedAudioOutputRole = "music" | "music_alternative" | "sound_effect" | "sound_effect_alternative" | "uploaded_audio" | AudioStemRole | LegacyAudioOutputRole;
const descriptors: Record<string, AudioOutputDescriptor> = { ...basicOutputs };
for (const role of AUDIO_STEM_ROLES) {
  const alternative = role.endsWith("_alternative");
  const part = role.slice(5).replace(/_alternative$/u, "") as AudioStemPart;
  descriptors[role] = { kind: "stem", part,
    label: alternative ? `Alternative ${stemLabels[part].toLowerCase()}` : stemLabels[part],
    ...(alternative ? { alternative: true as const } : {}),
  };
}
export function audioOutputDescriptor(role: unknown): AudioOutputDescriptor | undefined {
  if (typeof role !== "string") return undefined;
  const canonical = canonicalAudioOutputRole(role);
  return Object.hasOwn(descriptors, canonical) ? { ...descriptors[canonical]! } : undefined;
}
export function isGeneratedAudioOutputRole(role: unknown): role is GeneratedAudioOutputRole {
  if (typeof role !== "string" || !audioOutputDescriptor(role)) return false;
  const canonical = canonicalAudioOutputRole(role);
  return canonical.startsWith("stem_") || ["music", "music_alternative", "sound_effect", "sound_effect_alternative", "uploaded_audio"].includes(canonical);
}
export function isGeneratedStemRole(role: unknown): role is AudioStemRole | LegacyAudioOutputRole {
  return isGeneratedAudioOutputRole(role) && audioOutputDescriptor(role)?.kind === "stem";
}
export const AUDIO_OUTPUT_LABELS = Object.fromEntries([
  ...Object.entries(descriptors).filter(([role]) => role !== "source").map(([role, descriptor]) => [role, descriptor.label]),
  ...AUDIO_STEM_ROLES.map((role) => [legacyAudioOutputRole(role), descriptors[role]!.label]),
]) as Record<Exclude<AudioOutputRole, "source">, string>;


/** Plugin artifacts without an output role carry no inferred musical category. */
export function audioArtifactOutputDescriptor(artifact: { id: string; role?: AudioOutputRole }): AudioOutputDescriptor {
  return artifact.role === undefined ? { kind: "audio", label: "Audio" } : audioOutputDescriptor(artifact.role)!;
}

/** An explicit revision may preserve unknown meaning, but cannot turn components into song versions. */
export function audioOutputsCanShareWork(output: AudioOutputDescriptor, source: AudioOutputDescriptor): boolean {
  const kinds: AudioOutputDescriptor["kind"][] = ["audio", "music", "sound_effect"];
  return kinds.includes(output.kind) && kinds.includes(source.kind) &&
    (output.kind === "audio" || source.kind === "audio" || output.kind === source.kind);
}
