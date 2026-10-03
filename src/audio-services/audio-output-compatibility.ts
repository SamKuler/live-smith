import type { AudioStemRole } from "./audio-output.js";

/** Persisted role keys remain opaque: changing one would change its saved asset ID. */
export type LegacyAudioOutputRole = `suno_${AudioStemRole}`;
export function canonicalAudioOutputRole(role: string): string {
  return role.startsWith("suno_stem_") ? role.slice(5) : role;
}
export function legacyAudioOutputRole(role: AudioStemRole): LegacyAudioOutputRole {
  return `suno_${role}`;
}
