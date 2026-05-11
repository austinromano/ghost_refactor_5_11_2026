import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { useProjectStore } from '../../stores/projectStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx } from '../../stores/audio/graph';
import { getMidiTrackBus } from '../../stores/audio/midiFxBus';
import { pitchShiftRatio } from '../../lib/midiSchedule';
import { SAMPLE_LIBRARY_DRAG_MIME } from '../layout/SampleLibrarySection';

// Sampler — the v1 instrument for MIDI tracks. Inspired by Ableton's
// Sampler / Simpler: waveform display with draggable start/end markers,
// ADSR envelope, base-note picker, and a click-to-preview keyboard
// strip. Renders as a floating panel anchored to the bottom of the
// arrangement column so the user can keep one eye on the track lanes
// while editing the patch.
//
// Drop targets:
//   - Header strip → load the dropped audio as the patch's source
//     sample (OS file, sample-library item, or project file).
//   - Waveform area is read-only (drag the start/end handles to
//     trim, not to load).
//
// Plays through the same scheduler as the piano roll — every MIDI
// note routed to this track triggers the sampler's BufferSource with
// the note's pitch, the patch's pitch-shift ratio, and the patch's
// ADSR envelope.

interface Props {
  projectId: string;
}

const PANEL_WIDTH = 720;
const PANEL_HEIGHT = 380;
const HEADER_H = 36;
const WAVEFORM_H = 130;
const KEYBOARD_H = 30;
const ADSR_H = 110;
const COLOR_BG = '#120822';
const COLOR_PANEL_HEADER = '#0E0620';
const COLOR_DIVIDER = 'rgba(255,255,255,0.06)';

// One semitone block in the mini keyboard at the bottom — enough to
// preview an octave and a half so the user can hear the patch across
// the keyboard without loading the piano roll.
const KEYBOARD_LOW = 48;  // C3
const KEYBOARD_HIGH = 84; // C6

