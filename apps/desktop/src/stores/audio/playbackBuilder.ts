import { getCtx } from './graph';
import type { WarpMarker } from './types';
import { adaptiveStretch, type SampleCharacter } from '../../lib/stretch';

/**
 * Pick the playable buffer for a sample with a detected BPM at a given
 * project BPM. Passes through (cheap, no DSP) when the two tempos agree or
 * when we lack the data to stretch. Cap at 2x either direction — WSOLA
 * artifacts stack past that and the result sounds worse than unstretched.
 * Character + beats metadata route us into transient-preserving stretch
 * for percussive samples and larger-frame WSOLA for tonal ones.
 */
export function stretchForProject(
  originalBuffer: AudioBuffer,
  detectedBpm: number | undefined,
  projectBpm: number,
  meta: { character?: SampleCharacter; beats?: number[] } = {},
): AudioBuffer {
  if (!detectedBpm || detectedBpm <= 0 || projectBpm <= 0) return originalBuffer;
  const factor = detectedBpm / projectBpm;
  if (factor < 0.5 || factor > 2) return originalBuffer;
  if (Math.abs(factor - 1) < 0.005) return originalBuffer;
  try {
    return adaptiveStretch(originalBuffer, factor, getCtx(), meta);
  } catch {
    return originalBuffer;
  }
}

/**
 * Pitch-preserving playback build. Combines warp stretch + pitch
 * compensation into ONE pass over the original buffer:
 *   warpFactor  = sourceBpm / projectBpm (or 1 if warp off / no data)
 *   pitchFactor = 2^(semitones / 12)
 *   stretchFactor = warpFactor * pitchFactor
 *
 * The buffer ends up `pitchFactor` longer than the warped length; at
 * playback time the source is run at `playbackRate = pitchFactor` so the
 * resample shifts the pitch but the OUTPUT duration is just the warped
 * length again — i.e. pitching down doesn't slow the clip down. Falls
 * back to the original buffer when the combined factor is too extreme
 * for WSOLA to handle gracefully.
 */
export interface PlayBufferResult { buffer: AudioBuffer; playbackRate: number }

/**
 * The clip's effective duration in PROJECT TIME, accounting for the
 * pitch-compensation pre-stretch + matching playbackRate. This is what
 * every visual / timing calculation should use — not buffer.duration —
 * so pitching a clip doesn't change its visual width on the timeline.
 */
export function getEffectiveDuration(track: { buffer?: AudioBuffer; pitch?: number }): number {
  if (!track.buffer) return 0;
  const playbackRate = Math.pow(2, (track.pitch || 0) / 12);
  return track.buffer.duration / Math.max(0.0001, playbackRate);
}

// Memoise stretched buffers per (originalBuffer, factor, character, beats).
// Two clips that share the same source file and the same effective stretch
// factor end up pointing at the SAME AudioBuffer — identical waveforms,
// no per-clip variance, and one stretch pass instead of N. WeakMap keyed
// on the original buffer means cache entries drop the moment the buffer
// itself is GC'd.
const stretchCache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>();
function cachedAdaptiveStretch(
  original: AudioBuffer,
  factor: number,
  meta: { character?: SampleCharacter; beats?: number[] },
): AudioBuffer {
  const key = `${factor.toFixed(6)}|${meta.character || ''}|${(meta.beats?.length ?? 0)}`;
  let inner = stretchCache.get(original);
  if (!inner) { inner = new Map(); stretchCache.set(original, inner); }
  const hit = inner.get(key);
  if (hit) return hit;
  const result = adaptiveStretch(original, factor, getCtx(), meta);
  inner.set(key, result);
  return result;
}

// Slice a portion of an AudioBuffer into a fresh AudioBuffer. Used by
// the piecewise warp stretcher to break the source into per-segment
// chunks before stretching each at its own factor.
function sliceAudioBuffer(src: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const ctx = getCtx();
  const startSample = Math.max(0, Math.floor(startSec * src.sampleRate));
  const endSample = Math.min(src.length, Math.ceil(endSec * src.sampleRate));
  const length = Math.max(1, endSample - startSample);
  const out = ctx.createBuffer(src.numberOfChannels, length, src.sampleRate);
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    const srcCh = src.getChannelData(ch);
    const dstCh = out.getChannelData(ch);
    for (let i = 0; i < length; i++) dstCh[i] = srcCh[startSample + i];
  }
  return out;
}

// Concatenate AudioBuffers head-to-tail. Output sample rate / channel
// count matches the first input.
function concatAudioBuffers(parts: AudioBuffer[]): AudioBuffer {
  const ctx = getCtx();
  if (parts.length === 0) return ctx.createBuffer(2, 1, ctx.sampleRate);
  const sampleRate = parts[0].sampleRate;
  const channels = parts[0].numberOfChannels;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = ctx.createBuffer(channels, total, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const dst = out.getChannelData(ch);
    let pos = 0;
    for (const p of parts) {
      const src = p.getChannelData(Math.min(ch, p.numberOfChannels - 1));
      dst.set(src, pos);
      pos += p.length;
    }
  }
  return out;
}

