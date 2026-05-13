import { useMidiTrack } from '../midiTrackStore';
import type { MidiClip, MidiInstrument, MidiSyncPayload } from '../midiTrackStore';

export function buildSyncPayload(instruments: Record<string, MidiInstrument>, clips: MidiClip[]): MidiSyncPayload {
  const out: MidiSyncPayload['instruments'] = {};
  for (const [trackId, inst] of Object.entries(instruments)) {
    out[trackId] = {
      fileId: inst.fileId,
      name: inst.name,
      baseNote: inst.baseNote,
      volume: inst.volume,
      muted: inst.muted,
      startOffset: inst.startOffset,
      endOffset: inst.endOffset,
      attackSec: inst.attackSec,
      decaySec: inst.decaySec,
      sustainLevel: inst.sustainLevel,
      releaseSec: inst.releaseSec,
    };
  }
  return { instruments: out, clips };
}

export function payloadHasContent(p: MidiSyncPayload): boolean {
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
