import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { useAudioStore } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { sendSessionAction } from '../../lib/socket';
import PianoRollKeyboard, { previewKey } from './PianoRollKeyboard';
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
 * Floating buttons for the bottom-right of the arrangement column:
 *   - "+ MIDI Track" creates a new MIDI track on the current project
 *     and refreshes so it shows up as a lane immediately.
 *   - "Piano Roll" opens the editor panel for whatever clip is
 *     currently selected (renders only while the panel is closed —
 *     the panel itself owns the ✕ to close).
 *
 * Phase 5 will replace the standalone Piano Roll button with the
 * "click any MIDI clip in the arrangement" entrypoint as the
 * primary path; this button stays as a fallback for power users
 * who want to switch between clips without going through the lane.
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
      title="Open piano roll for the selected clip"
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

/**
 * Adds a MIDI track to the current project. Sits to the LEFT of the
 * Piano Roll button so the two are visually grouped. Once clicked
 * the new lane appears in the arrangement; the user clicks empty
 * lane space to start a clip.
 */
export function AddMidiTrackButton({ projectId }: { projectId: string }) {
  const open = useMidiTrack((s) => s.open);
  const ensureInstrument = useMidiTrack((s) => s.ensureInstrument);
  // We hide the button while the panel is open — the panel covers
  // most of the bottom-right area anyway, and adding new tracks
  // mid-edit would require closing the piano roll first to see them.
  if (open) return null;

  const onClick = async () => {
    if (!projectId) return;
    try {
      const result: any = await api.addTrack(projectId, { name: 'MIDI', type: 'midi' as any } as any);
      // Pre-create the instrument record so the lane can immediately
      // accept a sample drop without an extra ensureInstrument round
      // trip. The MIDI store is keyed by the project track id.
      if (result?.id) ensureInstrument(result.id);
      window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
    } catch { /* server error — user can retry */ }
  };

  return (
    <button
      onClick={onClick}
      className="absolute bottom-3 right-[148px] z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-white shadow-lg transition-all hover:scale-[1.02]"
      style={{ background: 'linear-gradient(180deg, #4F46E5 0%, #3730A3 100%)', boxShadow: '0 4px 12px rgba(79,70,229,0.4)' }}
      title="Add a MIDI track to the arrangement"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      MIDI
    </button>
  );
}

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

// Color tokens for the piano roll — tuned to match Ghost Session's
// dark purple-black body. Slightly lighter than the app body so the
// panel reads as a contained surface; black-key rows go darker with
// a strong overlay so pitch positions are still readable on the
// already-dark base.
const COLOR_BG = '#120822';
const COLOR_BG_BLACKROW = 'rgba(0,0,0,0.40)';
const COLOR_GRID_LINE = 'rgba(255,255,255,0.04)';
const COLOR_GRID_BAR = 'rgba(255,255,255,0.16)';
const COLOR_GRID_C = 'rgba(255,255,255,0.10)';
const COLOR_HEADER = '#0E0620';
const COLOR_RULER = '#0B0518';

interface Props {
  projectId: string;
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'paint'; noteId: string; startX: number; pitch: number }
  | { kind: 'move'; noteIds: string[]; originX: number; originY: number; originStarts: Map<string, number>; originPitches: Map<string, number> }
  | { kind: 'resize'; noteId: string; originX: number; originDuration: number }
  | { kind: 'marquee'; startX: number; startY: number; baseSelection: Set<string>; additive: boolean };

type Tool = 'draw' | 'select';

interface ClipboardNote {
  pitch: number;
  relStartSec: number;
  durationSec: number;
  velocity: number;
}

