import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

// Beat Battle — Ghost Session's live producer competition mode.
// Top-level page rendered from PluginLayout when the user picks the
// game-controller dock button. v1 is a mock-data lobby that captures
// the full layout; real matchmaking + voting come in follow-ups.

type LobbyTab = 'lobby' | 'sessions' | 'community';

interface Player {
  id: string;
  name: string;
  avatarHue: number;
  status: 'ready' | 'waiting';
  badge?: string;
}

interface ChatMessage {
  id: string;
  author: string;
  text: string;
  avatarHue: number;
  timestamp: string;
}

const MOCK_PLAYERS: Player[] = [
  { id: 'p1', name: 'lonny.maker', avatarHue: 280, status: 'ready', badge: '🎧' },
  { id: 'p2', name: '808.mystic', avatarHue: 320, status: 'ready' },
  { id: 'p3', name: 'vibezNyx', avatarHue: 200, status: 'ready' },
  { id: 'p4', name: 'prodletronyx', avatarHue: 30, status: 'ready' },
  { id: 'p5', name: 'sezzyBxd', avatarHue: 160, status: 'waiting' },
  { id: 'p6', name: 'lil.cruise', avatarHue: 0, status: 'waiting' },
  { id: 'p7', name: 'lewd.exec', avatarHue: 250, status: 'waiting' },
  { id: 'p8', name: 'darkroots.exe', avatarHue: 350, status: 'waiting' },
];

const MOCK_CHAT: ChatMessage[] = [
  { id: 'c1', author: 'lonny.maker', text: 'Whats good crew', avatarHue: 280, timestamp: '1m' },
  { id: 'c2', author: '808.mystic', text: 'Locked in. ready to cook 🔥', avatarHue: 320, timestamp: '52s' },
  { id: 'c3', author: 'vibezNyx', text: 'Anyone running mono kits on this one?', avatarHue: 200, timestamp: '34s' },
  { id: 'c4', author: 'prodletronyx', text: 'voting trap or hyperpop?', avatarHue: 30, timestamp: '18s' },
];

const SESSION_RULES = [
  '20 minutes once the timer drops',
  'Only kit samples — no external imports',
  'Stems must clear at -1 dBFS',
  'Vote for the top 3, not your own',
  'Top 3 split the pot — anonymous tally',
];

