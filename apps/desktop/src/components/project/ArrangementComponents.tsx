import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { useAudioStore, pendingTrackOffsets, pendingTrackProps } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { useCollabStore } from '../../stores/collabStore';
import { api } from '../../lib/api';
import { snapToGrid } from '../../lib/audio';
import { getSocket } from '../../lib/socket';
import Waveform from '../tracks/Waveform';
import Avatar from '../common/Avatar';
import { useDrumRack } from '../../stores/drumRackStore';
import { useMidiTrack } from '../../stores/midiTrackStore';
import MidiLane from './MidiLane';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';
import { useEffectsStore, EFFECT_DRAG_MIME, EFFECT_HUE, DRUM_RACK_FX_KEY, laneKeyOf, type EffectKind } from '../../stores/effectsStore';
import { DRUM_RACK_LANE_KEY, DrumRackLanes } from './DrumRackArrangement';
import { LaneClip } from './LaneClip';

export { DRUM_RACK_LANE_KEY } from './DrumRackArrangement';

export type Member = { userId: string; displayName: string; avatarUrl: string | null };

// Width of the FL-Studio-style track header column on the left of every
// lane. BarRuler and ArrangementPlayhead both pad/offset by this so their
// time axis stays aligned with the clip area, NOT the headers.
export const TRACK_HEADER_WIDTH = 110;

// Same hue palette the Waveform uses, so the lane header's accent strip
// always matches the colour of the clips inside it.
const LANE_HUE_PALETTE = [270, 165, 300, 220, 190, 330];

// Tiny chip strip rendered in the track header's top row. Shows up to 3
// effect kind initials; if more are present, a "+N" trailer summarises.
// Bypassed effects render at 30 % opacity so the strip still answers
// "what's on this track" at a glance. Reads the chain by laneKey so
// every clip in the same lane sees the same chips.
export function HeaderEffectChips({ laneKey }: { laneKey: string }) {
  // Subscribe to byProject so the chip strip re-renders on add / remove /
  // bypass-toggle / reorder. getChain reads off currentProjectId inside
  // the store closure.
  const byProject = useEffectsStore((s) => s.byProject);
  void byProject;
  const chain = useEffectsStore((s) => s.getChain(laneKey));
  if (!chain || chain.length === 0) return null;
  const visible = chain.slice(0, 3);
  const extra = chain.length - visible.length;
  const initial: Record<EffectKind, string> = { eq: 'EQ', comp: 'CP', reverb: 'RV' };
  return (
    <span className="shrink-0 flex items-center gap-0.5 mr-1">
      {visible.map((fx) => {
        const hue = EFFECT_HUE[fx.kind];
        return (
          <span
            key={fx.id}
            className="text-[7px] font-bold tracking-wide rounded-sm px-1 py-px"
            style={{
              background: `hsla(${hue}, 80%, 50%, ${fx.bypassed ? 0.10 : 0.25})`,
              color: fx.bypassed ? 'rgba(255,255,255,0.35)' : `hsl(${hue}, 90%, 80%)`,
              border: `1px solid hsla(${hue}, 80%, 60%, ${fx.bypassed ? 0.15 : 0.4})`,
              textShadow: 'none',
            }}
            title={`${fx.kind.toUpperCase()}${fx.bypassed ? ' (bypassed)' : ''}`}
          >
            {initial[fx.kind]}
          </span>
        );
      })}
      {extra > 0 && (
        <span className="text-[7px] font-bold text-white/60 px-1">+{extra}</span>
      )}
    </span>
  );
}

function laneHueForKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return LANE_HUE_PALETTE[Math.abs(h) % LANE_HUE_PALETTE.length];
}

