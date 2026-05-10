import { memo, useEffect, useRef, useState } from 'react';
import type { MidiClip } from '../../stores/midiTrackStore';

// One MIDI clip block on a MIDI lane in the arrangement.
//
// Visual: violet block with a tiny note preview drawn inside (one dot
// per note, positioned by pitch + time within the clip). Mirrors how
// drum clips render their step pattern — gives the user a sense of
// what's in the clip without opening the piano roll.
//
// Interactions handled here:
//   - Click body → onSelect (parent opens piano roll for this clip)
//   - Drag body → onMove (snapped to bar by parent)
//   - Drag right edge → onResize (length, snapped to bar by parent)
//   - Right-click → context menu (Duplicate). Delete is keyboard-only
//     to prevent accidental destructive right-clicks.
//   - dragstart on body → emits 'application/x-ghost-midi-clip' MIME so
//     the user can drag the clip to a different MIDI lane (FL-style).

export const MIDI_CLIP_DRAG_MIME = 'application/x-ghost-midi-clip';

interface Props {
  clip: MidiClip;
  arrangementDur: number;
  selected: boolean;
  laneHeight: number;
  onSelect: () => void;
  onMove: (newStartSec: number) => void;
  onResize: (newLengthSec: number) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleGhost: () => void;
  onToggleLoopSection: () => void;
  isGhost: boolean;
  isLoopedSection: boolean;
  // Convert a clientX (page coords) → project-time on this lane. The
  // parent owns the lane geometry so this gets passed in.
  xToTime: (clientX: number) => number;
}

const PREVIEW_LOW_PITCH = 36;   // C2
const PREVIEW_HIGH_PITCH = 96;  // C7

