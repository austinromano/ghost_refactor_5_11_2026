import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAudioStore } from '../../stores/audioStore';
import { getCtx, getMaster } from '../../stores/audio/graph';
import { getSocket } from '../../lib/socket';
import { setBattleOptOut } from '../../hooks/useBeatBattleOptOut';

// Submit Beat flow for Beat Battle projects. Renders the full
// arrangement in real time by tapping the master gain node into a
// MediaStreamDestination + MediaRecorder, hands the resulting blob
// back as a preview audio player, and (on confirm) tells the server
// the producer has submitted and routes them to the lobby.
//
// Why real-time and not OfflineAudioContext: the live playback path
// owns the entire scheduling graph (worklets, sends, FX bus, master
// limiter). Re-implementing all of that against an OfflineAudio-
// Context would double the surface area we have to maintain. Realtime
// capture means the bounce takes exactly as long as the arrangement,
// which is acceptable for a competition submission UX — the user
// expects to wait for a render.

interface Props {
  open: boolean;
  battleId: string;
  onClose: () => void;
  // Called after the user confirms submission AND the server has
  // received the battle:submit event. PluginLayout uses this to drop
  // the open project and route back to the lobby in submitted state.
  onSubmitted: () => void;
}

type Phase = 'idle' | 'rendering' | 'ready' | 'submitting';

