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

export function useBeatBattle(battleId: string | null) {
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
    socket.emit('battle:join', { battleId });

    return () => {
      socket.off('battle:state', onState);
      socket.off('battle:message', onMessage);
      try { socket.emit('battle:leave', { battleId }); } catch { /* socket closed */ }
    };
  }, [battleId]);

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
