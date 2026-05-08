import { memo } from 'react';
import type { MidiNote } from '../../stores/midiTrackStore';

// Single note rendered inside the piano-roll grid.
//
// Visual: violet pill matching the app's MIDI track color
// (#7C3AED — same as the `midiTrack` token). Notes get a thin top
// highlight + dark border so they read clearly on the dark purple
// grid. Selected notes go brighter (#A855F7) with an outer glow.
//
// Geometry:
//   - left   = note.startSec * pixelsPerSecond
//   - top    = (highPitch - note.pitch) * pitchHeight + 1
//   - width  = max(2, note.durationSec * pixelsPerSecond)
//   - height = max(1, pitchHeight - 2)  (1px gap top/bottom keeps
//                                        adjacent pitches visually
//                                        separated)
//
// Pure presentation — interactions live on the parent grid.

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

  // Velocity → fill brightness. Below 0.2 we still keep usable
  // saturation so the user can see + click low-velocity notes;
  // above that, opacity tracks velocity directly.
  const alpha = Math.max(0.6, 0.6 + note.velocity * 0.4);

  const fill = selected ? '#A855F7' : `rgba(124, 58, 237, ${alpha})`;
  const border = selected ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.7)';
  const topHighlight = selected ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)';

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
        backgroundImage: `linear-gradient(180deg, ${topHighlight} 0%, ${topHighlight} 1px, transparent 1px, transparent 100%)`,
        backgroundColor: fill,
        border: `1px solid ${border}`,
        borderRadius: 2,
        boxShadow: selected
          ? '0 0 6px rgba(168,85,247,0.55), inset 0 1px 0 rgba(255,255,255,0.6)'
          : 'inset 0 1px 0 rgba(255,255,255,0.25)',
      }}
    />
  );
}

export default memo(PianoRollNoteInner);
