import type { Track } from './track';

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  tempo: number;
  key: string;
  genre: string;
  timeSignature: string;
  projectType?: string;
  // JSON-serialised arrangement blob (set by the client). Null when no
  // arrangement has been saved yet.
  arrangementJson?: string | null;
  // Set when this project is the workspace for a Beat Battle session.
  // battleId identifies the lobby (used to resubscribe to battle:state
  // events) and battleEndsAt is the production-phase deadline so the
  // header timer keeps a sensible value even before the live socket
  // payload arrives.
  battleId?: string | null;
  battleEndsAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

export interface ProjectDetail extends Project {
  members: ProjectMember[];
  tracks: Track[];
}