export default function Sampler({ projectId }: Props) {
  const samplerOpenTrackId = useMidiTrack((s) => s.samplerOpenTrackId);
  const openSampler = useMidiTrack((s) => s.openSampler);
  const samplerPosition = useMidiTrack((s) => s.samplerPosition);
  const setSamplerPosition = useMidiTrack((s) => s.setSamplerPosition);
  const instruments = useMidiTrack((s) => s.instruments);
  const ensureInstrument = useMidiTrack((s) => s.ensureInstrument);
  const setInstrument = useMidiTrack((s) => s.setInstrument);
  const setBaseNote = useMidiTrack((s) => s.setBaseNote);
  const setInstrumentVolume = useMidiTrack((s) => s.setInstrumentVolume);
  const setSamplerRange = useMidiTrack((s) => s.setSamplerRange);
  const setSamplerEnvelope = useMidiTrack((s) => s.setSamplerEnvelope);

  const trackName = useProjectStore((s) => {
    if (!samplerOpenTrackId) return null;
    const tr = s.currentProject?.tracks?.find((t: any) => t.id === samplerOpenTrackId);
    return tr?.name ?? null;
  });

  if (!samplerOpenTrackId) return null;
  const trackId = samplerOpenTrackId;
  const inst = instruments[trackId];

  // Default position when the user has never dragged the panel:
  // bottom-right of the viewport with a 16 px margin. Once they
  // move it, samplerPosition is set and we honour it instead.
  const left = samplerPosition
    ? samplerPosition.x
    : Math.max(16, window.innerWidth - PANEL_WIDTH - 16);
  const top = samplerPosition
    ? samplerPosition.y
    : Math.max(16, window.innerHeight - PANEL_HEIGHT - 16);

  // Header pointer-down → start a drag. We track the offset from
  // the panel's top-left to the click point so the drag feels
  // anchored at the click position instead of teleporting the
  // panel under the cursor on first move.
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // Buttons inside the header (close ✕) shouldn't start a drag.
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startLeft = left;
    const startTop = top;
    const onMove = (mv: PointerEvent) => {
      const nextX = startLeft + (mv.clientX - startClientX);
      const nextY = startTop + (mv.clientY - startClientY);
      // Clamp so a corner of the panel is always reachable for
      // re-grabbing — keep at least 32 px of header on screen.
      const minX = -PANEL_WIDTH + 32;
      const maxX = window.innerWidth - 32;
      const minY = 0;
      const maxY = window.innerHeight - 32;
      setSamplerPosition({
        x: Math.max(minX, Math.min(maxX, nextX)),
        y: Math.max(minY, Math.min(maxY, nextY)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className="fixed z-40 flex flex-col rounded-md overflow-hidden select-none"
      style={{
        left,
        top,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        background: COLOR_BG,
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
      }}
    >
      <SamplerHeader
        trackName={trackName}
        instrumentName={inst?.fileId ? inst.name : 'Empty'}
        onClose={() => openSampler(null)}
        onPointerDown={onHeaderPointerDown}
      />
      <SamplerBody
        projectId={projectId}
        trackId={trackId}
        inst={inst}
        ensureInstrument={ensureInstrument}
        setInstrument={setInstrument}
        setBaseNote={setBaseNote}
        setInstrumentVolume={setInstrumentVolume}
        setSamplerRange={setSamplerRange}
        setSamplerEnvelope={setSamplerEnvelope}
        hideKeyboard
      />
    </div>
  );
}

function SamplerHeader({ trackName, instrumentName, onClose, onPointerDown }: {
  trackName: string | null;
  instrumentName: string;
  onClose: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="shrink-0 flex items-center px-3 cursor-grab active:cursor-grabbing"
      style={{ height: HEADER_H, background: COLOR_PANEL_HEADER, borderBottom: `1px solid ${COLOR_DIVIDER}` }}
      title="Drag to move the Sampler panel"
    >
      <span className="text-[12px] font-semibold text-white/85">Sampler</span>
      {trackName && (
        <>
          <span className="mx-2 text-white/30">·</span>
          <span className="text-[11px] text-white/75 truncate">{trackName}</span>
        </>
      )}
      <span className="mx-2 text-white/30">·</span>
      <span className="text-[11px] text-white/55 truncate flex-1">{instrumentName}</span>
      <button
        onClick={onClose}
        className="text-white/50 hover:text-white text-[13px] px-1.5"
        title="Close sampler"
      >
        ✕
      </button>
    </div>
  );
}

function SamplerBody({ projectId, trackId, inst, ensureInstrument, setInstrument, setBaseNote, setInstrumentVolume, setSamplerRange, setSamplerEnvelope, hideKeyboard, onRemove }: {
  projectId: string;
  trackId: string;
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  ensureInstrument: (trackId: string) => void;
  setInstrument: (trackId: string, name: string, buffer: AudioBuffer, fileId?: string | null) => void;
  setBaseNote: (trackId: string, pitch: number) => void;
  setInstrumentVolume: (trackId: string, v: number) => void;
  setSamplerRange: (trackId: string, startOffset: number, endOffset: number) => void;
  setSamplerEnvelope: (trackId: string, env: Partial<{ attackSec: number; decaySec: number; sustainLevel: number; releaseSec: number }>) => void;
  hideKeyboard?: boolean;
  // ✕ in the new internal header. When provided, clicking the ✕
  // removes the Sampler from the track (chain-card use case).
  onRemove?: () => void;
}) {
  const onSampleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file && /audio|wav|mp3|flac|aiff|ogg|m4a|aac/i.test(file.type + file.name)) {
      try {
        const arr = await file.arrayBuffer();
        const buffer = await getCtx().decodeAudioData(arr.slice(0));
        const name = file.name.replace(/\.[^.]+$/, '');
        const { fileId } = await api.uploadFile(projectId, file);
        ensureInstrument(trackId);
        setInstrument(trackId, name, buffer, fileId);
        // Reset the playback window when a new sample loads — old
        // start/end positions are meaningless against the new buffer.
        setSamplerRange(trackId, 0, 1);
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
        setSamplerRange(trackId, 0, 1);
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
        setSamplerRange(trackId, 0, 1);
      } catch { /* ignore */ }
    }
  }, [projectId, trackId, ensureInstrument, setInstrument, setSamplerRange]);

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDrop={onSampleDrop}
      style={{
        // Match the reference render: deep navy gradient background.
        background: 'rgba(15, 12, 32, 0.92)',
      }}
    >
      <SamplerInternalHeader inst={inst} onRemove={onRemove} />
      <SamplerWaveform inst={inst} trackId={trackId} setSamplerRange={setSamplerRange} />
      <SamplerControlsRow
        inst={inst}
        trackId={trackId}
        setBaseNote={setBaseNote}
        setInstrumentVolume={setInstrumentVolume}
        setSamplerEnvelope={setSamplerEnvelope}
      />
      {!hideKeyboard && <SamplerKeyboardStrip inst={inst} trackId={trackId} />}
    </div>
  );
}

