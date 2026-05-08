import { useRef, useCallback } from 'react';
import type { MidiNote } from '../../stores/midiTrackStore';
import { useMidiTrack } from '../../stores/midiTrackStore';

// Velocity lane below the piano roll grid. FL-Studio style: each note
// is a thin vertical "stem" rising from the bottom of the lane to
// (1 - velocity * height), capped with a small filled circle. Drag the
// circle (or anywhere along the stem's column) to set velocity.

interface Props {
  clipId: string;
  notes: MidiNote[];
  selectedNoteIds: Set<string>;
  pixelsPerSecond: number;
  height: number;
  // Velocity lane scrolls with the grid horizontally. We render it
  // as a wide div inside an externally-managed scroll container so
  // its left edge always tracks the grid's scroll offset.
  width: number;
}

const HIT_RADIUS = 6; // px column tolerance for picking the closest stem

export default function VelocityLane({ clipId, notes, selectedNoteIds, pixelsPerSecond, height, width }: Props) {
  const setVelocity = useMidiTrack((s) => s.setNoteVelocity);
  const ref = useRef<HTMLDivElement>(null);
  // Keep editing the same note across the whole drag — once a stem
  // is picked, the user can move the pointer freely without snapping
  // to a different stem mid-gesture.
  const scrubbingRef = useRef<string | null>(null);

  const pickAt = useCallback((x: number): MidiNote | null => {
    let pick: MidiNote | null = null;
    let bestDist = Infinity;
    for (const n of notes) {
      const bx = n.startSec * pixelsPerSecond;
      const d = Math.abs(x - bx);
      if (d < bestDist && d <= HIT_RADIUS) { bestDist = d; pick = n; }
    }
    return pick;
  }, [notes, pixelsPerSecond]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pick = pickAt(x);
    if (!pick) return;
    scrubbingRef.current = pick.id;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / height));
    setVelocity(clipId, pick.id, v);
  }, [pickAt, height, clipId, setVelocity]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / height));
    setVelocity(clipId, scrubbingRef.current, v);
  }, [height, clipId, setVelocity]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    scrubbingRef.current = null;
  }, []);

  // Background grid: thin horizontal mid-line at 50% velocity makes
  // it easy to eyeball whether a note is above or below the default.
  return (
    <div
      ref={ref}
      className="relative select-none cursor-ns-resize"
      style={{
        width,
        height,
        background: '#243140',
        borderTop: '1px solid rgba(0,0,0,0.55)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Mid-line at 50% velocity — pure visual reference. */}
      <div
        className="absolute left-0 right-0 pointer-events-none"
        style={{ top: height / 2, height: 1, background: 'rgba(255,255,255,0.04)' }}
      />
      {notes.map((n) => {
        const x = n.startSec * pixelsPerSecond;
        const stemTop = (1 - n.velocity) * height;
        const stemHeight = height - stemTop;
        const isSel = selectedNoteIds.has(n.id);
        const stemColor = isSel ? '#B8F0CB' : '#84D9A2';
        return (
          <div key={n.id} className="absolute pointer-events-none" style={{ left: x - 1, top: stemTop, width: 2, height: stemHeight }}>
            {/* Stem */}
            <div
              className="absolute left-0 top-0 w-full h-full"
              style={{ background: stemColor, opacity: 0.85 }}
            />
            {/* Lollipop head — small filled circle at the top of the
                stem. Sits 3px tall * 6px wide so it reads as a circle
                without overlapping neighbouring stems. */}
            <div
              className="absolute"
              style={{
                left: -2,
                top: -3,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: stemColor,
                border: '1px solid rgba(0,0,0,0.55)',
                boxShadow: isSel ? '0 0 4px rgba(184,240,203,0.6)' : 'none',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
