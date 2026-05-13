import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { BattleSubmissionMeta } from '../../hooks/useBeatBattle';
import type { Player, ChatMessage } from './BeatBattlePage';

// ── Hero card with countdown + ready up ─────────────────────────────────

export function Hero({ status, kit, secondsLeft, fmtTime, ready, onReady, readyCount, joinedCount, maxPlayers, prizePool, spectator }: {
  status: 'waiting' | 'starting' | 'active' | 'voting' | 'complete';
  kit: string;
  secondsLeft: number;
  fmtTime: (s: number) => string;
  ready: boolean;
  onReady: () => void;
  readyCount: number;
  joinedCount: number;
  maxPlayers: number;
  prizePool: number;
  // When true, the Ready Up button is replaced with a Rejoin CTA
  // (handler still goes through onReady so the parent decides whether
  // to set ready or call rejoinBattle).
  spectator?: boolean;
}) {
  const phaseLabel = status === 'starting' ? 'Starting in'
    : status === 'active' ? 'Production phase'
    : status === 'voting' ? 'Voting closes in'
    : 'Session starts in';
  return (
    <div className="grid grid-cols-[1fr_360px] gap-5">
      <div
        className="flex flex-col justify-between p-6 rounded-2xl overflow-hidden relative"
        style={{
          // Cinematic hero. Background-image hook expects a file at
          // `/beat-battle-hero.png` in the server's public folder —
          // generate with ChatGPT (or any image source) and drop it
          // there. While missing, the layered gradients still produce
          // a moody concert-stage feel so the card never looks blank.
          backgroundImage:
            'linear-gradient(90deg, rgba(7,3,15,0.95) 0%, rgba(7,3,15,0.55) 45%, rgba(7,3,15,0.20) 70%, rgba(7,3,15,0) 100%), ' +
            'radial-gradient(ellipse at top right, rgba(232,121,249,0.30), transparent 55%), ' +
            'radial-gradient(ellipse at bottom right, rgba(168,85,247,0.25), transparent 60%), ' +
            "url('/beat-battle-hero.png?v=2')",
          backgroundSize: 'cover',
          backgroundPosition: 'right center',
          backgroundRepeat: 'no-repeat',
          backgroundColor: '#10071F',
          border: '1px solid rgba(168, 85, 247, 0.30)',
          minHeight: 200,
        }}
      >
        <div className="relative z-10">
          <div className="text-[30px] font-bold text-white leading-tight">Beat Battle Royale</div>
          <div className="text-[12.5px] text-white/65 mt-1.5">Make a beat. Win the vote. Prove you're the best.</div>
        </div>
        {/* Stat-card row — TIME LIMIT / PLAYERS / PRIZE POOL */}
        <div className="relative z-10 flex items-center gap-3 mt-5">
          <HeroStat
            label="Time Limit"
            value="20:00"
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            }
          />
          <HeroStat
            label="Players"
            value={`${joinedCount} / ${maxPlayers}`}
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            }
          />
          <HeroStat
            label="Prize Pool"
            value={String(prizePool)}
            valueColor="#FBBF24"
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24">
                <defs>
                  <linearGradient id="coinGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#FBBF24" /><stop offset="100%" stopColor="#D97706" />
                  </linearGradient>
                </defs>
                <circle cx="12" cy="12" r="9" fill="url(#coinGrad)" stroke="#FCD34D" strokeWidth="0.8" />
                <text x="12" y="16" textAnchor="middle" fontSize="10.5" fontWeight="bold" fill="#7C2D12">G</text>
              </svg>
            }
          />
        </div>
      </div>

      <div className="flex flex-col p-4 rounded-2xl"
        style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.22)' }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[8.5px] font-bold tracking-[0.18em] uppercase text-white/45">{phaseLabel}</span>
          {(status === 'active' || status === 'voting') && (
            <span className="px-1.5 py-0.5 rounded text-[8.5px] font-bold tracking-[0.14em] uppercase"
              style={{
                background: 'rgba(232,121,249,0.18)',
                color: '#E879F9',
                border: '1px solid rgba(232,121,249,0.40)',
              }}
            >
              {status === 'active' ? 'Live · ' + kit : 'Vote'}
            </span>
          )}
        </div>
        <motion.div
          key={Math.floor(secondsLeft / 5)}
          initial={{ scale: 0.96, opacity: 0.85 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-[44px] font-bold leading-none tabular-nums"
          style={{ color: '#F0ABFC', textShadow: '0 0 14px rgba(232,121,249,0.55)' }}
        >
          {fmtTime(secondsLeft)}
        </motion.div>
        <div className="text-[11px] text-white/55 mt-1">
          {status === 'starting' && 'Lobby filling — hold tight'}
          {status === 'active' && 'Make your beat. Time is ticking.'}
          {status === 'voting' && 'Vote for your favourite submissions'}
          {status === 'waiting' && 'Get ready to start producing'}
        </div>
        {spectator ? (
          <button
            onClick={onReady}
            className="mt-3 px-4 py-2 rounded-lg text-[12px] font-bold tracking-[0.12em] uppercase transition-colors"
            style={{
              background: 'linear-gradient(180deg, #a855f7 0%, #7c3aed 100%)',
              color: '#ffffff',
              border: '1px solid rgba(168, 85, 247, 0.55)',
              boxShadow: '0 6px 16px rgba(124, 58, 237, 0.45)',
            }}
          >
            Rejoin to Play
          </button>
        ) : status === 'waiting' || status === 'starting' ? (
          <button
            onClick={onReady}
            disabled={status === 'starting' && ready}
            className="mt-3 px-4 py-2 rounded-lg text-[12px] font-bold tracking-[0.12em] uppercase transition-colors disabled:opacity-70"
            style={{
              background: ready ? 'rgba(16, 185, 129, 0.20)' : 'linear-gradient(180deg, #a855f7 0%, #7c3aed 100%)',
              color: ready ? '#34D399' : '#ffffff',
              border: ready ? '1px solid rgba(16, 185, 129, 0.45)' : '1px solid rgba(168, 85, 247, 0.55)',
              boxShadow: ready ? 'none' : '0 6px 16px rgba(124, 58, 237, 0.45)',
            }}
          >
            {ready ? '✓ Ready' : 'Ready Up'}
          </button>
        ) : (
          <div
            className="mt-3 px-4 py-2 rounded-lg text-[12px] font-bold tracking-[0.12em] uppercase text-center"
            style={{
              background: 'rgba(168, 85, 247, 0.18)',
              color: '#E879F9',
              border: '1px dashed rgba(168, 85, 247, 0.45)',
            }}
          >
            {status === 'active' ? 'Session in progress' : 'Voting'}
          </div>
        )}
        <div className="text-[10px] text-white/45 mt-2 text-center">
          {readyCount}/{maxPlayers} players ready
        </div>
      </div>
    </div>
  );
}

