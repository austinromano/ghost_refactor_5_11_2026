import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { useAudioStore } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { useArrangement, TRACK_HEADER_WIDTH, HeaderEffectChips } from './ArrangementComponents';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';
import MidiClipBlock, { MIDI_CLIP_DRAG_MIME } from './MidiClipBlock';
import { MIDI_LIBRARY_DRAG_MIME, getMidiLibraryEntry } from '../../lib/midiLibrary';
import { INSTRUMENT_DRAG_MIME } from '../instruments/InstrumentsSection';
import { useEffectsStore, EFFECT_DRAG_MIME, type EffectKind } from '../../stores/effectsStore';

// One MIDI track lane in the arrangement. Mirrors the drum-rack lane's
// shape but per-track (each MIDI project track gets its own lane,
// where the drum rack is one shared lane for the whole project).
//
// Lane responsibilities:
//   - Render the track header (name + sample drop zone + instrument
//     readout). Drop a sample on the header → the track's instrument
//     is set in the MIDI store; future MIDI notes pitch-shift it.
//   - Render every MIDI clip on this track via <MidiClipBlock>.
//   - Click empty lane space → create a new clip at that bar, snapped
//     to the bar grid; immediately open the piano roll for it.
//   - Accept drag-drop of a MIDI clip (MIDI_CLIP_DRAG_MIME) from
//     anywhere — moves the dropped clip to this lane at the drop time
//     and reassigns its trackId. FL-style.

interface Props {
  laneKey: string;
  track: { id: string; name: string };
  laneHeight: number;
  projectId: string;
}

