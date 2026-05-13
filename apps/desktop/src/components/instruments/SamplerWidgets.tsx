import { useCallback, useEffect, useRef } from 'react';
import { useMidiTrack } from '../../stores/midiTrackStore';

const COLOR_DIVIDER = 'rgba(255,255,255,0.06)';

export function VolumeSection({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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

export function RootNoteSection({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
export function Knob({ label, min, max, step, value, format, onChange, large }: {
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
export function AdsrCurve({ inst }: { inst: ReturnType<typeof useMidiTrack.getState>['instruments'][string] | undefined }) {
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

export function Slider({ label, tooltip, min, max, step, value, format, onChange }: {
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

export function BaseNotePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