export default function PianoRollPanel({ projectId }: Props) {
  const open = useMidiTrack((s) => s.open);
  const setOpen = useMidiTrack((s) => s.setOpen);
  const panelHeight = useMidiTrack((s) => s.panelHeight);
  const setPanelHeight = useMidiTrack((s) => s.setPanelHeight);

  const instruments = useMidiTrack((s) => s.instruments);
  const clips = useMidiTrack((s) => s.clips);
  const selectedClipId = useMidiTrack((s) => s.selectedClipId);
  const setInstrument = useMidiTrack((s) => s.setInstrument);
  const setBaseNote = useMidiTrack((s) => s.setBaseNote);
  const selectClip = useMidiTrack((s) => s.selectClip);
  const addNote = useMidiTrack((s) => s.addNote);
  const deleteNotes = useMidiTrack((s) => s.deleteNotes);
  const moveNote = useMidiTrack((s) => s.moveNote);
  const transposeNotes = useMidiTrack((s) => s.transposeNotes);
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

  const setLoopRegion = useAudioStore((s) => s.setLoopRegion);

  // --- On open, fall back to the first existing clip --------------
  // Real MIDI tracks live in the project's track table now, and clips
  // are created via the lane (click empty space → new clip). When the
  // user opens the piano roll directly via the button without a clip
  // selected, jump them to whatever clip exists so they don't see an
  // empty editor; if the project has no MIDI clips at all, the panel
  // shows an empty-state message and the user adds a track first.
  useEffect(() => {
    if (!open) return;
    if (selectedClipId) return;
    if (clips.length > 0) selectClip(clips[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selectedClipId) ?? null,
    [clips, selectedClipId],
  );
  const instrument = selectedClip ? instruments[selectedClip.trackId] : undefined;
  // Pull the project track's display name so the header reads "Piano
  // Roll · <track name> · <sample>" — the user can tell at a glance
  // which MIDI track they're editing when there are several.
  const trackName = useProjectStore((s) => {
    if (!selectedClip) return null;
    const tr = s.currentProject?.tracks?.find((t: any) => t.id === selectedClip.trackId);
    return tr?.name ?? null;
  });

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
  const [tool, setTool] = useState<Tool>('draw');
  const [audition, setAudition] = useState(true);
  const [autoLoop, setAutoLoop] = useState(true);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // --- Auto-loop the selected clip --------------------------------
  // When the panel is open with a clip selected and auto-loop is on,
  // tell the audio store to wrap transport between the clip's bounds.
  // updatePosition() reads loopRegion every RAF tick so changes here
  // take effect on the next frame without restarting playback.
  useEffect(() => {
    if (!open || !autoLoop) {
      setLoopRegion(null);
      return;
    }
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) {
      setLoopRegion(null);
      return;
    }
    setLoopRegion({ start: clip.startSec, end: clip.startSec + clip.lengthSec });
    return () => { setLoopRegion(null); };
  }, [open, autoLoop, selectedClipId, clips, setLoopRegion]);
  // Focus scoping — keyboard shortcuts (Delete / Ctrl+C/V/X/A) and the
  // select-tool crosshair cursor should only fire when the user has
  // actively clicked into the piano roll. Otherwise pressing Delete in
  // the arrangement above ends up wiping piano-roll notes too. Default
  // to false so the panel doesn't grab focus the moment it opens.
  const [focused, setFocused] = useState(false);
  const dragRef = useRef<DragState>({ kind: 'idle' });
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const velocityRef = useRef<HTMLDivElement>(null);
  // Clipboard + paste anchor. clipboardRef stores notes with startSec
  // normalized so the earliest note sits at relStartSec=0; pasteAnchorRef
  // tracks where the *next* paste should land so consecutive Ctrl+V's
  // chain after the previous paste instead of stacking on top of it.
  const clipboardRef = useRef<ClipboardNote[]>([]);
  const clipboardSpanRef = useRef<number>(0);
  const pasteAnchorRef = useRef<number | null>(null);

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
  // x/y here are in GRID-CONTENT coordinates (0-based within the
  // notes area). The scroll container's leftmost KEYBOARD_WIDTH px
  // are occupied by the keyboard column, so we have to subtract it
  // to align note positions with click positions. xRaw still has
  // the keyboard offset so the move/resize/paint deltas computed in
  // onGridMouseMove (which compare against this same xRaw stored on
  // the drag state) stay self-consistent.
  const onGridMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedClip || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const xRaw = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const x = xRaw - KEYBOARD_WIDTH;
    // Clicks that land on the keyboard column (left of the grid)
    // are handled by the keyboard's own onMouseDown — bail so we
    // don't paint a phantom note at sec=0 when the user previews
    // a key.
    if (x < 0) return;
    // Walk up to the nearest [data-note-id] ancestor so clicks on
    // child elements inside a note (e.g. the cursor-resize edge
    // hint) still resolve to the note's id.
    const target = (e.target as HTMLElement);
    const noteEl = target.closest('[data-note-id]') as HTMLElement | null;
    const noteId = noteEl?.dataset.noteId;

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
      // Resize edge — rightmost ~10 px of the note. Wide enough to be
      // hit-able with the mouse without making the body click area
      // feel cramped on small notes. Cursor hint comes from
      // PianoRollNote's overlay child.
      if (offsetX > noteWidth - 10) {
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

      // Audition — fire the sample at this note's pitch through the
      // track FX bus. Same one-shot path the keyboard column uses.
      if (audition && instrument?.buffer) {
        previewKey(note.pitch, instrument.buffer, instrument.baseNote, instrument.volume * note.velocity, selectedClip.trackId);
      }

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

    // Empty grid — branch on tool.
    if (tool === 'select') {
      // Start a marquee. Holding shift means "add to existing
      // selection"; otherwise the existing selection is dropped as
      // soon as the user releases without intersecting anything.
      const additive = e.shiftKey;
      dragRef.current = {
        kind: 'marquee',
        startX: x,
        startY: y,
        baseSelection: new Set(additive ? selectedIds : []),
        additive,
      };
      setMarqueeRect({ x, y, w: 0, h: 0 });
      if (!additive) setSelectedIds(new Set());
      return;
    }

    // Draw tool → paint a new note.
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
    // Audition the freshly-painted note so the user hears the pitch
    // they just dropped without having to start playback.
    if (audition && instrument?.buffer) {
      previewKey(pitch, instrument.buffer, instrument.baseNote, instrument.volume * 0.85, selectedClip.trackId);
    }
  }, [selectedClip, selectedIds, pixelsPerSecond, xyToNote, snap, snapDiv, barSec, addNote, deleteNotes, tool, audition, instrument]);

  const onGridMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedClip || !gridRef.current || dragRef.current.kind === 'idle') return;
    const rect = gridRef.current.getBoundingClientRect();
    // Same KEYBOARD_WIDTH correction as onGridMouseDown — keeps the
    // x stored on the drag state and the x measured each move in the
    // SAME coordinate system, so dx = x - originX is a true pixel
    // delta instead of being permanently off by KEYBOARD_WIDTH.
    const xRaw = e.clientX - rect.left + gridRef.current.scrollLeft;
    const y = e.clientY - rect.top + gridRef.current.scrollTop;
    const x = xRaw - KEYBOARD_WIDTH;
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
    } else if (drag.kind === 'marquee') {
      const rx = Math.min(drag.startX, x);
      const ry = Math.min(drag.startY, y);
      const rw = Math.abs(x - drag.startX);
      const rh = Math.abs(y - drag.startY);
      setMarqueeRect({ x: rx, y: ry, w: rw, h: rh });
      // Live-update selection so the user gets immediate feedback as
      // they drag. Test note bounding boxes against the rect — any note
      // overlapping the rect is in the selection (plus baseSelection
      // when shift is held).
      const next = new Set(drag.baseSelection);
      for (const n of selectedClip.notes) {
        const nLeft = n.startSec * pixelsPerSecond;
        const nWidth = Math.max(2, n.durationSec * pixelsPerSecond);
        const nTop = (highPitch - n.pitch) * PITCH_HEIGHT + 1;
        const nHeight = Math.max(1, PITCH_HEIGHT - 2);
        const overlaps = nLeft < rx + rw && nLeft + nWidth > rx
                      && nTop < ry + rh && nTop + nHeight > ry;
        if (overlaps) next.add(n.id);
      }
      setSelectedIds(next);
    }
  }, [selectedClip, pixelsPerSecond, barSec, snapDiv, snap, moveNote, resizeNote, highPitch]);

  const onGridMouseUp = useCallback(() => {
    if (dragRef.current.kind === 'marquee') {
      setMarqueeRect(null);
    }
    dragRef.current = { kind: 'idle' };
  }, []);

  // --- Focus scoping ----------------------------------------------
  // Track whether the user is currently working inside the piano roll
  // panel. Click anywhere in the panel → focused; click anywhere else
  // (or escape out of the panel) → unfocused. We use mousedown on
  // window with a containment check rather than DOM focus events
  // because most of the panel's children aren't natively focusable
  // (divs, not inputs) and we don't want to add tabIndex everywhere.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const inside = !!panelRef.current && panelRef.current.contains(target);
      setFocused(inside);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocused(false);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // --- Keyboard shortcuts ------------------------------------------
  useEffect(() => {
    if (!open || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!selectedClip) return;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        deleteNotes(selectedClip.id, Array.from(selectedIds));
        setSelectedIds(new Set());
        return;
      }

      // Transpose — Up/Down by 1 semitone, Shift+Up/Down by an octave.
      // FL Studio's piano-roll bindings; preventDefault stops the page
      // from scrolling while the user nudges notes around.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const semitones = (e.shiftKey ? 12 : 1) * dir;
        transposeNotes(selectedClip.id, Array.from(selectedIds), semitones);
        return;
      }

      // Select all — useful as a shortcut to grab every note in the
      // clip without having to marquee-drag the whole grid.
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSelectedIds(new Set(selectedClip.notes.map((n) => n.id)));
        return;
      }

      // Copy — store relative startSec so paste can drop the block at
      // an arbitrary anchor while preserving inter-note timing.
      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const sel = selectedClip.notes.filter((n) => selectedIds.has(n.id));
        if (sel.length === 0) return;
        const minStart = Math.min(...sel.map((n) => n.startSec));
        const maxEnd = Math.max(...sel.map((n) => n.startSec + n.durationSec));
        clipboardRef.current = sel.map((n) => ({
          pitch: n.pitch,
          relStartSec: n.startSec - minStart,
          durationSec: n.durationSec,
          velocity: n.velocity,
        }));
        clipboardSpanRef.current = Math.max(barSec / 4, maxEnd - minStart);
        // Reset the paste anchor so the next Ctrl+V starts at the
        // playhead (or right after the source block) rather than
        // continuing whatever chain the previous clipboard had built.
        pasteAnchorRef.current = null;
        return;
      }

      // Cut — copy + delete in one shot, FL-Studio style.
      if (mod && (e.key === 'x' || e.key === 'X')) {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const sel = selectedClip.notes.filter((n) => selectedIds.has(n.id));
        if (sel.length === 0) return;
        const minStart = Math.min(...sel.map((n) => n.startSec));
        const maxEnd = Math.max(...sel.map((n) => n.startSec + n.durationSec));
        clipboardRef.current = sel.map((n) => ({
          pitch: n.pitch,
          relStartSec: n.startSec - minStart,
          durationSec: n.durationSec,
          velocity: n.velocity,
        }));
        clipboardSpanRef.current = Math.max(barSec / 4, maxEnd - minStart);
        pasteAnchorRef.current = null;
        deleteNotes(selectedClip.id, Array.from(selectedIds));
        setSelectedIds(new Set());
        return;
      }

      // Paste — anchor at the playhead if it's inside this clip;
      // otherwise chain after the previous paste (or right after the
      // source block on the first paste). Snap the anchor so pasted
      // notes land on the grid the user is currently working with.
      if (mod && (e.key === 'v' || e.key === 'V')) {
        if (clipboardRef.current.length === 0) return;
        e.preventDefault();
        const audio = useAudioStore.getState();
        const playheadInClip = audio.isPlaying
          && audio.currentTime >= selectedClip.startSec
          && audio.currentTime < selectedClip.startSec + selectedClip.lengthSec;
        let anchor: number;
        if (playheadInClip) {
          anchor = snap(audio.currentTime - selectedClip.startSec);
          pasteAnchorRef.current = anchor + clipboardSpanRef.current;
        } else if (pasteAnchorRef.current !== null) {
          anchor = pasteAnchorRef.current;
          pasteAnchorRef.current = anchor + clipboardSpanRef.current;
        } else {
          // First paste with no playhead — drop the block right after
          // the original copied notes so the user can stamp out a
          // sequence by holding Ctrl+V.
          const sel = selectedClip.notes.filter((n) => selectedIds.has(n.id));
          const seedEnd = sel.length > 0
            ? Math.max(...sel.map((n) => n.startSec + n.durationSec))
            : 0;
          anchor = snap(seedEnd);
          pasteAnchorRef.current = anchor + clipboardSpanRef.current;
        }
        const newIds: string[] = [];
        for (const c of clipboardRef.current) {
          const id = addNote(selectedClip.id, {
            pitch: c.pitch,
            startSec: anchor + c.relStartSec,
            durationSec: c.durationSec,
            velocity: c.velocity,
          });
          newIds.push(id);
        }
        setSelectedIds(new Set(newIds));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, focused, selectedClip, selectedIds, deleteNotes, addNote, transposeNotes, snap, barSec]);

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
      ref={panelRef}
      className="w-full flex flex-col select-none relative"
      style={{
        height: panelHeight,
        background: COLOR_BG,
        // Tinted top border when the panel is the active surface — a
        // quiet "this is where your shortcuts go" indicator without
        // being a distracting glow.
        borderTop: focused
          ? '1px solid rgba(168,85,247,0.55)'
          : '1px solid rgba(0,0,0,0.6)',
      }}
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
        {trackName && (
          <>
            <span className="text-white/30">·</span>
            <span className="text-[11px] text-white/80">{trackName}</span>
          </>
        )}
        <span className="text-white/30">·</span>
        <span className="text-[11px] text-white/65">
          {instrument?.fileId ? instrument.name : selectedClip ? 'Drop a sample here →' : 'No clip selected'}
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
          {/* Tool toggle — pencil paints new notes (default), marquee
              drag-selects existing notes for copy/delete/move. Mirrors
              the FL Studio piano-roll tool palette. */}
          <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded overflow-hidden">
            <button
              onClick={() => setTool('draw')}
              title="Draw tool — click to paint notes"
              className="px-1.5 py-0.5 flex items-center justify-center"
              style={{
                background: tool === 'draw' ? 'rgba(168,85,247,0.35)' : 'transparent',
                color: tool === 'draw' ? '#fff' : 'rgba(255,255,255,0.55)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                <path d="M2 2l7.586 7.586" />
                <circle cx="11" cy="11" r="2" />
              </svg>
            </button>
            <button
              onClick={() => setTool('select')}
              title="Select tool — drag to marquee-select notes"
              className="px-1.5 py-0.5 flex items-center justify-center"
              style={{
                background: tool === 'select' ? 'rgba(168,85,247,0.35)' : 'transparent',
                color: tool === 'select' ? '#fff' : 'rgba(255,255,255,0.55)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 2">
                <rect x="3" y="3" width="18" height="18" rx="1" />
              </svg>
            </button>
          </div>
          {/* Audition toggle — when on, painting a note (or clicking
              an existing one) one-shots the track's instrument at
              that pitch so the user can hear what they're entering
              without starting transport. */}
          <button
            onClick={() => setAudition((v) => !v)}
            title={audition ? 'Audition on — click to silence note input' : 'Audition off — click to hear notes as you input them'}
            className="flex items-center justify-center px-1.5 py-0.5 rounded border"
            style={{
              background: audition ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.04)',
              borderColor: audition ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.08)',
              color: audition ? '#fff' : 'rgba(255,255,255,0.55)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {audition ? (
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              ) : (
                <>
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              )}
            </svg>
          </button>
          {/* Auto-loop toggle — when on, transport wraps between the
              selected clip's start/end so the user can hear their
              edits on repeat without manually re-pressing play. */}
          <button
            onClick={() => setAutoLoop((v) => !v)}
            title={autoLoop ? 'Auto-loop on — selected clip plays on repeat' : 'Auto-loop off — playback runs through the whole arrangement'}
            className="flex items-center justify-center px-1.5 py-0.5 rounded border"
            style={{
              background: autoLoop ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.04)',
              borderColor: autoLoop ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.08)',
              color: autoLoop ? '#fff' : 'rgba(255,255,255,0.55)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          </button>
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
          style={{ cursor: focused && tool === 'select' ? 'crosshair' : 'default' }}
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
                previewTrackId={selectedClip?.trackId}
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
              {/* Marquee — translucent rectangle drawn while the user
                  drags with the select tool. Sits above the grid lines
                  but below notes so selected pills still render with
                  their glow on top. */}
              {marqueeRect && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: marqueeRect.x,
                    top: marqueeRect.y,
                    width: marqueeRect.w,
                    height: marqueeRect.h,
                    background: 'rgba(168,85,247,0.15)',
                    border: '1px dashed rgba(168,85,247,0.85)',
                    borderRadius: 2,
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
            style={{ width: KEYBOARD_WIDTH, background: COLOR_HEADER, borderRight: '1px solid rgba(0,0,0,0.55)', borderTop: '1px solid rgba(0,0,0,0.65)' }}
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
