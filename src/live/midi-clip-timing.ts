interface ClipTiming {
  duration: number; startMarker: number; endMarker: number;
  looping: boolean; loopEnd: number;
}

/** Creation writes section-relative notes directly into the retained source timeline. */
export function midiClipHasAuthoringTiming(
  timing: ClipTiming,
  durationBeats: number,
  looping = timing.looping,
): boolean {
  return Math.abs(timing.duration - durationBeats) < 0.0001 &&
    timing.startMarker === 0 &&
    (looping
      ? timing.loopEnd >= durationBeats
      : timing.endMarker >= durationBeats);
}
