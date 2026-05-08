import { create } from 'zustand';
import { getCtx, getMaster, safeStop } from './audio/graph';
import { audioBufferCache, getAudioData } from '../lib/audio';
import { useAudioStore, getStartedAt } from './audioStore';
import { sendSessionAction } from '../lib/socket';
import { pitchShiftRatio, clampPitch, clampVelocity } from '../lib/midiSchedule';

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
}

interface MidiTrackState {
  // Panel UI state.
  open: boolean;
  panelHeight: number;

  // Per-track instrument (keyed by the project-store track id).
  instruments: Record<string, MidiInstrument>;

  // All MIDI clips, regardless of track. Each carries its own trackId.
  clips: MidiClip[];

  selectedClipId: string | null;

  setOpen: (v: boolean) => void;
  setPanelHeight: (px: number) => void;

  // Instrument config
  ensureInstrument: (trackId: string) => void;
  setInstrument: (trackId: string, name: string, buffer: AudioBuffer, fileId?: string | null) => void;
  setBaseNote: (trackId: string, pitch: number) => void;
  setInstrumentVolume: (trackId: string, v: number) => void;
  toggleInstrumentMuted: (trackId: string) => void;

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
  }>;
  clips: MidiClip[];
}

function buildSyncPayload(instruments: Record<string, MidiInstrument>, clips: MidiClip[]): MidiSyncPayload {
  const out: MidiSyncPayload['instruments'] = {};
  for (const [trackId, inst] of Object.entries(instruments)) {
    out[trackId] = {
      fileId: inst.fileId,
      name: inst.name,
      baseNote: inst.baseNote,
      volume: inst.volume,
      muted: inst.muted,
    };
  }
  return { instruments: out, clips };
}

function payloadHasContent(p: MidiSyncPayload): boolean {
  if (p.clips.length > 0) return true;
  return Object.values(p.instruments).some((i) => !!i.fileId);
}

// Called by sessionStore when a peer sends `midi.request-state`. Same
// shape as the drum rack snapshot helper — only reply when there's
// real state to share so a late joiner with populated localStorage
// doesn't get clobbered.
export function getMidiSyncSnapshot(): MidiSyncPayload | null {
  const s = useMidiTrack.getState();
  const payload = buildSyncPayload(s.instruments, s.clips);
  return payloadHasContent(payload) ? payload : null;
}

function makeInstrument(): MidiInstrument {
  return {
    fileId: null,
    name: 'Empty',
    baseNote: 60,         // C4 — Ableton Sampler's default
    volume: 1,
    muted: false,
  };
}

export const useMidiTrack = create<MidiTrackState>((set, get) => ({
  open: false,
  panelHeight: 320,

  instruments: {},
  clips: [],
  selectedClipId: null,

  setOpen: (v) => set({ open: v }),
  setPanelHeight: (px) => set({ panelHeight: Math.max(160, Math.min(720, px)) }),

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

  selectClip: (clipId) => set({ selectedClipId: clipId }),

  createClipAt: (trackId, startSec, lengthSec) => {
    const id = crypto.randomUUID();
    set((s) => ({
      clips: [...s.clips, {
        id,
        trackId,
        startSec: Math.max(0, startSec),
        lengthSec: Math.max(0.05, lengthSec),
        notes: [],
      }],
      selectedClipId: id,
      // Make sure the track has an instrument entry so the piano roll
      // has something to read for baseNote / volume even on first paint.
      instruments: s.instruments[trackId]
        ? s.instruments
        : { ...s.instruments, [trackId]: makeInstrument() },
    }));
    return id;
  },

  duplicateClip: (clipId, atSec) => {
    const src = get().clips.find((c) => c.id === clipId);
    if (!src) return null;
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

  deleteClip: (clipId) => set((s) => ({
    clips: s.clips.filter((c) => c.id !== clipId),
    selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
  })),

  moveClip: (clipId, newStartSec) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, startSec: Math.max(0, newStartSec) } : c)),
  })),

  resizeClip: (clipId, newLengthSec) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, lengthSec: Math.max(0.05, newLengthSec) } : c)),
  })),

  clearClip: (clipId) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId ? { ...c, notes: [] } : c)),
  })),

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

  deleteNote: (clipId, noteId) => set((s) => ({
    clips: s.clips.map((c) => (c.id === clipId
      ? { ...c, notes: c.notes.filter((n) => n.id !== noteId) }
      : c)),
  })),

  deleteNotes: (clipId, noteIds) => {
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
      // new (looped) project times.
      if (lastProjectNow >= 0 && projectNow < lastProjectNow - 0.05) {
        queued.clear();
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
          // Only schedule notes that fall inside the lookahead window.
          // The 5 ms slack on the trailing edge matches the drum rack
          // and absorbs jitter in setInterval timing.
          if (noteAbsTime < projectNow - 0.005) continue;
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
          g.gain.value = inst.volume * note.velocity;
          src.connect(g);
          g.connect(getMaster());

          const when = noteAbsTime + startedAt;
          src.start(Math.max(ctxNow, when));

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
        };
        const instruments: Record<string, MidiInstrument> = {};
        for (const [tid, i] of Object.entries(data.instruments || {})) {
          instruments[tid] = { ...i, buffer: undefined };
        }
        set({
          instruments,
          clips: Array.isArray(data.clips) ? data.clips : [],
          selectedClipId: data.selectedClipId ?? null,
          open: data.open ?? false,
          panelHeight: data.panelHeight ?? 320,
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
        next[tid] = {
          ...i,
          buffer: i.fileId ? fileIdToBuffer.get(i.fileId) : undefined,
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

// Bar-lock MIDI clip positions when the project tempo changes. Same
// `ghost-bpm-rescale` event the drum rack listens for — every clip's
// startSec / lengthSec scale by the BPM ratio and re-snap to the new bar
// grid so multiple tempo changes don't accumulate drift.
function snapClipsToProjectGrid(scale = 1) {
  const newBpm = useAudioStore.getState().projectBpm || 120;
  const newBarSec = 240 / newBpm;
  useMidiTrack.setState((s) => ({
    clips: s.clips.map((c) => {
      const scaledStart = c.startSec * scale;
      const scaledLen = c.lengthSec * scale;
      // Notes scale within the clip — they're stored relative to the
      // clip start, so when the clip stretches, every note's startSec
      // and durationSec scale by the same factor to stay musically
      // aligned with the bar grid.
      const notes = c.notes.map((n) => ({
        ...n,
        startSec: n.startSec * scale,
        durationSec: n.durationSec * scale,
      }));
      return {
        ...c,
        startSec: Math.max(0, Math.round(scaledStart / newBarSec) * newBarSec),
        lengthSec: Math.max(newBarSec, Math.round(scaledLen / newBarSec) * newBarSec),
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