export default function SubmitBeatModal({ open, battleId, onClose, onSubmitted }: Props) {
  const duration = useAudioStore((s) => s.duration);
  const play = useAudioStore((s) => s.play);
  const stop = useAudioStore((s) => s.stop);
  const seekTo = useAudioStore((s) => s.seekTo);

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0); // 0..1
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Plumbing refs cleaned up on close / cancel.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Each open is a fresh render — reset state when the modal mounts.
  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setProgress(0);
    setBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setError(null);
    return () => {
      // Unmount cleanup — make sure we don't leak the master tap or
      // leave playback running if the user yanks the modal mid-render.
      teardownCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function teardownCapture() {
    try { recorderRef.current?.state === 'recording' && recorderRef.current.stop(); } catch { /* noop */ }
    recorderRef.current = null;
    try { streamDestRef.current?.disconnect(); } catch { /* noop */ }
    streamDestRef.current = null;
    if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
  }

  async function startRender() {
    setError(null);
    if (!duration || duration <= 0) {
      setError('Add at least one clip to the arrangement before submitting.');
      return;
    }
    try {
      const ctx = getCtx();
      // Most browsers leave a freshly-created context suspended until
      // a user gesture. The Submit click IS that gesture, so resuming
      // here is safe and required for playback + capture to start.
      if (ctx.state === 'suspended') await ctx.resume();
      const master = getMaster();
      const dest = ctx.createMediaStreamDestination();
      master.connect(dest);
      streamDestRef.current = dest;

      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
      const mime = mimeCandidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
      const recorder = mime ? new MediaRecorder(dest.stream, { mimeType: mime }) : new MediaRecorder(dest.stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          const url = URL.createObjectURL(blob);
          setBlobUrl(url);
          setPhase('ready');
        } catch (err) {
          setError('Render finished but the audio blob could not be assembled.');
          setPhase('idle');
          if (import.meta.env.DEV) console.warn('[SubmitBeat] blob assembly failed:', err);
        } finally {
          teardownCapture();
        }
      };

      setPhase('rendering');
      setProgress(0);
      seekTo(0);
      recorder.start();
      play();

      // 100 ms progress tick — gives the user a smooth bar and a
      // count of seconds remaining without thrashing renders.
      const startedAt = performance.now();
      progressTimerRef.current = setInterval(() => {
        const elapsed = (performance.now() - startedAt) / 1000;
        setProgress(Math.min(1, elapsed / duration));
      }, 100);

      // Hard stop a few hundred ms after the arrangement ends so the
      // final tails make it into the bounce — without the pad the
      // recorder cuts off the reverb decay of the last hit.
      const TAIL_MS = 600;
      stopTimerRef.current = setTimeout(() => {
        try { stop(); } catch { /* noop */ }
        try { recorder.stop(); } catch { /* already stopped */ }
      }, Math.round(duration * 1000) + TAIL_MS);
    } catch (err) {
      teardownCapture();
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Failed to start render.');
    }
  }

  function cancel() {
    teardownCapture();
    try { stop(); } catch { /* noop */ }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); }
    setBlobUrl(null);
    setPhase('idle');
    setProgress(0);
    onClose();
  }

  function submit() {
    setPhase('submitting');
    try {
      const socket = getSocket();
      socket?.emit('battle:submit', { battleId });
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[SubmitBeat] socket emit failed:', err);
    }
    // Once submitted the producer should fall back to the lobby
    // (spectator mode) and watch the remaining timer tick out. The
    // opt-out flag drops them from the "active producer" set on the
    // client so they don't get auto-reopened into another project.
    try { setBattleOptOut(true); } catch { /* noop */ }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    onSubmitted();
  }

  if (!open) return null;

  const remainingSec = phase === 'rendering' ? Math.max(0, Math.ceil(duration * (1 - progress))) : 0;

  return (
    <AnimatePresence>
      <motion.div
        key="submit-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center"
        style={{ background: 'rgba(7, 3, 15, 0.78)', backdropFilter: 'blur(6px)' }}
        onClick={(e) => { if (e.target === e.currentTarget && phase !== 'rendering' && phase !== 'submitting') cancel(); }}
      >
        <motion.div
          initial={{ scale: 0.94, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
          className="w-[480px] rounded-2xl p-6"
          style={{
            background: 'linear-gradient(180deg, rgba(20,12,40,0.96) 0%, rgba(10,4,22,0.96) 100%)',
            border: '1px solid rgba(168, 85, 247, 0.35)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(168,85,247,0.10)',
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E879F9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="text-[15px] font-bold tracking-wide text-white">Submit Beat</span>
          </div>
          <div className="text-[12px] text-white/55 mb-5">
            {phase === 'idle' && 'Bounce the full arrangement, take one last listen, then lock it in.'}
            {phase === 'rendering' && `Rendering… ${remainingSec}s remaining`}
            {phase === 'ready' && 'Preview your bounce before final submission.'}
            {phase === 'submitting' && 'Locking in your submission…'}
          </div>

          {/* Phase-specific body */}
          {phase === 'idle' && (
            <div className="flex flex-col gap-3">
              <div
                className="p-4 rounded-lg text-[12.5px] text-white/70"
                style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.22)' }}
              >
                Arrangement length: <span className="font-bold text-white tabular-nums">{formatTime(duration)}</span>
                <div className="text-[11px] text-white/45 mt-1">
                  Rendering happens in real time — you'll hear the playback while it bounces.
                </div>
              </div>
              {error && (
                <div className="text-[12px] text-rose-400 px-1">{error}</div>
              )}
              <div className="flex items-center justify-end gap-2 mt-1">
                <button
                  onClick={cancel}
                  className="px-3.5 py-1.5 rounded-md text-[12px] font-semibold text-white/65 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={startRender}
                  className="px-4 py-2 rounded-lg text-[12px] font-bold tracking-[0.12em] uppercase transition-colors"
                  style={{
                    background: 'linear-gradient(180deg, #a855f7 0%, #7c3aed 100%)',
                    color: '#ffffff',
                    border: '1px solid rgba(168, 85, 247, 0.55)',
                    boxShadow: '0 6px 16px rgba(124, 58, 237, 0.45)',
                  }}
                >
                  Bounce
                </button>
              </div>
            </div>
          )}

          {phase === 'rendering' && (
            <div className="flex flex-col gap-3">
              <div
                className="h-2.5 rounded-full overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.06)' }}
              >
                <motion.div
                  className="h-full"
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    background: 'linear-gradient(90deg, #a855f7, #E879F9)',
                    boxShadow: '0 0 12px rgba(232,121,249,0.5)',
                  }}
                />
              </div>
              <div className="text-[11px] text-white/45 tabular-nums text-right">
                {Math.round(progress * 100)}%
              </div>
            </div>
          )}

          {phase === 'ready' && blobUrl && (
            <div className="flex flex-col gap-3">
              <audio
                src={blobUrl}
                controls
                className="w-full"
                style={{ filter: 'invert(0.85) hue-rotate(180deg)' }}
              />
              <div className="flex items-center justify-between mt-1">
                <button
                  onClick={() => { void startRender(); }}
                  className="px-3.5 py-1.5 rounded-md text-[12px] font-semibold text-white/65 hover:text-white hover:bg-white/[0.06] transition-colors"
                  title="Bounce again from scratch"
                >
                  Re-bounce
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={cancel}
                    className="px-3.5 py-1.5 rounded-md text-[12px] font-semibold text-white/65 hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submit}
                    className="px-4 py-2 rounded-lg text-[12px] font-bold tracking-[0.12em] uppercase transition-colors"
                    style={{
                      background: 'linear-gradient(180deg, #10B981 0%, #047857 100%)',
                      color: '#ffffff',
                      border: '1px solid rgba(16, 185, 129, 0.55)',
                      boxShadow: '0 6px 16px rgba(5, 150, 105, 0.45)',
                    }}
                  >
                    Submit Beat
                  </button>
                </div>
              </div>
            </div>
          )}

          {phase === 'submitting' && (
            <div className="flex items-center justify-center py-6 text-[13px] text-white/65">
              Submitting…
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function formatTime(sec: number): string {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
