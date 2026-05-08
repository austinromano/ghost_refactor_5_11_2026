import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { useAudioStore } from '../../stores/audioStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { sendSessionAction } from '../../lib/socket';
import PianoRollKeyboard from './PianoRollKeyboard';
import PianoRollNote from './PianoRollNote';
import VelocityLane from './VelocityLane';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';

// Piano-roll panel — FL-Studio styled. Sits at the bottom of the
// arrangement column, parallel to DrumRackPanel. v1 manages its own
// internal MIDI track list; project-track integration lands in
// phase 4 alongside arrangement-timeline rendering.
//
// Layout:
//   resize-handle 4px
//   header        36px      (sample drop + base note + snap + close)
//   ruler-row     22px      (bar numbers, scrolls with grid horizontally)
//   grid-area     flex      (keyboard left, notes right; both scroll v+h)
//   velocity-row  70px      (lollipop velocity, scrolls with grid h)
//
// The three horizontally-scrolling rows (ruler, grid, velocity) sync
// their scrollLeft so the bars stay aligned at every column. Vertical
// scroll lives inside grid-area only — the velocity lane is anchored
// to the bottom regardless of pitch scroll.

/**
 * Floating toggle button that opens the piano roll panel. Renders
 * only while the panel is closed so the two pieces don't visually
 * fight — the panel itself owns the ✕ to close.
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

const DEFAULT_TRACK_ID = 'midi-track-1';
const DEFAULT_CLIP_LENGTH_BARS = 4;
const PITCH_HEIGHT = 14;
const KEYBOARD_WIDTH = 60;
const HEADER_HEIGHT = 36;
const RULER_HEIGHT = 22;
const VELOCITY_HEIGHT = 70;
const PIXELS_PER_BAR = 200;
const BLACK_KEY_PITCHES = new Set([1, 3, 6, 8, 10]);
const SNAP_OPTIONS: Array<{ label: string; div: number }> = [
  { label: '1/4', div: 4 },
  { label: '1/8', div: 8 },
  { label: '1/16', div: 16 },
  { label: '1/32', div: 32 },
  { label: 'Off', div: 0 },
];

// FL-style color tokens — kept inline because they're tightly coupled
// to the piano roll's visual identity. Other parts of the app use
// the shared token system.
const COLOR_BG = '#2A3848';
const COLOR_BG_BLACKROW = 'rgba(0,0,0,0.18)';
const COLOR_GRID_LINE = 'rgba(255,255,255,0.05)';
const COLOR_GRID_BAR = 'rgba(255,255,255,0.18)';
const COLOR_GRID_C = 'rgba(255,255,255,0.10)';
const COLOR_HEADER = '#1F2A38';
const COLOR_RULER = '#1A2330';

interface Props {
  projectId: string;
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'paint'; noteId: string; startX: number; pitch: number }
  | { kind: 'move'; noteIds: string[]; originX: number; originY: number; originStarts: Map<string, number>; originPitches: Map<string, number> }
  | { kind: 'resize'; noteId: string; originX: number; originDuration: number };

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
  const lowPitch = 24;   // C1
  const highPitch = 96;  // C7
  const totalPitches = highPitch - lowPitch + 1;
  const gridHeight = totalPitches * PITCH_HEIGHT;

  const barSec = 240 / projectBpm;
  const pixelsPerSecond = PIXELS_PER_BAR / barSec;
  const clipLengthSec = selectedClip?.lengthSec ?? 0;
  const clipBars = Math.max(1, Math.ceil(clipLengthSec / barSec));
  const gridWidth = Math.max(800, clipLengthSec * pixelsPerSecond);

  // --- Selection + drag --------------------------------------------
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snapDiv, setSnapDiv] = useState(16);
  const dragRef = useRef<DragState>({ kind: 'idle' });
  const gridRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const velocityRef = useRef<HTMLDivElement>(null);

  const snap = useCallback((sec: number): number => {
    if (snapDiv <= 0) return Math.max(0, sec);
    const stepSec = barSec / snapDiv;
    return Math.max(0, Math.round(sec / stepSec) * stepSec);
  }, [snapDiv, barSec]);

  const xyToNote = useCallback((x: number, y: number) => {
    const sec = x / pixelsPerSecond;
    const pitch = highPitch - Math.floor(y / PITCH_HEIGHT);
    return { sec, pitch };
  }, [pixelsPerSecond, highPitch]);

  // Sync horizontal scroll across the three rows (ruler / grid /
  // velocity). The grid is the source of truth — when it scrolls
  // horizontally we mirror its scrollLeft to the other two.
  const onGridScroll = useCallback(() => {
    if (!gridRef.current) return;
    const sl = gridRef.current.scrollLeft;
    if (rulerRef.current && rulerRef.current.scrollLeft !== sl) {
      rulerRef.current.scrollLeft = sl;
    }
    if (velocityRef.current && velocityRef.current.scrollLeft !== sl) {
      velocityRef.current.scrollLeft = sl;
    }
  }, []);

  // --- Grid mouse handlers ----------------------------------------
  const onGridMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedClip || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const target = (e.target as HTMLElement);
    const noteId = target.dataset.noteId;

    if (noteId) {
      const note = selectedClip.notes.find((n) => n.id === noteId);
      if (!note) return;
      if (e.button === 2) {
        e.preventDefault();
        deleteNotes(selectedClip.id, [noteId]);
        setSelectedIds((s) => {
          const next = new Set(s); next.delete(noteId); return next;
        });
        return;
      }

      const noteLeft = note.startSec * pixelsPerSecond;
      const noteWidth = Math.max(2, note.durationSec * pixelsPerSecond);
      const offsetX = x - noteLeft;
      if (offsetX > noteWidth - 6) {
        dragRef.current = { kind: 'resize', noteId, originX: x, originDuration: note.durationSec };
        if (!selectedIds.has(noteId)) setSelectedIds(new Set([noteId]));
        return;
      }

      let nextSel: Set<string>;
      if (e.shiftKey) {
        nextSel = new Set(selectedIds);
        if (nextSel.has(noteId)) nextSel.delete(noteId); else nextSel.add(noteId);
      } else if (selectedIds.has(noteId)) {
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

    // Empty grid → paint
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
    dragRef.current = { kind: 'paint', noteId: newId, startX: x, pitch };
  }, [selectedClip, selectedIds, pixelsPerSecond, xyToNote, snap, snapDiv, barSec, addNote, deleteNotes]);

  const onGridMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedClip || !gridRef.current || dragRef.current.kind === 'idle') return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const drag = dragRef.current;

    if (drag.kind === 'paint') {
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
    if (!selectedClip) return [] as Array<{ x: number; weight: 'bar' | 'beat' | 'sub' }>;
    const lines: Array<{ x: number; weight: 'bar' | 'beat' | 'sub' }> = [];
    const beatSec = barSec / 4;
    const subDiv = snapDiv > 0 ? snapDiv : 16;
    const subSec = barSec / subDiv;
    const subCount = Math.ceil(selectedClip.lengthSec / subSec);
    for (let i = 0; i <= subCount; i++) {
      const sec = i * subSec;
      const x = sec * pixelsPerSecond;
      // Classify: bar boundary > beat boundary > sub-step.
      const isBar = Math.abs(sec / barSec - Math.round(sec / barSec)) < 1e-4;
      const isBeat = Math.abs(sec / beatSec - Math.round(sec / beatSec)) < 1e-4;
      lines.push({ x, weight: isBar ? 'bar' : isBeat ? 'beat' : 'sub' });
    }
    return lines;
  }, [selectedClip, snapDiv, barSec, pixelsPerSecond]);

  // --- Pitch row bands (black-key shading + C separators) ----------
  const pitchBands = useMemo(() => {
    const bands: Array<{ y: number; isC: boolean; isBlack: boolean }> = [];
    for (let p = highPitch; p >= lowPitch; p--) {
      const y = (highPitch - p) * PITCH_HEIGHT;
      const mod = ((p % 12) + 12) % 12;
      bands.push({ y, isC: mod === 0, isBlack: BLACK_KEY_PITCHES.has(mod) });
    }
    return bands;
  }, [lowPitch, highPitch]);

  // --- Bar number labels for the ruler -----------------------------
  const barLabels = useMemo(() => {
    const labels: Array<{ x: number; n: number }> = [];
    for (let b = 0; b <= clipBars; b++) {
      labels.push({ x: b * PIXELS_PER_BAR + 4, n: b + 1 });
    }
    return labels;
  }, [clipBars]);

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
      className="w-full flex flex-col select-none relative"
      style={{ height: panelHeight, background: COLOR_BG, borderTop: '1px solid rgba(0,0,0,0.6)' }}
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
        style={{ height: HEADER_HEIGHT, background: COLOR_HEADER, borderBottom: '1px solid rgba(0,0,0,0.55)' }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={onHeaderDrop}
      >
        <span className="text-[12px] font-semibold text-white/85">Piano Roll</span>
        <span className="text-white/30">·</span>
        <span className="text-[11px] text-white/65">
          {instrument?.fileId ? instrument.name : 'Drop a sample here →'}
        </span>
        {instrument?.fileId && selectedClip && (
          <>
            <span className="text-white/20">·</span>
            <label className="text-[11px] text-white/55 flex items-center gap-1">
              base
              <input
                type="number"
                min={0}
                max={127}
                value={instrument.baseNote}
                onChange={(e) => setBaseNote(selectedClip.trackId, parseInt(e.target.value, 10) || 60)}
                className="w-12 bg-white/[0.04] border border-white/[0.08] rounded px-1 py-0.5 text-white/80 text-[11px]"
              />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[11px] text-white/55 flex items-center gap-1">
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

      {/* Ruler row — keyboard-width spacer, then bar numbers that
          horizontally scroll with the grid. */}
      <div
        className="flex shrink-0"
        style={{ height: RULER_HEIGHT, background: COLOR_RULER, borderBottom: '1px solid rgba(0,0,0,0.55)' }}
      >
        <div
          className="shrink-0"
          style={{ width: KEYBOARD_WIDTH, borderRight: '1px solid rgba(0,0,0,0.5)' }}
        />
        <div
          ref={rulerRef}
          className="flex-1 overflow-x-hidden overflow-y-hidden relative"
        >
          <div className="relative" style={{ width: gridWidth, height: RULER_HEIGHT }}>
            {barLabels.map((b) => (
              <span
                key={b.n}
                className="absolute top-0 text-[10px] font-mono text-white/55"
                style={{ left: b.x, lineHeight: `${RULER_HEIGHT}px` }}
              >
                {b.n}
              </span>
            ))}
            {/* Tick marks at every bar */}
            {gridLines
              .filter((l) => l.weight === 'bar')
              .map((l, i) => (
                <div
                  key={i}
                  className="absolute bottom-0 pointer-events-none"
                  style={{ left: l.x, width: 1, height: 6, background: 'rgba(255,255,255,0.4)' }}
                />
              ))}
          </div>
        </div>
      </div>

      {/* Body: keyboard | grid (both share vertical scroll inside grid-area) */}
      <div className="flex-1 min-h-0 flex">
        <div
          ref={gridRef}
          className="flex-1 relative overflow-auto"
          onScroll={onGridScroll}
          onMouseDown={onGridMouseDown}
          onMouseMove={onGridMouseMove}
          onMouseUp={onGridMouseUp}
          onMouseLeave={onGridMouseUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Inside the scroll container we lay out a wide+tall canvas:
              keyboard sticks to the left at all horizontal scroll
              positions; grid content fills the rest. */}
          <div className="relative" style={{ width: KEYBOARD_WIDTH + gridWidth, height: gridHeight }}>
            {/* Keyboard column — sticky-left so it stays visible as
                the user scrolls horizontally. zIndex sits above the
                grid content so notes scrolling under it are clipped
                visually by the sticky edge. */}
            <div
              className="sticky top-0 z-20"
              style={{ left: 0, width: KEYBOARD_WIDTH, float: 'left' }}
            >
              <PianoRollKeyboard
                lowPitch={lowPitch}
                highPitch={highPitch}
                pitchHeight={PITCH_HEIGHT}
                width={KEYBOARD_WIDTH}
                previewBuffer={instrument?.buffer}
                previewBaseNote={instrument?.baseNote}
                previewVolume={instrument?.volume}
              />
            </div>
            {/* Grid content — pitch bands, time grid lines, notes,
                playhead. Offset to the right of the keyboard. */}
            <div
              className="absolute top-0"
              style={{ left: KEYBOARD_WIDTH, width: gridWidth, height: gridHeight }}
            >
              {/* Black-key row tints + C row separator */}
              {pitchBands.map((b, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 pointer-events-none"
                  style={{
                    top: b.y,
                    height: PITCH_HEIGHT,
                    background: b.isBlack ? COLOR_BG_BLACKROW : 'transparent',
                    borderBottom: b.isC ? `1px solid ${COLOR_GRID_C}` : '1px solid rgba(255,255,255,0.025)',
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
                    background: l.weight === 'bar' ? COLOR_GRID_BAR
                      : l.weight === 'beat' ? 'rgba(255,255,255,0.10)'
                      : COLOR_GRID_LINE,
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
                    background: '#FFFFFF',
                    boxShadow: '0 0 6px rgba(255,255,255,0.55)',
                    opacity: 0.9,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Velocity row — spacer + lollipop lane that scrolls with grid */}
      {selectedClip && (
        <div className="flex shrink-0" style={{ height: VELOCITY_HEIGHT }}>
          <div
            className="shrink-0 flex items-center justify-end pr-2"
            style={{ width: KEYBOARD_WIDTH, background: '#1F2A38', borderRight: '1px solid rgba(0,0,0,0.5)', borderTop: '1px solid rgba(0,0,0,0.55)' }}
          >
            <span className="text-[9px] font-mono text-white/40 uppercase tracking-wider">vel</span>
          </div>
          <div
            ref={velocityRef}
            className="flex-1 overflow-x-hidden overflow-y-hidden"
          >
            <VelocityLane
              clipId={selectedClip.id}
              notes={selectedClip.notes}
              selectedNoteIds={selectedIds}
              pixelsPerSecond={pixelsPerSecond}
              height={VELOCITY_HEIGHT}
              width={gridWidth}
            />
          </div>
        </div>
      )}
    </div>
  );
}
