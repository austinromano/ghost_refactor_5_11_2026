import { create } from 'zustand';
import { getCtx, safeStop } from './audio/graph';
import { audioBufferCache, getAudioData } from '../lib/audio';
import { useAudioStore, getStartedAt } from './audioStore';
import { sendSessionAction } from '../lib/socket';
import { pitchShiftRatio, clampPitch, clampVelocity } from '../lib/midiSchedule';
import { getMidiTrackBus } from './audio/midiFxBus';
import { api } from '../lib/api';
import { coerceInstrument, makeInstrument } from './midi/instrument';
import { buildSyncPayload } from './midi/sync';

export { getMidiSyncSnapshot } from './midi/sync';

// MIDI track / piano-roll store.
//
// Architecture (mirrors drumRackStore.ts intentionally):
//   - Each MIDI track owns ONE instrument config — a sample (fileId +
//     AudioBuffer) plus a baseNote (the pitch it plays at unshifted).
//     MIDI notes pitch-shift the sample using AudioBufferSourceNode's
//     playbackRate (2^((pitch - baseNote)/12)).
//   - The arrangement holds clips on a MIDI track lane. Each clip carries
//     its own array of notes (pitch, startSec from clip start, durationSec,
//     velocity). Notes are absolute time within the clip, not step indices,
//     because piano-roll editors deal in continuous time.
//   - The piano-roll panel always shows the SELECTED clip. Open the panel
//     for a different clip and the notes swap in.
//   - The scheduler walks every clip on every tick and schedules any note
//     whose absolute project-time hits inside the lookahead window. One
//     BufferSource per note; gain = instrument.volume × note.velocity;
//     playbackRate = pitchShiftRatio(note.pitch, instrument.baseNote).
//
// V1 constraints (deliberate):
//   - One-shot only: notes don't sustain past the sample's natural length.
//     `durationSec` is editor metadata for now; v2 can add loop / envelope.
//   - 16-voice polyphony cap per track to keep CPU bounded on chord stabs.
//   - One sample per MIDI track. Per-clip sample override is a v2 thing.

export interface MidiNote {
  id: string;
  pitch: number;          // 0-127 MIDI number (60 = C4)
  startSec: number;       // seconds from clip start
  durationSec: number;    // editor-only in v1 (one-shot scheduler ignores)
  velocity: number;       // 0-1
}

export interface MidiClip {
  id: string;
  trackId: string;        // which MIDI track this clip belongs to
  startSec: number;       // arrangement-time start
  lengthSec: number;
  notes: MidiNote[];
}

export interface MidiInstrument {
  // The sample to pitch-shift. Mirrors DrumRow shape so the same
  // sample-library drag-and-drop flow can target a MIDI track.
  fileId: string | null;
  name: string;
  buffer?: AudioBuffer;
  baseNote: number;       // pitch the sample plays at unshifted (default 60 = C4)
  volume: number;         // 0-1.5 — same range as drum rows
  muted: boolean;

  // --- Sampler params ---------------------------------------------
  // Normalised playback window into the source sample. 0..1 fractions
  // of buffer.duration. start=0, end=1 plays the whole buffer.
  startOffset: number;
  endOffset: number;
  // ADSR envelope (seconds, sustain is 0..1). Applied to the per-note
  // gain in the scheduler so notes can have soft attacks, percussive
  // releases, etc. Default = 0/0/1/0 (instant attack, full sustain,
  // instant release) so existing patches don't change behaviour.
  attackSec: number;
  decaySec: number;
  sustainLevel: number;
  releaseSec: number;
}

interface MidiTrackState {
  // Panel UI state.
  open: boolean;
  panelHeight: number;
  // Track id whose Sampler is currently being edited in the floating
  // sampler panel. Null = no sampler panel open. Click a MIDI track's
  // instrument badge in the arrangement to set this.
  samplerOpenTrackId: string | null;
  // Top-left position of the floating Sampler panel in viewport
  // coordinates. Null = use the default (bottom-right anchor) so the
  // panel always pops up somewhere visible on a fresh project before
  // the user has dragged it. Once moved, this is persisted in
  // localStorage and restored on next load.
  samplerPosition: { x: number; y: number } | null;

  // Per-track instrument (keyed by the project-store track id).
  instruments: Record<string, MidiInstrument>;

  // All MIDI clips, regardless of track. Each carries its own trackId.
  clips: MidiClip[];

  selectedClipId: string | null;

  // Ghost-layer overlay clip ids. Tracing-paper UX: each clip listed
  // here renders its notes as a faded, non-interactive overlay
  // behind the actively-edited clip in the piano roll, so the user
  // can write a part that fits with another clip without flipping
  // back and forth. Notes align by clip-relative time (note at
  // relSec=0 in the ghost shows at relSec=0 in the editor). The
  // active selectedClipId is filtered out at render time, so
  // toggling a clip here doesn't conflict with editing it normally.
  ghostClipIds: string[];