// Piecewise WSOLA stretch driven by warp markers. Each adjacent pair
// of (sourceSec, bufferSec) anchors defines a segment; the source slice
// for that segment is stretched to fit its target buffer length, then
// every segment is concatenated. Implicit anchors (0, 0) and
// (sourceLen, sourceLen * baseStretch) bracket the user's markers so
// the head and tail of the buffer always render.
function stretchWithMarkers(
  original: AudioBuffer,
  markers: WarpMarker[],
  baseStretch: number,
  meta: { character?: SampleCharacter; beats?: number[] },
): AudioBuffer {
  const sorted = markers.slice().sort((a, b) => a.sourceSec - b.sourceSec);
  const points: WarpMarker[] = [
    { sourceSec: 0, bufferSec: 0 },
    ...sorted,
    { sourceSec: original.duration, bufferSec: original.duration * baseStretch },
  ];
  const segments: AudioBuffer[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const sourceLen = b.sourceSec - a.sourceSec;
    const bufferLen = b.bufferSec - a.bufferSec;
    if (sourceLen <= 0 || bufferLen <= 0) continue;
    const factor = bufferLen / sourceLen;
    const slice = sliceAudioBuffer(original, a.sourceSec, b.sourceSec);
    if (Math.abs(factor - 1) < 0.005) {
      segments.push(slice);
    } else {
      try {
        segments.push(adaptiveStretch(slice, factor, getCtx(), meta));
      } catch {
        segments.push(slice);
      }
    }
  }
  return concatAudioBuffers(segments);
}

// Scale every marker's bufferSec by the same ratio that the global
// stretch factor changed by — keeps markers locked to their musical
// positions through tempo / pitch / warp changes.
export function rescaleWarpMarkers(markers: WarpMarker[] | undefined, ratio: number): WarpMarker[] | undefined {
  if (!markers || markers.length === 0) return markers;
  if (Math.abs(ratio - 1) < 1e-6) return markers;
  return markers.map((m) => ({ sourceSec: m.sourceSec, bufferSec: m.bufferSec * ratio }));
}

export function composePlayBuffer(
  track: { originalBuffer?: AudioBuffer; bpm?: number; detectedBpm?: number; warp?: boolean; pitch?: number; character?: SampleCharacter; beats?: number[]; buffer: AudioBuffer; warpMarkers?: WarpMarker[] },
  projectBpm: number,
): PlayBufferResult {
  const pitchFactor = Math.pow(2, (track.pitch || 0) / 12);
  if (!track.originalBuffer) return { buffer: track.buffer, playbackRate: pitchFactor };
  const sourceBpm = (track.bpm && track.bpm > 0) ? track.bpm : track.detectedBpm;
  const warpActive = track.warp !== false && !!sourceBpm && sourceBpm > 0 && projectBpm > 0;
  const warpFactor = warpActive ? (sourceBpm! / projectBpm) : 1;
  const baseStretch = warpFactor * pitchFactor;
  // Piecewise warp path — user has placed at least one warp marker.
  // Each segment between markers gets its own stretch factor based on
  // its target buffer length, so dragging a marker re-positions audio
  // independently of every other marker.
  if (track.warpMarkers && track.warpMarkers.length > 0) {
    try {
      const buffer = stretchWithMarkers(track.originalBuffer, track.warpMarkers, baseStretch, {
        character: track.character, beats: track.beats,
      });
      return { buffer, playbackRate: pitchFactor };
    } catch {
      // fall through to global stretch on failure
    }
  }
  // Skip WSOLA only when the stretch is imperceptible (±2 %). The
  // previous extra-extreme bail-out (< 0.4 or > 2.5) was meant to
  // dodge WSOLA artifacts at hard ratios, but a normal one-octave
  // pitch (factor 0.5 / 2.0) combined with any non-1.0 warp factor
  // would land below 0.4 and silently disable the time-stretch.
  // Result: pitching -12 with warp on doubled the audible duration
  // because only playbackRate dropped while the buffer stayed at
  // its full length. WSOLA quality degrades but doesn't break at
  // ±2-octave ratios, so trust it for the full range the user
  // would actually dial in.
  if (Math.abs(baseStretch - 1) < 0.02 || baseStretch < 0.1 || baseStretch > 10) {
    return { buffer: track.originalBuffer, playbackRate: pitchFactor };
  }
  try {
    const buffer = cachedAdaptiveStretch(track.originalBuffer, baseStretch, {
      character: track.character, beats: track.beats,
    });
    return { buffer, playbackRate: pitchFactor };
  } catch {
    return { buffer: track.originalBuffer, playbackRate: pitchFactor };
  }
}
