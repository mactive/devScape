export interface ParsedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp?: string
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  isToolCall?: boolean
  toolName?: string
}

export interface Session {
  id: string
  projectPath: string
  projectName: string
  startTime: string
  endTime: string
  firstPrompt: string
  lastPrompt: string
  promptCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  status: 'success' | 'debug' | 'error'
  linesAdded: number
  linesRemoved: number
  messages?: ParsedMessage[]
}

export interface ProjectStats {
  name: string
  path: string
  totalTokens: number
  sessionCount: number
  promptCount: number
  lastActive: string
}

export interface HeatmapCell {
  date: string
  count: number
  sessions: number
  tokens: number
}

export type HeatmapMode = 'SESSIONS' | 'FILES' | 'TOKENS'
export type HeatmapTimeRange = 'DAY' | 'WEEK' | 'MONTH'