// ── Players grid ───────────────────────────────────────────────────────

export function PlayersGrid({ players, youReady, maxPlayers }: { players: Player[]; youReady: boolean; maxPlayers: number }) {
  const filled = players.filter((p) => !p.id.startsWith('empty-')).length;
  const readyHere = players.filter((p) => p.status === 'ready').length;
  const submittedHere = players.filter((p) => p.status === 'submitted').length;
  return (
    <div className="p-4 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-white/55">Players ({filled}/{maxPlayers})</div>
        <div className="flex items-center gap-1.5">
          {submittedHere > 0 ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#E879F9', boxShadow: '0 0 6px rgba(232,121,249,0.7)' }} />
              <span className="text-[9.5px] text-white/55">{submittedHere} submitted</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-[9.5px] text-white/45">{readyHere + (youReady ? 1 : 0)} ready</span>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2.5">
        {players.map((p) => {
          const isSubmitted = p.status === 'submitted';
          const isReady = p.status === 'ready';
          const glow = isSubmitted
            ? '0 0 12px rgba(232,121,249,0.55)'
            : isReady ? '0 0 10px rgba(16, 185, 129, 0.45)' : 'none';
          const labelColour = isSubmitted ? '#E879F9' : isReady ? '#34D399' : '#FBBF24';
          return (
            <div key={p.id} className="flex flex-col items-center gap-1 p-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div
                className="w-10 h-10 rounded-full relative flex items-center justify-center text-[14px] font-bold"
                style={{
                  background: `linear-gradient(135deg, hsl(${p.avatarHue}, 70%, 55%), hsl(${(p.avatarHue + 40) % 360}, 70%, 35%))`,
                  boxShadow: glow,
                }}
              >
                {p.name[0].toUpperCase()}
                {isSubmitted && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center" style={{ border: '2px solid #0E0620', background: '#E879F9' }}>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
                {isReady && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center" style={{ border: '2px solid #0E0620' }}>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
              </div>
              <div className="text-[10px] font-semibold text-white/80 truncate w-full text-center">{p.name}</div>
              <div className="text-[8.5px] tracking-wider uppercase" style={{ color: labelColour }}>
                {p.status}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Chat panel ─────────────────────────────────────────────────────────

export function ChatPanel({ chat, input, setInput, send }: {
  chat: ChatMessage[];
  input: string;
  setInput: (s: string) => void;
  send: () => void;
}) {
  return (
    <div className="p-3 rounded-2xl flex flex-col gap-2" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)', minHeight: 220 }}>
      <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55 mb-1">Chat</div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
        {chat.map((m) => (
          <div key={m.id} className="flex items-start gap-2">
            <div
              className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
              style={{ background: `linear-gradient(135deg, hsl(${m.avatarHue}, 70%, 55%), hsl(${(m.avatarHue + 40) % 360}, 70%, 35%))` }}
            >
              {m.author[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10.5px] font-semibold text-white/85 truncate">{m.author}</span>
                <span className="text-[9px] text-white/30 tabular-nums shrink-0">{m.timestamp}</span>
              </div>
              <div className="text-[11px] text-white/75 break-words">{m.text}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Type a message…"
          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-2.5 py-1 text-[11px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-purple-400/50"
        />
        <button
          onClick={send}
          className="px-2.5 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase"
          style={{
            background: 'rgba(168,85,247,0.20)',
            color: '#E879F9',
            border: '1px solid rgba(168,85,247,0.40)',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── Session rules panel ────────────────────────────────────────────────

export function RulesPanel({ rules }: { rules: string[] }) {
  return (
    <div className="p-3 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55 mb-2">Session Rules</div>
      <ol className="flex flex-col gap-1.5">
        {rules.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-[11px] text-white/75">
            <span
              className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[8.5px] font-bold mt-0.5"
              style={{ background: 'rgba(168,85,247,0.18)', color: '#E879F9', border: '1px solid rgba(168,85,247,0.35)' }}
            >
              {i + 1}
            </span>
            <span>{r}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Voting preview panel ───────────────────────────────────────────────

export function VotingPreviewPanel({ submissions, fetchSubmission }: {
  submissions: BattleSubmissionMeta[];
  fetchSubmission: (userId: string) => Promise<Blob | null>;
}) {
  // Per-submission audio cache. fetchSubmission round-trips to the
  // server the first time a user clicks play; afterwards we reuse the
  // cached blob URL so flipping between tracks doesn't re-stream.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Tear down every blob URL we created when the panel goes away.
  useEffect(() => () => {
    Object.values(urls).forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* noop */ } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop playback if the active submission is removed from the list
  // (e.g. round reset clears battle.submissions on the server).
  useEffect(() => {
    if (!activeId) return;
    if (!submissions.some((s) => s.userId === activeId)) {
      try { audioRef.current?.pause(); } catch { /* noop */ }
      setActiveId(null);
    }
  }, [submissions, activeId]);

  async function togglePlay(s: BattleSubmissionMeta) {
    const audio = audioRef.current;
    if (!audio) return;
    // Pause whatever's currently playing if we're switching tracks.
    if (activeId === s.userId && !audio.paused) {
      audio.pause();
      setActiveId(null);
      return;
    }
    let url = urls[s.userId];
    if (!url) {
      setLoadingId(s.userId);
      try {
        const blob = await fetchSubmission(s.userId);
        if (!blob) { setLoadingId(null); return; }
        url = URL.createObjectURL(blob);
        setUrls((prev) => ({ ...prev, [s.userId]: url! }));
      } finally {
        setLoadingId(null);
      }
    }
    audio.src = url;
    setActiveId(s.userId);
    try { await audio.play(); } catch { /* user gesture pending or aborted */ }
  }

  return (
    <div className="p-3 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55">Voting Preview</div>
        <span className="text-[9px] text-white/30">
          {submissions.length} submitted
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {submissions.length === 0 && (
          <div className="text-[10.5px] text-white/35 italic px-1 py-2">
            No submissions yet — beats will appear here as producers lock in.
          </div>
        )}
        {submissions.map((s) => {
          const isActive = activeId === s.userId;
          const isLoading = loadingId === s.userId;
          return (
            <div key={s.userId} className="flex items-center gap-2 p-1.5 rounded-md" style={{ background: 'rgba(0,0,0,0.30)' }}>
              <button
                onClick={() => { void togglePlay(s); }}
                disabled={isLoading}
                className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors disabled:opacity-60"
                style={{
                  background: isActive ? 'rgba(232,121,249,0.30)' : 'rgba(168,85,247,0.20)',
                  border: `1px solid ${isActive ? 'rgba(232,121,249,0.60)' : 'rgba(168,85,247,0.40)'}`,
                }}
                title={isActive ? 'Pause' : 'Play submission'}
              >
                {isLoading ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#E879F9" strokeWidth="3">
                    <circle cx="12" cy="12" r="9" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 1-9 9" strokeLinecap="round">
                      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
                    </path>
                  </svg>
                ) : isActive ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="#E879F9">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="#E879F9"><polygon points="6 4 20 12 6 20 6 4" /></svg>
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-1.5">
                  <span className="text-[10.5px] font-semibold text-white/85 truncate">{s.displayName}</span>
                  <span className="text-[9px] text-white/35 tabular-nums shrink-0">{formatDurationShort(s.durationSec)}</span>
                </div>
                <MiniBars />
              </div>
            </div>
          );
        })}
      </div>
      <audio
        ref={audioRef}
        onEnded={() => setActiveId(null)}
        onPause={() => { if (audioRef.current && audioRef.current.ended) setActiveId(null); }}
        className="hidden"
      />
    </div>
  );
}

export function formatDurationShort(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m <= 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Right column: Session info + Prizes ────────────────────────────────

export function SessionInfoPanel() {
  const rows = [
    ['Mode', 'Beat Battle Royale'],
    ['Time Limit', '20 minutes'],
    ['Sample Kit', 'Trap Essentials'],
    ['Voting', 'Anonymous'],
    ['Reward', '100 Ghost Coins'],
  ];
  return (
    <div className="p-4 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55 mb-3">Session Info</div>
      <div className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="text-white/45">{k}</span>
            <span className="text-white/90 font-medium text-right">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PrizesPanel() {
  const prizes = [
    { place: '1st Place', coins: 500, color: '#FBBF24', medal: '🥇' },
    { place: '2nd Place', coins: 300, color: '#D1D5DB', medal: '🥈' },
    { place: '3rd Place', coins: 150, color: '#F59E0B', medal: '🥉' },
  ];
  return (
    <div className="p-4 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55 mb-3">Prizes</div>
      <div className="flex flex-col gap-2">
        {prizes.map((p) => (
          <div key={p.place} className="flex items-center gap-2.5 p-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <div className="text-[16px]">{p.medal}</div>
            <div className="flex-1">
              <div className="text-[11px] font-semibold text-white/90">{p.place}</div>
              <div className="text-[9.5px] text-white/45">Ghost Coins reward</div>
            </div>
            <div className="text-[12px] font-bold tabular-nums" style={{ color: p.color }}>
              {p.coins}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Small visual helpers ───────────────────────────────────────────────

export function MiniWaveform() {
  const bars = Array.from({ length: 56 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 0.4 + Math.cos(i * 0.7))));
  return (
    <div className="flex items-end gap-[2px] h-7 ml-2">
      {bars.map((b, i) => (
        <div
          key={i}
          className="w-[2px] rounded-sm"
          style={{
            height: `${b * 100}%`,
            background: i < bars.length * 0.4
              ? 'linear-gradient(180deg, #E879F9, #a855f7)'
              : 'rgba(255,255,255,0.18)',
          }}
        />
      ))}
    </div>
  );
}

export function MiniBars() {
  const bars = Array.from({ length: 28 }, (_, i) => 0.3 + 0.7 * Math.abs(Math.sin(i * 0.6 + i)));
  return (
    <div className="flex items-end gap-[1.5px] h-3 mt-0.5">
      {bars.map((b, i) => (
        <div
          key={i}
          className="w-[1.5px] rounded-sm"
          style={{ height: `${b * 100}%`, background: 'rgba(168,85,247,0.50)' }}
        />
      ))}
    </div>
  );
}

// Deterministic hue from a userId — so every producer has a stable
// avatar colour regardless of when they joined the lobby.
export function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// Short relative-time formatter for chat timestamps. Returns "now"
// for anything < 5 s, then Ns / Mm / Hh / Dd. Avoids dragging in a
// full date lib for what's a single use case.
export function formatRelTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function HeroStat({ label, value, icon, valueColor }: {
  label: string;
  value: string;
  icon: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 px-3 py-2 rounded-lg backdrop-blur-sm"
      style={{
        background: 'rgba(0, 0, 0, 0.55)',
        border: '1px solid rgba(168, 134, 255, 0.18)',
        minWidth: 110,
      }}
    >
      <span className="text-[8.5px] font-bold tracking-[0.18em] uppercase text-white/55">{label}</span>
      <span className="flex items-center gap-1.5 text-[14px] font-bold tabular-nums" style={{ color: valueColor ?? '#ffffff' }}>
        <span style={{ color: valueColor ?? '#a855f7' }}>{icon}</span>
        {value}
      </span>
    </div>
  );
}

export function TransportBtn({ children, primary }: { children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      className="flex items-center justify-center rounded-full transition-colors"
      style={{
        width: primary ? 32 : 26,
        height: primary ? 32 : 26,
        background: primary ? 'linear-gradient(180deg, #a855f7, #7c3aed)' : 'transparent',
        color: primary ? '#fff' : 'rgba(255,255,255,0.65)',
        boxShadow: primary ? '0 4px 10px rgba(124,58,237,0.45)' : 'none',
      }}
    >
      <svg width={primary ? 12 : 11} height={primary ? 12 : 11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
