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
  // True once the producer fires battle:submit. Lobby tiles show a
  // "Submitted" badge instead of the ready/waiting status.
  submitted?: boolean;
}

export interface BattleSubmissionMeta {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  mime: string;
  durationSec: number;
  submittedAt: string;
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
  // Metadata for each producer who has bounced their beat. Audio is
  // fetched on demand via fetchSubmission().
  submissions?: BattleSubmissionMeta[];
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
      // IMPORTANT: don't emit battle:leave on every unmount. The
      // lobby component unmounts every time the user navigates to a
      // project (including the auto-opened battle project), and
      // firing leave there would kick the user out of participants
      // server-side — breaking submission, ready, and "still in the
      // lobby after submit". Explicit Quit handlers and the socket
      // disconnect handler are the only legitimate ways to drop a
      // participant. Spectator-mode listeners simply unbind here.
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

  // Lazy audio fetch for a single submission. Returns a Promise that
  // resolves to a Blob (or null when the server has no audio for
  // that user). Used by the Voting Preview panel's play buttons —
  // we never preload audio so a lobby with 8 submissions doesn't
  // burn 8 sockets of bandwidth on join.
  const fetchSubmission = useCallback((userId: string): Promise<Blob | null> => {
    if (!battleId) return Promise.resolve(null);
    const socket = getSocket();
    if (!socket) return Promise.resolve(null);
    return new Promise<Blob | null>((resolve) => {
      // audio is typed as `unknown` in the protocol so the shared
      // package doesn't depend on Node's Buffer — runtime, it's an
      // ArrayBuffer/Uint8Array/Blob from socket.io's binary transport.
      const handler = (payload: { userId: string; audio: unknown; mime: string | null }) => {
        if (payload.userId !== userId) return;
        socket.off('battle:submission-audio', handler);
        if (!payload.audio || !payload.mime) {
          resolve(null);
          return;
        }
        try {
          resolve(new Blob([payload.audio as BlobPart], { type: payload.mime }));
        } catch {
          resolve(null);
        }
      };
      socket.on('battle:submission-audio', handler);
      // Safety timeout — if the server never responds, don't leave
      // the listener hanging on the socket forever.
      setTimeout(() => {
        socket.off('battle:submission-audio', handler);
        resolve(null);
      }, 15000);
      socket.emit('battle:fetch-submission', { battleId, userId });
    });
  }, [battleId]);

  return { state, chat, setReady, sendChat, fetchSubmission };
}
