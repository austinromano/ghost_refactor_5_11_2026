import { useEffect, useMemo, useState } from 'react';
import { useAudioStore } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import Waveform from '../tracks/Waveform';
import { samplePreview } from '../../lib/samplePreview';
import EffectChainEditor from './EffectChainEditor';
import { DRUM_RACK_FX_KEY, MASTER_FX_KEY, laneKeyOf, useEffectsStore } from '../../stores/effectsStore';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { INSTRUMENT_DRAG_MIME } from '../instruments/InstrumentsSection';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';

// Bottom sample editor / clip inspector. Mounts at the bottom of the
// arrangement view; shows when exactly one clip is selected. Big waveform,
// metadata pills (BPM, character, duration), and the per-clip controls
// the audio store already supports (volume, pitch, mute, fine-trim).

const PITCH_MIN = -12;
const PITCH_MAX = 12;

export default function SampleEditorPanel({ projectId }: { projectId: string }) {
  const selectedTrackIds = useAudioStore((s) => s.selectedTrackIds);
  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const setTrackVolume = useAudioStore((s) => s.setTrackVolume);
  const setTrackMuted = useAudioStore((s) => s.setTrackMuted);
  const setTrackPitch = useAudioStore((s) => s.setTrackPitch);
  const setTrackBpm = useAudioStore((s) => s.setTrackBpm);
  const setTrackWarp = useAudioStore((s) => s.setTrackWarp);
  const setTrackPan = useAudioStore((s) => s.setTrackPan);
  const selectedBusId = useAudioStore((s) => s.selectedBusId);
  const currentProject = useProjectStore((s) => s.currentProject);

  // The panel operates on the WHOLE selection. Single click = one clip;
  // multi-select = same controls apply to every selected clip at once.
  // First selected acts as the "anchor" for display values; values that
  // differ across the selection are flagged "Mixed".
  const ids = useMemo(() => Array.from(selectedTrackIds), [selectedTrackIds]);
  const trackId = ids[0] || null;
  const isMulti = ids.length > 1;

  const projectTrack = useMemo(() => {
    if (!trackId || !currentProject?.tracks) return null;
    return (currentProject.tracks as any[]).find((t) => t.id === trackId) || null;
  }, [trackId, currentProject?.tracks]);

  const loaded = trackId ? loadedTracks.get(trackId) : undefined;

  // Compute whether a getter returns the same value across every clip in
  // the selection. Used to render the "Mixed" hint on controls.
  const allSameNumber = (g: (t: any) => number | undefined): boolean => {
    if (!isMulti) return true;
    let first: number | undefined;
    let init = false;
    for (const id of ids) {
      const v = g(loadedTracks.get(id));
      if (!init) { first = v; init = true; }
      else if (v !== first) return false;
    }
    return true;
  };
  const allSameBool = (g: (t: any) => boolean): boolean => {
    if (!isMulti) return true;
    let first: boolean | undefined;
    let init = false;
    for (const id of ids) {
      const v = g(loadedTracks.get(id));
      if (!init) { first = v; init = true; }
      else if (v !== first) return false;
    }
    return true;
  };

  // Drum rack as a group: clicking the rack header sets selectedBusId
  // to DRUM_RACK_FX_KEY. Render the chain editor for that key so the
  // user can edit the rack's EQ/Comp the same way they edit per-track
  // chains. Master-bus rack itself was removed; any other bus value
  // collapses to the empty state.
  if (selectedBusId === DRUM_RACK_FX_KEY) {
    return <DrumRackFxView />;
  }
  if (selectedBusId === 'master') {
    return <MasterFxView />;
  }
  if (selectedBusId) {
    // Could be a MIDI track id — render a MIDI-track-specific FX
    // editor when the bus id matches a project track of type='midi'.
    // Any other bus id (legacy / unknown) collapses to the empty
    // state below.
    const midiTrack = currentProject?.tracks?.find((t: any) => t.id === selectedBusId && t.type === 'midi');
    if (midiTrack) {
      return <MidiTrackFxView trackName={midiTrack.name || 'MIDI'} laneKey={selectedBusId} />;
    }
    return null;
  }

  if (!trackId || !projectTrack) {
    return (
      <div className="shrink-0 h-[112px] mt-2 rounded-2xl glass flex items-center justify-center text-[11px] text-white/30 italic">
        Click a clip to inspect it — or click the bus to edit FX
      </div>
    );
  }

  const fileName = projectTrack.name || projectTrack.fileName || 'Untitled';
  const detectedBpm: number | null = projectTrack.detectedBpm ?? null;
  const sampleCharacter: string | null = projectTrack.sampleCharacter ?? null;
  const durationSec = loaded?.buffer?.duration ?? 0;
  const volume = loaded?.volume ?? 1;
  const pitch = loaded?.pitch ?? 0;
  const pan = loaded?.pan ?? 0;
  const muted = loaded?.muted ?? false;
  const warp = loaded?.warp !== false;
  // Manual BPM override (loaded.bpm). Falls back to the file's detected
  // BPM so the box always shows the value currently driving the stretch.
  const effectiveBpm = (loaded?.bpm && loaded.bpm > 0) ? loaded.bpm : (detectedBpm ?? 120);

  const fmtDuration = (s: number) => {
    if (!s || !Number.isFinite(s)) return '–';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${r}`;
  };

  const handlePreview = () => samplePreview.toggle(`clip:${trackId}`);

  // "Mixed" detection per control. When true, the value display shows
  // a hint that not every selected clip shares the value — but a change
  // still applies the new value to every clip.
  const mixedVolume = !allSameNumber((t) => t?.volume);
  const mixedPitch = !allSameNumber((t) => t?.pitch);
  const mixedPan = !allSameNumber((t) => t?.pan ?? 0);
  const mixedMuted = !allSameBool((t) => !!t?.muted);
  const mixedWarp = !allSameBool((t) => t?.warp !== false);
  const mixedBpm = !allSameNumber((t) => t?.bpm || 0);

  // Fan-out helpers — every action runs against every selected clip.
  const applyVolume = (v: number) => ids.forEach((id) => setTrackVolume(id, v));
  const applyPitch = (v: number) => ids.forEach((id) => setTrackPitch(id, v));
  const applyPan = (v: number) => ids.forEach((id) => setTrackPan(id, v));
  const applyMute = (next: boolean) => ids.forEach((id) => setTrackMuted(id, next));
  const applyWarp = (next: boolean) => ids.forEach((id) => setTrackWarp(id, next));
  const applyBpm = (next: number) => ids.forEach((id) => setTrackBpm(id, next));

  return (
    <>
      {/* Per-lane FX chain — keyed by fileId so every clip in the
          lane resolves to the same chain. Falls back to the trackId
          for tracks without a fileId (uncommon). */}
      <EffectChainEditor laneKey={laneKeyOf(projectTrack)} />
    <div className="shrink-0 h-[140px] mt-2 rounded-2xl glass flex overflow-hidden">
      {/* Left: file info + metadata pills */}
      <div className="shrink-0 w-[220px] flex flex-col gap-2 px-3 py-2 border-r border-white/[0.05]">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={handlePreview}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-ghost-green/20 text-ghost-green hover:bg-ghost-green/30 transition-colors"
            title="Preview clip"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9" /></svg>
          </button>
          <span className="text-[12px] font-semibold text-white/90 truncate" title={fileName}>
            {isMulti ? `${ids.length} clips selected` : fileName}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          <button
            onClick={() => applyWarp(!warp)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors"
            style={{
              background: warp ? 'rgba(0,255,200,0.18)' : 'rgba(255,255,255,0.04)',
              color: warp ? '#00FFC8' : 'rgba(255,255,255,0.55)',
              border: `1px solid ${warp ? 'rgba(0,255,200,0.5)' : 'rgba(255,255,255,0.06)'}`,
            }}
            title={
              mixedWarp ? 'Warp differs across selection — click to set all' :
              warp ? 'Warp on — sample stretches to project BPM' : 'Warp off — plays at native speed'
            }
          >
            Warp {mixedWarp ? '~' : warp ? 'On' : 'Off'}
          </button>
          <BpmEditor
            value={effectiveBpm}
            onChange={(v) => applyBpm(v)}
            isOverride={!!loaded?.bpm && loaded.bpm > 0}
            disabled={!warp}
            mixed={mixedBpm}
          />
          <Pill icon="time" label={fmtDuration(durationSec)} />
          {sampleCharacter && !isMulti && (
            <Pill icon="dot" label={sampleCharacter[0].toUpperCase() + sampleCharacter.slice(1)} />
          )}
        </div>
        <button
          onClick={() => applyMute(!muted)}
          className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded transition-colors mt-auto ${
            mixedMuted
              ? 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
              : muted
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
          }`}
        >
          {mixedMuted ? 'Mute (mixed)' : muted ? 'Muted' : 'Mute'}
        </button>
      </div>

      {/* Centre: big waveform with a bar-line overlay + warp markers
          (gray transient markers at detected beats, gold user-pinned
          warp markers). overflow-hidden on the inner positioned
          wrapper clips the absolute markers + bar grid so they can
          never bleed into the right slider column. */}
      <div className="flex-1 min-w-0 px-3 py-2 flex">
        <div className="flex-1 relative overflow-hidden">
          <Waveform
            seed={`editor:${trackId}`}
            height={120}
            fileId={projectTrack.fileId}
            projectId={projectId}
            trackId={trackId}
            showPlayhead={true}
          />
          <SampleEditorBarGrid trackId={trackId} />
          <WarpMarkerOverlay trackId={trackId} beats={(projectTrack as any).beats || []} />
        </div>
      </div>

      {/* Right: knobs (volume + pitch). Solid background + relative
           z-index so range-input tracks never read against the
           waveform if anything upstream ever leaks through. */}
      <div
        className="shrink-0 w-[180px] flex flex-col gap-3 px-3 py-2 border-l border-white/[0.05] overflow-y-auto relative"
        style={{ background: 'rgba(10, 4, 18, 0.95)', zIndex: 1 }}
      >
        <Slider
          label="Vol"
          value={volume}
          mixed={mixedVolume}
          min={0}
          max={1.5}
          step={0.01}
          defaultValue={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={applyVolume}
        />
        <Slider
          label="Pitch"
          value={pitch}
          mixed={mixedPitch}
          min={PITCH_MIN}
          max={PITCH_MAX}
          step={1}
          defaultValue={0}
          format={(v) => `${v >= 0 ? '+' : ''}${v} st`}
          onChange={applyPitch}
        />
        <Slider
          label="Pan"
          value={pan}
          mixed={mixedPan}
          min={-1}
          max={1}
          step={0.01}
          defaultValue={0}
          format={(v) => Math.abs(v) < 0.005 ? 'C' : (v > 0 ? `R${Math.round(v * 100)}` : `L${Math.round(-v * 100)}`)}
          onChange={applyPan}
        />
        <div className="text-[9px] text-white/30 italic mt-2 leading-tight">
          Drag EQ / Comp / Reverb from the sidebar onto a track to build a per-track chain.
        </div>
      </div>
    </div>
    </>
  );
}