// Real-time level meter for a lane. Reads each track's AnalyserNode
// (created in startAllSources) once per frame, takes the peak deviation
// from the silent centre, and renders a vertical fill on the lane header.
// Decays smoothly when audio drops (smoothingTimeConstant on the analyser
// handles the actual audio envelope; we mostly just clamp + map to UI).
function LaneLevelMeter({ trackIds }: { trackIds: string[] }) {
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const idsKey = trackIds.join(',');

  useEffect(() => {
    let raf = 0;
    const buf = new Uint8Array(128);
    let lastDisplayed = 0;
    const tick = () => {
      let peak = 0;
      const tracks = useAudioStore.getState().loadedTracks;
      for (const id of trackIds) {
        const t = tracks.get(id);
        if (t?.analyser) {
          t.analyser.getByteTimeDomainData(buf);
          let p = 0;
          for (let i = 0; i < buf.length; i++) {
            const dev = Math.abs(buf[i] - 128);
            if (dev > p) p = dev;
          }
          if (p > peak) peak = p;
        }
      }
      // Map 0..128 → 0..1 and apply a mild attack/release so the meter
      // tracks audio without flickering on every frame.
      const target = peak / 128;
      const next = target > lastDisplayed ? target : lastDisplayed * 0.85 + target * 0.15;
      lastDisplayed = next;
      const el = fillRef.current;
      if (el) el.style.height = `${Math.min(100, next * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idsKey, isPlaying]);

  return (
    <div
      className="relative shrink-0 rounded-sm overflow-hidden"
      style={{
        width: 4,
        height: '70%',
        background: 'rgba(0,0,0,0.45)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
      }}
    >
      <div
        ref={fillRef}
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: '0%',
          // Classic VU gradient — green at the bottom for safe levels,
          // amber in the middle, red near clipping.
          background: 'linear-gradient(180deg, #ff4d4d 0%, #ffd24d 25%, #4dff8c 60%, #2bd16f 100%)',
          transition: 'height 0.05s linear',
        }}
      />
    </div>
  );
}

export function TrackHeader({ name, hue, isSelected, trackIds, laneKey, meter, controls }: {
  name: string;
  hue: number;
  isSelected?: boolean;
  trackIds: string[];
  // The lane's stable identifier (fileId for normal tracks; trackId for
  // drum-rack rows). Effects keyed by laneKey so all clips in the lane
  // share one chain. Optional because some headers (drum rack, drum
  // rows) don't represent FX-bearing lanes.
  laneKey?: string;
  // Optional override for the level-meter strip on the right edge of
  // the header. Defaults to LaneLevelMeter (per-track analyser tap).
  // Pass <DrumRackLevelMeter /> or <DrumRowLevelMeter rowId=… /> for
  // lanes that aren't backed by per-track analysers.
  meter?: React.ReactNode;
  // Optional Mute / Solo / FX-bus-send controls for regular track lanes.
  // Drum rack and drum-row headers don't pass this; they keep the
  // simple single-row layout.
  controls?: {
    muted: boolean;
    soloed: boolean;
    busSend: number;          // 0..1
    onToggleMute: () => void;
    onToggleSolo: () => void;
    onSendChange: (v: number) => void;
  };
}) {
  // Solid block fill (FL Studio playlist style) — saturated colour, full
  // lane height, name across the top, accent dot on the right.
  const fill = `hsl(${hue}, 38%, 30%)`;
  const accent = `hsl(${hue}, 80%, 60%)`;
  const cleanName = name.replace(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i, '').replace(/_/g, ' ');

  // When controls are provided, render the dense two-row layout: name +
  // accent dot on top, M / S buttons + send slider + meter on bottom.
  if (controls) {
    return (
      <div
        className="relative shrink-0 select-none flex flex-col gap-0.5 px-1.5 py-1 rounded-l-md overflow-hidden"
        style={{
          width: TRACK_HEADER_WIDTH,
          height: '100%',
          background: fill,
          borderRight: `2px solid ${accent}`,
          boxShadow: isSelected ? `inset 0 0 0 1px ${accent}` : 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.25)',
        }}
        title={cleanName}
      >
        <div className="flex items-center gap-1 min-h-0">
          <span className="text-[10px] font-semibold text-white/95 truncate flex-1" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
            {cleanName}
          </span>
          <HeaderEffectChips laneKey={laneKey ?? trackIds[0] ?? ''} />
          <span
            className="shrink-0 w-1.5 h-1.5 rounded-full"
            style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
          />
        </div>
        <div className="flex items-center gap-1 mt-auto" onPointerDown={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => { e.stopPropagation(); controls.onToggleMute(); }}
            className="w-4 h-4 flex items-center justify-center rounded text-[8px] font-bold transition-colors"
            style={{
              background: controls.muted ? 'rgba(239,68,68,0.7)' : 'rgba(0,0,0,0.35)',
              color: controls.muted ? '#fff' : 'rgba(255,255,255,0.7)',
            }}
            title={controls.muted ? 'Unmute' : 'Mute'}
          >M</button>
          <button
            onClick={(e) => { e.stopPropagation(); controls.onToggleSolo(); }}
            className="w-4 h-4 flex items-center justify-center rounded text-[8px] font-bold transition-colors"
            style={{
              background: controls.soloed ? 'rgba(250,204,21,0.85)' : 'rgba(0,0,0,0.35)',
              color: controls.soloed ? '#000' : 'rgba(255,255,255,0.7)',
            }}
            title={controls.soloed ? 'Unsolo' : 'Solo'}
          >S</button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={controls.busSend}
            onChange={(e) => controls.onSendChange(parseFloat(e.target.value))}
            onDoubleClick={(e) => { e.stopPropagation(); controls.onSendChange(0); }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 h-1 cursor-pointer accent-white"
            style={{ minWidth: 0 }}
            title={`FX bus send — ${Math.round(controls.busSend * 100)}%. Double-click to reset.`}
          />
          {meter ?? <LaneLevelMeter trackIds={trackIds} />}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative shrink-0 select-none flex items-center gap-1.5 px-2 rounded-l-md overflow-hidden"
      style={{
        width: TRACK_HEADER_WIDTH,
        height: '100%',
        background: fill,
        borderRight: `2px solid ${accent}`,
        boxShadow: isSelected ? `inset 0 0 0 1px ${accent}` : 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.25)',
      }}
      title={cleanName}
    >
      <span className="text-[11px] font-semibold text-white/95 truncate flex-1" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
        {cleanName}
      </span>
      {laneKey && <HeaderEffectChips laneKey={laneKey} />}
      <span
        className="shrink-0 w-1.5 h-1.5 rounded-full"
        style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
      />
      {meter ?? <LaneLevelMeter trackIds={trackIds} />}
    </div>
  );
}

/**
 * Generic level meter that taps any AnalyserNode. Used by the drum-rack
 * lane (sum of all drum rows via drumAnalyser) and per-row sub-lanes
 * (individual row analysers tracked in drumRackStore.rowAnalysers).
 * Mirrors LaneLevelMeter's 4 px VU strip styling so every meter in the
 * arrangement reads the same.
 */
export function AnalyserMeter({ getNode }: { getNode: () => AnalyserNode | null }) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const buf = new Float32Array(256);
    let lastDisplayed = 0;
    const tick = () => {
      const a = getNode();
      if (a) {
        a.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const abs = buf[i] < 0 ? -buf[i] : buf[i];
          if (abs > peak) peak = abs;
        }
        const next = peak > lastDisplayed ? peak : lastDisplayed * 0.85 + peak * 0.15;
        lastDisplayed = next;
        if (fillRef.current) fillRef.current.style.height = `${Math.min(100, next * 100)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getNode]);
  return (
    <div
      className="relative shrink-0 rounded-sm overflow-hidden"
      style={{ width: 4, height: '70%', background: 'rgba(0,0,0,0.45)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)' }}
    >
      <div
        ref={fillRef}
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: '0%',
          background: 'linear-gradient(180deg, #ff4d4d 0%, #ffd24d 25%, #4dff8c 60%, #2bd16f 100%)',
          transition: 'height 0.05s linear',
        }}
      />
    </div>
  );
}