function MidiClipBlockInner({ clip, arrangementDur, selected, laneHeight, onSelect, onMove, onResize, onDelete, onDuplicate, onToggleGhost, onToggleLoopSection, isGhost, isLoopedSection, xToTime }: Props) {
  const leftPct = (clip.startSec / arrangementDur) * 100;
  const widthPct = (clip.lengthSec / arrangementDur) * 100;

  // Right-click context menu. Anchored in screen coords; window-level
  // mousedown / Escape dismiss it. Right-click no longer deletes
  // outright — that was too easy to trigger by accident.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Drag state lives in refs so re-renders during drag don't reset it.
  // Pattern matches the drum clip block — onMouseDown attaches window
  // listeners that fire onMove until mouseup.
  const dragRef = useRef<{ kind: 'move' | 'resize' | null; startClientX: number; originStart: number; originLength: number }>({
    kind: null, startClientX: 0, originStart: 0, originLength: 0,
  });

  const onBodyDown = (e: React.MouseEvent) => {
    // Right-click is handled by onContextMenu below. Bail here so the
    // pointer-down doesn't kick off a move-drag from the right button.
    if (e.button === 2) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect();
    dragRef.current = {
      kind: 'move',
      startClientX: e.clientX,
      originStart: clip.startSec,
      originLength: clip.lengthSec,
    };
    const onMouseMove = (mv: MouseEvent) => {
      const drag = dragRef.current;
      if (drag.kind !== 'move') return;
      // Map deltaX to delta-seconds. We can't just call xToTime(mv.clientX)
      // and subtract the start — that loses the original click offset
      // inside the clip. Instead, compute delta from the original click.
      const deltaX = mv.clientX - drag.startClientX;
      // The lane width is unknown locally; use xToTime of two reference
      // x's to derive seconds-per-pixel implicitly. xToTime(clientX) is
      // a linear function of clientX, so the slope is constant and we
      // can compute it once per drag.
      const t0 = xToTime(drag.startClientX);
      const t1 = xToTime(drag.startClientX + 1);
      const secPerPx = t1 - t0;
      const newStart = Math.max(0, drag.originStart + deltaX * secPerPx);
      onMove(newStart);
    };
    const onMouseUp = () => {
      dragRef.current.kind = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const onResizeDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      kind: 'resize',
      startClientX: e.clientX,
      originStart: clip.startSec,
      originLength: clip.lengthSec,
    };
    const onMouseMove = (mv: MouseEvent) => {
      const drag = dragRef.current;
      if (drag.kind !== 'resize') return;
      const deltaX = mv.clientX - drag.startClientX;
      const t0 = xToTime(drag.startClientX);
      const t1 = xToTime(drag.startClientX + 1);
      const secPerPx = t1 - t0;
      const newLen = Math.max(0.05, drag.originLength + deltaX * secPerPx);
      onResize(newLen);
    };
    const onMouseUp = () => {
      dragRef.current.kind = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // FL-style drag-out: HTML5 drag emits a MIME with the clip id so the
  // user can drop it onto a different MIDI lane and the parent moves
  // the clip there. Setting effectAllowed=move means the cursor reads
  // as a move while dragging, not a copy.
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MIDI_CLIP_DRAG_MIME, JSON.stringify({ clipId: clip.id }));
    e.dataTransfer.effectAllowed = 'move';
  };

  // Note-preview dot positions. Drawn relative to the block. Using
  // percentages so the preview stays accurate when the clip is
  // resized; the parent rect width changes naturally with widthPct.
  const previewRange = PREVIEW_HIGH_PITCH - PREVIEW_LOW_PITCH;

  return (
    <div
      data-clip-id={clip.id}
      data-midi-clip
      draggable
      onDragStart={onDragStart}
      onMouseDown={onBodyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Select the clip first so the user sees what the menu is
        // operating on, then open the menu at the click point.
        onSelect();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className="absolute top-0 cursor-grab active:cursor-grabbing rounded-md overflow-hidden"
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        height: laneHeight,
        background: selected
          ? 'linear-gradient(180deg, rgba(168,85,247,0.85) 0%, rgba(124,58,237,0.85) 100%)'
          : 'linear-gradient(180deg, rgba(124,58,237,0.7) 0%, rgba(91,33,182,0.75) 100%)',
        border: selected ? '1px solid rgba(255,255,255,0.85)' : '1px solid rgba(255,255,255,0.18)',
        boxShadow: selected ? '0 0 8px rgba(168,85,247,0.45)' : 'none',
      }}
      title="Click to edit · drag to move · right-click for options · Delete key to remove"
    >
      {/* Top label strip — clip name placeholder for now. Future: clip
          name editable via double-click. */}
      <div
        className="absolute top-0 left-0 right-0 px-1.5 py-0.5 text-[9px] font-mono text-white/85 truncate pointer-events-none flex items-center gap-1"
        style={{ background: 'rgba(0,0,0,0.25)' }}
      >
        <span className="truncate">MIDI · {clip.notes.length} {clip.notes.length === 1 ? 'note' : 'notes'}</span>
        {isGhost && (
          <span
            className="ml-auto px-1 rounded text-[8px] font-bold tracking-wider"
            style={{ background: 'rgba(255,255,255,0.20)', color: 'rgba(255,255,255,0.95)' }}
            title="Showing as ghost layer in the piano roll"
          >
            GHOST
          </span>
        )}
      </div>
      {/* Note preview — one dot per note. Ghost-green dots stand out
          on the violet body. Pitches outside the preview range get
          clamped to the edges so we never draw outside the block. */}
      {clip.notes.map((n) => {
        const xPct = (n.startSec / Math.max(0.05, clip.lengthSec)) * 100;
        const wPct = Math.max(0.5, (n.durationSec / Math.max(0.05, clip.lengthSec)) * 100);
        const clampedPitch = Math.max(PREVIEW_LOW_PITCH, Math.min(PREVIEW_HIGH_PITCH, n.pitch));
        const yPct = ((PREVIEW_HIGH_PITCH - clampedPitch) / previewRange) * 100;
        // Reserve the top 12px for the label strip — preview lives in
        // the rest of the block.
        const previewTop = 12;
        const previewHeight = laneHeight - previewTop - 2;
        return (
          <div
            key={n.id}
            className="absolute pointer-events-none"
            style={{
              left: `${xPct}%`,
              width: `${wPct}%`,
              top: previewTop + (yPct / 100) * previewHeight,
              height: 2,
              minHeight: 2,
              background: '#00FFC8',
              opacity: 0.55 + n.velocity * 0.45,
              borderRadius: 1,
            }}
          />
        );
      })}
      {/* Resize edge — rightmost 6px. Cursor flips to ew-resize on hover
          so the user knows it's a different gesture than dragging the
          body. */}
      <div
        onMouseDown={onResizeDown}
        className="absolute top-0 bottom-0 right-0 cursor-ew-resize"
        style={{ width: 6, background: 'rgba(255,255,255,0.04)' }}
        title="Drag to resize"
      />
      {menu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] min-w-[200px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{
            left: menu.x, top: menu.y,
            background: 'rgba(20, 12, 30, 0.96)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            onClick={() => { setMenu(null); onDuplicate(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-white/80 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Duplicate
          </button>
          <button
            onClick={() => { setMenu(null); onToggleLoopSection(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-white/80 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {isLoopedSection ? 'Stop looping' : 'Loop this section'}
          </button>
          <button
            onClick={() => { setMenu(null); onToggleGhost(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-white/80 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
            title="Show this clip's notes as a faded overlay in the piano roll while editing another clip"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isGhost ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
            {isGhost ? 'Hide ghost layer' : 'Show as ghost layer'}
          </button>
          <button
            onClick={() => { setMenu(null); onDelete(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(MidiClipBlockInner);
