import { create } from 'zustand';
import type { Project, ProjectDetail, Track, Version } from '@ghost/types';
import { api } from '../lib/api';
import { peaksCache } from '../lib/audio';

interface ProjectState {
  projects: Project[];
  currentProject: ProjectDetail | null;
  versions: Version[];
  loading: boolean;

  fetchProjects: () => Promise<void>;
  fetchProject: (id: string) => Promise<void>;
  createProject: (data: { name: string; description?: string; tempo?: number; key?: string; timeSignature?: string; projectType?: string; battleId?: string | null; battleEndsAt?: string | null }) => Promise<Project>;

  updateProject: (projectId: string, data: { name?: string; tempo?: number; key?: string; genre?: string }) => Promise<void>;
  addTrack: (projectId: string, data: { name: string; type: string }) => Promise<void>;
  updateTrack: (projectId: string, trackId: string, data: Partial<Track>) => Promise<void>;
  deleteTrack: (projectId: string, trackId: string) => Promise<void>;

  fetchVersions: (projectId: string) => Promise<void>;
  createVersion: (projectId: string, data: { name: string; description?: string }) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  versions: [],
  loading: false,

  fetchProjects: async () => {
    set({ loading: true });
    const projects = await api.listProjects();
    set({ projects, loading: false });
  },

  fetchProject: async (id) => {
    set({ loading: true });
    const project = await api.getProject(id);
    // Seed the peaks cache from the inline peaks that came back with the
    // project detail. Waveform components will render immediately from
    // these without hitting the network.
    if (project?.tracks) {
      for (const t of project.tracks as any[]) {
        if (t.fileId && t.peaks) peaksCache.set(t.fileId, t.peaks);
      }
    }
    set({ currentProject: project, loading: false });
  },

  createProject: async (data) => {
    const project = await api.createProject(data);
    set((s) => ({ projects: [project, ...s.projects] }));
    return project;
  },

  updateProject: async (projectId, data) => {
    await api.updateProject(projectId, data);
    await get().fetchProject(projectId);
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, ...data } : p
      ),
    }));
  },

  addTrack: async (projectId, data) => {
    await api.addTrack(projectId, data as any);
    await get().fetchProject(projectId);
  },

  updateTrack: async (projectId, trackId, data) => {
    await api.updateTrack(projectId, trackId, data);
    await get().fetchProject(projectId);
  },

  deleteTrack: async (projectId, trackId) => {
    await api.deleteTrack(projectId, trackId);
    await get().fetchProject(projectId);
  },

  fetchVersions: async (projectId) => {
    const versions = await api.listVersions(projectId);
    set({ versions });
  },

  createVersion: async (projectId, data) => {
    await api.createVersion(projectId, data);
    await get().fetchVersions(projectId);
  },
}));