  setOpen: (v: boolean) => void;
  setPanelHeight: (px: number) => void;
  openSampler: (trackId: string | null) => void;
  setSamplerPosition: (pos: { x: number; y: number } | null) => void;
  // Ghost-layer toggles.
  toggleGhostClip: (clipId: string) => void;
  clearGhostClips: () => void;

  // Instrument config
  ensureInstrument: (trackId: string) => void;
  setInstrument: (trackId: string, name: string, buffer: AudioBuffer, fileId?: string | null) => void;
  removeInstrument: (trackId: string) => void;
  setBaseNote: (trackId: string, pitch: number) => void;
  setInstrumentVolume: (trackId: string, v: number) => void;
  toggleInstrumentMuted: (trackId: string) => void;
  // Sampler params
  setSamplerRange: (trackId: string, startOffset: number, endOffset: number) => void;
  setSamplerEnvelope: (trackId: string, env: Partial<{ attackSec: number; decaySec: number; sustainLevel: number; releaseSec: number }>) => void;

  // Clip-level
  selectClip: (clipId: string | null) => void;
  createClipAt: (trackId: string, startSec: number, lengthSec: number) => string;
  duplicateClip: (clipId: string, atSec: number) => string | null;
  deleteClip: (clipId: string) => void;
  moveClip: (clipId: string, newStartSec: number) => void;
  resizeClip: (clipId: string, newLengthSec: number) => void;
  clearClip: (clipId: string) => void;

  // Note-level
  addNote: (clipId: string, note: Omit<MidiNote, 'id'>) => string;
  deleteNote: (clipId: string, noteId: string) => void;
  deleteNotes: (clipId: string, noteIds: string[]) => void;
  moveNote: (clipId: string, noteId: string, newStartSec: number, newPitch: number) => void;
  resizeNote: (clipId: string, noteId: string, newDurationSec: number) => void;
  setNoteVelocity: (clipId: string, noteId: string, velocity: number) => void;
  transposeNotes: (clipId: string, noteIds: string[], semitones: number) => void;

  // Undo / redo — captures clips + instruments snapshots before
  // destructive ops (delete clip / delete note / clear clip), and a
  // separate command-style entry for whole-track deletes (which need
  // a server-side recreate to undo).
  canUndoMidi: boolean;
  canRedoMidi: boolean;
  lastMidiUndoTs: number;
  captureUndoSnapshot: (label: string) => void;
  captureTrackDeleteSnapshot: (args: { projectId: string; trackId: string; trackName: string }) => void;
  undoMidi: () => Promise<boolean>;
  redoMidi: () => boolean;

  // Scheduler
  startScheduler: (projectId: string) => void;
  stopScheduler: () => void;

  // Persistence (instruments + clips per project; buffers rehydrated from fileId)
  loadForProject: (projectId: string) => Promise<void>;

