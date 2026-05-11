import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '@ghost/protocol';

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type SK = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

// Beat Battle lobby — v1 holds a single shared room ("the-arena") and
// keeps participant state in-memory. Mirrors the pattern used by
// community.ts (presence map + room broadcast on every mutation). No
// DB rows yet — battles are ephemeral; persistence + Sessions tab
// history come once the format settles.

interface Participant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  ready: boolean;
  joinedAt: string;
  // Set true when the producer fires battle:submit during the
  // 'active' phase. Once flipped, the lobby shows their tile with a
  // "Submitted" badge and they're free to sit out the rest of the
  // countdown without losing their slot.
  submitted: boolean;
}

interface Battle {
  id: string;
  name: string;
  status: 'waiting' | 'starting' | 'active' | 'voting' | 'complete';
  kit: string;
  timeLimit: number;
  prizePool: number;
  maxPlayers: number;
  participants: Map<string, Participant>;
  // ISO timestamps that drive the client-side countdowns. startsAt
  // is set when status flips to 'starting' (now + 5s); endsAt is set
  // when status flips to 'active' (now + timeLimit). Cleared on
  // every reset back to 'waiting'.
  startsAt: string | null;
  endsAt: string | null;
  // Server-side timer handle so we can cancel a pending start when
  // the readiness condition stops being met mid-countdown.
  startTimer?: ReturnType<typeof setTimeout> | null;
  endTimer?: ReturnType<typeof setTimeout> | null;
}

const BATTLES = new Map<string, Battle>();
const MIN_PLAYERS_TO_START = 2;
const COUNTDOWN_SECONDS = 5;
const VOTING_SECONDS = 30;

// Kit pool — v1 picks a random one on every transition into
// 'active'. Names are placeholder; real sample-library mapping
// happens in the next slice (DAW handoff).
const KITS = [
  'Trap Essentials',
  'Drill Vault',
  'Lo-Fi Boom Bap',
  'House Foundations',
  'Hyperpop Glitch',
  'Afro Drum Lab',
];

// Seed the only lobby. Once create-battle lands this becomes a default
// matchmaking pool; until then every user lands here.
const ARENA_ID = 'the-arena';
BATTLES.set(ARENA_ID, {
  id: ARENA_ID,
  name: 'The Arena',
  status: 'waiting',
  kit: KITS[0],
  timeLimit: 20 * 60,
  prizePool: 500,
  maxPlayers: 8,
  participants: new Map(),
  startsAt: null,
  endsAt: null,
});

function snapshot(battle: Battle) {
  return {
    battleId: battle.id,
    name: battle.name,
    status: battle.status,
    kit: battle.kit,
    timeLimit: battle.timeLimit,
    prizePool: battle.prizePool,
    maxPlayers: battle.maxPlayers,
    participants: Array.from(battle.participants.values()),
    startsAt: battle.startsAt,
    endsAt: battle.endsAt,
  };
}

function broadcast(io: IO, battle: Battle) {
  io.to(`battle:${battle.id}`).emit('battle:state', snapshot(battle));
}

// Reset the battle to its idle state. Clears any pending timers,
// un-readies every participant, drops countdown timestamps, and
// rolls a fresh kit so the next round isn't a repeat.
function resetToWaiting(battle: Battle) {
  if (battle.startTimer) { clearTimeout(battle.startTimer); battle.startTimer = null; }
  if (battle.endTimer) { clearTimeout(battle.endTimer); battle.endTimer = null; }
  battle.status = 'waiting';
  battle.startsAt = null;
  battle.endsAt = null;
  for (const p of battle.participants.values()) {
    p.ready = false;
    p.submitted = false;
  }
}

