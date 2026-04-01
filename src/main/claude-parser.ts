import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface RawMessage {
  uuid?: string
  type: string
  role?: string
  content?: string | ContentBlock[]
  timestamp?: string
  parentUuid?: string
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
  message?: {
    role: string
    content: string | ContentBlock[]
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

export interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  content?: string | ContentBlock[]
}

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
  toolCallCount: number
  bashCallCount: number
  toolDensity: number
  bashRatio: number
}

function decodeDirName(dirName: string): string {
  // Convert -Users-foo-bar to /Users/foo/bar
  // Replace leading - with / and all other - with /
  // But path segments with hyphens are tricky - we use leading - as indicator
  if (dirName.startsWith('-')) {
    return '/' + dirName.slice(1).replace(/-/g, '/')
  }
  return dirName.replace(/-/g, '/')
}

function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text || '')
      .join('\n')
      .trim()
  }
  return ''
}

function extractToolName(content: string | ContentBlock[] | undefined): string | null {
  if (!Array.isArray(content)) return null
  const toolUse = content.find((c) => c.type === 'tool_use')
  return toolUse?.name || null
}

function countLinesFromMessages(messages: RawMessage[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const msg of messages) {
    if (msg.type !== 'tool' && msg.role !== 'tool') continue
    const content = msg.content
    if (typeof content === 'string') {
      const lines = content.split('\n')
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++
        if (line.startsWith('-') && !line.startsWith('---')) removed++
      }
    }
  }
  return { added, removed }
}