  // Multiplayer sync — apply a snapshot received over the socket.
  applyRemoteState: (payload: MidiSyncPayload) => Promise<void>;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
const activeSources: Set<AudioBufferSourceNode> = new Set();

// Undo / redo state. Most entries are full state snapshots that any
// destructive action (delete clip, delete note, clear clip) restores
// in one shot. Whole-track deletes can't be reversed by a state
// snapshot alone — the project track row was deleted server-side and
// re-fetching the project would clobber any local restore. Those use
// a dedicated `track-delete` entry that recreates the track via the
// API on undo and re-keys the captured clips/instrument to the new
// id.
interface MidiStateSnapshot {
  kind: 'state';
  clips: MidiClip[];
  instruments: Record<string, MidiInstrument>;
  selectedClipId: string | null;
  label: string;
  ts: number;
}
interface MidiTrackDeleteSnapshot {
  kind: 'track-delete';
  projectId: string;
  trackName: string;
  // Captured BEFORE the lane mutates the store, so they include the
  // user's instrument config (sample, ADSR, baseNote, ...) and every
  // clip with notes for the doomed trackId.
  instrument: MidiInstrument | null;
  clips: MidiClip[];
  label: string;
  ts: number;
}
type MidiUndoEntry = MidiStateSnapshot | MidiTrackDeleteSnapshot;

const midiUndoStack: MidiUndoEntry[] = [];
const midiRedoStack: MidiUndoEntry[] = [];
const MAX_UNDO = 50;
function snapshotState(label: string): MidiStateSnapshot {
  const s = useMidiTrack.getState();
  // Deep-clone clips so future mutations don't bleed into the
  // snapshot. Instruments share buffer references — buffers are
  // immutable and re-fetchable from fileId, so a shallow copy is fine.
  const clips: MidiClip[] = s.clips.map((c) => ({
    ...c,
    notes: c.notes.map((n) => ({ ...n })),
  }));
  const instruments: Record<string, MidiInstrument> = {};
  for (const [k, v] of Object.entries(s.instruments)) instruments[k] = { ...v };
  return { kind: 'state', clips, instruments, selectedClipId: s.selectedClipId, label, ts: Date.now() };
}
// Voice tracking per track for the polyphony cap. Each track gets a
// circular buffer of currently-playing sources; once it hits the cap
// the oldest is force-stopped to make room for the new note.
const VOICES_PER_TRACK = 16;
const trackVoices: Map<string, AudioBufferSourceNode[]> = new Map();

// Persistence — instruments + clips, keyed by projectId in localStorage.
// Buffer rehydrated from fileId on load. Real-time multiplayer broadcasts
// the same payload over the project socket as a `midi.state` session-action.
let _currentProjectId: string | null = null;
let _hydrating = false;
let _applyingRemote = false;
let _lastBroadcastJson = '';
const persistKey = (projectId: string) => `miditrack::${projectId}`;

export interface MidiSyncPayload {
  instruments: Record<string, {
    fileId: string | null;
    name: string;
    baseNote: number;
    volume: number;
    muted: boolean;
    startOffset: number;
    endOffset: number;
    attackSec: number;
    decaySec: number;
    sustainLevel: number;
    releaseSec: number;
  }>;
  clips: MidiClip[];
}

export const useMidiTrack = create<MidiTrackState>((set, get) => ({
  open: false,
  panelHeight: 320,
  samplerOpenTrackId: null,
  samplerPosition: null,

  instruments: {},
  clips: [],
  selectedClipId: null,
  ghostClipIds: [],

  toggleGhostClip: (clipId) => set((s) => {
    const has = s.ghostClipIds.includes(clipId);
    return {
      ghostClipIds: has
        ? s.ghostClipIds.filter((id) => id !== clipId)
        : [...s.ghostClipIds, clipId],
    };
  }),
  clearGhostClips: () => set({ ghostClipIds: [] }),

  canUndoMidi: false,
  canRedoMidi: false,
  lastMidiUndoTs: 0,

  captureUndoSnapshot: (label) => {
    if (_applyingRemote || _hydrating) return;
    midiUndoStack.push(snapshotState(label));
    if (midiUndoStack.length > MAX_UNDO) midiUndoStack.shift();
    midiRedoStack.length = 0;
    set({ canUndoMidi: true, canRedoMidi: false, lastMidiUndoTs: Date.now() });
  },

  captureTrackDeleteSnapshot: ({ projectId, trackId, trackName }) => {
    if (_applyingRemote || _hydrating) return;
    const s = useMidiTrack.getState();
    const inst = s.instruments[trackId];
    const instrument = inst ? { ...inst } : null;
    const clips = s.clips
      .filter((c) => c.trackId === trackId)
      .map((c) => ({ ...c, notes: c.notes.map((n) => ({ ...n })) }));
    midiUndoStack.push({
      kind: 'track-delete',
      projectId,
      trackName,
      instrument,
      clips,
      label: `Delete track "${trackName}"`,
      ts: Date.now(),
    });
    if (midiUndoStack.length > MAX_UNDO) midiUndoStack.shift();
    midiRedoStack.length = 0;
    set({ canUndoMidi: true, canRedoMidi: false, lastMidiUndoTs: Date.now() });
  },

  undoMidi: async () => {
    if (midiUndoStack.length === 0) return false;
    const entry = midiUndoStack.pop()!;

    if (entry.kind === 'state') {
      // Plain state snapshot — restore in one shot and push the
      // current state onto the redo stack so the user can redo.
      midiRedoStack.push(snapshotState(`Redo: ${entry.label}`));
      if (midiRedoStack.length > MAX_UNDO) midiRedoStack.shift();
      set({
        clips: entry.clips,
        instruments: entry.instruments,
        selectedClipId: entry.selectedClipId,
        canUndoMidi: midiUndoStack.length > 0,
        canRedoMidi: true,
        lastMidiUndoTs: Date.now(),
      });
      return true;
    }

    // Track-delete recovery — recreate the track on the server, then
    // re-key the captured clips/instrument under the new track id.
    // Server-issued ids are random so the restored row gets a new id;
    // we update local store state to match before refreshing the
    // project so MidiLane sees both the new track row AND its
    // restored clips on the same render pass.
    try {
      const result: any = await api.addTrack(entry.projectId, { name: entry.trackName, type: 'midi' as any } as any);
      const newId: string | undefined = result?.id;
      if (!newId) throw new Error('addTrack returned no id');

      const cur = get();
      const nextInstruments = { ...cur.instruments };
      if (entry.instrument) {
        nextInstruments[newId] = { ...entry.instrument };
      }
      // Re-key clips to the new track id so the lane lookup
      // (clips.filter(c => c.trackId === trackId)) finds them.
      const restoredClips = entry.clips.map((c) => ({
        ...c,
        trackId: newId,
        notes: c.notes.map((n) => ({ ...n })),
      }));

      set({
        instruments: nextInstruments,
        clips: [...cur.clips, ...restoredClips],
        canUndoMidi: midiUndoStack.length > 0,
        // Track-delete undo doesn't push a redo — the user can just
        // right-click the restored lane to delete it again, which
        // creates a fresh undo entry.
        canRedoMidi: midiRedoStack.length > 0,
        lastMidiUndoTs: Date.now(),
      });
      // Refresh so the new project track row appears in the lane list.
      window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
      return true;
    } catch (err) {
      // Server error — push the entry back so the user can retry.
      midiUndoStack.push(entry);
      set({ canUndoMidi: true });
      if (typeof console !== 'undefined') console.warn('[midiTrackStore] undo track-delete failed:', err);
      return false;
    }
  },

  redoMidi: () => {
    if (midiRedoStack.length === 0) return false;
    const snap = midiRedoStack.pop()!;
    if (snap.kind !== 'state') {
      // Track-delete entries don't go through redo — drop silently.
      set({ canRedoMidi: midiRedoStack.length > 0 });
      return false;
    }
    midiUndoStack.push(snapshotState(`Undo: ${snap.label}`));
    if (midiUndoStack.length > MAX_UNDO) midiUndoStack.shift();
    set({
      clips: snap.clips,
      instruments: snap.instruments,
      selectedClipId: snap.selectedClipId,
      canUndoMidi: true,
      canRedoMidi: midiRedoStack.length > 0,
      lastMidiUndoTs: Date.now(),
    });
    return true;
  },

  setOpen: (v) => set({ open: v }),
  setPanelHeight: (px) => set({ panelHeight: Math.max(160, Math.min(720, px)) }),
  openSampler: (trackId) => set({ samplerOpenTrackId: trackId }),
  setSamplerPosition: (pos) => set({ samplerPosition: pos }),

  ensureInstrument: (trackId) => set((s) => {
    if (s.instruments[trackId]) return s;
    return { instruments: { ...s.instruments, [trackId]: makeInstrument() } };
  }),

  setInstrument: (trackId, name, buffer, fileId) => set((s) => {
    const prev = s.instruments[trackId] ?? makeInstrument();
    return {
      instruments: {
        ...s.instruments,
        [trackId]: { ...prev, name, buffer, fileId: fileId ?? null },
      },
    };
  }),

  removeInstrument: (trackId) => {
    if (!useMidiTrack.getState().instruments[trackId]) return;
    // Snapshot first so undo can put the Sampler back exactly as it
    // was — sample, base note, ADSR, the lot.
    get().captureUndoSnapshot('Remove Sampler');
    // Close the floating Sampler editor if it was viewing this track,
    // otherwise it would hang on a now-missing instrument record.
    if (useMidiTrack.getState().samplerOpenTrackId === trackId) {
      set({ samplerOpenTrackId: null });
    }
    set((s) => {
      const { [trackId]: _gone, ...rest } = s.instruments;
      return { instruments: rest };
    });
  },

  setBaseNote: (trackId, pitch) => set((s) => {
    const prev = s.instruments[trackId];
    if (!prev) return s;
    return {
      instruments: {
        ...s.instruments,
        [trackId]: { ...prev, baseNote: clampPitch(pitch) },
      },
    };
  }),

  setInstrumentVolume: (trackId, v) => set((s) => {
    const prev = s.instruments[trackId];
    if (!prev) return s;
    return {
      instruments: {
        ...s.instruments,
        [trackId]: { ...prev, volume: Math.max(0, Math.min(1.5, v)) },
      },
    };
  }),

  toggleInstrumentMuted: (trackId) => set((s) => {
    const prev = s.instruments[trackId];
    if (!prev) return s;
    return {
      instruments: {
        ...s.instruments,
        [trackId]: { ...prev, muted: !prev.muted },
      },
    };
  }),

  setSamplerRange: (trackId, startOffset, endOffset) => set((s) => {
    const prev = s.instruments[trackId];
    if (!prev) return s;
    const lo = Math.max(0, Math.min(1, Math.min(startOffset, endOffset)));
    const hi = Math.max(lo + 0.001, Math.min(1, Math.max(startOffset, endOffset)));
    return {
      instruments: {
        ...s.instruments,
        [trackId]: { ...prev, startOffset: lo, endOffset: hi },
      },
    };
  }),

  setSamplerEnvelope: (trackId, env) => set((s) => {
    const prev = s.instruments[trackId];
    if (!prev) return s;
    return {
      instruments: {
        ...s.instruments,
        [trackId]: {
          ...prev,
          attackSec: env.attackSec !== undefined ? Math.max(0, Math.min(8, env.attackSec)) : prev.attackSec,
          decaySec: env.decaySec !== undefined ? Math.max(0, Math.min(8, env.decaySec)) : prev.decaySec,
          sustainLevel: env.sustainLevel !== undefined ? Math.max(0, Math.min(1, env.sustainLevel)) : prev.sustainLevel,
          releaseSec: env.releaseSec !== undefined ? Math.max(0, Math.min(8, env.releaseSec)) : prev.releaseSec,
        },
      },
    };
  }),

  selectClip: (clipId) => set({ selectedClipId: clipId }),

  createClipAt: (trackId, startSec, lengthSec) => {
    get().captureUndoSnapshot('Add MIDI clip');
    const id = crypto.randomUUID();
    // Don't auto-create an instrument — Sampler is now opt-in. The
    // user explicitly adds it by dragging the Sampler tile (or a
    // sample) onto the FX chain or lane header. The piano roll
    // tolerates a missing instrument with `?.` lookups, and the
    // scheduler skips clips whose track has no buffer to play.
    set((s) => ({
      clips: [...s.clips, {
        id,
        trackId,
        startSec: Math.max(0, startSec),
        lengthSec: Math.max(0.05, lengthSec),
        notes: [],
      }],
      selectedClipId: id,
    }));
    return id;
  },

  duplicateClip: (clipId, atSec) => {
    const src = get().clips.find((c) => c.id === clipId);
    if (!src) return null;
    get().captureUndoSnapshot('Duplicate MIDI clip');
    const id = crypto.randomUUID();
    set((s) => ({
      clips: [...s.clips, {
        ...src,
        id,
        startSec: Math.max(0, atSec),
        // Notes get fresh ids so future per-note edits don't ghost-affect
        // the original clip.
        notes: src.notes.map((n) => ({ ...n, id: crypto.randomUUID() })),
      }],
      selectedClipId: id,
    }));
    return id;
  },

  deleteClip: (clipId) => {
    get().captureUndoSnapshot('Delete MIDI clip');
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== clipId),
      selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
    }));
  },

  moveClip: (clipId, newStartSec) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, startSec: Math.max(0, newStartSec) } : c)),
  })),

  resizeClip: (clipId, newLengthSec) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, lengthSec: Math.max(0.05, newLengthSec) } : c)),
  })),

  clearClip: (clipId) => {
    get().captureUndoSnapshot('Clear notes');
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId ? { ...c, notes: [] } : c)),
    }));
  },

  addNote: (clipId, note) => {
    const id = crypto.randomUUID();
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          notes: [...c.notes, {
            id,
            pitch: clampPitch(note.pitch),
            startSec: Math.max(0, note.startSec),
            durationSec: Math.max(0.01, note.durationSec),
            velocity: clampVelocity(note.velocity),
          }],
        };
      }),
    }));
    return id;
  },

  deleteNote: (clipId, noteId) => {
    get().captureUndoSnapshot('Delete note');
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId
        ? { ...c, notes: c.notes.filter((n) => n.id !== noteId) }
        : c)),
    }));
  },

  deleteNotes: (clipId, noteIds) => {
    if (noteIds.length === 0) return;
    get().captureUndoSnapshot(noteIds.length === 1 ? 'Delete note' : `Delete ${noteIds.length} notes`);
    const idSet = new Set(noteIds);
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId
        ? { ...c, notes: c.notes.filter((n) => !idSet.has(n.id)) }
        : c)),
    }));
  },

  moveNote: (clipId, noteId, newStartSec, newPitch) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      return {
        ...c,
        notes: c.notes.map((n) => (n.id === noteId
          ? { ...n, startSec: Math.max(0, newStartSec), pitch: clampPitch(newPitch) }
          : n)),
      };
    }),
  })),

  resizeNote: (clipId, noteId, newDurationSec) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      return {
        ...c,
        notes: c.notes.map((n) => (n.id === noteId
          ? { ...n, durationSec: Math.max(0.01, newDurationSec) }
          : n)),
      };
    }),
  })),

  setNoteVelocity: (clipId, noteId, velocity) => set((s) => ({
    clips: s.clips.map((c) => {
      if (c.id !== clipId) return c;
      return {
        ...c,
        notes: c.notes.map((n) => (n.id === noteId
          ? { ...n, velocity: clampVelocity(velocity) }
          : n)),
      };
    }),
  })),

  transposeNotes: (clipId, noteIds, semitones) => {
    const idSet = new Set(noteIds);
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          notes: c.notes.map((n) => (idSet.has(n.id)
            ? { ...n, pitch: clampPitch(n.pitch + semitones) }
            : n)),
        };
      }),
    }));
  },

  startScheduler: () => {
    if (schedulerTimer) return;
    const ctx = getCtx();
    // Track which (clipId, noteId, loopIteration) tuples we've queued so
    // overlapping ticks don't double-fire. Same dedupe pattern as the
    // drum rack — we use noteId here instead of step index because MIDI
    // notes have unique stable ids.
    const queued = new Set<string>();
    let lastProjectNow = -1;
    let wasPlaying = false;

    const tick = () => {
      const audio = useAudioStore.getState();
      if (!audio.isPlaying) {
        if (wasPlaying) { queued.clear(); lastProjectNow = -1; wasPlaying = false; }
        return;
      }
      wasPlaying = true;

      const lookahead = 0.12; // seconds — same window as drum rack

      const ctxNow = ctx.currentTime;
      const startedAt = getStartedAt();
      const projectNow = ctxNow - startedAt;
      const horizonProjectTime = projectNow + lookahead;

      // Backward jump → loop / seek / rewind. Wipe the dedupe set so
      // notes that fired in the previous pass can fire again at their
      // new (looped) project times. Also stop any sources still in
      // flight from the pre-wrap window so a stale tail of notes
      // scheduled near the loop end doesn't bleed into the new pass.
      const jumpedBackward = lastProjectNow >= 0 && projectNow < lastProjectNow - 0.05;
      if (jumpedBackward) {
        queued.clear();
        for (const src of activeSources) safeStop(src);
        activeSources.clear();
        trackVoices.clear();
      }
      lastProjectNow = projectNow;

      const state = get();

      for (const clip of state.clips) {
        const clipEnd = clip.startSec + clip.lengthSec;
        if (clipEnd <= projectNow) continue;
        if (clip.startSec >= horizonProjectTime) continue;

        const inst = state.instruments[clip.trackId];
        if (!inst || inst.muted || !inst.buffer) continue;

        for (const note of clip.notes) {
          const noteAbsTime = clip.startSec + note.startSec;
          // Schedule any note inside [projectNow - 50ms, projectNow +
          // lookahead]. The 50 ms past-time tolerance covers the
          // worst-case gap between a transport loop wrap (which
          // happens in updatePosition's RAF) and the next scheduler
          // tick (25 ms interval, plus possible drift). Without it,
          // notes sitting exactly on region.start get dropped because
          // by the time the post-wrap tick fires, projectNow has
          // already advanced past them. The dedupe `queued` set keeps
          // this from re-firing the same note in steady-state play.
          if (noteAbsTime < projectNow - 0.050) continue;
          if (noteAbsTime > horizonProjectTime) continue;

          const queueKey = `${clip.id}:${note.id}`;
          if (queued.has(queueKey)) continue;
          queued.add(queueKey);

          if (note.velocity <= 0) continue;

          // --- Schedule a pitch-shifted BufferSource for this note ---
          const src = ctx.createBufferSource();
          src.buffer = inst.buffer;
          src.playbackRate.value = pitchShiftRatio(note.pitch, inst.baseNote);

          const g = ctx.createGain();
          // ADSR envelope on the per-note gain. The peak velocity
          // value is at the end of the attack ramp; sustain holds at
          // peak * sustainLevel until note-off, then ramps to zero
          // over releaseSec. Sample-accurate via AudioParam scheduling.
          const peak = inst.volume * note.velocity;
          const sustainAmp = peak * inst.sustainLevel;
          src.connect(g);
          // Route through the track's persistent FX bus instead of
          // going straight to master. The bus owns the full effect
          // chain (eq / comp / reverb) and handles its own master
          // connection, so we just need to feed the per-note gain
          // into it. Effects added via drag-drop on the lane mutate
          // the chain; midiFxBus listens to ghost-fx-rewire and
          // rebuilds the wiring without disturbing this connection.
          g.connect(getMidiTrackBus(clip.trackId));

          // Sample window: skip into the buffer by startOffset, stop
          // when the playback head crosses endOffset. Both expressed
          // as fractions of buffer.duration so they survive a sample
          // swap without re-normalising.
          const bufDur = inst.buffer.duration;
          const startBufSec = inst.startOffset * bufDur;
          const endBufSec = inst.endOffset * bufDur;
          const playableBufSec = Math.max(0.005, endBufSec - startBufSec);

          const when = Math.max(ctxNow, noteAbsTime + startedAt);
          // Apply envelope at `when`. setValueAtTime locks the
          // initial 0 so a fresh AudioParam doesn't slew from its
          // previous value if g is somehow reused.
          g.gain.setValueAtTime(0, when);
          if (inst.attackSec > 0) {
            g.gain.linearRampToValueAtTime(peak, when + inst.attackSec);
          } else {
            g.gain.setValueAtTime(peak, when);
          }
          if (inst.decaySec > 0 && sustainAmp < peak) {
            g.gain.linearRampToValueAtTime(sustainAmp, when + inst.attackSec + inst.decaySec);
          } else {
            // No decay → hold peak until release.
            g.gain.setValueAtTime(peak, when + inst.attackSec);
          }
          // Note-off: at note end, ramp to zero over releaseSec.
          // note.durationSec is editor metadata; clamp to the
          // sample's playable window so we never schedule past the
          // actual buffer length.
          const noteOff = when + Math.min(note.durationSec, playableBufSec / src.playbackRate.value);
          g.gain.setValueAtTime(g.gain.value, noteOff);
          if (inst.releaseSec > 0) {
            g.gain.linearRampToValueAtTime(0, noteOff + inst.releaseSec);
          } else {
            g.gain.setValueAtTime(0, noteOff);
          }

          src.start(when, startBufSec);
          // Hard-stop the source after the release tail completes so
          // the AudioBufferSourceNode is GC-eligible. +50 ms guard
          // covers any sub-quantum scheduling jitter.
          src.stop(noteOff + inst.releaseSec + 0.05);
          // Broadcast playback to the Sampler UI so it can render a
          // live cursor sweeping across the waveform. Timing is in
          // audio-context seconds; the listener subtracts ctx.now to
          // get an elapsed-in-sample time it can convert to a pixel
          // position. Total render lifetime ends at noteOff + release
          // + a small tail so the cursor doesn't snap off mid-decay.
          if (typeof window !== 'undefined') {
            const totalDur = (noteOff - when) + inst.releaseSec + 0.05;
            window.dispatchEvent(new CustomEvent('ghost-sampler-voice', {
              detail: {
                trackId: clip.trackId,
                whenCtx: when,
                startBufSec,
                endBufSec,
                playbackRate: src.playbackRate.value,
                totalDur,
              },
            }));
          }

          // Polyphony cap — drop the oldest voice on this track if we
          // hit the limit. Keeps CPU bounded on long held chords.
          let voices = trackVoices.get(clip.trackId);
          if (!voices) { voices = []; trackVoices.set(clip.trackId, voices); }
          if (voices.length >= VOICES_PER_TRACK) {
            const oldest = voices.shift();
            if (oldest) safeStop(oldest);
          }
          voices.push(src);

          activeSources.add(src);
          src.onended = () => {
            activeSources.delete(src);
            const list = trackVoices.get(clip.trackId);
            if (list) {
              const idx = list.indexOf(src);
              if (idx >= 0) list.splice(idx, 1);
            }
            try { src.disconnect(); g.disconnect(); } catch { /* ignore */ }
          };
        }
      }

      // Drop stale queued entries — keeps the set bounded over long
      // sessions. Anything older than 5 s of project time can't fire
      // again until a backward jump wipes the whole set anyway.
      if (queued.size > 4096) {
        // We don't know the per-key project time without parsing, and
        // parsing 4096+ keys per tick is not worth it. Instead, just
        // wipe — we rebuild from the current playhead naturally.
        queued.clear();
      }
    };

    schedulerTimer = setInterval(tick, 25);
    tick();
  },

  stopScheduler: () => {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    for (const src of activeSources) { safeStop(src); }
    activeSources.clear();
    trackVoices.clear();
  },

  loadForProject: async (projectId: string) => {
    _currentProjectId = projectId;
    _hydrating = true;
    try {
      const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(persistKey(projectId)) : null;
      if (raw) {
        const data = JSON.parse(raw) as {
          instruments: Record<string, Omit<MidiInstrument, 'buffer'>>;
          clips: MidiClip[];
          selectedClipId: string | null;
          open?: boolean;
          panelHeight?: number;
          samplerPosition?: { x: number; y: number } | null;
        };
        const instruments: Record<string, MidiInstrument> = {};
        for (const [tid, i] of Object.entries(data.instruments || {})) {
          // Migrate any pre-sampler saves through coerceInstrument so
          // missing ADSR / startOffset / endOffset get sensible defaults.
          instruments[tid] = coerceInstrument(i);
        }
        set({
          instruments,
          clips: Array.isArray(data.clips) ? data.clips : [],
          selectedClipId: data.selectedClipId ?? null,
          open: data.open ?? false,
          panelHeight: data.panelHeight ?? 320,
          samplerPosition: data.samplerPosition ?? null,
        });
      } else {
        set({
          instruments: {},
          clips: [],
          selectedClipId: null,
          open: false,
          panelHeight: 320,
        });
      }
    } catch {
      set({
        instruments: {},
        clips: [],
        selectedClipId: null,
        open: false,
        panelHeight: 320,
      });
    } finally {
      _hydrating = false;
    }

    // Rehydrate AudioBuffers from each instrument's fileId. Same lazy
    // streaming approach the drum rack uses — set state immediately so
    // the panel can render, then fill buffers in as they decode.
    const insts = get().instruments;
    for (const [tid, inst] of Object.entries(insts)) {
      if (!inst.fileId || inst.buffer) continue;
      try {
        const cached = audioBufferCache.get(inst.fileId);
        const buffer = cached ?? (await getAudioData(projectId, inst.fileId)).buffer;
        set((s) => ({
          instruments: {
            ...s.instruments,
            [tid]: s.instruments[tid] ? { ...s.instruments[tid], buffer } : s.instruments[tid],
          },
        }));
      } catch {
        // file deleted / unavailable — leave the instrument bufferless
      }
    }
  },

  applyRemoteState: async (payload) => {
    if (!payload || typeof payload.instruments !== 'object' || !Array.isArray(payload.clips)) return;
    const projectId = _currentProjectId;
    _applyingRemote = true;
    try {
      // Reuse cached AudioBuffers from any existing instrument with the
      // same fileId so we don't re-decode every time a peer broadcasts.
      const prev = get().instruments;
      const fileIdToBuffer = new Map<string, AudioBuffer>();
      for (const inst of Object.values(prev)) {
        if (inst.fileId && inst.buffer) fileIdToBuffer.set(inst.fileId, inst.buffer);
      }

      const next: Record<string, MidiInstrument> = {};
      for (const [tid, i] of Object.entries(payload.instruments)) {
        const coerced = coerceInstrument(i);
        next[tid] = {
          ...coerced,
          buffer: coerced.fileId ? fileIdToBuffer.get(coerced.fileId) : undefined,
        };
      }

      set((s) => ({
        instruments: next,
        clips: payload.clips,
        selectedClipId: s.selectedClipId,
      }));
    } finally {
      _applyingRemote = false;
    }

    if (!projectId) return;
    const insts = get().instruments;
    for (const [tid, inst] of Object.entries(insts)) {
      if (!inst.fileId || inst.buffer) continue;
      try {
        const cached = audioBufferCache.get(inst.fileId);
        const buffer = cached ?? (await getAudioData(projectId, inst.fileId)).buffer;
        _applyingRemote = true;
        try {
          set((s) => ({
            instruments: {
              ...s.instruments,
              [tid]: s.instruments[tid] ? { ...s.instruments[tid], buffer } : s.instruments[tid],
            },
          }));
        } finally {
          _applyingRemote = false;
        }
      } catch {
        // file unavailable
      }
    }
  },
}));

