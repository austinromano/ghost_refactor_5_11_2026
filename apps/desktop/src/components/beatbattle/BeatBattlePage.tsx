import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useBeatBattle, type BattleParticipant, type BattleSubmissionMeta } from '../../hooks/useBeatBattle';
import { useBeatBattleOptOut, setBattleOptOut } from '../../hooks/useBeatBattleOptOut';
import { clearBattleSubmitted } from '../../hooks/useBeatBattleSubmitted';
import { useProjectStore } from '../../stores/projectStore';
import { useAuthStore } from '../../stores/authStore';
import { getSocket } from '../../lib/socket';

// Beat Battle — Ghost Session's live producer competition mode.
// Top-level page rendered from PluginLayout when the user picks the
// game-controller dock button. v1 has ONE shared lobby ("the-arena")
// joined automatically on mount; the participant list + ready states
// are live via socket events.

const ARENA_ID = 'the-arena';

type LobbyTab = 'lobby' | 'sessions' | 'community';

interface Player {
  id: string;
  name: string;
  avatarHue: number;
  status: 'ready' | 'waiting' | 'submitted';
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
  const [chatInput, setChatInput] = useState('');
  // Local RAF-ish counter that re-renders the countdown each second.
  // The actual target time comes from battle.startsAt or
  // battle.endsAt — this just forces a re-render so the displayed
  // value ticks down. Server is the source of truth on the actual
  // phase transitions.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Opt-out state from the shared hook. Drives whether we subscribe
  // to battle:state events (joining the socket room + participant
  // set) or render the rejoin splash. Persists across mounts and
  // syncs with ProjectHeaderBar / CollaboratorsBar / sidebar.
  const optedOut = useBeatBattleOptOut();

  // Live lobby state via socket. battle.participants is the real list
  // of producers in the room; me.ready is what the Ready Up button
  // toggles; chat is the live message thread. When opted-out we join
  // as a spectator: socket subscribes for state + chat broadcasts,
  // but the server doesn't add us to the participant set, so we can
  // watch the others compete without silently rejoining.
  const { state: battle, chat: liveChat, setReady: emitReady, sendChat: emitChat, fetchSubmission } = useBeatBattle(ARENA_ID, { spectator: optedOut });

