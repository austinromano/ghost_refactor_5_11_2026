import { memo } from 'react';
import { getCtx, getMaster } from '../../stores/audio/graph';
import { pitchShiftRatio } from '../../lib/midiSchedule';

// Vertical piano keyboard, FL-Studio style. Each semitone is one row;
// white-key rows are a cream-ish surface, black-key rows draw a
// shorter/narrower black tab over the left portion of the row so the
// column reads as a real piano keyboard. Octave labels (C-1, C0, ...)
// sit on each C row. Click any row to preview the instrument at that
// pitch.

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
  // Top-to-bottom: highPitch first, lowPitch last — matches the grid.
  const keys: Array<{ pitch: number; isBlack: boolean; label: string | null }> = [];
  for (let p = highPitch; p >= lowPitch; p--) {
    keys.push({ pitch: p, isBlack: BLACK_KEY_PITCHES.has(((p % 12) + 12) % 12), label: pitchToLabel(p) });
  }

  // Black-key tab takes ~62% of the column width; the remaining strip
  // on the right keeps showing the white key behind it so the row
  // reads as part of a continuous piano.
  const blackTabWidth = Math.round(width * 0.62);

  return (
    <div
      className="shrink-0 flex flex-col select-none relative"
      style={{ width, background: '#E8E4D6', borderRight: '1px solid rgba(0,0,0,0.35)' }}
    >
      {keys.map((k) => (
        <div
          key={k.pitch}
          onMouseDown={() => previewKey(k.pitch, previewBuffer, previewBaseNote, previewVolume)}
          className="relative cursor-pointer"
          style={{
            height: pitchHeight,
            // Subtle shading line BETWEEN white keys so adjacent
            // E/F and B/C boundaries read clearly.
            borderBottom: (k.pitch % 12 === 5 || k.pitch % 12 === 0)
              ? '1px solid rgba(0,0,0,0.18)'
              : '1px solid rgba(0,0,0,0.06)',
          }}
        >
          {/* Black-key tab — only on accidentals. Slightly inset top
              and bottom so adjacent black keys don't merge into one
              vertical bar; matches how real piano keys are spaced. */}
          {k.isBlack && (
            <div
              className="absolute left-0 pointer-events-none"
              style={{
                top: 1,
                bottom: 1,
                width: blackTabWidth,
                background: '#1A1A1A',
                borderRight: '1px solid rgba(0,0,0,0.5)',
                boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.06)',
              }}
            />
          )}
          {/* Hover wash sits on top of the key surface so it works on
              both white and black halves. */}
          <div className="absolute inset-0 hover:bg-white/[0.08] transition-colors" />
          {k.label && (
            <span
              className="absolute right-1.5 top-0 text-[9px] font-mono text-black/70 leading-none pointer-events-none"
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