// New internal header strip. Mirrors the reference design: small
// magenta speaker glyph, "SAMPLER" wordmark, a pill showing the
// loaded sample name (or "Empty"), and a ✕ on the right. The ✕ is
// hooked to either onRemove (chain-card use) or simply hidden when
// neither callback is provided (the floating panel still has its
// own outer header bar).
function SamplerInternalHeader({ inst, onRemove }: {
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  onRemove?: () => void;
}) {
  const sampleName = inst?.fileId ? inst.name : 'Empty';
  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
      style={{ height: 36, borderColor: 'rgba(255,255,255,0.05)' }}
    >
      <span
        className="w-3 h-3 rotate-45"
        style={{
          background: 'linear-gradient(135deg, #c084fc 0%, #7c3aed 100%)',
          borderRadius: 2,
          boxShadow: '0 0 6px #a855f7',
        }}
      />
      <span className="text-[12px] font-semibold text-white/90">Sampler</span>
      <span className="text-white/30">·</span>
      <span
        className="text-[11px] text-white/65 truncate max-w-[180px]"
        title={sampleName}
      >
        {sampleName}
      </span>
      <span className="ml-auto" />
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.10] transition-colors"
          title="Remove Sampler from this track"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

// Embeddable variant of the Sampler — pulls store hooks itself so a
// caller (e.g. the MIDI FX chain rail) can drop in `<EmbeddedSampler
// trackId=… />` without wiring every setter. Hides the on-panel
// keyboard strip by default since the inline use case is meant for a
// device-chain row, not a standalone preview surface.
export function EmbeddedSampler({ projectId, trackId, onRemove }: {
  projectId: string;
  trackId: string;
  onRemove?: () => void;
}) {
  const inst = useMidiTrack((s) => s.instruments[trackId]);
  const ensureInstrument = useMidiTrack((s) => s.ensureInstrument);
  const setInstrument = useMidiTrack((s) => s.setInstrument);
  const setBaseNote = useMidiTrack((s) => s.setBaseNote);
  const setInstrumentVolume = useMidiTrack((s) => s.setInstrumentVolume);
  const setSamplerRange = useMidiTrack((s) => s.setSamplerRange);
  const setSamplerEnvelope = useMidiTrack((s) => s.setSamplerEnvelope);
  return (
    <SamplerBody
      projectId={projectId}
      trackId={trackId}
      inst={inst}
      ensureInstrument={ensureInstrument}
      setInstrument={setInstrument}
      setBaseNote={setBaseNote}
      setInstrumentVolume={setInstrumentVolume}
      setSamplerRange={setSamplerRange}
      setSamplerEnvelope={setSamplerEnvelope}
      hideKeyboard
      onRemove={onRemove}
    />
  );
}

// ---- Waveform display + start/end handles --------------------------