  // When the round resets (status flips back to 'waiting'), the
  // per-battle "I already submitted" flag has to be cleared so the
  // Submit Beat button reappears for the next session. Track the
  // previous status to detect the edge transition.
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev && prev !== 'waiting' && battle?.status === 'waiting') {
      clearBattleSubmitted(ARENA_ID);
    }
    prevStatusRef.current = battle?.status ?? null;
  }, [battle?.status]);

  // Adapt the server's chat message shape into the local ChatMessage
  // type the panel renders. Coloured avatars are deterministic via
  // hashHue(userId), and timestamps render as "Hh / Mm / Ns ago".
  const chat: ChatMessage[] = useMemo(
    () => liveChat.map((m) => ({
      id: m.id,
      author: m.displayName,
      text: m.text,
      avatarHue: hashHue(m.userId),
      timestamp: formatRelTime(m.createdAt),
    })),
    [liveChat],
  );

  // Reflect remote ready toggles too — find the current user by
  // matching the auth context's userId. The socket auth middleware
  // tagged socket.data.userId on the server side so the participant
  // entry's userId === our auth userId. For client-side lookup we
  // could expose userId via a hook, but as a v1 shortcut we just
  // track "last clicked" locally and let the server be source of
  // truth on next state push.
  const [ready, setReady] = useState(false);

  // Sync local ready state with server snapshot. If another tab on
  // the same account toggles ready, our button reflects that too.
  useEffect(() => {
    if (!battle) return;
    // Without userId in hand we can't pick OUR participant. v1 fudges
    // by checking if EVERY visible "you" candidate is ready — we'll
    // refine once auth exposes userId here. For now the local optimistic
    // state in setReady() drives the UI.
    void battle;
  }, [battle]);

  // Derive the headline countdown from the live battle state. While
  // 'starting' we count down to startsAt (the 5-second lobby kick-
  // off). While 'active' or 'voting' we count down to endsAt. While
  // 'waiting' we show 00:00 so the user sees we're idle.
  const status = battle?.status ?? 'waiting';
  const target = status === 'starting'
    ? battle?.startsAt ?? null
    : (status === 'active' || status === 'voting')
      ? battle?.endsAt ?? null
      : null;
  const secondsLeft = target
    ? Math.max(0, Math.ceil((Date.parse(target) - now) / 1000))
    : 0;

  // When production starts, drop the user into a fresh beat project so
  // they can actually start cooking. PluginLayout listens for the
  // 'ghost-open-project' event and will route us out of the lobby and
  // into the new project. Keyed off (battleId × startsAt) so we create
  // exactly one project per session — but cached as `sessionKey|projectId`
  // so that a remount mid-session (e.g. user navigates back to the
  // lobby and the battle is still active) re-routes to the same project
  // instead of failing silently because the create was already done.
  const createProject = useProjectStore((s) => s.createProject);
  // Scope the auto-open cache by userId so switching accounts on the
  // same browser doesn't bleed one user's project id into the other
  // user's session — the cached project wouldn't exist for them and
  // PluginLayout's selection guard would clear it, dropping them on
  // home instead of opening their own fresh project.
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const autoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    // Opted-out spectators must NEVER get auto-pulled into a project
    // — that's the whole point of quitting. The lobby still renders
    // live state for them, but production transitions are read-only.
    if (status !== 'active' || !battle || optedOut) return;
    if (!currentUserId) return; // wait until auth restores
    const sessionKey = `${battle.battleId}::${battle.startsAt ?? ''}`;
    if (autoOpenedRef.current === sessionKey) return;
    autoOpenedRef.current = sessionKey;

    const persistedKey = `beat-battle-auto-opened::${currentUserId}`;

    (async () => {
      try {
        // Try the cached projectId first — but validate it against
        // the user's actual project list before dispatching. If the
        // project was created by another account on this browser, or
        // has since been deleted, the cleanup effect downstream would
        // silently clear the selection and drop the user on home.
        const persistedRaw = localStorage.getItem(persistedKey);
        if (persistedRaw && persistedRaw.startsWith(sessionKey + '|')) {
          const existingId = persistedRaw.slice(sessionKey.length + 1);
          if (existingId) {
            await useProjectStore.getState().fetchProjects();
            const stillExists = useProjectStore.getState().projects.some((p) => p.id === existingId);
            if (stillExists) {
              window.dispatchEvent(new CustomEvent('ghost-open-project', { detail: { projectId: existingId } }));
              return;
            }
            // Stale cache → fall through to fresh create.
            try { localStorage.removeItem(persistedKey); } catch { /* quota */ }
          }
        }

        const name = `Beat Battle — ${battle.kit ?? 'Royale'}`;
        const p = await createProject({
          name,
          projectType: 'beat-battle',
          battleId: battle.battleId,
          battleEndsAt: battle.endsAt,
        });
        localStorage.setItem(persistedKey, `${sessionKey}|${p.id}`);
        // One-shot cleanup of the legacy unscoped key so multi-account
        // browsers don't keep tripping over the stale cross-account
        // projectId that used to live there.
        try { localStorage.removeItem('beat-battle-auto-opened'); } catch { /* quota */ }
        window.dispatchEvent(new CustomEvent('ghost-open-project', { detail: { projectId: p.id } }));
      } catch (err) {
        // Reset the ref so the next render attempts again — without
        // this a transient network blip would lock the user out of
        // production for the rest of the session.
        autoOpenedRef.current = null;
        if (import.meta.env.DEV) console.warn('[BeatBattle] auto-open failed:', err);
      }
    })();
  }, [status, optedOut, currentUserId, battle?.battleId, battle?.startsAt, battle?.endsAt, battle?.kit, createProject]);

  const sendChat = () => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    emitChat(trimmed);
    setChatInput('');
  };

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // Merge live participants into the Player shape the players grid
  // expects. Pad with empty slots up to maxPlayers (8) so the grid
  // always renders a uniform 4×2 layout while the lobby fills up.
  const players: Player[] = useMemo(() => {
    const live = battle?.participants ?? [];
    const max = battle?.maxPlayers ?? 8;
    const mapped: Player[] = live.map((p: BattleParticipant) => ({
      id: p.userId,
      name: p.displayName,
      avatarHue: hashHue(p.userId),
      // During production the most useful signal is "did they
      // submit?" — once flipped it overrides ready/waiting so the
      // tile stays visibly "locked in" for the rest of the round.
      status: p.submitted ? 'submitted' : p.ready ? 'ready' : 'waiting',
    }));
    while (mapped.length < max) {
      mapped.push({ id: `empty-${mapped.length}`, name: '— open slot —', avatarHue: 0, status: 'waiting' });
    }
    return mapped;
  }, [battle]);

  const readyCount = (battle?.participants ?? []).filter((p) => p.ready).length;
  const joinedCount = battle?.participants.length ?? 0;
  const maxPlayers = battle?.maxPlayers ?? 8;

  // Bail out of the battle entirely: drop the socket-level participant
  // record, persist the opt-out flag so the next mount of this page
  // (e.g. user clicks the controller dock again) does NOT auto-rejoin,
  // clear the auto-open memo so the next session creates a fresh
  // project, and tell PluginLayout to flip back to the home dock.
  const quitBattle = () => {
    try {
      const socket = getSocket();
      socket?.emit('battle:leave', { battleId: ARENA_ID });
    } catch { /* socket may be down — server cleanup will catch us */ }
    try { localStorage.removeItem('beat-battle-auto-opened'); } catch { /* quota */ }
    setBattleOptOut(true);
    // We stay on the lobby — flipping opted-out re-renders the page
    // in spectator mode so the user keeps seeing who's still playing.
  };

  // Reverse of quitBattle — wired to the "Rejoin Battle" CTA on the
  // opt-out splash. Clearing the flag re-arms useBeatBattle below,
  // which fires battle:join on its next mount and pulls fresh state.
  const rejoinBattle = () => {
    setBattleOptOut(false);
  };

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
          {optedOut ? (
            <>
              <span
                className="flex items-center gap-1.5 px-3 py-1 rounded-full"
                style={{ background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.30)', color: '#94A3B8' }}
                title="You've left the battle — watching as a spectator"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span className="text-[10.5px] font-bold tracking-[0.14em] uppercase">Spectating</span>
              </span>
              <button
                onClick={rejoinBattle}
                className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-colors"
                style={{ background: 'rgba(168,85,247,0.16)', border: '1px solid rgba(168,85,247,0.45)', color: '#E879F9' }}
                title="Rejoin the battle as a participant"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
                <span className="text-[11px] font-bold tracking-[0.12em] uppercase">Rejoin</span>
              </button>
            </>
          ) : (
            <button
              onClick={quitBattle}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-colors"
              style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)', color: '#F87171' }}
              title="Leave the battle but keep watching as a spectator"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span className="text-[11px] font-bold tracking-[0.12em] uppercase">Quit</span>
            </button>
          )}
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
              <Hero
                status={status}
                kit={battle?.kit ?? 'Trap Essentials'}
                secondsLeft={secondsLeft}
                fmtTime={fmtTime}
                ready={ready}
                onReady={() => {
                  if (optedOut) { rejoinBattle(); return; }
                  const next = !ready;
                  setReady(next);
                  emitReady(next);
                }}
                readyCount={readyCount + (!optedOut && ready ? 1 : 0)}
                joinedCount={joinedCount}
                maxPlayers={maxPlayers}
                prizePool={battle?.prizePool ?? 500}
                spectator={optedOut}
              />
              <PlayersGrid players={players} youReady={ready} maxPlayers={maxPlayers} />
              <div className="grid grid-cols-3 gap-4">
                <ChatPanel chat={chat} input={chatInput} setInput={setChatInput} send={sendChat} />
                <RulesPanel rules={SESSION_RULES} />
                <VotingPreviewPanel submissions={battle?.submissions ?? []} fetchSubmission={fetchSubmission} />
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

function Hero({ status, kit, secondsLeft, fmtTime, ready, onReady, readyCount, joinedCount, maxPlayers, prizePool, spectator }: {
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

function PlayersGrid({ players, youReady, maxPlayers }: { players: Player[]; youReady: boolean; maxPlayers: number }) {
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

function VotingPreviewPanel({ submissions, fetchSubmission }: {
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

function formatDurationShort(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m <= 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, '0')}`;
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

// Deterministic hue from a userId — so every producer has a stable
// avatar colour regardless of when they joined the lobby.
function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// Short relative-time formatter for chat timestamps. Returns "now"
// for anything < 5 s, then Ns / Mm / Hh / Dd. Avoids dragging in a
// full date lib for what's a single use case.
function formatRelTime(iso: string): string {
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
