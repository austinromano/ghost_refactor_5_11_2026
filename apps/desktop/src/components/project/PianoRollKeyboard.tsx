import { memo } from 'react';
import { getCtx, getMaster } from '../../stores/audio/graph';
import { pitchShiftRatio } from '../../lib/midiSchedule';

// Vertical piano keyboard, MIDI-style. Pitches go HIGH at top, LOW at
// bottom — matches Ableton/Logic. Black keys are darker; octave labels
// (C-1, C0, C1...) sit on every C. Click a key to preview the
// instrument's sample at that pitch.
//
// `pitchHeight` is the pixel height of one semitone. Total component
// height = (highPitch - lowPitch + 1) * pitchHeight.

interface Props {
  lowPitch: number;
  highPitch: number;
  pitchHeight: number;
  width: number;
  // The instrument used to preview a key click. When omitted, clicking
  // a key still highlights it but plays nothing.
  previewBuffer?: AudioBuffer;
  previewBaseNote?: number;
  previewVolume?: number;
}

const BLACK_KEY_PITCHES = new Set([1, 3, 6, 8, 10]);

function pitchToLabel(pitch: number): string | null {
  // Only label C in each octave — keeps the keyboard column readable.
  // MIDI 0 = C-1, 12 = C0, 24 = C1, ... 60 = C4 (middle C).
  if (pitch % 12 !== 0) return null;
  const octave = Math.floor(pitch / 12) - 1;
  return `C${octave}`;
}

function previewKey(pitch: number, buffer?: AudioBuffer, baseNote = 60, volume = 1) {
  if (!buffer) return;
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = pitchShiftRatio(pitch, baseNote);
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g);
  g.connect(getMaster());
  src.start();
  src.onended = () => {
    try { src.disconnect(); g.disconnect(); } catch { /* ignore */ }
  };
}

function PianoRollKeyboardInner({ lowPitch, highPitch, pitchHeight, width, previewBuffer, previewBaseNote, previewVolume }: Props) {
  // Render top-to-bottom from highPitch to lowPitch so pitch ordering
  // matches what users expect from a piano roll (high notes at top).
  const keys: Array<{ pitch: number; isBlack: boolean; label: string | null }> = [];
  for (let p = highPitch; p >= lowPitch; p--) {
    keys.push({ pitch: p, isBlack: BLACK_KEY_PITCHES.has(p % 12), label: pitchToLabel(p) });
  }

  return (
    <div
      className="shrink-0 flex flex-col select-none"
      style={{ width, background: 'rgba(255,255,255,0.02)', borderRight: '1px solid rgba(255,255,255,0.08)' }}
    >
      {keys.map((k) => (
        <div
          key={k.pitch}
          onMouseDown={() => previewKey(k.pitch, previewBuffer, previewBaseNote, previewVolume)}
          className="relative cursor-pointer hover:bg-white/[0.06] transition-colors"
          style={{
            height: pitchHeight,
            background: k.isBlack ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.015)',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          {k.label && (
            <span
              className="absolute right-1.5 top-0 text-[9px] font-mono text-white/40 leading-none"
              style={{ lineHeight: `${pitchHeight}px` }}
            >
              {k.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default memo(PianoRollKeyboardInner);