// Standalone view shown when the user clicks the drum-rack header to
// edit its group effects. EffectChainEditor renders its own empty-
// state dropzone with a rack-specific hint.
function DrumRackFxView() {
  return (
    <div className="shrink-0 mt-2">
      <div className="px-3 py-1 text-[10.5px] font-bold tracking-[0.15em] uppercase text-purple-300/80">
        Drum Rack FX
      </div>
      <EffectChainEditor
        laneKey={DRUM_RACK_FX_KEY}
        emptyMessage="Drag EQ or Comp from the sidebar to add group effects to the drum rack."
      />
    </div>
  );
}

// Standalone view shown when the user clicks a MIDI track header.
// Same shape as DrumRackFxView but the lane key is the MIDI track's
// project id, so the chain stored under that id is what midiFxBus
// routes notes through. The label uses the track's display name so
// the user can tell at a glance which MIDI track they're editing
// when there are several. The Sampler device sits ABOVE the effect
// chain — Ableton-style: instrument first, FX inserts after.
function MidiTrackFxView({ trackName, laneKey }: { trackName: string; laneKey: string }) {
  return (
    <div className="shrink-0 mt-2">
      <div className="px-3 py-1 text-[10.5px] font-bold tracking-[0.15em] uppercase text-purple-300/80">
        {trackName} FX
      </div>
      <EffectChainEditor
        laneKey={laneKey}
        emptyMessage="Drag EQ, Comp, or Reverb from the sidebar to add effects to this MIDI track."
        leading={<SamplerChainCard trackId={laneKey} />}
      />
    </div>
  );
}

