import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMidiTrack } from '../../stores/midiTrackStore';
import { getCtx } from '../../stores/audio/graph';

const WAVEFORM_H = 130;
const COLOR_DIVIDER = 'rgba(255,255,255,0.06)';

export function SamplerWaveform({ inst, trackId, setSamplerRange }: {
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

  // Live playback cursors. The MIDI scheduler (and keyboard preview)
  // dispatch `ghost-sampler-voice` whenever they fire a BufferSource;
  // we keep a small list of currently-active voices and use RAF to
  // recompute each one's playhead position inside the buffer. Each
  // voice fades out (and gets pruned) once its total lifetime
  // elapses. State is rendered as positioned divs over the canvas.
  type Voice = {
    id: number;
    whenCtx: number;
    startBufSec: number;
    endBufSec: number;
    playbackRate: number;
    totalDur: number;
  };
  const [activeVoices, setActiveVoices] = useState<Array<{ id: number; xPct: number; alpha: number }>>([]);
  const voicesRef = useRef<Voice[]>([]);
  const nextVoiceIdRef = useRef(1);
  useEffect(() => {
    const onVoice = (e: Event) => {
      const ce = e as CustomEvent;
      if (!ce.detail || ce.detail.trackId !== trackId) return;
      const id = nextVoiceIdRef.current++;
      voicesRef.current.push({
        id,
        whenCtx: ce.detail.whenCtx,
        startBufSec: ce.detail.startBufSec,
        endBufSec: ce.detail.endBufSec,
        playbackRate: ce.detail.playbackRate,
        totalDur: ce.detail.totalDur,
      });
    };
    window.addEventListener('ghost-sampler-voice', onVoice as EventListener);
    return () => window.removeEventListener('ghost-sampler-voice', onVoice as EventListener);
  }, [trackId]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const bufDur = inst?.buffer?.duration ?? 0;
      const ctxNow = getCtx().currentTime;
      // Drop voices whose lifetime has elapsed. Keeps the list bounded
      // even on long sustained patches.
      voicesRef.current = voicesRef.current.filter((v) => ctxNow < v.whenCtx + v.totalDur + 0.05);
      // Compute each voice's current position in the buffer and an
      // overall alpha that pulses bright at attack and tails off on
      // release. The "phase" 0..1 is normalised over totalDur so the
      // alpha curve respects the user's release setting.
      const next = voicesRef.current.map((v) => {
        const elapsedSinceStart = Math.max(0, ctxNow - v.whenCtx);
        const bufPos = v.startBufSec + elapsedSinceStart * v.playbackRate;
        const clampedBuf = Math.min(bufDur, Math.max(0, bufPos));
        const xPct = bufDur > 0 ? (clampedBuf / bufDur) * 100 : 0;
        const phase = Math.min(1, elapsedSinceStart / Math.max(0.01, v.totalDur));
        // Fast attack (full brightness in first ~30 ms), gentle
        // exponential decay over the rest of the voice's lifetime.
        const attack = Math.min(1, elapsedSinceStart / 0.03);
        const decay = Math.pow(1 - phase, 1.6);
        return { id: v.id, xPct, alpha: attack * (0.55 + 0.45 * decay) };
      });
      setActiveVoices(next);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [inst?.buffer]);

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
      {/* Live playback cursors — one vertical line per active voice
          sweeping across the waveform at the buffer's read position.
          Wrapped in framer-motion so each cursor fades in on attack
          and tails off through the voice's release. */}
      <AnimatePresence>
        {activeVoices.map((v) => (
          <motion.div
            key={v.id}
            className="absolute top-0 bottom-0 pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: v.alpha }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.08, ease: 'linear' }}
            style={{
              left: `${v.xPct}%`,
              width: 2,
              marginLeft: -1,
              background: 'linear-gradient(180deg, rgba(232, 213, 255, 0.95) 0%, rgba(168, 85, 247, 0.75) 100%)',
              boxShadow: '0 0 10px rgba(168,85,247,0.75), 0 0 22px rgba(232,121,249,0.45)',
              borderRadius: 1,
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
