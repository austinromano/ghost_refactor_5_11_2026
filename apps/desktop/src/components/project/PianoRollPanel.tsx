import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useMidiTrack, type MidiNote } from '../../stores/midiTrackStore';
import { useAudioStore } from '../../stores/audioStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { sendSessionAction } from '../../lib/socket';
import PianoRollKeyboard from './PianoRollKeyboard';
import PianoRollNote from './PianoRollNote';
import VelocityLane from './VelocityLane';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';

// Piano-roll panel. Sits at the bottom of the arrangement column,
// parallel to DrumRackPanel. v1 manages its own internal MIDI track
// list — full project-track integration lands in phase 4 alongside
// arrangement-timeline rendering.
//
// Interactions wired in this build:
//   - Click empty grid → paint a new note at click position. Drag
//     before mouseup to set initial duration.
//   - Click existing note → select that note (others deselect).
//   - Shift-click existing note → toggle in multi-selection.
//   - Drag note body → move (pitch + time, both snap to grid).
//   - Drag rightmost ~6px of note → resize duration.
//   - Delete / Backspace → remove every selected note.
//   - Right-click note → delete that note (no selection needed).
//   - Drop audio file / sample-library item on the track header
//     → set the track's instrument (sample to pitch-shift).
//
// Phase 3 will add: marquee select, copy/paste, transpose w/ arrow
// keys, multi-track switching.

const DEFAULT_TRACK_ID = 'midi-track-1';
const DEFAULT_CLIP_LENGTH_BARS = 4;
const PITCH_HEIGHT = 14;             // px per semitone
const KEYBOARD_WIDTH = 60;
const HEADER_HEIGHT = 36;
const VELOCITY_HEIGHT = 70;
const PIXELS_PER_BAR = 200;
const SNAP_OPTIONS: Array<{ label: string; div: number }> = [
  { label: '1/4', div: 4 },
  { label: '1/8', div: 8 },
  { label: '1/16', div: 16 },
  { label: '1/32', div: 32 },
  { label: 'Off', div: 0 },
];

interface Props {
  projectId: string;
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'paint'; noteId: string; startX: number; pitch: number }
  | { kind: 'move'; noteIds: string[]; originX: number; originY: number; originStarts: Map<string, number>; originPitches: Map<string, number> }
  | { kind: 'resize'; noteId: string; originX: number; originDuration: number };

/**
 * Floating toggle button that opens the piano roll panel. Renders only
 * while the panel is closed so the two pieces don't visually fight —
 * the panel itself owns the ✕ to close. Sits in the bottom-right corner
 * of the arrangement column so it's discoverable without occupying any
 * permanent UI space.
 *
 * Phase 4 will replace this with proper MIDI-track / MIDI-clip entry
 * points in the arrangement (clicking a MIDI clip opens the roll, just
 * like clicking a drum clip opens the rack today).
 */
export function PianoRollOpenButton() {
  const open = useMidiTrack((s) => s.open);
  const setOpen = useMidiTrack((s) => s.setOpen);
  if (open) return null;
  return (
    <button
      onClick={() => setOpen(true)}
      className="absolute bottom-3 right-3 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-white shadow-lg transition-all hover:scale-[1.02]"
      style={{ background: 'linear-gradient(180deg, #9333EA 0%, #6B21A8 100%)', boxShadow: '0 4px 12px rgba(147,51,234,0.4)' }}
      title="Open piano roll"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="1" />
        <line x1="6" y1="6" x2="6" y2="14" />
        <line x1="10" y1="6" x2="10" y2="14" />
        <line x1="14" y1="6" x2="14" y2="14" />
        <line x1="18" y1="6" x2="18" y2="14" />
      </svg>
      Piano Roll
    </button>
  );
}

