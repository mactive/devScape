import { create } from 'zustand'
import type { Session, ProjectStats, HeatmapMode, HeatmapTimeRange } from '../types'

function projectSelectionKey(source: Session['source'] | ProjectStats['source'], projectPath: string): string {
  return `${source}:${projectPath}`
}

interface AppState {
  sessions: Session[]
  projects: ProjectStats[]
  selectedSession: Session | null
  selectedProjectKey: string | null
  loadingDetail: boolean
  loading: boolean
  error: string | null
  heatmapMode: HeatmapMode
  heatmapTimeRange: HeatmapTimeRange
  heatmapProject: string
  searchQuery: string

  loadSessions: () => Promise<void>
  selectSession: (session: Session | null) => Promise<void>
  selectProject: (projectKey: string | null) => void
  setHeatmapMode: (mode: HeatmapMode) => void
  setHeatmapTimeRange: (range: HeatmapTimeRange) => void
  setHeatmapProject: (project: string) => void
  setSearchQuery: (q: string) => void

  // Derived metrics
  totalSessions: () => number
  totalPrompts: () => number
  totalTokens: () => number
  totalLinesAdded: () => number
  totalLinesRemoved: () => number
}

export const useStore = create<AppState>((set, get) => ({
  sessions: [],
  projects: [],
  selectedSession: null,
  selectedProjectKey: null,
  loadingDetail: false,
  loading: false,
  error: null,
  heatmapMode: 'TOKENS',
  heatmapTimeRange: 'MONTH',
  heatmapProject: 'ALL PROJECTS',
  searchQuery: '',

  loadSessions: async () => {
    set({ loading: true, error: null })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (window as any).api.getSessions()
      
      // Deduplicate projects by source + name
      const uniqueProjects = Array.from(
        new Map((result.projects || []).map((p: ProjectStats) => [`${p.source}:${p.path}`, p])).values()
      ) as ProjectStats[]
      
      set({ sessions: result.sessions || [], projects: uniqueProjects, loading: false })
    } catch (err) {
      set({ error: String(err), loading: false })
    }
  },

  selectSession: async (session: Session | null) => {
    if (!session) {
      set({ selectedSession: null })
      return
    }
    // Also select the corresponding project to ensure the terrain updates
    set({
      selectedSession: session,
      selectedProjectKey: projectSelectionKey(session.source, session.projectPath),
      loadingDetail: true
    })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = await (window as any).api.getSessionDetail(session.id)
      if (detail?.messages) {
        set({ selectedSession: { ...session, messages: detail.messages }, loadingDetail: false })
      } else {
        set({ selectedSession: session, loadingDetail: false })
      }
    } catch {
      set({ selectedSession: session, loadingDetail: false })
    }
  },

  selectProject: (projectKey) => set({ selectedProjectKey: projectKey }),

  setHeatmapMode: (mode) => set({ heatmapMode: mode }),
  setHeatmapTimeRange: (range) => set({ heatmapTimeRange: range }),
  setHeatmapProject: (project) => set({ heatmapProject: project }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  totalSessions: () => get().sessions.length,
  totalPrompts: () => get().sessions.reduce((sum, s) => sum + s.promptCount, 0),
  totalTokens: () => get().sessions.reduce((sum, s) => sum + s.totalTokens, 0),
  totalLinesAdded: () => get().sessions.reduce((sum, s) => sum + (s.linesAdded || 0), 0),
  totalLinesRemoved: () => get().sessions.reduce((sum, s) => sum + (s.linesRemoved || 0), 0)
}))