// Sampler device card rendered as the first device in a MIDI track's
// chain — Ableton-style. Sits inline with the EQ/Comp/Reverb cards so
// the user reads the chain left-to-right: Sampler → effects. Drop
// targets:
//   - INSTRUMENT_DRAG_MIME (sampler tile from the sidebar) → seeds an
//     empty instrument record + pops the sampler editor
//   - OS file / sample-library / project-file drops → loads the
//     sample into the instrument directly
// Same drop logic as the lane header so the user can drop in either
// place; this one just lives inside the FX panel where the chain is.
function SamplerChainCard({ trackId }: { trackId: string }) {
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const instrument = useMidiTrack((s) => s.instruments[trackId]);
  const ensureInstrument = useMidiTrack((s) => s.ensureInstrument);
  const setInstrument = useMidiTrack((s) => s.setInstrument);
  const openSampler = useMidiTrack((s) => s.openSampler);
  const [dragOver, setDragOver] = useState(false);

  const acceptDrag = (dt: DataTransfer) => (
    !!dt.files?.length
    || dt.types.includes(SAMPLE_LIBRARY_DRAG_MIME)
    || dt.types.includes('application/x-ghost-projectfile')
    || dt.types.includes(INSTRUMENT_DRAG_MIME)
  );
  const onDragOver = (e: React.DragEvent) => {
    if (!acceptDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = async (e: React.DragEvent) => {
    if (!acceptDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!projectId) return;

    const instRaw = e.dataTransfer.getData(INSTRUMENT_DRAG_MIME);
    if (instRaw) {
      try {
        const payload = JSON.parse(instRaw) as { kind: string };
        if (payload?.kind === 'sampler') {
          ensureInstrument(trackId);
          openSampler(trackId);
          return;
        }
      } catch { /* malformed — fall through */ }
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

  const hasSample = !!(instrument?.fileId || instrument?.buffer);
  const sampleName = instrument?.name || 'Empty';

  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => { ensureInstrument(trackId); openSampler(trackId); }}
      className="shrink-0 cursor-pointer rounded-xl flex flex-col overflow-hidden transition-colors"
      style={{
        // Match the EQ/Comp/Reverb chain cards' size so the device
        // chain reads as one rail. 252 px tall matches the trailing
        // drop slot height inside EffectChainEditor.
        width: 220,
        height: 252,
        background: dragOver ? 'rgba(168,85,247,0.18)' : 'linear-gradient(180deg, rgba(124,58,237,0.18) 0%, rgba(124,58,237,0.08) 100%)',
        border: dragOver ? '2px dashed rgba(168,85,247,0.85)' : '1px solid rgba(168,85,247,0.35)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
      title={hasSample
        ? `Sampler · ${sampleName} — click to edit, drop a sample to replace`
        : 'Drag a Sampler from the Instruments sidebar, or drop a sample directly'}
    >
      {/* Header strip — matches EQ/Comp panels' top bar style. */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5"
        style={{ background: 'rgba(168,85,247,0.25)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12c1-3 2-3 3 0s2 3 3 0 2-3 3 0 2 3 3 0 2-3 3 0 2 3 3 0" />
        </svg>
        <span className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-white">Sampler</span>
        <span className="ml-auto text-[8.5px] font-mono text-white/40 uppercase tracking-wider">Inst</span>
      </div>
      {/* Body — sample slot. Big drop affordance when empty, name +
          tiny waveform-ish glyph when loaded. */}
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-3 text-center">
        {hasSample ? (
          <>
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(168,85,247,0.3)', border: '1px solid rgba(168,85,247,0.55)' }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h2l3-9 4 18 3-9h6" />
              </svg>
            </div>
            <div className="text-[11.5px] font-medium text-white/90 truncate w-full">{sampleName}</div>
            <div className="text-[9.5px] uppercase tracking-wider text-purple-300/70">Click to edit</div>
          </>
        ) : (
          <>
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px dashed rgba(168,85,247,0.4)' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(168,134,255,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <div className="text-[11px] text-white/55 italic leading-snug">Drop a sample or<br/>drag the Sampler here</div>
          </>
        )}
      </div>
      {/* Footer arrow — points into the rest of the chain so the user
          reads the signal flow left-to-right. */}
      <div className="shrink-0 flex items-center justify-end px-2 py-1 text-[12px] text-white/30">→</div>
    </div>
  );
}

// Standalone view shown when the user clicks the MASTER lane (the
// gold one). EffectChainEditor renders the chain bound to
// MASTER_FX_KEY, which audioStore splices between mixerBus and
// masterGain so the entire mix (every track + drum row + return
// bus output) routes through these inserts before the destination.
function MasterFxView() {
  return (
    <div className="shrink-0 mt-2">
      <div className="px-3 py-1 text-[10.5px] font-bold tracking-[0.15em] uppercase text-yellow-300/80">
        Master FX
      </div>
      <EffectChainEditor
        laneKey={MASTER_FX_KEY}
        emptyMessage="Drag EQ, Comp, or Reverb from the sidebar to insert effects on the master output."
      />
    </div>
  );
}

function BpmEditor({ value, onChange, isOverride, disabled, mixed }: { value: number; onChange: (v: number) => void; isOverride: boolean; disabled?: boolean; mixed?: boolean }) {
  // Local text state so the user can type freely (e.g. backspace through "1"
  // without the field snapping back). Commits on Enter or blur, clamped to
  // a sane musical range. Highlights when the user has overridden the
  // detected value so they can tell at a glance.
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => { setDraft(String(Math.round(value * 100) / 100)); }, [value]);

  const commit = (v: number) => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(20, Math.min(400, v));
    onChange(Number(clamped.toFixed(2)));
  };

  return (
    <span
      className="inline-flex items-stretch rounded overflow-hidden text-[10px] font-medium"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${isOverride ? 'rgba(0,255,200,0.45)' : 'rgba(255,255,255,0.06)'}`,
        opacity: disabled ? 0.4 : 1,
        pointerEvents: disabled ? 'none' : undefined,
      }}
    >
      <span className="px-1.5 self-center text-ghost-green/80 uppercase tracking-wider text-[9px] font-semibold">BPM</span>
      <input
        type="text"
        value={mixed ? '~' : draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(parseFloat(draft)); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') { setDraft(String(Math.round(value * 100) / 100)); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={() => commit(parseFloat(draft))}
        className="w-12 bg-transparent text-white/90 text-center outline-none tabular-nums focus:bg-white/[0.06]"
      />
      <button
        onClick={() => commit(value / 2)}
        className="px-1.5 text-white/50 hover:bg-white/[0.06] hover:text-white border-l border-white/[0.06]"
        title="Half time"
      >
        /2
      </button>
      <button
        onClick={() => commit(value * 2)}
        className="px-1.5 text-white/50 hover:bg-white/[0.06] hover:text-white border-l border-white/[0.06]"
        title="Double time"
      >
        ×2
      </button>
    </span>
  );
}

function Pill({ icon, label }: { icon: 'bpm' | 'time' | 'dot'; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-white/70"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ghost-green/80">
        {icon === 'bpm' && (<><circle cx="12" cy="12" r="9" /><polyline points="12 6 12 12 16 14" /></>)}
        {icon === 'time' && (<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 13 17 13" /></>)}
        {icon === 'dot' && (<circle cx="12" cy="12" r="3" fill="currentColor" />)}
      </svg>
      {label}
    </span>
  );
}

function Slider({ label, value, min, max, step, format, onChange, mixed, defaultValue }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  mixed?: boolean;
  defaultValue?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] font-semibold text-white/60">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="tabular-nums text-white/80">{mixed ? 'Mixed' : format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => { if (defaultValue !== undefined) onChange(defaultValue); }}
        title={defaultValue !== undefined ? 'Double-click to reset' : undefined}
        className="w-full accent-ghost-green"
        style={{ opacity: mixed ? 0.6 : 1 }}
      />
    </div>
  );
}

/**
 * Ableton-style warp + transient markers above the waveform.
 *
 * - Gray downward triangles at every detected transient (`beats[]`),
 *   non-interactive — purely a visual reference for where the audio's
 *   transient onsets sit.
 * - Gold downward triangles at every user-placed warp marker
 *   (`track.warpMarkers`, in original-buffer seconds). Draggable to
 *   reposition, right-click to delete.
 * - Right-click on empty header space adds a new warp marker at the
 *   cursor's source-time position.
 *
 * For now markers are visual + persisted only — they don't yet drive
 * the WSOLA stretch engine. Hooking them into composePlayBuffer for
 * piecewise warping is a follow-up.
 */
function WarpMarkerOverlay({ trackId, beats }: { trackId: string; beats: number[] }) {
  const trimStart = useAudioStore((s) => s.loadedTracks.get(trackId)?.trimStart ?? 0);
  const trimEnd = useAudioStore((s) => s.loadedTracks.get(trackId)?.trimEnd ?? 0);
  const bufferDuration = useAudioStore((s) => s.loadedTracks.get(trackId)?.buffer?.duration ?? 0);
  const originalDuration = useAudioStore((s) => s.loadedTracks.get(trackId)?.originalBuffer?.duration ?? 0);
  const warpMarkersRaw = useAudioStore((s) => s.loadedTracks.get(trackId)?.warpMarkers ?? []);
  const setTrackWarpMarkers = useAudioStore((s) => s.setTrackWarpMarkers);

  if (bufferDuration <= 0) return null;
  const effectiveTrimEnd = trimEnd > 0 ? trimEnd : bufferDuration;

  // Stretch ratio between original and current play buffer — used both
  // to compute default bufferSec when adding a new marker, and to map
  // detected transients (in original-buffer time) to the rendered
  // waveform (in buffer time).
  const stretchRatio = originalDuration > 0 ? bufferDuration / originalDuration : 1;
  const sourceToBufferTime = (s: number) => s * stretchRatio;

  // Markers in the store are { sourceSec, bufferSec } — the bufferSec
  // is what drives both the visual position AND the piecewise stretch
  // segment lengths in composePlayBuffer.
  const warpMarkers = warpMarkersRaw;

  // Map a buffer-time value to the visible pixel position (percentage)
  // inside the trimmed waveform. Returns null if outside the trim range.
  const bufTimeToPct = (b: number): number | null => {
    if (b < trimStart || b > effectiveTrimEnd) return null;
    return ((b - trimStart) / (effectiveTrimEnd - trimStart)) * 100;
  };

  // Add a new warp marker at a given source position. Default bufferSec
  // anchors the marker to its current global-stretch position so the
  // first frame plays unchanged — drag the marker to actually warp.
  const addMarkerAtSource = (sourceTime: number) => {
    // Don't double-up if a marker is already here within ~5 ms.
    if (warpMarkers.some((m) => Math.abs(m.sourceSec - sourceTime) < 0.005)) return;
    setTrackWarpMarkers(trackId, [...warpMarkers, { sourceSec: sourceTime, bufferSec: sourceTime * stretchRatio }]);
  };

  const onHeaderContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if ((e.target as HTMLElement).closest('[data-warp-marker]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const bufTime = trimStart + pct * (effectiveTrimEnd - trimStart);
    addMarkerAtSource(bufTime / Math.max(0.0001, stretchRatio));
  };

  const onHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-warp-marker]')) return;
    if ((e.target as HTMLElement).closest('[data-transient-marker]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const bufTime = trimStart + pct * (effectiveTrimEnd - trimStart);
    addMarkerAtSource(bufTime / Math.max(0.0001, stretchRatio));
  };

  const onMarkerPointerDown = (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 2) return; // right-click handled separately
    const target = e.currentTarget;
    const rect = target.parentElement!.getBoundingClientRect();
    target.setPointerCapture?.(e.pointerId);
    // Capture sourceSec at drag start; only bufferSec changes as the
    // user drags. This is the Ableton model — the marker stays pinned
    // to the same source position, the audio between markers warps to
    // make that position land where the user drops the marker.
    const pinnedSource = warpMarkers[idx]?.sourceSec ?? 0;
    const onMove = (ev: PointerEvent) => {
      const pct = (ev.clientX - rect.left) / rect.width;
      const bufTime = trimStart + Math.max(0, Math.min(1, pct)) * (effectiveTrimEnd - trimStart);
      const next = warpMarkers.slice();
      next[idx] = { sourceSec: pinnedSource, bufferSec: bufTime };
      setTrackWarpMarkers(trackId, next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onMarkerContextMenu = (idx: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTrackWarpMarkers(trackId, warpMarkers.filter((_, i) => i !== idx));
  };

  return (
    <>
      {/* Top header strip — double-click empty space to add a warp
          marker; right-click also works (kept for parity with the
          rest of the editor). */}
      <div
        className="absolute top-0 left-0 right-0 cursor-crosshair"
        style={{ height: 12 }}
        onContextMenu={onHeaderContextMenu}
        onDoubleClick={onHeaderDoubleClick}
        title="Double-click to add a warp marker"
      />
      {/* Transient markers — gray downward triangles. Double-click
          converts a transient into a draggable warp marker, just like
          Ableton. The hit zone extends past the visible triangle so
          they're easy to click on a small waveform. */}
      {beats.map((beatSec, i) => {
        const bufTime = sourceToBufferTime(beatSec);
        const pct = bufTimeToPct(bufTime);
        if (pct === null) return null;
        return (
          <div
            key={`tr-${i}`}
            data-transient-marker
            onDoubleClick={(e) => { e.stopPropagation(); addMarkerAtSource(beatSec); }}
            className="absolute top-0 cursor-pointer"
            style={{ left: `calc(${pct}% - 6px)`, width: 12, height: 12 }}
            title="Double-click to convert to warp marker"
          >
            <div
              className="absolute pointer-events-none"
              style={{
                left: 3,
                top: 0,
                width: 0,
                height: 0,
                borderLeft: '3px solid transparent',
                borderRight: '3px solid transparent',
                borderTop: '5px solid rgba(255,255,255,0.4)',
              }}
            />
          </div>
        );
      })}
      {/* User warp markers — gold draggable triangles + a thin gold line
          straight down through the waveform so they're easy to spot.
          Position uses bufferSec (the warped-time anchor) so dragging
          a marker visually moves it where the user dropped it. */}
      {warpMarkers.map((m, i) => {
        const pct = bufTimeToPct(m.bufferSec);
        if (pct === null) return null;
        return (
          <div
            key={`warp-${i}`}
            data-warp-marker
            onPointerDown={onMarkerPointerDown(i)}
            onContextMenu={onMarkerContextMenu(i)}
            className="absolute top-0 bottom-0 cursor-ew-resize z-10"
            style={{ left: `calc(${pct}% - 6px)`, width: 12 }}
            title="Drag to move · Right-click to delete"
          >
            {/* Gold pin head */}
            <div
              className="absolute"
              style={{
                left: '50%',
                top: 0,
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '5px solid transparent',
                borderRight: '5px solid transparent',
                borderTop: '8px solid #F5C518',
                filter: 'drop-shadow(0 0 4px rgba(245,197,24,0.6))',
              }}
            />
            {/* Vertical line through the waveform */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: '50%',
                top: 7,
                bottom: 0,
                width: 1,
                background: 'rgba(245,197,24,0.55)',
                boxShadow: '0 0 4px rgba(245,197,24,0.4)',
              }}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * Bar-line overlay for the sample editor's big waveform. Computes how
 * many bars the trimmed clip spans at the current project tempo and
 * draws a faint vertical line at each bar boundary. Same look as the
 * arrangement's BarGridOverlay, scoped to one clip.
 */
function SampleEditorBarGrid({ trackId }: { trackId: string }) {
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const trimStart = useAudioStore((s) => s.loadedTracks.get(trackId)?.trimStart ?? 0);
  const trimEnd = useAudioStore((s) => s.loadedTracks.get(trackId)?.trimEnd ?? 0);
  const bufferDuration = useAudioStore((s) => s.loadedTracks.get(trackId)?.buffer?.duration ?? 0);
  const pitch = useAudioStore((s) => s.loadedTracks.get(trackId)?.pitch ?? 0);

  if (bufferDuration <= 0 || projectBpm <= 0) return null;

  const playbackRate = Math.pow(2, pitch / 12);
  const effectiveTrimEnd = trimEnd > 0 ? trimEnd : bufferDuration;
  const clipDurTimeline = (effectiveTrimEnd - trimStart) / Math.max(0.0001, playbackRate);
  const barSec = 240 / projectBpm;
  const numBars = Math.max(1, Math.round(clipDurTimeline / barSec));

  // Bright line every `labeledStep` bars (matches the arrangement's
  // overlay density), dim line on every bar in between.
  const labeledStep = numBars <= 8 ? 1 : numBars <= 16 ? 2 : numBars <= 32 ? 4 : 8;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {Array.from({ length: numBars + 1 }).map((_, i) => {
        const isLabeled = i % labeledStep === 0;
        const leftPct = (i / numBars) * 100;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{
              left: `${leftPct}%`,
              width: 1,
              background: isLabeled ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
            }}
          />
        );
      })}
    </div>
  );
}