function SamplerWaveform({ inst, trackId, setSamplerRange }: {
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  trackId: string;
  setSamplerRange: (trackId: string, startOffset: number, endOffset: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Redraw the waveform whenever the buffer changes. Cheap min/max
  // peaks — same approach the arrangement uses for clip previews.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (!inst?.buffer || w === 0) {
      // Empty state — center text invitation.
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Drop a sample here', w / 2, h / 2);
      return;
    }

    const data = inst.buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(data.length / w));
    const mid = h / 2;
    // Magenta → purple vertical gradient under each peak. Mirrors
    // the reference Sampler render (the bright fuchsia spread out
    // toward the bottom, deepening to purple near the centerline).
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(217, 70, 239, 0.95)'); // magenta top
    grad.addColorStop(0.5, 'rgba(168, 85, 247, 0.85)'); // mid purple
    grad.addColorStop(1, 'rgba(124, 58, 237, 0.95)'); // deep purple bottom
    ctx.fillStyle = grad;
    for (let x = 0; x < w; x++) {
      let max = 0;
      const start = x * samplesPerPixel;
      const end = Math.min(data.length, start + samplesPerPixel);
      for (let i = start; i < end; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > max) max = v;
      }
      const peak = max * mid * 0.92;
      ctx.fillRect(x, mid - peak, 1, peak * 2);
    }
    // Center line
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, mid - 0.5, w, 1);
  }, [inst?.buffer]);

  // Time-marker labels along the bottom of the waveform. Step
  // chosen so the labels never crowd: bigger samples get fewer
  // markers so the row stays legible.
  const timeMarkers = useMemo(() => {
    const dur = inst?.buffer?.duration ?? 0;
    if (dur <= 0) return [] as Array<{ pct: number; label: string }>;
    const step = dur <= 2 ? 0.25 : dur <= 5 ? 0.5 : dur <= 12 ? 1 : Math.ceil(dur / 8);
    const out: Array<{ pct: number; label: string }> = [];
    for (let t = step; t < dur; t += step) {
      const pct = (t / dur) * 100;
      out.push({ pct, label: `${t.toFixed(t < 1 ? 2 : 1)}s` });
    }
    return out;
  }, [inst?.buffer?.duration]);

  // Start / end markers — drag to trim. Positions are 0..1 fractions
  // of the buffer length.
  const onHandleDown = (which: 'start' | 'end') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const onMove = (mv: MouseEvent) => {
      const ratio = Math.max(0, Math.min(1, (mv.clientX - rect.left) / rect.width));
      if (which === 'start') {
        const end = Math.max(ratio + 0.001, inst?.endOffset ?? 1);
        setSamplerRange(trackId, ratio, end);
      } else {
        const start = Math.min(ratio - 0.001, inst?.startOffset ?? 0);
        setSamplerRange(trackId, start, ratio);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startPct = (inst?.startOffset ?? 0) * 100;
  const endPct = (inst?.endOffset ?? 1) * 100;

  return (
    <div
      ref={wrapRef}
      className="relative shrink-0"
      style={{
        height: WAVEFORM_H,
        background: 'rgba(0,0,0,0.30)',
        borderBottom: `1px solid ${COLOR_DIVIDER}`,
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {/* Greyed-out region BEFORE the start marker */}
      {inst?.buffer && (
        <div
          className="absolute top-0 bottom-0 left-0 pointer-events-none"
          style={{ width: `${startPct}%`, background: 'rgba(0,0,0,0.55)' }}
        />
      )}
      {/* Greyed-out region AFTER the end marker */}
      {inst?.buffer && (
        <div
          className="absolute top-0 bottom-0 right-0 pointer-events-none"
          style={{ width: `${100 - endPct}%`, background: 'rgba(0,0,0,0.55)' }}
        />
      )}
      {/* Start handle */}
      {inst?.buffer && (
        <div
          onMouseDown={onHandleDown('start')}
          className="absolute top-0 bottom-0 cursor-ew-resize"
          style={{ left: `calc(${startPct}% - 4px)`, width: 8 }}
          title="Drag to set sample start"
        >
          <div className="absolute top-0 bottom-0" style={{ left: 3, width: 2, background: '#A855F7', boxShadow: '0 0 6px rgba(168,85,247,0.6)' }} />
          <div className="absolute top-0" style={{ left: 1, width: 6, height: 6, background: '#A855F7', borderRadius: '0 0 2px 2px' }} />
        </div>
      )}
      {/* End handle */}
      {inst?.buffer && (
        <div
          onMouseDown={onHandleDown('end')}
          className="absolute top-0 bottom-0 cursor-ew-resize"
          style={{ left: `calc(${endPct}% - 4px)`, width: 8 }}
          title="Drag to set sample end"
        >
          <div className="absolute top-0 bottom-0" style={{ left: 3, width: 2, background: '#A855F7', boxShadow: '0 0 6px rgba(168,85,247,0.6)' }} />
          <div className="absolute top-0" style={{ left: 1, width: 6, height: 6, background: '#A855F7', borderRadius: '0 0 2px 2px' }} />
        </div>
      )}
      {/* Time markers along the bottom — short purple ticks plus
          "0.5s, 1.0s, ..." labels positioned proportionally to the
          buffer's duration. Skipped on empty patches. */}
      {timeMarkers.map((m, i) => (
        <div
          key={i}
          className="absolute pointer-events-none"
          style={{ left: `${m.pct}%`, bottom: 0, transform: 'translateX(-50%)' }}
        >
          <div className="text-[8.5px] font-mono text-white/45 mb-0.5 text-center">{m.label}</div>
        </div>
      ))}
    </div>
  );
}

// ---- ADSR + volume + base note controls ----------------------------

function SamplerControls({ inst, trackId, setBaseNote, setInstrumentVolume, setSamplerEnvelope }: {
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  trackId: string;
  setBaseNote: (trackId: string, pitch: number) => void;
  setInstrumentVolume: (trackId: string, v: number) => void;
  setSamplerEnvelope: (trackId: string, env: Partial<{ attackSec: number; decaySec: number; sustainLevel: number; releaseSec: number }>) => void;
}) {
  return (
    <div
      className="shrink-0 flex"
      style={{ height: ADSR_H, borderBottom: `1px solid ${COLOR_DIVIDER}` }}
    >
      <AdsrCurve inst={inst} />
      <div className="flex-1 flex items-center gap-3 px-3">
        <Slider
          label="A" tooltip="Attack" min={0} max={4} step={0.001}
          value={inst?.attackSec ?? 0} format={(v) => `${(v * 1000).toFixed(0)} ms`}
          onChange={(v) => setSamplerEnvelope(trackId, { attackSec: v })}
        />
        <Slider
          label="D" tooltip="Decay" min={0} max={4} step={0.001}
          value={inst?.decaySec ?? 0} format={(v) => `${(v * 1000).toFixed(0)} ms`}
          onChange={(v) => setSamplerEnvelope(trackId, { decaySec: v })}
        />
        <Slider
          label="S" tooltip="Sustain" min={0} max={1} step={0.01}
          value={inst?.sustainLevel ?? 1} format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setSamplerEnvelope(trackId, { sustainLevel: v })}
        />
        <Slider
          label="R" tooltip="Release" min={0} max={4} step={0.001}
          value={inst?.releaseSec ?? 0.05} format={(v) => `${(v * 1000).toFixed(0)} ms`}
          onChange={(v) => setSamplerEnvelope(trackId, { releaseSec: v })}
        />
        <div className="w-px self-stretch" style={{ background: COLOR_DIVIDER, margin: '0 2px' }} />
        <Slider
          label="vol" tooltip="Volume" min={0} max={1.5} step={0.01}
          value={inst?.volume ?? 1} format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setInstrumentVolume(trackId, v)}
        />
        <BaseNotePicker
          value={inst?.baseNote ?? 60}
          onChange={(v) => setBaseNote(trackId, v)}
        />
      </div>
    </div>
  );
}

// New controls row matching the reference Sampler render: four
// vertical panels — FILTER (envelope curve + stage chips), ADSR
// knobs (A/D/S/R), VOLUME knob, ROOT NOTE display.
function SamplerControlsRow({ inst, trackId, setBaseNote, setInstrumentVolume, setSamplerEnvelope }: {
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  trackId: string;
  setBaseNote: (trackId: string, pitch: number) => void;
  setInstrumentVolume: (trackId: string, v: number) => void;
  setSamplerEnvelope: (trackId: string, env: Partial<{ attackSec: number; decaySec: number; sustainLevel: number; releaseSec: number }>) => void;
}) {
  return (
    <div
      className="shrink-0 flex"
      style={{
        // Slightly taller than the old row since the knob sections
        // need vertical room for label / dial / value. Top divider
        // matches the reference design's hard separation between
        // waveform and the controls strip.
        height: 124,
        background: 'rgba(0,0,0,0.25)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <FilterSection inst={inst} />
      <AdsrKnobsSection
        inst={inst}
        trackId={trackId}
        setSamplerEnvelope={setSamplerEnvelope}
      />
      <VolumeSection
        value={inst?.volume ?? 1}
        onChange={(v) => setInstrumentVolume(trackId, v)}
      />
      <RootNoteSection
        value={inst?.baseNote ?? 60}
        onChange={(v) => setBaseNote(trackId, v)}
      />
    </div>
  );
}

// Filter panel — mirrors the reference render: the envelope curve
// preview on top, stage-name chips along the bottom. The chips are
// readouts (which segment of the envelope is which) rather than
// independent toggles since the per-stage values live in the ADSR
// knobs to the right.
function FilterSection({ inst }: {
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
}) {
  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ width: 152, borderRight: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="px-2 pt-1.5 text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55">Filter</div>
      <div className="flex-1 mx-2 mb-1 rounded" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.05)' }}>
        <AdsrCurve inst={inst} />
      </div>
      <div className="flex gap-1 px-2 pb-1.5">
        {['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE'].map((s) => (
          <span
            key={s}
            className="flex-1 text-center text-[7.5px] font-bold tracking-wider rounded px-1 py-0.5 text-white/60"
            style={{ background: 'rgba(168,85,247,0.10)', border: '1px solid rgba(168,85,247,0.20)' }}
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

// ADSR knob row — A/D/S/R as four big circular knobs with values
// underneath. Drag any knob vertically to change its value (up =
// higher, down = lower); ranges + units match the previous Slider
// implementation so existing patches behave identically.
function AdsrKnobsSection({ inst, trackId, setSamplerEnvelope }: {
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  trackId: string;
  setSamplerEnvelope: (trackId: string, env: Partial<{ attackSec: number; decaySec: number; sustainLevel: number; releaseSec: number }>) => void;
}) {
  return (
    <div
      className="flex-1 flex items-center justify-around gap-1 px-2"
      style={{ borderRight: '1px solid rgba(255,255,255,0.06)' }}
    >
      <Knob
        label="A" min={0} max={4} step={0.001}
        value={inst?.attackSec ?? 0.005}
        format={(v) => v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(v < 0.01 ? 0 : 2)} ms`}
        onChange={(v) => setSamplerEnvelope(trackId, { attackSec: v })}
      />
      <Knob
        label="D" min={0} max={4} step={0.001}
        value={inst?.decaySec ?? 0}
        format={(v) => v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(v < 0.01 ? 0 : 2)} ms`}
        onChange={(v) => setSamplerEnvelope(trackId, { decaySec: v })}
      />
      <Knob
        label="S" min={0} max={1} step={0.01}
        value={inst?.sustainLevel ?? 1}
        // Sustain is a 0..1 fraction; dB readout matches the
        // reference render. -∞ at 0, 0 dB at 1.
        format={(v) => v <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`}
        onChange={(v) => setSamplerEnvelope(trackId, { sustainLevel: v })}
      />
      <Knob
        label="R" min={0} max={4} step={0.001}
        value={inst?.releaseSec ?? 0.05}
        format={(v) => v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(v < 0.01 ? 0 : 0)} ms`}
        onChange={(v) => setSamplerEnvelope(trackId, { releaseSec: v })}
      />
    </div>
  );
}

function VolumeSection({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div
      className="shrink-0 flex flex-col items-center justify-center px-3"
      style={{ width: 96, borderRight: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55 mb-0.5">Volume</div>
      <Knob
        label="" min={0} max={1.5} step={0.01}
        value={value}
        format={(v) => v <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(v)).toFixed(2)} dB`}
        onChange={onChange}
        large
      />
    </div>
  );
}

function RootNoteSection({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const noteName = useCallback((p: number): string => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const oct = Math.floor(p / 12) - 1;
    return `${names[((p % 12) + 12) % 12]}${oct}`;
  }, []);
  // Click-and-drag the note display vertically to nudge ±1 semitone
  // per ~6 px, matching how the knobs feel. Same drag math as Knob
  // but pinned to integer pitches and the full MIDI range.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startVal = value;
    const onMove = (mv: PointerEvent) => {
      const dy = startY - mv.clientY;
      const next = Math.max(0, Math.min(127, Math.round(startVal + dy / 6)));
      if (next !== startVal) onChange(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div className="shrink-0 flex flex-col items-center justify-center px-3" style={{ width: 100 }}>
      <div className="text-[9.5px] font-bold tracking-[0.16em] uppercase text-white/55">Root Note</div>
      <div
        onPointerDown={onPointerDown}
        className="my-1 px-3 py-1.5 rounded select-none cursor-ns-resize"
        style={{
          background: 'rgba(0,0,0,0.35)',
          border: '1px solid rgba(168,85,247,0.30)',
          minWidth: 64,
          textAlign: 'center',
        }}
        title="Drag up / down to change the root note"
      >
        <span className="text-[20px] font-bold tracking-wide text-white">{noteName(value)}</span>
      </div>
      <div className="text-[8.5px] font-bold tracking-[0.16em] uppercase text-white/40">MIDI Note</div>
      <div className="text-[11px] font-mono text-white/65 tabular-nums">{value}</div>
    </div>
  );
}

// Circular knob matched to the ReverbPanel knob style: radial-gradient
// capsule body with a subtle inset highlight, purple arc that lights
// up around the perimeter, and a white tick line that points at the
// current value. Vertical drag changes the value; shift = fine.
function Knob({ label, min, max, step, value, format, onChange, large }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  large?: boolean;
}) {
  const ACCENT = '#a855f7';
  const SIZE = large ? 44 : 36;
  const RADIUS = large ? 19 : 14;
  const t = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  const startAngle = -135;
  const endAngle = 135;
  const angle = startAngle + t * (endAngle - startAngle);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const toXY = (a: number) => {
    const r = (a - 90) * (Math.PI / 180);
    return [cx + RADIUS * Math.cos(r), cy + RADIUS * Math.sin(r)] as const;
  };
  const [sx, sy] = toXY(startAngle);
  const [ex, ey] = toXY(angle);
  const [tx, ty] = toXY(endAngle);
  const largeArcBg = endAngle - startAngle > 180 ? 1 : 0;
  const largeArcFg = angle - startAngle > 180 ? 1 : 0;
  const arcBg = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArcBg} 1 ${tx.toFixed(2)} ${ty.toFixed(2)}`;
  const arcFg = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArcFg} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  const [tickX, tickY] = toXY(angle);
  const tickInnerR = RADIUS - 9;
  const tickInner = (() => {
    const r = (angle - 90) * (Math.PI / 180);
    return [cx + tickInnerR * Math.cos(r), cy + tickInnerR * Math.sin(r)];
  })();

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    const startVal = value;
    const onMove = (mv: PointerEvent) => {
      const dy = startY - mv.clientY;
      const sensitivity = mv.shiftKey ? 1000 : 100;
      const next = startVal + (dy / sensitivity) * (max - min);
      const clamped = Math.max(min, Math.min(max, next));
      const stepped = step > 0 ? Math.round(clamped / step) * step : clamped;
      if (Math.abs(stepped - value) >= step) onChange(stepped);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex flex-col items-center select-none">
      {label && (
        <span className="text-[9.5px] uppercase text-white/55 leading-none mb-[3px]" style={{ letterSpacing: '0.03em' }}>{label}</span>
      )}
      <div
        onPointerDown={onPointerDown}
        style={{
          width: SIZE,
          height: SIZE,
          cursor: 'ns-resize',
          touchAction: 'none',
          borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 35%, #2c1f54 0%, #14102b 80%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -2px 4px rgba(0,0,0,0.35), 0 0 12px rgba(168,85,247,0.20)',
          border: '1px solid rgba(168, 134, 255, 0.22)',
        }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ display: 'block' }}>
          <path d={arcBg} stroke="rgba(255,255,255,0.08)" strokeWidth={2.5} fill="none" strokeLinecap="round" />
          <path d={arcFg} stroke={ACCENT} strokeWidth={2.5} fill="none" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${ACCENT})` }} />
          <line x1={tickInner[0]} y1={tickInner[1]} x2={tickX} y2={tickY} stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
        </svg>
      </div>
      <span className="text-[11.5px] font-semibold tabular-nums text-white/90 leading-none mt-1">{format(value)}</span>
    </div>
  );
}

// Mini visualisation of the current ADSR shape — gives the user a
// quick read on how the envelope will behave without playing a note.
function AdsrCurve({ inst }: { inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const a = inst?.attackSec ?? 0.005;
    const d = inst?.decaySec ?? 0;
    const s = inst?.sustainLevel ?? 1;
    const r = inst?.releaseSec ?? 0.05;

    // Time domain we render: the envelope's natural duration plus a
    // half-second sustain plateau so the shape reads correctly when
    // attack/decay/release are tiny.
    const total = a + d + 0.5 + r;
    const xOf = (t: number) => (t / total) * (w - 8) + 4;
    const yOf = (level: number) => h - (level * (h - 8)) - 4;

    // Background grid line at sustain level.
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, yOf(s), w, 1);

    // Envelope path.
    ctx.strokeStyle = '#A855F7';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    ctx.lineTo(xOf(a), yOf(1));
    ctx.lineTo(xOf(a + d), yOf(s));
    ctx.lineTo(xOf(a + d + 0.5), yOf(s));
    ctx.lineTo(xOf(a + d + 0.5 + r), yOf(0));
    ctx.stroke();

    // Filled area under the curve.
    ctx.fillStyle = 'rgba(168,85,247,0.18)';
    ctx.lineTo(xOf(total), yOf(0));
    ctx.lineTo(xOf(0), yOf(0));
    ctx.closePath();
    ctx.fill();
  }, [inst?.attackSec, inst?.decaySec, inst?.sustainLevel, inst?.releaseSec]);

  return (
    <div
      className="shrink-0 self-stretch"
      style={{
        width: 130,
        background: 'rgba(0,0,0,0.30)',
        borderRight: `1px solid ${COLOR_DIVIDER}`,
      }}
    >
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

function Slider({ label, tooltip, min, max, step, value, format, onChange }: {
  label: string; tooltip: string;
  min: number; max: number; step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1" title={tooltip} style={{ width: 56 }}>
      <span className="text-[10px] font-mono text-white/55 uppercase tracking-wider">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="track-volume w-full"
      />
      <span className="text-[9px] font-mono text-white/40 tabular-nums truncate">{format(value)}</span>
    </div>
  );
}

function BaseNotePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const noteName = useCallback((p: number): string => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const oct = Math.floor(p / 12) - 1;
    return `${names[((p % 12) + 12) % 12]}${oct}`;
  }, []);
  return (
    <div className="flex flex-col items-center gap-1" title="Base note (sample plays unshifted at this pitch)" style={{ width: 60 }}>
      <span className="text-[10px] font-mono text-white/55 uppercase tracking-wider">root</span>
      <input
        type="number" min={0} max={127} step={1} value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 60)}
        className="bg-white/[0.04] border border-white/[0.08] rounded px-1 py-0.5 text-white/85 text-[11px] w-full text-center"
      />
      <span className="text-[9px] font-mono text-white/40 tabular-nums">{noteName(value)}</span>
    </div>
  );
}

// ---- Click-to-preview keyboard at the bottom -----------------------

function SamplerKeyboardStrip({ inst, trackId }: { inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined; trackId: string }) {
  const [hovering, setHovering] = useState<number | null>(null);
  const previewKey = (pitch: number) => {
    if (!inst?.buffer) return;
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = inst.buffer;
    src.playbackRate.value = pitchShiftRatio(pitch, inst.baseNote);
    const g = ctx.createGain();
    g.gain.value = inst.volume;
    src.connect(g);
    // Route preview through the same FX bus the scheduler uses, so
    // turning on EQ / Comp / Reverb on the track is audible in the
    // keyboard preview too.
    g.connect(getMidiTrackBus(trackId));
    const startBufSec = inst.startOffset * inst.buffer.duration;
    const endBufSec = inst.endOffset * inst.buffer.duration;
    src.start(0, startBufSec);
    src.stop(ctx.currentTime + (endBufSec - startBufSec) / src.playbackRate.value + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  };

  const keys: Array<{ pitch: number; isBlack: boolean; label: string | null }> = [];
  const blackPitches = new Set([1, 3, 6, 8, 10]);
  for (let p = KEYBOARD_LOW; p <= KEYBOARD_HIGH; p++) {
    keys.push({
      pitch: p,
      isBlack: blackPitches.has(((p % 12) + 12) % 12),
      label: p % 12 === 0 ? `C${Math.floor(p / 12) - 1}` : null,
    });
  }

  // White-key count for layout — black keys overlay between adjacent
  // white keys at half-width.
  const whiteKeys = keys.filter((k) => !k.isBlack);

  return (
    <div
      className="shrink-0 flex-1 relative"
      style={{ minHeight: KEYBOARD_H, background: '#0A0414' }}
    >
      <div className="absolute inset-0 flex">
        {whiteKeys.map((k, i) => (
          <div
            key={k.pitch}
            onMouseDown={() => previewKey(k.pitch)}
            onMouseEnter={() => setHovering(k.pitch)}
            onMouseLeave={() => setHovering((h) => (h === k.pitch ? null : h))}
            className="flex-1 relative cursor-pointer"
            style={{
              background: hovering === k.pitch ? '#E0DCC8' : '#E8E4D6',
              borderRight: i < whiteKeys.length - 1 ? '1px solid rgba(0,0,0,0.25)' : 'none',
            }}
          >
            {k.label && (
              <span
                className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-mono text-black/55 pointer-events-none"
              >
                {k.label}
              </span>
            )}
          </div>
        ))}
      </div>
      {/* Black keys overlay — positioned proportionally to the white-key
          flex layout. Each black key sits between two adjacent whites
          and gets ~60% of a white-key's width. */}
      <div className="absolute inset-0 pointer-events-none">
        {keys.map((k) => {
          if (!k.isBlack) return null;
          // Compute the % position of the black key. It sits AT the
          // boundary between the previous white key and this one's
          // hosting white, so we count how many white keys came
          // before it and offset by half a white-key width.
          const whitesBefore = keys
            .slice(0, keys.indexOf(k))
            .filter((kk) => !kk.isBlack).length;
          const pct = (whitesBefore / whiteKeys.length) * 100;
          const widthPct = (1 / whiteKeys.length) * 60;
          return (
            <div
              key={k.pitch}
              onMouseDown={(e) => { e.preventDefault(); previewKey(k.pitch); }}
              onMouseEnter={() => setHovering(k.pitch)}
              onMouseLeave={() => setHovering((h) => (h === k.pitch ? null : h))}
              className="absolute top-0 cursor-pointer pointer-events-auto"
              style={{
                left: `calc(${pct}% - ${widthPct / 2}%)`,
                width: `${widthPct}%`,
                height: '60%',
                background: hovering === k.pitch ? '#1F1F1F' : '#0E0E0E',
                borderRadius: '0 0 2px 2px',
                boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.4)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
