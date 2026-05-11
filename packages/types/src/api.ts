import type { User } from './user';
import type { TrackType } from './track';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  tempo?: number;
  key?: string;
  genre?: string;
  timeSignature?: string;
  projectType?: string;
  battleId?: string | null;
  battleEndsAt?: string | null;
}

export interface AddTrackRequest {
  name: string;
  type: TrackType;
  fileId?: string;
  fileName?: string;
  bpm?: number;
  key?: string;
}

export interface CreateVersionRequest {
  name: string;
  description?: string;
}

export interface AddCommentRequest {
  text: string;
  positionBeats?: number;
  parentId?: string;
}