// State-machine driver. Called after every join/leave/ready mutation
// to push the lobby through its lifecycle:
//   waiting → all ready + min players → starting (5 s countdown)
//   starting → countdown done → active (kit randomized, endsAt set)
//   active  → endsAt reached → voting (30 s)
//   voting  → timer done → waiting (everyone un-readied)
function evaluateTransitions(io: IO, battle: Battle) {
  if (battle.status === 'waiting') {
    const enough = battle.participants.size >= MIN_PLAYERS_TO_START;
    const allReady = battle.participants.size > 0
      && Array.from(battle.participants.values()).every((p) => p.ready);
    if (enough && allReady) {
      battle.status = 'starting';
      battle.startsAt = new Date(Date.now() + COUNTDOWN_SECONDS * 1000).toISOString();
      battle.startTimer = setTimeout(() => {
        // Re-check readiness at the end of the countdown — a user
        // could have un-readied or left in the last few seconds.
        const stillReady = battle.participants.size >= MIN_PLAYERS_TO_START
          && Array.from(battle.participants.values()).every((p) => p.ready);
        if (!stillReady) {
          resetToWaiting(battle);
          broadcast(io, battle);
          return;
        }
        battle.status = 'active';
        battle.kit = KITS[Math.floor(Math.random() * KITS.length)];
        battle.startsAt = null;
        battle.endsAt = new Date(Date.now() + battle.timeLimit * 1000).toISOString();
        battle.startTimer = null;
        // Schedule the active → voting flip. Voting → waiting is
        // chained on top so the room recycles itself.
        battle.endTimer = setTimeout(() => {
          battle.status = 'voting';
          battle.endsAt = new Date(Date.now() + VOTING_SECONDS * 1000).toISOString();
          broadcast(io, battle);
          battle.endTimer = setTimeout(() => {
            resetToWaiting(battle);
            broadcast(io, battle);
          }, VOTING_SECONDS * 1000);
        }, battle.timeLimit * 1000);
        broadcast(io, battle);
      }, COUNTDOWN_SECONDS * 1000);
    }
    return;
  }
  if (battle.status === 'starting') {
    // Mid-countdown — bail if someone unreadied or dropped below
    // the minimum. The timer that flips to 'active' double-checks
    // too, but cancelling here gives faster UI feedback.
    const enough = battle.participants.size >= MIN_PLAYERS_TO_START;
    const allReady = Array.from(battle.participants.values()).every((p) => p.ready);
    if (!enough || !allReady) {
      resetToWaiting(battle);
    }
  }
}

export function registerBeatBattleHandlers(io: IO, socket: SK) {
  const joined = new Set<string>();

  socket.on('battle:join', ({ battleId, spectator }: { battleId: string; spectator?: boolean }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    // Spectator joins subscribe to the socket room (so they receive
    // state + chat broadcasts) without being added to the competing
    // participant set. Used after a Quit so the user can keep
    // watching the battle they bailed on.
    if (spectator) {
      socket.join(`battle:${battle.id}`);
      joined.add(battle.id);
      broadcast(io, battle);
      return;
    }
    if (battle.participants.size >= battle.maxPlayers && !battle.participants.has(socket.data.userId)) {
      // Lobby full — silently ignore. v2 will surface a "lobby full"
      // toast to the client and offer to spin up a sibling room.
      return;
    }
    socket.join(`battle:${battle.id}`);
    joined.add(battle.id);
    if (!battle.participants.has(socket.data.userId)) {
      battle.participants.set(socket.data.userId, {
        userId: socket.data.userId,
        displayName: socket.data.displayName,
        avatarUrl: socket.data.avatarUrl ?? null,
        ready: false,
        joinedAt: new Date().toISOString(),
        submitted: false,
      });
    }
    evaluateTransitions(io, battle);
    broadcast(io, battle);
  });

  // Producer hits "Submit Beat" in their project. We just flip the
  // submitted flag on their participant record and rebroadcast so
  // every lobby viewer sees the badge. Vote-ready audio + judging
  // are still v2 — the flag is what the UI keys off of for v1.
  socket.on('battle:submit', ({ battleId }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    const me = battle.participants.get(socket.data.userId);
    if (!me) return;
    if (battle.status !== 'active') return; // ignore early/late submits
    me.submitted = true;
    broadcast(io, battle);
  });

  socket.on('battle:leave', ({ battleId }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    socket.leave(`battle:${battle.id}`);
    joined.delete(battle.id);
    battle.participants.delete(socket.data.userId);
    evaluateTransitions(io, battle);
    broadcast(io, battle);
  });

  socket.on('battle:ready', ({ battleId, ready }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    const me = battle.participants.get(socket.data.userId);
    if (!me) return;
    me.ready = !!ready;
    evaluateTransitions(io, battle);
    broadcast(io, battle);
  });

  socket.on('battle:chat', ({ battleId, text }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    // Lobby chat is open to anyone in the room (even spectators when
    // we add that), so we don't gate on `participants.has` here.
    // Anti-abuse: clamp text length + drop empties. Server stamps the
    // message id + timestamp so all clients see identical ordering.
    const trimmed = (text || '').trim().slice(0, 500);
    if (!trimmed) return;
    io.to(`battle:${battle.id}`).emit('battle:message', {
      id: crypto.randomUUID(),
      battleId: battle.id,
      userId: socket.data.userId,
      displayName: socket.data.displayName,
      avatarUrl: socket.data.avatarUrl ?? null,
      text: trimmed,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on('disconnect', () => {
    for (const battleId of joined) {
      const battle = BATTLES.get(battleId);
      if (!battle) continue;
      battle.participants.delete(socket.data.userId);
      evaluateTransitions(io, battle);
      broadcast(io, battle);
    }
    joined.clear();
  });
}