/* ── Drop zone for uploading audio files ── */
export function ArrangementDropZone({ projectId, onFilesAdded, children }: { projectId: string; onFilesAdded: () => void; children: React.ReactNode }) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // First: a Sample Library drag — no upload needed, server copies storage.
    const libPayload = e.dataTransfer.getData(SAMPLE_LIBRARY_DRAG_MIME);
    if (libPayload) {
      try {
        const { id } = JSON.parse(libPayload);
        if (id) {
          await api.copySampleLibraryFileToProject(id, projectId);
          window.dispatchEvent(new CustomEvent('ghost-storage-changed'));
          onFilesAdded();
          return;
        }
      } catch { /* fall through to file drop */ }
    }
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i)
    );
    if (droppedFiles.length === 0) return;
    for (const file of droppedFiles) {
      const { fileId } = await api.uploadFile(projectId, file);
      const trackName = file.name.replace(/\.[^.]+$/, '');
      await api.addTrack(projectId, { name: trackName, type: 'fullmix', fileId, fileName: file.name } as any);
    }
    window.dispatchEvent(new CustomEvent('ghost-storage-changed'));
    onFilesAdded();
  };

  return (
    <div
      className={`relative transition-all ${dragOver ? 'ring-2 ring-ghost-green/50 ring-inset' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {children}
      {dragOver && (
        <div className="absolute inset-0 bg-ghost-green/5 pointer-events-none z-30 rounded-xl" />
      )}
    </div>
  );
}

const BARS_PER_VIEW = 8;

export function ArrangementScrollView({ children, showAll }: { children: React.ReactNode; showAll?: boolean }) {
  const { numBars, arrangementDur } = useArrangement();
  const currentTime = useAudioStore((s) => s.currentTime);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Right-click → "+ Add track" context menu. Track headers, lanes,
  // and clips all stopPropagation on their own right-click handlers
  // so this only fires when the user clicks empty arrangement space.
  // Anchored in screen coords; window-level mousedown / Escape
  // dismiss it. Adding routes through the same api.addTrack +
  // ghost-refresh-project flow as AddMidiTrackButton.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!addMenu) return;
    const onDown = () => setAddMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [addMenu]);

  const addTrack = async (type: 'audio' | 'midi') => {
    const projectId = useProjectStore.getState().currentProject?.id;
    if (!projectId) return;
    const name = type === 'midi' ? 'MIDI' : 'Audio';
    try {
      await api.addTrack(projectId, { name, type: type as any } as any);
      // MIDI tracks no longer get an auto-created instrument — the
      // Sampler is opt-in via drag-drop on the lane header or the
      // track's FX chain.
      window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
    } catch { /* server error — user can retry */ }
  };

  // Inner wrapper is wider than the viewport so only BARS_PER_VIEW bars show
  // at a time. When showAll is on, the whole arrangement is fit to the
  // viewport. When numBars ≤ BARS_PER_VIEW, we already fit without scrolling.
  const innerWidthPct = showAll ? 100 : Math.max(100, (numBars / BARS_PER_VIEW) * 100);

  // Auto-follow: once the playhead leaves the visible range, page forward (or
  // back, if the user seeked) so the playhead stays on screen. Skipped when
  // showAll is on — the whole arrangement is already in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying || arrangementDur <= 0 || showAll) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const playheadX = (currentTime / arrangementDur) * inner.clientWidth;
    const viewStart = el.scrollLeft;
    const viewEnd = viewStart + el.clientWidth;
    if (playheadX > viewEnd) {
      const maxScroll = Math.max(0, inner.clientWidth - el.clientWidth);
      el.scrollTo({ left: Math.min(maxScroll, viewStart + el.clientWidth), behavior: 'smooth' });
    } else if (playheadX < viewStart) {
      el.scrollTo({ left: Math.max(0, playheadX - 20), behavior: 'smooth' });
    }
  }, [currentTime, isPlaying, arrangementDur, showAll]);

  // When toggling back to 8-bar view, reset scroll so the playhead is visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || showAll) return;
    el.scrollTo({ left: 0, behavior: 'auto' });
  }, [showAll]);

  return (
    <div
      ref={scrollRef}
      className="relative overflow-x-auto"
      style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(124,58,237,0.3) transparent' }}
      onContextMenu={(e) => {
        // Lane / track-header / clip onContextMenu handlers all
        // preventDefault() + stopPropagation, so this only fires on
        // empty arrangement space — exactly where the user expects an
        // "add track" affordance.
        e.preventDefault();
        setAddMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="relative" style={{ width: `${innerWidthPct}%` }}>
        {children}
      </div>
      {addMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] min-w-[170px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{
            left: addMenu.x, top: addMenu.y,
            background: 'rgba(20, 12, 30, 0.96)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            onClick={() => { setAddMenu(null); addTrack('midi'); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-white/80 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="20" height="12" rx="1" />
              <line x1="6" y1="6" x2="6" y2="14" />
              <line x1="10" y1="6" x2="10" y2="14" />
              <line x1="14" y1="6" x2="14" y2="14" />
              <line x1="18" y1="6" x2="18" y2="14" />
            </svg>
            Add MIDI track
          </button>
          <button
            onClick={() => { setAddMenu(null); addTrack('audio'); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-white/80 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h2l3-9 4 18 3-9h6" />
            </svg>
            Add audio track
          </button>
        </div>
      )}
    </div>
  );
}

// Shared time axis for the arrangement: at least 16 bars wide, stretches to
// cover the longest clip. Ruler, clips, and playhead all position against this
// so they stay aligned regardless of BPM or project length.
export function useArrangement() {
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const duration = useAudioStore((s) => s.duration);
  // audioStore's `duration` only reflects loaded audio tracks. MIDI
  // and drum clips live in sibling stores, so a clip dropped past the
  // end of audio content wouldn't extend the ruler — bar markers
  // would stop short of where the user could clearly see their clip.
  // Pull both stores in and fold them into the max.
  const midiClips = useMidiTrack((s) => s.clips);
  const drumClips = useDrumRack((s) => s.clips);
  const bpm = projectBpm > 0 ? projectBpm : 120;
  const barSec = 240 / bpm;
  let contentEnd = duration || 0;
  for (const c of midiClips) {
    const end = c.startSec + c.lengthSec;
    if (end > contentEnd) contentEnd = end;
  }
  for (const c of drumClips) {
    const end = c.startSec + c.lengthSec;
    if (end > contentEnd) contentEnd = end;
  }
  // Always keep a generous headroom of empty bars past the last clip
  // so the ruler reads as "infinite" — Ableton-style. The user can
  // scroll right and find more grid to drop clips onto instead of
  // hitting an abrupt end. 16 bars is enough that even a fast drag
  // won't run off the visible grid in one motion.
  const HEADROOM_BARS = 16;
  const contentBars = Math.ceil(contentEnd / barSec);
  const numBars = Math.max(16, contentBars + HEADROOM_BARS);
  const arrangementDur = numBars * barSec;
  return { bpm, barSec, arrangementDur, numBars };
}

export function BarRuler() {
  const { numBars, arrangementDur, bpm } = useArrangement();
  const seekTo = useAudioStore((s) => s.seekTo);
  const gridDivision = useAudioStore((s) => s.gridDivision);
  // Thin the label density as bar count grows so text doesn't crowd.
  const step = numBars <= 24 ? 2 : numBars <= 48 ? 4 : numBars <= 96 ? 8 : 16;

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (arrangementDur <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const raw = ratio * arrangementDur;
    // Snap the playhead to the active grid subdivision (Bar / 1/2 / 1/4
    // / 1/8 / 1/16). gridDivision = 0 means free movement; pass through.
    const snapped = gridDivision > 0
      ? Math.max(0, Math.min(arrangementDur, snapToGrid(raw, bpm, gridDivision, 'nearest')))
      : raw;
    seekTo(snapped);
  };

  return (
    <div className="flex h-[18px] w-full select-none" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      {/* Header-column spacer keeps the time grid aligned with the clip
          area below — bar 1 sits at the same x as the leftmost clip. */}
      <div style={{ width: TRACK_HEADER_WIDTH }} className="shrink-0" />
      <div
        className="relative flex-1 cursor-pointer"
        onClick={handleSeek}
        title="Click to seek"
      >
        {Array.from({ length: numBars }).map((_, i) => {
          const leftPct = (i / numBars) * 100;
          const labeled = i % step === 0;
          return (
            <div key={i} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${leftPct}%` }}>
              <div className="absolute top-0 left-0" style={{ width: 1, height: labeled ? 7 : 4, background: 'rgba(255,255,255,0.22)' }} />
              {labeled && (
                <span className="absolute left-[3px] top-[7px] text-[9px] leading-none font-medium tracking-wider text-white/35">
                  {i + 1}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
// Full-height vertical bar lines — same density as the BarRuler, drawn as
// an overlay over the lane area so the time grid runs continuously top to
// bottom (FL Studio playlist look). Renders ON TOP of clips with low
// opacity + pointer-events:none so it reads through them without blocking
// any interaction. Lines on labeled bars are brighter; in-between bars
// are dimmer for context.
export function BarGridOverlay() {
  const { numBars } = useArrangement();
  // Two-tier density. `labeledStep` = bright lines that align with the
  // labeled BarRuler ticks. `minorStep` = how often a dim line is drawn
  // in between. Past ~64 bars the dim in-between lines start crowding,
  // so we drop them and the grid stays readable in fit-all-bars view.
  const labeledStep = numBars <= 24 ? 2 : numBars <= 48 ? 4 : numBars <= 96 ? 8 : 16;
  const minorStep = numBars <= 16 ? 1 : numBars <= 32 ? 1 : numBars <= 64 ? 2 : numBars <= 128 ? 4 : 8;
  return (
    <div
      className="absolute pointer-events-none"
      style={{ left: TRACK_HEADER_WIDTH, top: 0, bottom: 0, right: 0, zIndex: 15 }}
    >
      {Array.from({ length: numBars }).map((_, i) => {
        // Skip the line entirely if it isn't on the labeled step or the
        // minor step — keeps the grid clean at high bar counts.
        const isLabeled = i % labeledStep === 0;
        if (!isLabeled && i % minorStep !== 0) return null;
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

/* ── Playhead across all lanes ── */
export function ArrangementPlayhead() {
  const currentTime = useAudioStore((s) => s.currentTime);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const soloPlayingTrackId = useAudioStore((s) => s.soloPlayingTrackId);
  const { arrangementDur } = useArrangement();

  if (soloPlayingTrackId) return null;
  const showLocal = isPlaying || currentTime > 0;
  const localPct = arrangementDur > 0 ? (currentTime / arrangementDur) * 100 : 0;

  // Collaborator ghost playheads removed by design — playback is per-user
  // and showing other people's positions on your timeline was confusing
  // when multiple people scrub different sections.
  const remotes: Array<{ userId: string; pct: number; colour: string; displayName: string; isPlaying: boolean }> = [];

  return (
    // Wrapper offset by the track-header column so percentages map to the
    // CLIP area only — playhead at 0% sits at the leftmost clip edge, not
    // the leftmost header.
    <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: TRACK_HEADER_WIDTH, right: 0 }}>
      {remotes.map((r) => (
        <div
          key={r.userId}
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none z-[18]"
          style={{
            left: `${Math.min(r.pct, 100)}%`,
            background: r.colour,
            opacity: r.isPlaying ? 0.75 : 0.35,
            boxShadow: `0 0 5px ${r.colour}`,
          }}
          title={`${r.displayName}${r.isPlaying ? ' (playing)' : ''}`}
        />
      ))}
      {showLocal && (
        <div
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none z-20"
          style={{ left: `${Math.min(localPct, 100)}%`, background: '#00FFC8', boxShadow: '0 0 6px rgba(0,255,200,0.5)' }}
        />
      )}
    </div>
  );
}

/* ── Single lane row ── */
// One reorderable lane. Drag is gated to the track header on the left so
// pointer-down on a clip / empty clip space behaves exactly like before
// (clip drag, marquee, etc.). useDragControls + dragListener=false is the
// framer-motion idiom for "drag only when I tell you to."
function LaneRow({ laneKey, laneTracks, laneHeight, selectedProjectId, deleteTrack, trackZoom, members }: {
  laneKey: string;
  laneTracks: any[];
  laneHeight: number;
  selectedProjectId: string;
  deleteTrack: any;
  trackZoom: 'full' | 'half';
  members: Member[];
}) {
  const dragControls = useDragControls();
  const hue = laneHueForKey(laneKey);
  const laneName = laneTracks[0]?.name || 'Track';
  const setTrackMuted = useAudioStore((s) => s.setTrackMuted);
  const setTrackSoloed = useAudioStore((s) => s.setTrackSoloed);
  const setTrackBusSend = useAudioStore((s) => s.setTrackBusSend);
  // True if every clip in this lane is currently muted — drives the
  // menu toggle's checkmark + label.
  const laneIsMuted = useAudioStore((s) => {
    const ids = laneTracks.map((t: any) => t.id);
    if (ids.length === 0) return false;
    return ids.every((id: string) => s.loadedTracks.get(id)?.muted === true);
  });
  // Lane-level solo/send mirrors the FIRST loaded clip in the lane —
  // every other clip in the same lane gets the same value when the user
  // toggles. Picking "first clip" matches how mute already works.
  const laneIsSoloed = useAudioStore((s) => {
    const first = laneTracks[0]?.id;
    return first ? s.loadedTracks.get(first)?.soloed === true : false;
  });
  const laneBusSend = useAudioStore((s) => {
    const first = laneTracks[0]?.id;
    return first ? (s.loadedTracks.get(first)?.busSend ?? 0) : 0;
  });
  const toggleLaneSolo = () => {
    const target = !laneIsSoloed;
    for (const t of laneTracks) setTrackSoloed(t.id, target);
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  };
  const setLaneBusSend = (v: number) => {
    for (const t of laneTracks) setTrackBusSend(t.id, v);
  };
  // Right-click menu on the header (anchor in screen coords).
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

  const toggleLaneMute = () => {
    const target = !laneIsMuted;
    for (const t of laneTracks) setTrackMuted(t.id, target);
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  };

  const deleteLane = async () => {
    const count = laneTracks.length;
    const cleanName = laneName.replace(/\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i, '');
    if (!window.confirm(`Delete the entire "${cleanName}" track? This removes ${count} clip${count === 1 ? '' : 's'} from the arrangement.`)) return;
    for (const t of laneTracks) {
      useAudioStore.getState().removeTrack(t.id);
      try { await deleteTrack(selectedProjectId, t.id); } catch { /* keep going */ }
    }
    window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
  };

  // Effect-drop target: when a chip is dragged from the sidebar's
  // Effects section, accept the drop and append the new effect to this
  // lane's primary track id. Other drags (clip drags, sample-library
  // drags) must NOT call preventDefault so they stay on the existing
  // codepaths.
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
      // Effects are lane-scoped — every clip in the same lane shares
      // one chain so an EQ on the "vocals" lane processes every
      // vocal clip through it.
      if (!laneKey || !payload?.kind) return;
      useEffectsStore.getState().add(laneKey, payload.kind);
    } catch { /* malformed payload — ignore */ }
  };

  return (
    <Reorder.Item
      value={laneKey}
      dragListener={false}
      dragControls={dragControls}
      className="flex"
      style={{ height: laneHeight, position: 'relative' }}
      whileDrag={{ scale: 1.005, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      transition={{ duration: 0.15 }}
      as="div"
      onDragOver={onFxDragOver}
      onDragEnter={onFxDragOver}
      onDragLeave={onFxDragLeave}
      onDrop={onFxDrop}
    >
      {/* Track header is the drag handle. data-track-header lets the
          marquee handler bail out without starting a rubber-band. */}
      <div
        data-track-header
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          dragControls.start(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHeaderMenu({ x: e.clientX, y: e.clientY });
        }}
        className="h-full flex"
        style={{ cursor: 'grab' }}
      >
        <TrackHeader
          name={laneName}
          hue={hue}
          trackIds={laneTracks.map((t: any) => t.id)}
          laneKey={laneKey}
          isSelected={laneIsMuted}
          controls={{
            muted: laneIsMuted,
            soloed: laneIsSoloed,
            busSend: laneBusSend,
            onToggleMute: toggleLaneMute,
            onToggleSolo: toggleLaneSolo,
            onSendChange: setLaneBusSend,
          }}
        />
      </div>
      <div
        className="relative rounded-r-lg flex-1"
        style={{
          background: 'rgba(10,4,18,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          opacity: laneIsMuted ? 0.45 : 1,
          transition: 'opacity 0.15s linear',
        }}
      >
        {laneTracks.map((track: any, idx: number) => (
          <LaneClip
            key={track.id}
            track={track}
            selectedProjectId={selectedProjectId}
            deleteTrack={deleteTrack}
            trackZoom={trackZoom}
            laneWidth={100}
            clipIndex={idx}
            totalClips={laneTracks.length}
            members={members}
          />
        ))}
        {fxDragOver && (
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
              Drop to add effect
            </span>
          </div>
        )}
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
            onClick={() => { setHeaderMenu(null); toggleLaneMute(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {laneIsMuted ? (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              ) : (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </>
              )}
            </svg>
            {laneIsMuted ? 'Unmute track' : 'Mute track'}
          </button>
          <button
            onClick={() => { setHeaderMenu(null); deleteLane(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            Delete entire track
          </button>
        </div>
      )}
    </Reorder.Item>
  );
}

/* ── Track lanes with horizontal clips ── */
export function DraggableTrackList({ tracks, selectedProjectId, deleteTrack, updateTrack, trackZoom, fetchProject, members = [] }: {
  tracks: any[];
  selectedProjectId: string;
  deleteTrack: any;
  updateTrack: any;
  trackZoom: 'full' | 'half';
  fetchProject: any;
  members?: Member[];
}) {
  const bufferVersion = useAudioStore((s) => s.bufferVersion);

  const loadedTracks = useAudioStore((s) => s.loadedTracks);
  const setTrackOffset = useAudioStore((s) => s.setTrackOffset);
  // Tracks we've already seeded an initial offset for. Prevents re-seeding
  // after the user drags a clip, and also prevents double-seeding if the
  // effect fires repeatedly while a newly-duplicated track is decoding.
  const seededRef = useRef<Set<string>>(new Set());

  // Group tracks by fileId — same file = same lane, clips side by side
  const lanes = tracks.reduce((acc: Map<string, any[]>, track: any) => {
    const key = track.fileId || track.id;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key)!.push(track);
    return acc;
  }, new Map<string, any[]>());

  // If the server has a non-empty persisted arrangement, trust it and skip
  // the seeder — otherwise default idx*clipDur positions would stomp on the
  // user's saved drags after the restore applies. An empty clips array is
  // treated as "no arrangement yet" so fresh projects still get seeded.
  const hasServerArrangement = useProjectStore((s) => {
    const raw = s.currentProject?.arrangementJson;
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.clips) && parsed.clips.length > 0;
    } catch {
      return false;
    }
  });

  // Seed startOffsets for never-positioned duplicate clips so they land side
  // by side on FIRST load (before anything is saved). Once the server owns
  // an arrangement, this effect no-ops.
  useEffect(() => {
    if (hasServerArrangement) return;
    lanes.forEach((laneTracks) => {
      if (laneTracks.length <= 1) return;
      const firstBuffer = loadedTracks.get(laneTracks[0].id)?.buffer;
      if (!firstBuffer) return;
      const clipDur = firstBuffer.duration;
      laneTracks.forEach((t: any, idx: number) => {
        if (idx === 0) return;
        if (seededRef.current.has(t.id)) return;
        const loaded = loadedTracks.get(t.id);
        if (!loaded) return;
        if (loaded.startOffset === 0) {
          setTrackOffset(t.id, idx * clipDur);
        }
        seededRef.current.add(t.id);
      });
    });
  }, [tracks.length, bufferVersion, loadedTracks, hasServerArrangement]);

  // When the project changes, forget what we've seeded so the new project
  // starts clean.
  useEffect(() => {
    seededRef.current.clear();
  }, [selectedProjectId]);

  const laneHeight = trackZoom === 'half' ? 50 : 72;

  // Marquee (rubber-band) multi-select. Pointer down on empty lane space
  // starts it; on release every clip whose bounding rect intersects the
  // marquee is dumped into the selection. Hit-testing via the data-clip-id
  // attribute on LaneClip — cheaper than maintaining a rect cache, and
  // accurate regardless of how the arrangement was scrolled/zoomed.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<null | { x1: number; y1: number; x2: number; y2: number }>(null);
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);
  const clearSelection = useAudioStore((s) => s.clearSelection);

  // Lane order lives in the audio store and is round-tripped through the
  // server's arrangement blob — every collaborator sees the same vertical
  // layout. Reordering dispatches a flush so the change syncs instantly.
  const laneOrder = useAudioStore((s) => s.laneOrder);
  const setLaneOrderStore = useAudioStore((s) => s.setLaneOrder);
  const handleReorder = useCallback((next: string[]) => {
    setLaneOrderStore(next);
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  }, [setLaneOrderStore]);

  const orderedLaneKeys = useMemo(() => {
    // Inject the drum-rack sentinel so it lives inside the same Reorder
    // group and can be dragged up/down with the other lanes.
    const keys = [DRUM_RACK_LANE_KEY, ...Array.from(lanes.keys())];
    const indexOf = new Map(laneOrder.map((k, i) => [k, i]));
    // Stable sort: lanes the user has already arranged keep their slot;
    // brand-new lanes (and a never-reordered drum rack) land at the
    // bottom in insertion order.
    return keys.sort((a, b) => {
      const ia = indexOf.get(a) ?? Infinity;
      const ib = indexOf.get(b) ?? Infinity;
      return ia - ib;
    });
  }, [lanes, laneOrder]);

  const handleMarqueeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't start a marquee if the user actually grabbed a clip OR a track
    // header (which now drags the whole lane up/down).
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip-id]')) return;
    if (target.closest('[data-track-header]')) return;
    if (e.button !== 0) return;
    const root = containerRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    // Plain click on empty space clears the selection immediately. If this
    // turns into a drag, the marquee will replace it with its own set.
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) clearSelection();
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      dragged = true;
      setMarquee({ x1: startX, y1: startY, x2: ev.clientX, y2: ev.clientY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragged) { setMarquee(null); return; }
      // Read final marquee rect and hit-test every clip.
      const minX = Math.min(startX, (window as any).__lastMoveX ?? startX);
      setMarquee((m) => {
        if (!m) return null;
        const nx1 = Math.min(m.x1, m.x2), ny1 = Math.min(m.y1, m.y2);
        const nx2 = Math.max(m.x1, m.x2), ny2 = Math.max(m.y1, m.y2);
        const hits = new Set<string>();
        const extant = useAudioStore.getState().selectedTrackIds;
        // Preserve existing selection when Shift/Ctrl is held.
        if (e.shiftKey || e.ctrlKey || e.metaKey) for (const id of extant) hits.add(id);
        root.querySelectorAll<HTMLElement>('[data-clip-id]').forEach((el) => {
          const cr = el.getBoundingClientRect();
          const intersects = !(cr.right < nx1 || cr.left > nx2 || cr.bottom < ny1 || cr.top > ny2);
          if (intersects) {
            const id = el.getAttribute('data-clip-id');
            if (id) hits.add(id);
          }
        });
        setSelectedTrackIds(hits);
        return null;
      });
      void minX;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    void rect;
  };

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col gap-1 mt-2"
      onPointerDown={handleMarqueeStart}
    >
      <Reorder.Group
        axis="y"
        values={orderedLaneKeys}
        onReorder={handleReorder}
        className="flex flex-col gap-1"
        as="div"
      >
        {orderedLaneKeys.map((laneKey) => {
          if (laneKey === DRUM_RACK_LANE_KEY) {
            // The drum rack rides the same Reorder group; it owns its
            // own Reorder.Item internally so the chevron expansion +
            // sub-lanes move as one block.
            return <DrumRackLanes key={laneKey} laneHeight={laneHeight} />;
          }
          const laneTracks = lanes.get(laneKey);
          if (!laneTracks) return null;
          // MIDI tracks render their own lane component — they don't
          // share the audio LaneRow geometry because they have a
          // different header (sample drop + instrument readout) and
          // their clips live in the midiTrackStore, not loadedTracks.
          if (laneTracks[0]?.type === 'midi') {
            return (
              <MidiLane
                key={laneKey}
                laneKey={laneKey}
                track={laneTracks[0]}
                laneHeight={laneHeight}
                projectId={selectedProjectId}
              />
            );
          }
          return (
            <LaneRow
              key={laneKey}
              laneKey={laneKey}
              laneTracks={laneTracks}
              laneHeight={laneHeight}
              selectedProjectId={selectedProjectId}
              deleteTrack={deleteTrack}
              trackZoom={trackZoom}
              members={members}
            />
          );
        })}
      </Reorder.Group>
      {/* Bar grid lines drawn ON TOP of all lanes (FL-Studio playlist
          style). pointer-events:none so the lines never block clip
          interactions. Opacity is low enough that clip waveforms read
          through cleanly. */}
      <BarGridOverlay />
      {marquee && (
        <div
          className="pointer-events-none"
          style={{
            position: 'fixed',
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            background: 'rgba(0, 255, 200, 0.08)',
            border: '1px solid rgba(0, 255, 200, 0.6)',
            borderRadius: 4,
            zIndex: 40,
          }}
        />
      )}
    </div>
  );
}

export function TrackWithWidth({ track, selectedProjectId, deleteTrack, updateTrack, trackZoom, fetchProject }: { track: any; selectedProjectId: string; deleteTrack: any; updateTrack: any; trackZoom: 'full' | 'half'; fetchProject: any }) {
  return null;
}
