export type DataSource = 'claude' | 'trae' | 'trae-cn'

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
  source: DataSource
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
  source: DataSource
  totalTokens: number
  sessionCount: number
  promptCount: number
  lastActive: string
  toolCallCount: number   // total tool_use calls across all sessions
  bashCallCount: number   // subset that are Bash calls
  toolDensity: number     // toolCallCount / promptCount (0 if no prompts)
  bashRatio: number       // bashCallCount / toolCallCount (0 if no tools)
}

export interface HeatmapCell {
  date: string
  count: number
  sessions: number
  tokens: number
}

export type HeatmapMode = 'SESSIONS' | 'FILES' | 'TOKENS'
export type HeatmapTimeRange = 'DAY' | 'WEEK' | 'MONTH'
