import type { MidiInstrument } from '../midiTrackStore';

// Coerce a saved/remote instrument blob into a fully-shaped
// MidiInstrument. Older saves (before the sampler params landed)
// don't have startOffset / ADSR fields; migrate by filling in the
// makeInstrument() defaults so playback still works on first load.
export function coerceInstrument(raw: any): MidiInstrument {
  const def = makeInstrumentInternal();
  return {
    fileId: raw?.fileId ?? null,
    name: typeof raw?.name === 'string' ? raw.name : def.name,
    buffer: undefined,
    baseNote: Number.isFinite(raw?.baseNote) ? raw.baseNote : def.baseNote,
    volume: Number.isFinite(raw?.volume) ? raw.volume : def.volume,
    muted: !!raw?.muted,
    startOffset: Number.isFinite(raw?.startOffset) ? raw.startOffset : def.startOffset,
    endOffset: Number.isFinite(raw?.endOffset) ? raw.endOffset : def.endOffset,
    attackSec: Number.isFinite(raw?.attackSec) ? raw.attackSec : def.attackSec,
    decaySec: Number.isFinite(raw?.decaySec) ? raw.decaySec : def.decaySec,
    sustainLevel: Number.isFinite(raw?.sustainLevel) ? raw.sustainLevel : def.sustainLevel,
    releaseSec: Number.isFinite(raw?.releaseSec) ? raw.releaseSec : def.releaseSec,
  };
}

function makeInstrumentInternal(): MidiInstrument {
  return {
    fileId: null,
    name: 'Empty',
    baseNote: 60,         // C4 — Ableton Sampler's default
    volume: 1,
    muted: false,
    startOffset: 0,
    endOffset: 1,
    attackSec: 0.005,     // ~5 ms — avoids click on fast attacks while
    decaySec: 0,          //         keeping the sampler responsive
    sustainLevel: 1,      // full sustain (one-shot pass-through)
    releaseSec: 0.05,     // ~50 ms tail to soften note-off click
  };
}

// Public alias preserved for the rest of the file's call sites.
export const makeInstrument = makeInstrumentInternal;