export default function BeatBattlePage() {
  const [tab, setTab] = useState<LobbyTab>('lobby');
  const [ready, setReady] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(165);
  const [chatInput, setChatInput] = useState('');
  const [chat, setChat] = useState<ChatMessage[]>(MOCK_CHAT);

  // Countdown — purely cosmetic; resets at 0.
  useEffect(() => {
    const t = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 165)), 1000);
    return () => clearInterval(t);
  }, []);

  const sendChat = () => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    setChat((c) => [
      ...c,
      { id: crypto.randomUUID(), author: 'you', text: trimmed, avatarHue: 270, timestamp: 'now' },
    ]);
    setChatInput('');
  };

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const readyCount = MOCK_PLAYERS.filter((p) => p.status === 'ready').length + (ready ? 1 : 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col" style={{ background: 'linear-gradient(180deg, #0E0620 0%, #07030F 100%)' }}>
      {/* Header strip — page title + tabs */}
      <div
        className="shrink-0 flex items-center gap-6 px-6 py-3 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-2">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 12a5 5 0 0 0-10 0v6a3 3 0 0 0 6 0v-1h2v1a3 3 0 0 0 6 0v-6" />
            <circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" />
          </svg>
          <span className="text-[16px] font-bold tracking-wide text-white">Beat Battle</span>
        </div>
        <div className="flex items-center gap-1 ml-4">
          {(['lobby', 'sessions', 'community'] as LobbyTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3.5 py-1.5 rounded-md text-[11px] font-bold tracking-[0.16em] uppercase transition-colors"
              style={{
                background: tab === t ? 'rgba(168, 85, 247, 0.20)' : 'transparent',
                color: tab === t ? '#E879F9' : 'rgba(255,255,255,0.55)',
                border: tab === t ? '1px solid rgba(168, 85, 247, 0.45)' : '1px solid transparent',
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-2 px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10.5px] font-mono text-white/65">live</span>
          </span>
          <span className="flex items-center gap-2 px-3 py-1 rounded-full" style={{ background: 'rgba(168,85,247,0.10)', border: '1px solid rgba(168,85,247,0.30)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#FBBF24"><circle cx="12" cy="12" r="9" /></svg>
            <span className="text-[12px] font-semibold tabular-nums text-white">1,250</span>
          </span>
        </span>
      </div>

      {tab !== 'lobby' ? (
        <div className="flex-1 flex items-center justify-center text-center">
          <div>
            <div className="text-[14px] font-bold tracking-wider uppercase text-purple-300/70 mb-2">
              {tab === 'sessions' ? 'Past Sessions' : 'Community'}
            </div>
            <div className="text-[13px] text-white/45 max-w-sm">
              {tab === 'sessions'
                ? 'Replays of recent battles will land here — winners, voting tallies, and full stems.'
                : 'Producer profiles, leaderboards, and crew rooms.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-[1fr_320px] gap-5">
            {/* Left + center column */}
            <div className="flex flex-col gap-5">
              <Hero secondsLeft={secondsLeft} fmtTime={fmtTime} ready={ready} onReady={() => setReady((r) => !r)} readyCount={readyCount} />
              <PlayersGrid players={MOCK_PLAYERS} youReady={ready} />
              <div className="grid grid-cols-3 gap-4">
                <ChatPanel chat={chat} input={chatInput} setInput={setChatInput} send={sendChat} />
                <RulesPanel rules={SESSION_RULES} />
                <VotingPreviewPanel />
              </div>
            </div>

            {/* Right column */}
            <div className="flex flex-col gap-5">
              <SessionInfoPanel />
              <PrizesPanel />
            </div>
          </div>
        </div>
      )}

      {/* Bottom transport — mock; previews the user's "now playing" preview track */}
      <div
        className="shrink-0 flex items-center gap-4 px-6 py-2.5 border-t"
        style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.35)' }}
      >
        <div className="flex items-center gap-3 min-w-[200px]">
          <div className="w-9 h-9 rounded-md" style={{ background: 'linear-gradient(135deg, hsl(280, 70%, 50%), hsl(320, 70%, 40%))' }} />
          <div className="flex flex-col leading-tight">
            <span className="text-[11.5px] font-semibold text-white">Midnight Dreams</span>
            <span className="text-[9.5px] text-white/40">lonny.maker · preview</span>
          </div>
        </div>
        <MiniWaveform />
        <div className="flex items-center gap-1 ml-auto">
          <TransportBtn>
            <polyline points="11 19 2 12 11 5" /><polyline points="22 19 13 12 22 5" />
          </TransportBtn>
          <TransportBtn primary>
            <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
          </TransportBtn>
          <TransportBtn>
            <polyline points="13 19 22 12 13 5" /><polyline points="2 19 11 12 2 5" />
          </TransportBtn>
        </div>
        <div className="flex items-center gap-3 ml-3">
          <button className="flex items-center gap-1.5 text-[11px] text-white/65 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            142
          </button>
          <button className="text-white/45 hover:text-white transition-colors">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Hero card with countdown + ready up ─────────────────────────────────

function Hero({ secondsLeft, fmtTime, ready, onReady, readyCount }: {
  secondsLeft: number;
  fmtTime: (s: number) => string;
  ready: boolean;
  onReady: () => void;
  readyCount: number;
}) {
  return (
    <div className="grid grid-cols-[1fr_360px] gap-5">
      <div
        className="flex flex-col justify-between p-6 rounded-2xl overflow-hidden relative"
        style={{
          // Cinematic hero. Background-image hook expects a file at
          // `/beat-battle-hero.jpg` in the server's public folder —
          // generate with ChatGPT (or any image source) and drop it
          // there. While missing, the layered gradients still produce
          // a moody concert-stage feel so the card never looks blank.
          backgroundImage:
            'linear-gradient(90deg, rgba(7,3,15,0.95) 0%, rgba(7,3,15,0.55) 45%, rgba(7,3,15,0.20) 70%, rgba(7,3,15,0) 100%), ' +
            'radial-gradient(ellipse at top right, rgba(232,121,249,0.30), transparent 55%), ' +
            'radial-gradient(ellipse at bottom right, rgba(168,85,247,0.25), transparent 60%), ' +
            "url('/beat-battle-hero.jpg')",
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
            value="8 / 8"
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            }
          />
          <HeroStat
            label="Prize Pool"
            value="500"
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
        <div className="text-[8.5px] font-bold tracking-[0.18em] uppercase text-white/45 mb-1">Session starts in</div>
        <motion.div
          key={Math.floor(secondsLeft / 5)}
          initial={{ scale: 0.96, opacity: 0.85 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-[44px] font-bold leading-none tabular-nums"
          style={{ color: '#F0ABFC', textShadow: '0 0 14px rgba(232,121,249,0.55)' }}
        >
          {fmtTime(secondsLeft)}
        </motion.div>
        <div className="text-[11px] text-white/55 mt-1">Get ready to start producing</div>
        <button
          onClick={onReady}
          className="mt-3 px-4 py-2 rounded-lg text-[12px] font-bold tracking-[0.12em] uppercase transition-colors"
          style={{
            background: ready ? 'rgba(16, 185, 129, 0.20)' : 'linear-gradient(180deg, #a855f7 0%, #7c3aed 100%)',
            color: ready ? '#34D399' : '#ffffff',
            border: ready ? '1px solid rgba(16, 185, 129, 0.45)' : '1px solid rgba(168, 85, 247, 0.55)',
            boxShadow: ready ? 'none' : '0 6px 16px rgba(124, 58, 237, 0.45)',
          }}
        >
          {ready ? '✓ Ready' : 'Ready Up'}
        </button>
        <div className="text-[10px] text-white/45 mt-2 text-center">
          {readyCount}/8 players ready
        </div>
      </div>
    </div>
  );
}

// ── Players grid ───────────────────────────────────────────────────────

function PlayersGrid({ players, youReady }: { players: Player[]; youReady: boolean }) {
  return (
    <div className="p-4 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-white/55">Players (8/8)</div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-[9.5px] text-white/45">{players.filter((p) => p.status === 'ready').length + (youReady ? 1 : 0)} ready</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2.5">
        {players.map((p) => (
          <div key={p.id} className="flex flex-col items-center gap-1 p-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div
              className="w-10 h-10 rounded-full relative flex items-center justify-center text-[14px] font-bold"
              style={{
                background: `linear-gradient(135deg, hsl(${p.avatarHue}, 70%, 55%), hsl(${(p.avatarHue + 40) % 360}, 70%, 35%))`,
                boxShadow: p.status === 'ready' ? '0 0 10px rgba(16, 185, 129, 0.45)' : 'none',
              }}
            >
              {p.name[0].toUpperCase()}
              {p.status === 'ready' && (
                <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center" style={{ border: '2px solid #0E0620' }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              )}
            </div>
            <div className="text-[10px] font-semibold text-white/80 truncate w-full text-center">{p.name}</div>
            <div className="text-[8.5px] tracking-wider uppercase"
              style={{ color: p.status === 'ready' ? '#34D399' : '#FBBF24' }}
            >
              {p.status}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Chat panel ─────────────────────────────────────────────────────────

function ChatPanel({ chat, input, setInput, send }: {
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

function RulesPanel({ rules }: { rules: string[] }) {
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

function VotingPreviewPanel() {
  const tracks = ['Submission #1', 'Submission #2', 'Submission #3'];
  return (
    <div className="p-3 rounded-2xl" style={{ background: 'rgba(15, 12, 32, 0.92)', border: '1px solid rgba(168, 134, 255, 0.18)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9.5px] font-bold tracking-[0.18em] uppercase text-white/55">Voting Preview</div>
        <span className="text-[9px] text-white/30">opens after submission</span>
      </div>
      <div className="flex flex-col gap-2">
        {tracks.map((t, i) => (
          <div key={i} className="flex items-center gap-2 p-1.5 rounded-md" style={{ background: 'rgba(0,0,0,0.30)' }}>
            <button className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(168,85,247,0.20)', border: '1px solid rgba(168,85,247,0.40)' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="#E879F9"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-[10.5px] font-semibold text-white/85 truncate">{t}</div>
              <MiniBars />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Right column: Session info + Prizes ────────────────────────────────

function SessionInfoPanel() {
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

function PrizesPanel() {
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

function MiniWaveform() {
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

function MiniBars() {
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

function TransportBtn({ children, primary }: { children: React.ReactNode; primary?: boolean }) {
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
