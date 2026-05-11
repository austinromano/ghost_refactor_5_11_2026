import { useCallback, useEffect, useState } from 'react';
import { getSocket } from '../lib/socket';

// Live state for a single Beat Battle lobby. Mounts → join via socket;
// unmounts → leave. Subscribes to `battle:state` and re-renders the
// caller (BeatBattlePage) with the latest participant + status data.

export interface BattleParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  ready: boolean;
  joinedAt: string;
}

export interface BattleState {
  battleId: string;
  name: string;
  status: 'waiting' | 'starting' | 'active' | 'voting' | 'complete';
  kit: string;
  timeLimit: number;
  prizePool: number;
  maxPlayers: number;
  participants: BattleParticipant[];
  startsAt: string | null;
  endsAt: string | null;
}

export interface BattleChatMessage {
  id: string;
  battleId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  text: string;
  createdAt: string;
}

export function useBeatBattle(battleId: string | null, opts?: { spectator?: boolean }) {
  const spectator = !!opts?.spectator;
  const [state, setState] = useState<BattleState | null>(null);
  // Capped rolling buffer of chat messages — keep the most recent
  // 100 so a long lobby doesn't blow up state. Server doesn't
  // backfill history on join yet (v2 todo); new joiners start with
  // an empty thread and see messages from the moment they joined.
  const [chat, setChat] = useState<BattleChatMessage[]>([]);

  useEffect(() => {
    if (!battleId) return;
    const socket = getSocket();
    if (!socket) return;

    const onState = (payload: BattleState) => {
      if (payload.battleId !== battleId) return;
      setState(payload);
    };
    const onMessage = (payload: BattleChatMessage) => {
      if (payload.battleId !== battleId) return;
      setChat((prev) => {
        const next = [...prev, payload];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    };

    socket.on('battle:state', onState);
    socket.on('battle:message', onMessage);
    // Spectator joins subscribe to broadcasts without being added to
    // the participants set on the server, so a user who quit the
    // battle can keep watching the lobby without silently rejoining.
    socket.emit('battle:join', { battleId, spectator });

    return () => {
      socket.off('battle:state', onState);
      socket.off('battle:message', onMessage);
      // Spectators were never in the participants set, but the leave
      // handler also removes us from the socket.io room which is
      // exactly what we want either way — it's a no-op on the
      // participant side when we're a spectator.
      try { socket.emit('battle:leave', { battleId }); } catch { /* socket closed */ }
    };
  }, [battleId, spectator]);

  const setReady = useCallback((ready: boolean) => {
    if (!battleId) return;
    const socket = getSocket();
    if (!socket) return;
    socket.emit('battle:ready', { battleId, ready });
  }, [battleId]);

  const sendChat = useCallback((text: string) => {
    if (!battleId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const socket = getSocket();
    if (!socket) return;
    socket.emit('battle:chat', { battleId, text: trimmed });
  }, [battleId]);

  return { state, chat, setReady, sendChat };
}
