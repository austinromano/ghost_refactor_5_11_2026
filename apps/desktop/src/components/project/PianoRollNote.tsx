import { memo } from 'react';
import type { MidiNote } from '../../stores/midiTrackStore';

// Single note rendered inside the piano-roll grid.
//
// Geometry:
//   - left   = note.startSec * pixelsPerSecond
//   - top    = (highPitch - note.pitch) * pitchHeight
//   - width  = note.durationSec * pixelsPerSecond
//   - height = pitchHeight
//
// The component is purely presentational — all interactions (move,
// resize, delete, select) are handled by mouse events on the parent
// grid. That keeps note-level memo wins intact: 200 notes don't each
// install their own pointer handlers.

interface Props {
  note: MidiNote;
  highPitch: number;
  pitchHeight: number;
  pixelsPerSecond: number;
  selected: boolean;
  // Resize edge width — the inner edge that triggers a resize cursor
  // when hovered. Visual hint only; the parent grid actually owns
  // the resize logic and reads coordinates off mousedown events.
  edgeWidth?: number;
}

function PianoRollNoteInner({ note, highPitch, pitchHeight, pixelsPerSecond, selected, edgeWidth = 4 }: Props) {
  const left = note.startSec * pixelsPerSecond;
  const top = (highPitch - note.pitch) * pitchHeight;
  const width = Math.max(2, note.durationSec * pixelsPerSecond);
  const height = pitchHeight;

  // Velocity → opacity. Below 0.15 we still render at ~30% so the
  // user can see and click low-velocity notes. Above that, opacity
  // tracks velocity directly.
  const opacity = Math.max(0.3, 0.3 + note.velocity * 0.7);

  return (
    <div
      data-note-id={note.id}
      className="absolute pointer-events-auto rounded-sm"
      style={{
        left,
        top,
        width,
        height,
        background: selected
          ? 'rgba(168, 85, 247, 0.95)'
          : `rgba(124, 58, 237, ${opacity})`,
        border: selected
          ? '1px solid rgba(255,255,255,0.85)'
          : '1px solid rgba(255,255,255,0.15)',
        boxShadow: selected ? '0 0 6px rgba(168,85,247,0.6)' : 'none',
        // The "resize edge" is the rightmost ${edgeWidth}px — caller
        // detects this by checking event.offsetX >= width - edgeWidth
        // on the mousedown handler. We expose it via a CSS variable
        // so the parent can style cursors precisely if it wants to.
        ['--note-edge' as any]: `${edgeWidth}px`,
      }}
    />
  );
}

export default memo(PianoRollNoteInner);
