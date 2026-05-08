import { useRef, useCallback } from 'react';
import type { MidiNote } from '../../stores/midiTrackStore';
import { useMidiTrack } from '../../stores/midiTrackStore';

// Velocity lane below the piano roll grid. One vertical bar per note,
// height = velocity * laneHeight. Drag a bar's top to set its
// velocity; matches Ableton's behavior. Selected notes get the
// brighter chip color so the user can see which bars belong to a
// multi-selection.

interface Props {
  clipId: string;
  notes: MidiNote[];
  selectedNoteIds: Set<string>;
  pixelsPerSecond: number;
  height: number;
}

const BAR_WIDTH = 4;

export default function VelocityLane({ clipId, notes, selectedNoteIds, pixelsPerSecond, height }: Props) {
  const setVelocity = useMidiTrack((s) => s.setNoteVelocity);
  const ref = useRef<HTMLDivElement>(null);
  // Track which note we're scrubbing so a drag past the bar's column
  // keeps editing the same note (matches Ableton — the velocity drag
  // doesn't snap to a different bar mid-gesture).
  const scrubbingRef = useRef<string | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Find the closest note bar under the pointer. Use a generous hit
    // radius (BAR_WIDTH + 2) so single-pixel hits aren't fiddly.
    let pick: MidiNote | null = null;
    let bestDist = Infinity;
    for (const n of notes) {
      const bx = n.startSec * pixelsPerSecond;
      const d = Math.abs(x - bx);
      if (d < bestDist && d <= BAR_WIDTH + 4) { bestDist = d; pick = n; }
    }
    if (!pick) return;
    scrubbingRef.current = pick.id;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Map y → velocity. y=0 is top (max velocity), y=height is bottom.
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / height));
    setVelocity(clipId, pick.id, v);
  }, [notes, pixelsPerSecond, height, clipId, setVelocity]);

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

  return (
    <div
      ref={ref}
      className="relative w-full select-none cursor-ns-resize"
      style={{ height, background: 'rgba(0,0,0,0.25)', borderTop: '1px solid rgba(255,255,255,0.06)' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {notes.map((n) => {
        const left = n.startSec * pixelsPerSecond;
        const barH = n.velocity * height;
        const isSel = selectedNoteIds.has(n.id);
        return (
          <div
            key={n.id}
            className="absolute bottom-0 pointer-events-none"
            style={{
              left,
              width: BAR_WIDTH,
              height: barH,
              background: isSel ? 'rgba(168,85,247,0.95)' : 'rgba(124,58,237,0.7)',
              borderTop: '1px solid rgba(255,255,255,0.6)',
            }}
          />
        );
      })}
    </div>
  );
}