export function parseClaudeSessions(): { sessions: Session[]; projects: ProjectStats[] } {
  const claudeDir = join(homedir(), '.claude', 'projects')

  if (!existsSync(claudeDir)) {
    return { sessions: [], projects: [] }
  }

  const sessions: Session[] = []
  const projectMap = new Map<string, ProjectStats>()

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(claudeDir).filter((d) => {
      try {
        return statSync(join(claudeDir, d)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { sessions: [], projects: [] }
  }

  for (const projectDirName of projectDirs) {
    const projectDirPath = join(claudeDir, projectDirName)
    const projectPath = decodeDirName(projectDirName)
    const segments = projectPath.split('/').filter(Boolean)
    const projectName = segments[segments.length - 1] || projectDirName

    let jsonlFiles: string[]
    try {
      jsonlFiles = readdirSync(projectDirPath).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const jsonlFile of jsonlFiles) {
      const sessionId = jsonlFile.replace('.jsonl', '')
      const filePath = join(projectDirPath, jsonlFile)

      try {
        const fileContent = readFileSync(filePath, 'utf-8')
        const lines = fileContent.trim().split('\n').filter(Boolean)

        if (lines.length === 0) continue

        const rawMessages: RawMessage[] = []
        const parsedMessages: ParsedMessage[] = []
        let firstPrompt = ''
        let lastPrompt = ''
        let promptCount = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalCacheTokens = 0
        let toolCallCount = 0
        let bashCallCount = 0
        let startTime: Date | null = null
        let endTime: Date | null = null
        let hasError = false

        for (const line of lines) {
          try {
            const msg = JSON.parse(line) as RawMessage
            rawMessages.push(msg)

            if (msg.timestamp) {
              const ts = new Date(msg.timestamp)
              if (!isNaN(ts.getTime())) {
                if (!startTime || ts < startTime) startTime = ts
                if (!endTime || ts > endTime) endTime = ts
              }
            }

            if (msg.type === 'user' && msg.message) {
              const text = extractTextContent(msg.message.content)
              if (text.trim()) {
                promptCount++
                const truncated = text.substring(0, 300)
                if (!firstPrompt) firstPrompt = truncated
                lastPrompt = truncated

                parsedMessages.push({
                  role: 'user',
                  content: text,
                  timestamp: msg.timestamp
                })
              }
            } else if (msg.type === 'assistant' && msg.message) {
              const text = extractTextContent(msg.message.content)
              const toolName = extractToolName(msg.message.content)

              // Count all tool_use blocks in this message
              if (Array.isArray(msg.message.content)) {
                for (const block of msg.message.content) {
                  if (block.type === 'tool_use') {
                    toolCallCount++
                    if (block.name === 'Bash') bashCallCount++
                  }
                }
              }

              if (msg.message.usage) {
                const usage = msg.message.usage
                totalInputTokens += usage.input_tokens || 0
                totalOutputTokens += usage.output_tokens || 0
                totalCacheTokens +=
                  (usage.cache_creation_input_tokens || 0) +
                  (usage.cache_read_input_tokens || 0)
              }

              if (text || toolName) {
                parsedMessages.push({
                  role: 'assistant',
                  content: text || `[Tool: ${toolName}]`,
                  timestamp: msg.timestamp,
                  inputTokens: msg.message.usage?.input_tokens,
                  outputTokens: msg.message.usage?.output_tokens,
                  isToolCall: !!toolName,
                  toolName: toolName || undefined
                })
              }
            } else if (msg.type === 'error') {
              hasError = true
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (!startTime) startTime = new Date()
        if (!endTime) endTime = startTime

        const { added, removed } = countLinesFromMessages(rawMessages)

        let status: Session['status'] = 'success'
        if (hasError) {
          status = 'error'
        } else if (promptCount > 15) {
          status = 'debug'
        }

        const session: Session = {
          id: sessionId,
          projectPath,
          projectName,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          firstPrompt: firstPrompt || '(no prompts)',
          lastPrompt: lastPrompt || firstPrompt || '(no prompts)',
          promptCount,
          totalTokens: totalInputTokens + totalOutputTokens,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheTokens: totalCacheTokens,
          status,
          linesAdded: added,
          linesRemoved: removed,
          messages: parsedMessages
        }

        sessions.push(session)

        const existing = projectMap.get(projectPath) || {
          name: projectName,
          path: projectPath,
          totalTokens: 0,
          sessionCount: 0,
          promptCount: 0,
          lastActive: session.endTime,
          toolCallCount: 0,
          bashCallCount: 0,
          toolDensity: 0,
          bashRatio: 0,
        }
        existing.totalTokens += session.totalTokens
        existing.sessionCount++
        existing.promptCount += promptCount
        existing.toolCallCount += toolCallCount
        existing.bashCallCount += bashCallCount
        if (session.endTime > existing.lastActive) {
          existing.lastActive = session.endTime
        }
        projectMap.set(projectPath, existing)
      } catch {
        // Skip unreadable files
      }
    }
  }

  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())

  const projects = Array.from(projectMap.values())
  for (const p of projects) {
    p.toolDensity = p.promptCount > 0 ? p.toolCallCount / p.promptCount : 0
    p.bashRatio   = p.toolCallCount > 0 ? p.bashCallCount / p.toolCallCount : 0
  }
  projects.sort((a, b) => b.totalTokens - a.totalTokens)

  return { sessions, projects }
}

export function parseSessionDetail(sessionId: string, projectDirName: string): ParsedMessage[] {
  const claudeDir = join(homedir(), '.claude', 'projects')
  const filePath = join(claudeDir, projectDirName, `${sessionId}.jsonl`)

  if (!existsSync(filePath)) return []

  try {
    const fileContent = readFileSync(filePath, 'utf-8')
    const lines = fileContent.trim().split('\n').filter(Boolean)
    const messages: ParsedMessage[] = []

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as RawMessage

        if (msg.type === 'user' && msg.message) {
          const text = extractTextContent(msg.message.content)
          if (text.trim()) {
            messages.push({
              role: 'user',
              content: text,
              timestamp: msg.timestamp
            })
          }
        } else if (msg.type === 'assistant' && msg.message) {
          const text = extractTextContent(msg.message.content)
          const toolName = extractToolName(msg.message.content)

          if (text || toolName) {
            messages.push({
              role: 'assistant',
              content: text || `[Tool call: ${toolName}]`,
              timestamp: msg.timestamp,
              inputTokens: msg.message.usage?.input_tokens,
              outputTokens: msg.message.usage?.output_tokens,
              isToolCall: !!toolName && !text,
              toolName: toolName || undefined
            })
          }
        }
      } catch {
        // skip
      }
    }

    return messages
  } catch {
    return []
  }
}
