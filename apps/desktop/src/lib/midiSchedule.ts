// Pure math helpers for the MIDI scheduler. Kept out of the store so unit
// tests / future scheduler swaps don't have to drag the Zustand surface
// in too.

/**
 * 12-tone equal-temperament pitch ratio for sample-based MIDI playback.
 * A note `n` semitones away from the sample's base pitch plays back at
 * `2^(n/12)` × the original sample rate — same math the audio thread
 * does internally when you set `AudioBufferSourceNode.playbackRate`.
 *
 * pitch = 60 (C4), baseNote = 60 → ratio 1.0 (unshifted)
 * pitch = 72 (C5), baseNote = 60 → ratio 2.0 (one octave up)
 * pitch = 48 (C3), baseNote = 60 → ratio 0.5 (one octave down)
 */
export function pitchShiftRatio(notePitch: number, baseNote: number): number {
  return Math.pow(2, (notePitch - baseNote) / 12);
}

/** Convert a step count (16ths) to seconds at a given BPM. */
export function stepsToSeconds(steps: number, bpm: number): number {
  return steps * (60 / bpm / 4);
}

/** Inverse — seconds at a given BPM → 16th-note steps. */
export function secondsToSteps(seconds: number, bpm: number): number {
  return seconds * bpm * 4 / 60;
}

/** Convenience: clamp a MIDI pitch into 0–127. */
export function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

/** Convenience: clamp a velocity into 0–1. */
export function clampVelocity(velocity: number): number {
  return Math.max(0, Math.min(1, velocity));
}
