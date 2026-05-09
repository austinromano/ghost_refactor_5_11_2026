import { useEffect, useRef, useState, useCallback } from 'react';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { useProjectStore } from '../../stores/projectStore';
import { audioBufferCache, getAudioData } from '../../lib/audio';
import { api } from '../../lib/api';
import { getCtx, getMaster } from '../../stores/audio/graph';
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

  return (
    <div
      className="absolute z-40 flex flex-col rounded-md overflow-hidden select-none"
      style={{
        bottom: 16,
        right: 16,
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
      />
    </div>
  );
}

function SamplerHeader({ trackName, instrumentName, onClose }: { trackName: string | null; instrumentName: string; onClose: () => void }) {
  return (
    <div
      className="shrink-0 flex items-center px-3"
      style={{ height: HEADER_H, background: COLOR_PANEL_HEADER, borderBottom: `1px solid ${COLOR_DIVIDER}` }}
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

function SamplerBody({ projectId, trackId, inst, ensureInstrument, setInstrument, setBaseNote, setInstrumentVolume, setSamplerRange, setSamplerEnvelope }: {
  projectId: string;
  trackId: string;
  inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined;
  ensureInstrument: (trackId: string) => void;
  setInstrument: (trackId: string, name: string, buffer: AudioBuffer, fileId?: string | null) => void;
  setBaseNote: (trackId: string, pitch: number) => void;
  setInstrumentVolume: (trackId: string, v: number) => void;
  setSamplerRange: (trackId: string, startOffset: number, endOffset: number) => void;
  setSamplerEnvelope: (trackId: string, env: Partial<{ attackSec: number; decaySec: number; sustainLevel: number; releaseSec: number }>) => void;
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
    >
      <SamplerWaveform inst={inst} trackId={trackId} setSamplerRange={setSamplerRange} />
      <SamplerControls
        inst={inst}
        trackId={trackId}
        setBaseNote={setBaseNote}
        setInstrumentVolume={setInstrumentVolume}
        setSamplerEnvelope={setSamplerEnvelope}
      />
      <SamplerKeyboardStrip inst={inst} />
    </div>
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
    ctx.fillStyle = 'rgba(168,85,247,0.85)';
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

function SamplerKeyboardStrip({ inst }: { inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined }) {
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
    g.connect(getMaster());
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
