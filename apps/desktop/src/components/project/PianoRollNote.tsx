import { memo } from 'react';
import type { MidiNote } from '../../stores/midiTrackStore';

// Single note rendered inside the piano-roll grid.
//
// Visual: FL-Studio style mint-green pill with a thin top highlight
// and a dark border. Selected notes get a brighter fill + outer glow
// so multi-selection reads at a glance.
//
// Geometry:
//   - left   = note.startSec * pixelsPerSecond
//   - top    = (highPitch - note.pitch) * pitchHeight
//   - width  = max(2, note.durationSec * pixelsPerSecond)
//   - height = pitchHeight - 2  (1px gap top/bottom keeps adjacent
//                                pitches visually separated)
//
// Pure presentation: all interactions (move, resize, delete, select)
// live on the parent grid's mouse handlers. That way 200 notes don't
// each install their own listeners.

interface Props {
  note: MidiNote;
  highPitch: number;
  pitchHeight: number;
  pixelsPerSecond: number;
  selected: boolean;
}

function PianoRollNoteInner({ note, highPitch, pitchHeight, pixelsPerSecond, selected }: Props) {
  const left = note.startSec * pixelsPerSecond;
  const top = (highPitch - note.pitch) * pitchHeight + 1;
  const width = Math.max(2, note.durationSec * pixelsPerSecond);
  const height = Math.max(1, pitchHeight - 2);

  // Velocity → fill brightness. Below 0.2 we still keep a usable
  // amount of saturation so the user can see + click low-velocity
  // notes; above that, opacity tracks velocity.
  const alpha = Math.max(0.55, 0.55 + note.velocity * 0.45);

  const fill = selected ? '#B8F0CB' : `rgba(132, 217, 162, ${alpha})`;
  const border = selected ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.55)';
  const topHighlight = selected ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.35)';

  return (
    <div
      data-note-id={note.id}
      className="absolute pointer-events-auto"
      style={{
        left,
        top,
        width,
        height,
        background: fill,
        border: `1px solid ${border}`,
        borderRadius: 2,
        boxShadow: selected
          ? '0 0 6px rgba(132,217,162,0.55), inset 0 1px 0 rgba(255,255,255,0.6)'
          : 'inset 0 1px 0 rgba(255,255,255,0.25)',
        // Top inner highlight — 1px line of brighter color along the
        // top edge gives the note its slight 3D pill feel. Drawn via
        // a linear-gradient so the rest of the pill stays flat.
        backgroundImage: `linear-gradient(180deg, ${topHighlight} 0%, ${topHighlight} 1px, transparent 1px, transparent 100%)`,
        backgroundColor: fill,
      }}
    />
  );
}

export default memo(PianoRollNoteInner);
