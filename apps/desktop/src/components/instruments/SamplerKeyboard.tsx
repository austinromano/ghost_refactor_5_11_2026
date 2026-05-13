import { useState } from 'react';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { getCtx } from '../../stores/audio/graph';
import { getMidiTrackBus } from '../../stores/audio/midiFxBus';
import { pitchShiftRatio } from '../../lib/midiSchedule';

// One semitone block in the mini keyboard at the bottom — enough to
// preview an octave and a half so the user can hear the patch across
// the keyboard without loading the piano roll.
const KEYBOARD_LOW = 48;  // C3
const KEYBOARD_HIGH = 84; // C6
const KEYBOARD_H = 30;

// ---- Click-to-preview keyboard at the bottom -----------------------

export function SamplerKeyboardStrip({ inst, trackId }: { inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined; trackId: string }) {
  const [hovering, setHovering] = useState<number | null>(null);
  const previewKey = (pitch: number) => {
    if (!inst?.buffer) return;
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = inst.buffer;
    src.playbackRate.value = pitchShiftRatio(pitch, inst.baseNote);
    const g = ctx.createGain();
    g.gain.value = inst.volume;
    src.connect(g);
    // Route preview through the same FX bus the scheduler uses, so
    // turning on EQ / Comp / Reverb on the track is audible in the
    // keyboard preview too.
    g.connect(getMidiTrackBus(trackId));
    const startBufSec = inst.startOffset * inst.buffer.duration;
    const endBufSec = inst.endOffset * inst.buffer.duration;
    src.start(0, startBufSec);
    src.stop(ctx.currentTime + (endBufSec - startBufSec) / src.playbackRate.value + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  };

  const keys: Array<{ pitch: number; isBlack: boolean; label: string | null }> = [];
  const blackPitches = new Set([1, 3, 6, 8, 10]);
  for (let p = KEYBOARD_LOW; p <= KEYBOARD_HIGH; p++) {
    keys.push({
      pitch: p,
      isBlack: blackPitches.has(((p % 12) + 12) % 12),
      label: p % 12 === 0 ? `C${Math.floor(p / 12) - 1}` : null,
    });
  }

  // White-key count for layout — black keys overlay between adjacent
  // white keys at half-width.
  const whiteKeys = keys.filter((k) => !k.isBlack);

  return (
    <div
      className="shrink-0 flex-1 relative"
      style={{ minHeight: KEYBOARD_H, background: '#0A0414' }}
    >
      <div className="absolute inset-0 flex">
        {whiteKeys.map((k, i) => (
          <div
            key={k.pitch}
            onMouseDown={() => previewKey(k.pitch)}
            onMouseEnter={() => setHovering(k.pitch)}
            onMouseLeave={() => setHovering((h) => (h === k.pitch ? null : h))}
            className="flex-1 relative cursor-pointer"
            style={{
              background: hovering === k.pitch ? '#E0DCC8' : '#E8E4D6',
              borderRight: i < whiteKeys.length - 1 ? '1px solid rgba(0,0,0,0.25)' : 'none',
            }}
          >
            {k.label && (
              <span
                className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-mono text-black/55 pointer-events-none"
              >
                {k.label}
              </span>
            )}
          </div>
        ))}
      </div>
      {/* Black keys overlay — positioned proportionally to the white-key
          flex layout. Each black key sits between two adjacent whites
          and gets ~60% of a white-key's width. */}
      <div className="absolute inset-0 pointer-events-none">
        {keys.map((k) => {
          if (!k.isBlack) return null;
          // Compute the % position of the black key. It sits AT the
          // boundary between the previous white key and this one's
          // hosting white, so we count how many white keys came
          // before it and offset by half a white-key width.
          const whitesBefore = keys
            .slice(0, keys.indexOf(k))
            .filter((kk) => !kk.isBlack).length;
          const pct = (whitesBefore / whiteKeys.length) * 100;
          const widthPct = (1 / whiteKeys.length) * 60;
          return (
            <div
              key={k.pitch}
              onMouseDown={(e) => { e.preventDefault(); previewKey(k.pitch); }}
              onMouseEnter={() => setHovering(k.pitch)}
              onMouseLeave={() => setHovering((h) => (h === k.pitch ? null : h))}
              className="absolute top-0 cursor-pointer pointer-events-auto"
              style={{
                left: `calc(${pct}% - ${widthPct / 2}%)`,
                width: `${widthPct}%`,
                height: '60%',
                background: hovering === k.pitch ? '#1F1F1F' : '#0E0E0E',
                borderRadius: '0 0 2px 2px',
                boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.4)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
