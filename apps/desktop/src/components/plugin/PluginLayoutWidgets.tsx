import { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAudioStore } from '../../stores/audioStore';

// Grid snap subdivision picker. Sits next to the zoom buttons in the
// arrangement toolbar; reads/writes audioStore.gridDivision so every snap
// site (clip drag, paste, duplicate, trim) follows the same setting.
export function GridSnapPicker() {
  const grid = useAudioStore((s) => s.gridDivision);
  const setGrid = useAudioStore((s) => s.setGridDivision);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const options: Array<{ label: string; value: number }> = [
    { label: 'Bar', value: 1 },
    { label: '1/2', value: 0.5 },
    { label: '1/4', value: 0.25 },
    { label: '1/8', value: 0.125 },
    { label: '1/16', value: 0.0625 },
  ];
  const current = options.find((o) => Math.abs(o.value - grid) < 1e-6) || options[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-2 h-6 flex items-center justify-center gap-1 rounded text-[11px] font-semibold transition-colors ${grid !== 1 ? 'text-ghost-green' : 'text-white/40 hover:text-white/70'}`}
        title={`Grid snap: ${current.label}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
        <span className="tabular-nums">{current.label}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 z-50 min-w-[80px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{ background: 'rgba(20, 12, 30, 0.96)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {options.map((o) => {
            const active = Math.abs(o.value - grid) < 1e-6;
            return (
              <button
                key={o.value}
                onClick={() => { setGrid(o.value); setOpen(false); }}
                className={`w-full px-3 py-1 text-[12px] text-left transition-colors flex items-center justify-between ${active ? 'text-ghost-green bg-white/[0.06]' : 'text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white'}`}
              >
                <span>{o.label}</span>
                {active && <span className="text-[9px]">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Undo / redo pair that lives next to the zoom buttons in the arrangement
// toolbar. Wired straight to audioStore.undo / .redo and greyed out when
// their stack is empty.
export function UndoRedoButtons() {
  const undo = useAudioStore((s) => s.undo);
  const redo = useAudioStore((s) => s.redo);
  const canUndo = useAudioStore((s) => s.canUndo);
  const canRedo = useAudioStore((s) => s.canRedo);
  return (
    <>
      <button
        onClick={() => { if (canUndo) undo(); }}
        disabled={!canUndo}
        className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${canUndo ? 'text-white/40 hover:text-white' : 'text-white/15 cursor-not-allowed'}`}
        title="Undo"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
      <button
        onClick={() => { if (canRedo) redo(); }}
        disabled={!canRedo}
        className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${canRedo ? 'text-white/40 hover:text-white' : 'text-white/15 cursor-not-allowed'}`}
        title="Redo"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
        </svg>
      </button>
    </>
  );
}

// Tiny hidden <audio> that plays a remote MediaStream. Mounted at
// the PluginLayout root level so voice keeps playing even when the
// VideoGrid panel is collapsed. The element's autoplay survives a
// stream swap because the effect re-attaches srcObject whenever the
// stream prop changes.
export function RemoteVoicePlayer({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    // Some browsers won't autoplay audio without a user gesture.
    // Treat the play() promise as best-effort; failure just means
    // audio waits for the next user interaction.
    el.play().catch(() => { /* user gesture pending */ });
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

export function DockButton({ title, active, onClick, children }: { title: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      title={title}
      className={`w-11 h-11 flex items-center justify-center rounded-2xl transition-all shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:rounded-xl ${
        active ? 'text-white' : 'text-white/60 hover:text-white'
      }`}
      style={{
        background: active ? 'linear-gradient(135deg, #00FFC8 0%, #7C3AED 100%)' : 'rgba(255,255,255,0.05)',
        border: active ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow: active
          ? '0 0 16px rgba(0,255,200,0.3), 0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.2)'
          : '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      {children}
    </motion.button>
  );
}
