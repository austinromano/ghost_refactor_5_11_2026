import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useBeatBattle, type BattleParticipant, type BattleSubmissionMeta } from '../../hooks/useBeatBattle';
import { useBeatBattleOptOut, setBattleOptOut } from '../../hooks/useBeatBattleOptOut';
import { useBeatBattleSubmitted, clearBattleSubmitted } from '../../hooks/useBeatBattleSubmitted';
import { useProjectStore } from '../../stores/projectStore';
import { useAuthStore } from '../../stores/authStore';
import { getSocket } from '../../lib/socket';
import {
  Hero, PlayersGrid, ChatPanel, RulesPanel, VotingPreviewPanel,
  SessionInfoPanel, PrizesPanel, MiniWaveform, TransportBtn,
  hashHue, formatRelTime,
} from './BeatBattleComponents';

// Beat Battle — Ghost Session's live producer competition mode.
// Top-level page rendered from PluginLayout when the user picks the
// game-controller dock button. v1 has ONE shared lobby ("the-arena")
// joined automatically on mount; the participant list + ready states
// are live via socket events.

const ARENA_ID = 'the-arena';

type LobbyTab = 'lobby' | 'sessions' | 'community';

export interface Player {
  id: string;
  name: string;
  avatarHue: number;
  status: 'ready' | 'waiting' | 'submitted';
  badge?: string;
}

export interface ChatMessage {
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
  // Drop the submitted flag whenever the lobby is observed in a
  // pre-active state. Covers two paths we previously missed:
  //   1. user submitted, closed the app between rounds, re-opens
  //      while status is 'waiting' — without this they'd be locked
  //      out of auto-open with no recourse;
  //   2. round reset while the user was inside a project (lobby
  //      unmounted, edge transition missed) — flag persists, blocks
  //      next production phase. First mount on the new lobby sees
  //      'waiting' and clears.
  // We deliberately do NOT clear during 'active' / 'voting' — those
  // are the same round the user just submitted to, and the flag
  // should stay set so the Submit button stays hidden and auto-open
  // stays disabled.
  useEffect(() => {
    if (battle?.status === 'waiting' || battle?.status === 'starting') {
      clearBattleSubmitted(ARENA_ID);
    }
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
  // After submit, the producer should sit on the lobby and watch the
  // round finish — re-opening their project mid-spectate would
  // immediately yank them out the moment they land on the lobby.
  const alreadySubmittedToBattle = useBeatBattleSubmitted(ARENA_ID);
  const autoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    // Opted-out spectators must NEVER get auto-pulled into a project
    // — that's the whole point of quitting. The lobby still renders
    // live state for them, but production transitions are read-only.
    if (status !== 'active' || !battle || optedOut) return;
    if (alreadySubmittedToBattle) return; // already locked in this round
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
          // Beat Battle projects need a concrete tempo + time signature
          // out of the gate — the arrangement grid falls back to 120
          // when projectBpm <= 0 but several scheduler paths (warp,
          // drum stepping, MIDI snapping) bail when bpm <= 0, which
          // makes audio play at native speed while the grid still
          // renders at 120 → visible timing drift in the arrangement.
          // Persisting 120/4/4 keeps every code path in sync.
          tempo: 120,
          timeSignature: '4/4',
          battleId: battle.battleId,
          battleEndsAt: battle.endsAt,
        } as any);
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
  }, [status, optedOut, alreadySubmittedToBattle, currentUserId, battle?.battleId, battle?.startsAt, battle?.endsAt, battle?.kit, createProject]);

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
    // Drop both the legacy unscoped key AND the current per-user key
    // so a later Rejoin (even within the same active round) gets a
    // fresh project instead of being dumped back into the abandoned
    // one. Same key shape as the auto-open effect uses.
    try { localStorage.removeItem('beat-battle-auto-opened'); } catch { /* quota */ }
    if (currentUserId) {
      try { localStorage.removeItem(`beat-battle-auto-opened::${currentUserId}`); } catch { /* quota */ }
    }
    setBattleOptOut(true);
    // We stay on the lobby — flipping opted-out re-renders the page
    // in spectator mode so the user keeps seeing who's still playing.
  };

  // Reverse of quitBattle — wired to the "Rejoin Battle" CTA on the
  // opt-out splash. Clearing the flag re-arms useBeatBattle below,
  // which fires battle:join on its next mount and pulls fresh state.
  // We also belt-and-braces clear the auto-open cache so the user
  // always lands in a fresh project for the round they're rejoining.
  const rejoinBattle = () => {
    try { localStorage.removeItem('beat-battle-auto-opened'); } catch { /* quota */ }
    if (currentUserId) {
      try { localStorage.removeItem(`beat-battle-auto-opened::${currentUserId}`); } catch { /* quota */ }
    }
    // Same goes for the autoOpenedRef sessionKey memo — without
    // resetting it the effect's "I already handled this session"
    // guard would short-circuit and skip the fresh-create path.
    autoOpenedRef.current = null;
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