// Re-snap MIDI clip positions when the project tempo changes. Same
// `ghost-bpm-rescale` event the drum rack listens for — every clip's
// startSec / lengthSec scale by the BPM ratio. We snap at 16th-note
// resolution (1/16 of a bar) instead of whole-bar resolution: MIDI
// clips can be placed at beat positions and arbitrary lengths, so a
// bar-snap shoves them off their original musical position. A 16th
// is fine enough to round-trip any reasonable placement while still
// catching the floating-point drift that accumulates over many
// tempo changes. Notes inside the clip just scale by `scale` (they
// preserve their sub-step timing precisely).
function snapClipsToProjectGrid(scale = 1) {
  const newBpm = useAudioStore.getState().projectBpm || 120;
  const newBarSec = 240 / newBpm;
  const snapStep = newBarSec / 16;
  useMidiTrack.setState((s) => ({
    clips: s.clips.map((c) => {
      const scaledStart = c.startSec * scale;
      const scaledLen = c.lengthSec * scale;
      const notes = c.notes.map((n) => ({
        ...n,
        startSec: n.startSec * scale,
        durationSec: n.durationSec * scale,
      }));
      return {
        ...c,
        startSec: Math.max(0, Math.round(scaledStart / snapStep) * snapStep),
        lengthSec: Math.max(snapStep, Math.round(scaledLen / snapStep) * snapStep),
        notes,
      };
    }),
  }));
}