export default function MidiLane({ laneKey, track, laneHeight, projectId }: Props) {
  const trackId = track.id;
  const dragControls = useDragControls();

  const instruments = useMidiTrack((s) => s.instruments);
  const clips = useMidiTrack((s) => s.clips);
  const selectedClipId = useMidiTrack((s) => s.selectedClipId);
  const setOpen = useMidiTrack((s) => s.setOpen);
  const ensureInstrument = useMidiTrack((s) => s.ensureInstrument);
  const setInstrument = useMidiTrack((s) => s.setInstrument);
  const createClipAt = useMidiTrack((s) => s.createClipAt);
  const moveClip = useMidiTrack((s) => s.moveClip);
  const resizeClip = useMidiTrack((s) => s.resizeClip);
  const deleteClip = useMidiTrack((s) => s.deleteClip);
  const duplicateClip = useMidiTrack((s) => s.duplicateClip);
  const ghostClipIds = useMidiTrack((s) => s.ghostClipIds);
  const toggleGhostClip = useMidiTrack((s) => s.toggleGhostClip);
  const setLoopRegion = useAudioStore((s) => s.setLoopRegion);
  const loopRegion = useAudioStore((s) => s.loopRegion);
  const selectClip = useMidiTrack((s) => s.selectClip);
  const openSampler = useMidiTrack((s) => s.openSampler);
  const setSelectedBusId = useAudioStore((s) => s.setSelectedBusId);
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);

  const { bpm, arrangementDur } = useArrangement();
  const barSec = 240 / Math.max(1, bpm);
  // MIDI clips snap to a beat (1/4 bar) instead of a whole bar so
  // the user can position clips precisely without having to overshoot
  // the half-bar threshold to escape from a snapped bar position.
  // Drum lane uses bar-snap; MIDI gets the finer grid because it
  // tends to host shorter, melodic phrases.
  const beatSec = barSec / 4;

  // Pull this track's clips off the store. Clips for OTHER MIDI tracks
  // live in the same array but render on their own lanes via this
  // filter — the store stays flat, but lanes only show what they own.
  const myClips = useMemo(
    () => clips.filter((c) => c.trackId === trackId),
    [clips, trackId],
  );

  const inst = instruments[trackId];
  const laneRef = useRef<HTMLDivElement | null>(null);

  // Lane-local xToTime — convert pointer x to project-time using this
  // lane's own bounding rect so multiple lanes don't interfere.
  const xToTime = useCallback((clientX: number): number => {
    const el = laneRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * arrangementDur;
  }, [arrangementDur]);

  // Snap arbitrary project-time → grid. Magnetic-to-zero: anything
  // closer to 0 than half a beat lands exactly on 0, so the user
  // can ALWAYS push a clip flush to the start of the arrangement
  // by dragging it leftward — they don't have to find the exact
  // pixel where the snap rounds down.
  const snapTime = (t: number) => {
    if (t <= beatSec * 0.5) return 0;
    return Math.round(t / beatSec) * beatSec;
  };

  // Click empty lane → make a new clip there, 4 bars long by default.
  // No auto-ensureInstrument — Sampler is opt-in. The clip exists in
  // the store regardless; the user adds a Sampler when they want.
  const handleLaneMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-midi-clip]')) return;
    const t = Math.max(0, snapTime(xToTime(e.clientX)));
    const lengthSec = 4 * barSec;
    const id = createClipAt(trackId, t, lengthSec);
    selectClip(id);
    setOpen(true);
  };

  // ---- Sample / instrument drop on track header --------------------
  // Accepts: OS file drops, sample-library drops, project-file drops
  // (all set the track's sample directly), and instrument drops from
  // the Instruments sidebar (creates an empty Sampler and opens the
  // Sampler UI for the user to load a sample into).
  const onHeaderDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.files?.length
      || e.dataTransfer.types.includes(SAMPLE_LIBRARY_DRAG_MIME)
      || e.dataTransfer.types.includes('application/x-ghost-projectfile')
      || e.dataTransfer.types.includes(INSTRUMENT_DRAG_MIME)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onHeaderDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Instrument drag — the user dropped a "Sampler" tile onto this
    // lane. There's nothing audio to load yet; just make sure the
    // instrument record exists and pop the Sampler UI so the user
    // can drop a sample into it next.
    const instRaw = e.dataTransfer.getData(INSTRUMENT_DRAG_MIME);
    if (instRaw) {
      try {
        const payload = JSON.parse(instRaw) as { kind: string };
        if (payload?.kind === 'sampler') {
          ensureInstrument(trackId);
          openSampler(trackId);
          return;
        }
      } catch { /* malformed — fall through to other formats */ }
    }
    const file = e.dataTransfer.files?.[0];
    if (file && /audio|wav|mp3|flac|aiff|ogg|m4a|aac/i.test(file.type + file.name)) {
      try {
        const arr = await file.arrayBuffer();
        const buffer = await getCtx().decodeAudioData(arr.slice(0));
        const name = file.name.replace(/\.[^.]+$/, '');
        const { fileId } = await api.uploadFile(projectId, file);
        ensureInstrument(trackId);
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
        ensureInstrument(trackId);
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
        ensureInstrument(trackId);
        setInstrument(trackId, meta.name.replace(/\.[^.]+$/, ''), buffer, meta.id);
      } catch { /* ignore */ }
    }
  };

  // ---- Effect drop on the lane (EQ / Comp / Reverb) ----------------
  // Mirrors the drum-rack lane's FX-drop pattern. Effects land on the
  // track's effectsStore chain keyed by trackId; midiFxBus listens to
  // ghost-fx-rewire and rebuilds the per-track FX chain so the new
  // effect goes live without a playback restart.
  const [fxDragOver, setFxDragOver] = useState(false);
  const isEffectDrag = (dt: DataTransfer) => {
    for (const t of Array.from(dt.types)) if (t === EFFECT_DRAG_MIME) return true;
    return false;
  };
  const onFxDragOver = (e: React.DragEvent) => {
    if (!isEffectDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!fxDragOver) setFxDragOver(true);
  };
  const onFxDragLeave = (e: React.DragEvent) => {
    if (!isEffectDrag(e.dataTransfer)) return;
    setFxDragOver(false);
  };
  const onFxDrop = (e: React.DragEvent) => {
    if (!isEffectDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setFxDragOver(false);
    try {
      const raw = e.dataTransfer.getData(EFFECT_DRAG_MIME);
      const payload = JSON.parse(raw) as { kind: EffectKind };
      if (!payload?.kind) return;
      useEffectsStore.getState().add(trackId, payload.kind);
      // Pop the FX editor for this track so the user can see + tweak
      // the new effect immediately. Same UX as selecting the track
      // header by click.
      setSelectedTrackIds([]);
      setSelectedBusId(trackId);
    } catch { /* malformed — ignore */ }
  };

  // ---- MIDI clip drag-drop onto this lane --------------------------
  // Accepts two kinds of drags:
  //   - MIDI_CLIP_DRAG_MIME: an existing clip from another lane gets
  //     moved here (its trackId is retargeted)
  //   - MIDI_LIBRARY_DRAG_MIME: a saved clip from the sidebar's MIDI
  //     Library — looked up in localStorage, converted from bar-
  //     relative units back to seconds at the project's current
  //     BPM, and inserted as a brand-new clip on this lane.
  const [clipDragOver, setClipDragOver] = useState(false);
  const acceptsClipDrag = (dt: DataTransfer) => (
    dt.types.includes(MIDI_CLIP_DRAG_MIME)
    || dt.types.includes(MIDI_LIBRARY_DRAG_MIME)
  );
  const onClipLaneDragOver = (e: React.DragEvent) => {
    if (!acceptsClipDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MIDI_LIBRARY_DRAG_MIME) ? 'copy' : 'move';
    if (!clipDragOver) setClipDragOver(true);
  };
  const onClipLaneDragLeave = () => setClipDragOver(false);
  const onClipLaneDrop = (e: React.DragEvent) => {
    if (!acceptsClipDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setClipDragOver(false);
    try {
      // Library drop: spawn a fresh clip on this lane at the drop time.
      const libRaw = e.dataTransfer.getData(MIDI_LIBRARY_DRAG_MIME);
      if (libRaw) {
        const payload = JSON.parse(libRaw) as { id: string };
        const entry = payload?.id ? getMidiLibraryEntry(payload.id) : null;
        if (!entry) return;
        const t = Math.max(0, snapTime(xToTime(e.clientX)));
        const lengthSec = Math.max(barSec, entry.lengthBars * barSec);
        const clipId = createClipAt(trackId, t, lengthSec);
        // Convert the saved bar-relative notes back to seconds at the
        // project's current BPM so cross-BPM saves still hit the
        // right beat positions.
        useMidiTrack.setState((s) => ({
          clips: s.clips.map((c) => {
            if (c.id !== clipId) return c;
            return {
              ...c,
              notes: entry.notes.map((n) => ({
                id: crypto.randomUUID(),
                pitch: n.pitch,
                startSec: n.startBars * barSec,
                durationSec: Math.max(0.01, n.durationBars * barSec),
                velocity: n.velocity,
              })),
            };
          }),
        }));
        selectClip(clipId);
        setOpen(true);
        return;
      }
      const raw = e.dataTransfer.getData(MIDI_CLIP_DRAG_MIME);
      const payload = JSON.parse(raw) as { clipId: string };
      if (!payload?.clipId) return;
      // Move the clip to THIS lane at the dropped position. We update
      // BOTH startSec and (logically) trackId — but moveClip only
      // touches startSec, so we also need to retarget the trackId.
      const t = Math.max(0, snapTime(xToTime(e.clientX)));
      // Reassign trackId by editing the store directly. Cheaper than
      // adding a dedicated retargetClip action since the existing
      // setState call applies the broadcast subscription too.
      useMidiTrack.setState((s) => ({
        clips: s.clips.map((c) =>
          c.id === payload.clipId ? { ...c, trackId, startSec: t } : c,
        ),
      }));
    } catch { /* malformed drag — ignore */ }
  };

  // ---- Right-click → delete-track context menu ---------------------
  // Mirrors the audio-lane menu in ArrangementComponents.tsx. State is
  // an absolute screen-coord anchor so the menu floats over whatever
  // DOM is below; window-level mousedown / Escape dismiss it.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!headerMenu) return;
    const onDown = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHeaderMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [headerMenu]);

  const deleteMidiTrack = async () => {
    if (!window.confirm(`Delete the MIDI track "${track.name || 'MIDI'}"? This removes the track and every clip on it.`)) return;
    // Capture for undo BEFORE we mutate anything — the snapshot needs
    // to see the instrument config + clips that are about to be
    // wiped. undoMidi() will recreate the track via the API and
    // re-key these back into the store under the new server id.
    useMidiTrack.getState().captureTrackDeleteSnapshot({
      projectId,
      trackId,
      trackName: track.name || 'MIDI',
    });
    // Tear down MIDI-store state for this track BEFORE the project
    // refresh — clips and instrument are keyed by trackId, and once
    // the server-side track row is gone there's nothing to anchor
    // them to. The persist subscription on midiTrackStore broadcasts
    // the cleared payload to peers so they drop the same state.
    useMidiTrack.setState((s) => {
      const { [trackId]: _gone, ...remainingInstruments } = s.instruments;
      return {
        instruments: remainingInstruments,
        clips: s.clips.filter((c) => c.trackId !== trackId),
        selectedClipId: s.clips.find((c) => c.id === s.selectedClipId && c.trackId === trackId)
          ? null
          : s.selectedClipId,
      };
    });
    // Drop any audio-store wiring for this track (FX chain, etc.) so
    // a re-add of a same-id track doesn't inherit stale connections.
    useAudioStore.getState().removeTrack(trackId);
    try {
      await useProjectStore.getState().deleteTrack(projectId, trackId);
    } catch { /* server error — UI already cleared, refresh will reconcile */ }
    window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
  };

  if (arrangementDur <= 0) return null;

  return (
    <Reorder.Item
      value={laneKey}
      dragListener={false}
      dragControls={dragControls}
      className="flex relative"
      whileDrag={{ scale: 1.005, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      transition={{ duration: 0.15 }}
      as="div"
      style={{ height: laneHeight }}
      onDragOver={onFxDragOver}
      onDragEnter={onFxDragOver}
      onDragLeave={onFxDragLeave}
      onDrop={onFxDrop}
    >
      {/* Track header — narrower than the audio header since MIDI
          tracks don't have warp/pitch/trim controls. Drop a sample
          on this strip to set the instrument. Click selects the
          track as the FX-edit context so SampleEditorPanel pops the
          chain editor for this track's effect chain. */}
      <div
        data-track-header
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest('button')) return;
          e.preventDefault();
          dragControls.start(e);
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          // Mirror the drum-rack pattern: clear any track selection
          // and stash the trackId on selectedBusId so SampleEditor
          // Panel routes to MidiTrackFxView for this track.
          setSelectedTrackIds([]);
          setSelectedBusId(trackId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHeaderMenu({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={onHeaderDragOver}
        onDrop={onHeaderDrop}
        className="h-full flex flex-col justify-center px-2 shrink-0 cursor-grab active:cursor-grabbing relative rounded-l-lg"
        style={{
          // Match the canonical track-header width so MIDI lanes
          // align horizontally with audio + drum lanes — otherwise
          // a MIDI clip at startSec=0 visually lands tens of pixels
          // past the start of the arrangement.
          width: TRACK_HEADER_WIDTH,
          background: 'rgba(124,58,237,0.18)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
        }}
        title={inst?.fileId ? `Instrument: ${inst.name} · drop a sample to replace` : 'Drop a sample to set the instrument'}
      >
        <div className="flex items-center gap-1.5">
          {/* MIDI track icon (a small piano keys glyph) */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <rect x="2" y="6" width="20" height="12" rx="1" />
            <line x1="6" y1="6" x2="6" y2="14" />
            <line x1="10" y1="6" x2="10" y2="14" />
            <line x1="14" y1="6" x2="14" y2="14" />
            <line x1="18" y1="6" x2="18" y2="14" />
          </svg>
          <span className="text-[12px] font-semibold text-white/90 truncate flex-1">{track.name || 'MIDI'}</span>
          {/* Open Sampler — small button so the lane drag-to-reorder
              still works on the rest of the header (the parent's
              pointer-down bails when the target is a button). */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              ensureInstrument(trackId);
              openSampler(trackId);
            }}
            className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors"
            title="Open sampler"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12c1-3 2-3 3 0s2 3 3 0 2-3 3 0 2 3 3 0 2-3 3 0 2 3 3 0" />
            </svg>
          </button>
        </div>
        {/* Effect chips — one tiny tag per FX in the chain. Same
            renderer as audio + drum lanes, keyed by the MIDI track
            id. Drop an EQ / Comp / Reverb on the lane and a chip
            shows up here within the same render. */}
        <div className="mt-1 flex items-center">
          <HeaderEffectChips laneKey={trackId} />
        </div>
      </div>

      {/* Lane body */}
      <div
        ref={laneRef}
        onMouseDown={handleLaneMouseDown}
        onDragOver={onClipLaneDragOver}
        onDragLeave={onClipLaneDragLeave}
        onDrop={onClipLaneDrop}
        className="relative rounded-r-lg flex-1 cursor-cell"
        style={{
          background: 'rgba(124,58,237,0.06)',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
        }}
        title="Click empty space to add a clip · drop a clip from another lane to move it here"
      >
        {clipDragOver && (
          <div
            className="absolute inset-0 pointer-events-none rounded-r-lg flex items-center justify-center"
            style={{
              background: 'rgba(168, 85, 247, 0.10)',
              boxShadow: 'inset 0 0 0 2px rgba(168, 85, 247, 0.55)',
              zIndex: 5,
            }}
          >
            <span
              className="text-[11px] font-bold tracking-wider uppercase text-white px-2 py-1 rounded-md"
              style={{ background: 'rgba(168, 85, 247, 0.35)', backdropFilter: 'blur(4px)' }}
            >
              Drop to move clip here
            </span>
          </div>
        )}
        {fxDragOver && (
          <div
            className="absolute inset-0 pointer-events-none rounded-r-lg flex items-center justify-center"
            style={{
              background: 'rgba(0, 180, 216, 0.10)',
              boxShadow: 'inset 0 0 0 2px rgba(0, 180, 216, 0.6)',
              zIndex: 6,
            }}
          >
            <span
              className="text-[11px] font-bold tracking-wider uppercase text-white px-2 py-1 rounded-md"
              style={{ background: 'rgba(0, 180, 216, 0.35)', backdropFilter: 'blur(4px)' }}
            >
              Drop to add effect to this track
            </span>
          </div>
        )}
        {myClips.map((clip) => (
          <MidiClipBlock
            key={clip.id}
            clip={clip}
            arrangementDur={arrangementDur}
            laneHeight={laneHeight}
            selected={clip.id === selectedClipId}
            onSelect={() => { selectClip(clip.id); setOpen(true); }}
            onMove={(newStart) => moveClip(clip.id, Math.max(0, snapTime(newStart)))}
            onResize={(newLen) => resizeClip(clip.id, Math.max(barSec, snapTime(newLen)))}
            onDelete={() => deleteClip(clip.id)}
            onDuplicate={() => duplicateClip(clip.id, clip.startSec + clip.lengthSec)}
            onToggleGhost={() => toggleGhostClip(clip.id)}
            onToggleLoopSection={() => {
              const isCurrent = !!loopRegion
                && Math.abs(loopRegion.start - clip.startSec) < 1e-3
                && Math.abs(loopRegion.end - (clip.startSec + clip.lengthSec)) < 1e-3;
              if (isCurrent) setLoopRegion(null);
              else setLoopRegion({ start: clip.startSec, end: clip.startSec + clip.lengthSec });
            }}
            isGhost={ghostClipIds.includes(clip.id)}
            isLoopedSection={!!loopRegion
              && Math.abs(loopRegion.start - clip.startSec) < 1e-3
              && Math.abs(loopRegion.end - (clip.startSec + clip.lengthSec)) < 1e-3}
            xToTime={xToTime}
          />
        ))}
      </div>
      {headerMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] min-w-[160px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{
            left: headerMenu.x, top: headerMenu.y,
            background: 'rgba(20, 12, 30, 0.96)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            onClick={() => { setHeaderMenu(null); deleteMidiTrack(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Delete MIDI track
          </button>
        </div>
      )}
    </Reorder.Item>
  );
}
