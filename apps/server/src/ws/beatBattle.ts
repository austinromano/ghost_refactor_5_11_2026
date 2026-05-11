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
}

const BATTLES = new Map<string, Battle>();

// Seed the only lobby. Once create-battle lands this becomes a default
// matchmaking pool; until then every user lands here.
const ARENA_ID = 'the-arena';
BATTLES.set(ARENA_ID, {
  id: ARENA_ID,
  name: 'The Arena',
  status: 'waiting',
  kit: 'Trap Essentials',
  timeLimit: 20 * 60,
  prizePool: 500,
  maxPlayers: 8,
  participants: new Map(),
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
  };
}

function broadcast(io: IO, battle: Battle) {
  io.to(`battle:${battle.id}`).emit('battle:state', snapshot(battle));
}

export function registerBeatBattleHandlers(io: IO, socket: SK) {
  const joined = new Set<string>();

  socket.on('battle:join', ({ battleId }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
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
      });
    }
    broadcast(io, battle);
  });

  socket.on('battle:leave', ({ battleId }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    socket.leave(`battle:${battle.id}`);
    joined.delete(battle.id);
    battle.participants.delete(socket.data.userId);
    broadcast(io, battle);
  });

  socket.on('battle:ready', ({ battleId, ready }) => {
    const battle = BATTLES.get(battleId);
    if (!battle) return;
    const me = battle.participants.get(socket.data.userId);
    if (!me) return;
    me.ready = !!ready;
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
      broadcast(io, battle);
    }
    joined.clear();
  });
}