export default function PianoRollPanel({ projectId }: Props) {
  const open = useMidiTrack((s) => s.open);
  const setOpen = useMidiTrack((s) => s.setOpen);
  const panelHeight = useMidiTrack((s) => s.panelHeight);
  const setPanelHeight = useMidiTrack((s) => s.setPanelHeight);

  const instruments = useMidiTrack((s) => s.instruments);
  const clips = useMidiTrack((s) => s.clips);
  const selectedClipId = useMidiTrack((s) => s.selectedClipId);
  const ensureInstrument = useMidiTrack((s) => s.ensureInstrument);
  const setInstrument = useMidiTrack((s) => s.setInstrument);
  const setBaseNote = useMidiTrack((s) => s.setBaseNote);
  const createClipAt = useMidiTrack((s) => s.createClipAt);
  const selectClip = useMidiTrack((s) => s.selectClip);
  const deleteClip = useMidiTrack((s) => s.deleteClip);
  const addNote = useMidiTrack((s) => s.addNote);
  const deleteNotes = useMidiTrack((s) => s.deleteNotes);
  const moveNote = useMidiTrack((s) => s.moveNote);
  const resizeNote = useMidiTrack((s) => s.resizeNote);
  const startScheduler = useMidiTrack((s) => s.startScheduler);
  const stopScheduler = useMidiTrack((s) => s.stopScheduler);
  const loadForProject = useMidiTrack((s) => s.loadForProject);

  const projectBpm = useAudioStore((s) => s.projectBpm > 0 ? s.projectBpm : 120);
  const isPlaying = useAudioStore((s) => s.isPlaying);

  // --- Lifecycle: load state, start/stop scheduler -----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadForProject(projectId);
      if (cancelled) return;
      try { sendSessionAction(projectId, { type: 'midi.request-state' }); } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [projectId, loadForProject]);

  useEffect(() => {
    if (isPlaying) startScheduler(projectId);
    else stopScheduler();
    return () => { stopScheduler(); };
  }, [isPlaying, projectId, startScheduler, stopScheduler]);

  // --- Default track + clip ----------------------------------------
  // First time the panel opens, make sure there's a track and a clip
  // to edit. Without this the user clicks "open" and sees an empty
  // panel with no obvious action.
  useEffect(() => {
    if (!open) return;
    ensureInstrument(DEFAULT_TRACK_ID);
    const existing = clips.find((c) => c.trackId === DEFAULT_TRACK_ID);
    if (!existing) {
      const barSec = 240 / projectBpm;
      const lengthSec = DEFAULT_CLIP_LENGTH_BARS * barSec;
      const id = createClipAt(DEFAULT_TRACK_ID, 0, lengthSec);
      selectClip(id);
    } else if (!selectedClipId) {
      selectClip(existing.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selectedClipId) ?? null,
    [clips, selectedClipId],
  );
  const instrument = selectedClip ? instruments[selectedClip.trackId] : undefined;

  // --- Geometry ----------------------------------------------------
  // Pitch range — show a 4-octave window centered on C3..C5. User can
  // scroll the grid container vertically to see other ranges.
  const lowPitch = 24;   // C1
  const highPitch = 96;  // C7
  const totalPitches = highPitch - lowPitch + 1;
  const gridHeight = totalPitches * PITCH_HEIGHT;

  const barSec = 240 / projectBpm;
  const pixelsPerSecond = PIXELS_PER_BAR / barSec;
  const clipLengthSec = selectedClip?.lengthSec ?? 0;
  const gridWidth = Math.max(800, clipLengthSec * pixelsPerSecond);

  // --- Selection + drag --------------------------------------------
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snapDiv, setSnapDiv] = useState(16);
  const dragRef = useRef<DragState>({ kind: 'idle' });
  const gridRef = useRef<HTMLDivElement>(null);

  const snap = useCallback((sec: number): number => {
    if (snapDiv <= 0) return Math.max(0, sec);
    const stepSec = barSec / snapDiv;
    return Math.max(0, Math.round(sec / stepSec) * stepSec);
  }, [snapDiv, barSec]);

  // Translate (x, y) within the grid to (timeSec, pitch).
  const xyToNote = useCallback((x: number, y: number) => {
    const sec = x / pixelsPerSecond;
    const pitch = highPitch - Math.floor(y / PITCH_HEIGHT);
    return { sec, pitch };
  }, [pixelsPerSecond, highPitch]);

  // --- Grid mouse handlers ----------------------------------------
  const onGridMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedClip || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const target = (e.target as HTMLElement);
    const noteId = target.dataset.noteId;

    if (noteId) {
      // Click on existing note — select / move / resize.
      const note = selectedClip.notes.find((n) => n.id === noteId);
      if (!note) return;
      // Right-click anywhere on a note → delete.
      if (e.button === 2) {
        e.preventDefault();
        deleteNotes(selectedClip.id, [noteId]);
        setSelectedIds((s) => {
          const next = new Set(s); next.delete(noteId); return next;
        });
        return;
      }

      // Detect resize edge — rightmost ~6px of the note rect.
      const noteLeft = note.startSec * pixelsPerSecond;
      const noteWidth = Math.max(2, note.durationSec * pixelsPerSecond);
      const offsetX = x - noteLeft;
      if (offsetX > noteWidth - 6) {
        dragRef.current = {
          kind: 'resize',
          noteId,
          originX: x,
          originDuration: note.durationSec,
        };
        if (!selectedIds.has(noteId)) setSelectedIds(new Set([noteId]));
        return;
      }

      // Body click — select (and prepare to move).
      let nextSel: Set<string>;
      if (e.shiftKey) {
        nextSel = new Set(selectedIds);
        if (nextSel.has(noteId)) nextSel.delete(noteId); else nextSel.add(noteId);
      } else if (selectedIds.has(noteId)) {
        // Already selected — preserve the selection so we can move
        // every selected note together.
        nextSel = new Set(selectedIds);
      } else {
        nextSel = new Set([noteId]);
      }
      setSelectedIds(nextSel);

      const originStarts = new Map<string, number>();
      const originPitches = new Map<string, number>();
      for (const id of nextSel) {
        const n = selectedClip.notes.find((nn) => nn.id === id);
        if (!n) continue;
        originStarts.set(id, n.startSec);
        originPitches.set(id, n.pitch);
      }
      dragRef.current = {
        kind: 'move',
        noteIds: Array.from(nextSel),
        originX: x,
        originY: y,
        originStarts,
        originPitches,
      };
      return;
    }

    // Click on empty grid — paint a new note at the snapped position.
    const { sec, pitch } = xyToNote(x, y);
    const startSec = snap(sec);
    const stepSec = snapDiv > 0 ? barSec / snapDiv : 0.25;
    const newId = addNote(selectedClip.id, {
      pitch,
      startSec,
      durationSec: stepSec,
      velocity: 0.85,
    });
    setSelectedIds(new Set([newId]));
    dragRef.current = {
      kind: 'paint',
      noteId: newId,
      startX: x,
      pitch,
    };
  }, [selectedClip, selectedIds, pixelsPerSecond, xyToNote, snap, snapDiv, barSec, addNote, deleteNotes]);

  const onGridMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedClip || !gridRef.current || dragRef.current.kind === 'idle') return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const drag = dragRef.current;

    if (drag.kind === 'paint') {
      // Extend the painted note's duration as the user drags right.
      const note = selectedClip.notes.find((n) => n.id === drag.noteId);
      if (!note) return;
      const wantSec = (x - drag.startX) / pixelsPerSecond + (snapDiv > 0 ? barSec / snapDiv : 0.25);
      const stepSec = snapDiv > 0 ? barSec / snapDiv : 0.05;
      const snapped = Math.max(stepSec, Math.round(wantSec / stepSec) * stepSec);
      resizeNote(selectedClip.id, drag.noteId, snapped);
    } else if (drag.kind === 'resize') {
      const dx = x - drag.originX;
      const wantSec = drag.originDuration + dx / pixelsPerSecond;
      const stepSec = snapDiv > 0 ? barSec / snapDiv : 0.01;
      const snapped = Math.max(stepSec, Math.round(wantSec / stepSec) * stepSec);
      resizeNote(selectedClip.id, drag.noteId, snapped);
    } else if (drag.kind === 'move') {
      const dx = x - drag.originX;
      const dy = y - drag.originY;
      const dSec = dx / pixelsPerSecond;
      const dPitch = -Math.round(dy / PITCH_HEIGHT);
      for (const id of drag.noteIds) {
        const baseStart = drag.originStarts.get(id) ?? 0;
        const basePitch = drag.originPitches.get(id) ?? 60;
        const newStart = snap(baseStart + dSec);
        moveNote(selectedClip.id, id, newStart, basePitch + dPitch);
      }
    }
  }, [selectedClip, pixelsPerSecond, barSec, snapDiv, snap, moveNote, resizeNote]);

  const onGridMouseUp = useCallback(() => {
    dragRef.current = { kind: 'idle' };
  }, []);

  // --- Keyboard shortcuts ------------------------------------------
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Only react when the user isn't typing in an input field.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!selectedClip) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        deleteNotes(selectedClip.id, Array.from(selectedIds));
        setSelectedIds(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selectedClip, selectedIds, deleteNotes]);

  // --- Sample drop on the track header -----------------------------
  const onHeaderDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!selectedClip) return;
    const trackId = selectedClip.trackId;

    // OS file drop.
    const file = e.dataTransfer.files?.[0];
    if (file && /audio|wav|mp3|flac|aiff|ogg|m4a|aac/i.test(file.type + file.name)) {
      try {
        const arr = await file.arrayBuffer();
        const buffer = await getCtx().decodeAudioData(arr.slice(0));
        const name = file.name.replace(/\.[^.]+$/, '');
        const { fileId } = await api.uploadFile(projectId, file);
        setInstrument(trackId, name, buffer, fileId);
      } catch { /* user can retry */ }
      return;
    }

    // Sample library drag.
    const libRaw = e.dataTransfer.getData(SAMPLE_LIBRARY_DRAG_MIME);
    if (libRaw) {
      try {
        const lib = JSON.parse(libRaw) as { id: string; name: string };
        const arr = await api.downloadSampleLibraryAudio(lib.id);
        const buffer = await getCtx().decodeAudioData(arr.slice(0));
        const name = lib.name.replace(/\.[^.]+$/, '');
        const ext = lib.name.match(/\.[a-z0-9]+$/i)?.[0] || '.wav';
        const fileName = lib.name.endsWith(ext) ? lib.name : `${name}${ext}`;
        const fakeFile = new File([arr], fileName, { type: 'audio/wav' });
        const { fileId } = await api.uploadFile(projectId, fakeFile);
        setInstrument(trackId, name, buffer, fileId);
      } catch { /* user can retry */ }
      return;
    }

    // Project file drop (drag from arrangement / project).
    const projRaw = e.dataTransfer.getData('application/x-ghost-projectfile');
    if (projRaw) {
      try {
        const meta = JSON.parse(projRaw) as { id: string; name: string };
        const cached = audioBufferCache.get(meta.id);
        const buffer = cached ?? (await getAudioData(projectId, meta.id)).buffer;
        setInstrument(trackId, meta.name.replace(/\.[^.]+$/, ''), buffer, meta.id);
      } catch { /* ignore */ }
    }
  }, [selectedClip, projectId, setInstrument]);

  // --- Bar / beat grid lines ---------------------------------------
  const gridLines = useMemo(() => {
    if (!selectedClip) return [] as Array<{ x: number; bold: boolean }>;
    const lines: Array<{ x: number; bold: boolean }> = [];
    const stepDur = snapDiv > 0 ? barSec / snapDiv : barSec / 4;
    const stepCount = Math.ceil(selectedClip.lengthSec / stepDur);
    for (let i = 0; i <= stepCount; i++) {
      const sec = i * stepDur;
      lines.push({ x: sec * pixelsPerSecond, bold: i % (snapDiv || 4) === 0 });
    }
    return lines;
  }, [selectedClip, snapDiv, barSec, pixelsPerSecond]);

  // Octave / black-key band rendering for the grid background.
  // Highlights C rows + black keys so the user can read pitches at a
  // glance without the keyboard column being fully visible.
  const pitchBands = useMemo(() => {
    const bands: Array<{ y: number; isC: boolean; isBlack: boolean }> = [];
    for (let p = highPitch; p >= lowPitch; p--) {
      const y = (highPitch - p) * PITCH_HEIGHT;
      bands.push({ y, isC: p % 12 === 0, isBlack: [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12) });
    }
    return bands;
  }, [lowPitch, highPitch]);

  // --- Live playhead position --------------------------------------
  const currentTime = useAudioStore((s) => s.currentTime);
  let playheadX: number | null = null;
  if (selectedClip && isPlaying && currentTime >= selectedClip.startSec
      && currentTime < selectedClip.startSec + selectedClip.lengthSec) {
    playheadX = (currentTime - selectedClip.startSec) * pixelsPerSecond;
  }

  if (!open) return null;

  return (
    <div
      className="w-full flex flex-col select-none"
      style={{ height: panelHeight, background: 'rgba(10,4,18,0.97)', borderTop: '1px solid rgba(255,255,255,0.08)' }}
    >
      {/* Resize handle */}
      <div
        className="w-full cursor-ns-resize"
        style={{ height: 4, background: 'rgba(255,255,255,0.05)' }}
        onPointerDown={(e) => {
          const startY = e.clientY;
          const startH = panelHeight;
          const onMove = (mv: PointerEvent) => setPanelHeight(startH - (mv.clientY - startY));
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }}
      />

      {/* Header */}
      <div
        className="flex items-center gap-2 px-3"
        style={{ height: HEADER_HEIGHT, background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={onHeaderDrop}
      >
        <span className="text-[12px] font-semibold text-white/80">Piano Roll</span>
        <span className="text-white/30">·</span>
        <span className="text-[11px] text-white/60">
          {instrument?.fileId ? instrument.name : 'Drop a sample here →'}
        </span>
        {instrument?.fileId && (
          <>
            <span className="text-white/20">·</span>
            <label className="text-[11px] text-white/50 flex items-center gap-1">
              base
              <input
                type="number"
                min={0}
                max={127}
                value={instrument.baseNote}
                onChange={(e) => setBaseNote(selectedClip!.trackId, parseInt(e.target.value, 10) || 60)}
                className="w-12 bg-white/[0.04] border border-white/[0.08] rounded px-1 py-0.5 text-white/80 text-[11px]"
              />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[11px] text-white/50 flex items-center gap-1">
            snap
            <select
              value={snapDiv}
              onChange={(e) => setSnapDiv(parseInt(e.target.value, 10))}
              className="bg-white/[0.04] border border-white/[0.08] rounded px-1 py-0.5 text-white/80 text-[11px]"
            >
              {SNAP_OPTIONS.map((s) => (
                <option key={s.div} value={s.div}>{s.label}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setOpen(false)}
            className="text-white/50 hover:text-white text-[11px] px-1.5"
            title="Close piano roll"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body: keyboard | grid | velocity (one shared scroll) */}
      <div className="flex-1 min-h-0 flex">
        <PianoRollKeyboard
          lowPitch={lowPitch}
          highPitch={highPitch}
          pitchHeight={PITCH_HEIGHT}
          width={KEYBOARD_WIDTH}
          previewBuffer={instrument?.buffer}
          previewBaseNote={instrument?.baseNote}
          previewVolume={instrument?.volume}
        />

        <div className="flex-1 flex flex-col min-w-0">
          {/* Note grid */}
          <div
            ref={gridRef}
            className="flex-1 relative overflow-auto"
            onMouseDown={onGridMouseDown}
            onMouseMove={onGridMouseMove}
            onMouseUp={onGridMouseUp}
            onMouseLeave={onGridMouseUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="relative" style={{ width: gridWidth, height: gridHeight }}>
              {/* Pitch bands (alternating black/white) */}
              {pitchBands.map((b, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 pointer-events-none"
                  style={{
                    top: b.y,
                    height: PITCH_HEIGHT,
                    background: b.isBlack ? 'rgba(0,0,0,0.18)' : 'transparent',
                    borderBottom: b.isC ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(255,255,255,0.02)',
                  }}
                />
              ))}
              {/* Time grid lines */}
              {gridLines.map((l, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{
                    left: l.x,
                    width: 1,
                    background: l.bold ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)',
                  }}
                />
              ))}
              {/* Notes */}
              {selectedClip?.notes.map((n) => (
                <PianoRollNote
                  key={n.id}
                  note={n}
                  highPitch={highPitch}
                  pitchHeight={PITCH_HEIGHT}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={selectedIds.has(n.id)}
                />
              ))}
              {/* Playhead */}
              {playheadX !== null && (
                <div
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{
                    left: playheadX,
                    width: 2,
                    background: '#00FFC8',
                    boxShadow: '0 0 6px rgba(0,255,200,0.5)',
                  }}
                />
              )}
            </div>
          </div>

          {/* Velocity lane below the grid */}
          {selectedClip && (
            <div className="relative" style={{ width: gridWidth }}>
              <VelocityLane
                clipId={selectedClip.id}
                notes={selectedClip.notes}
                selectedNoteIds={selectedIds}
                pixelsPerSecond={pixelsPerSecond}
                height={VELOCITY_HEIGHT}
              />
            </div>
          )}
        </div>
      </div>

      {/* Empty state hint when no instrument */}
      {selectedClip && !instrument?.buffer && (
        <div className="absolute pointer-events-none flex items-center justify-center" style={{ top: HEADER_HEIGHT + 4, left: KEYBOARD_WIDTH + 12, right: 12 }}>
          <span className="text-[11px] text-white/40">
            Drag a sample onto the header above to set the instrument →
          </span>
        </div>
      )}
    </div>
  );
}