if (typeof window !== 'undefined') {
  window.addEventListener('ghost-bpm-rescale', ((e: CustomEvent) => {
    const ratio = e.detail?.ratio;
    if (!ratio || Math.abs(ratio - 1) < 1e-6) return;
    snapClipsToProjectGrid(ratio);
  }) as EventListener);
}

// Persist + broadcast on every state change. Same gate pattern as the
// drum rack so initial hydration and remote-applied state don't echo
// back out as new broadcasts.
useMidiTrack.subscribe((state) => {
  if (_hydrating || !_currentProjectId) return;

  const payload = buildSyncPayload(state.instruments, state.clips);
  const json = JSON.stringify(payload);

  try {
    const persisted = {
      ...payload,
      selectedClipId: state.selectedClipId,
      samplerPosition: state.samplerPosition,
      open: state.open,
      panelHeight: state.panelHeight,
    };
    localStorage.setItem(persistKey(_currentProjectId), JSON.stringify(persisted));
  } catch { /* quota / serialization — ignore */ }

  if (_applyingRemote) return;
  if (json === _lastBroadcastJson) return;
  _lastBroadcastJson = json;
  try {
    sendSessionAction(_currentProjectId, { type: 'midi.state', payload });
  } catch { /* socket may not be connected */ }
});
