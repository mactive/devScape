import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'

export type DataSource = 'claude' | 'trae' | 'trae-cn' | 'codex'

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
  name?: string
  id?: string
  input?: Record<string, unknown>
  content?: string | ContentBlock[]
}

interface CodexLogEvent {
  timestamp?: string
  type: string
  payload?: {
    type?: string
    role?: string
    content?: ContentBlock[]
    phase?: string
    name?: string
    arguments?: string
    input?: string
    message?: string
    id?: string
    timestamp?: string
    cwd?: string
    total_token_usage?: {
      input_tokens?: number
      output_tokens?: number
      cached_input_tokens?: number
      total_tokens?: number
    }
    last_token_usage?: {
      input_tokens?: number
      output_tokens?: number
      cached_input_tokens?: number
      total_tokens?: number
    }
    info?: {
      total_token_usage?: {
        input_tokens?: number
        output_tokens?: number
        cached_input_tokens?: number
        total_tokens?: number
      }
      last_token_usage?: {
        input_tokens?: number
        output_tokens?: number
        cached_input_tokens?: number
        total_tokens?: number
      }
    }
  }
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
  toolCallCount: number
  bashCallCount: number
  toolDensity: number
  bashRatio: number
}

interface TraeInputHistoryItem {
  inputText?: string
}

function parseJsonSafely<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function decodeFileUriPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''))
  } catch {
    return uri.replace(/^file:\/\//, '')
  }
}

function sqliteQueryAsJson(dbPath: string, sql: string): Array<Record<string, unknown>> {
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf-8' })
    if (!out.trim()) return []
    return parseJsonSafely<Array<Record<string, unknown>>>(out, [])
  } catch {
    return []
  }
}

function projectKey(source: DataSource, path: string): string {
  return `${source}:${path}`
}

function collectJsonlFiles(dir: string, limit = 4000): string[] {
  if (!existsSync(dir)) return []
  const result: string[] = []
  const stack = [dir]
  while (stack.length && result.length < limit) {
    const current = stack.pop()!
    let entries: string[] = []
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(current, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) stack.push(fullPath)
        else if (entry.endsWith('.jsonl')) result.push(fullPath)
      } catch {
        // Ignore entries that disappear or cannot be read.
      }
    }
  }
  return result
}

function extractCodexContent(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      if (Array.isArray(block.content)) return extractCodexContent(block.content)
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isCodexUserPrompt(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return !trimmed.startsWith('<environment_context>')
}

function codexSessionIdFromFile(filePath: string): string {
  const file = basename(filePath).replace('.jsonl', '')
  const match = file.match(/(019[a-z0-9-]+)$/i)
  return match?.[1] || file
}

function findCodexSessionFile(sessionId: string): string | null {
  const normalizedId = sessionId.replace(/^codex:/, '')
  const codexDir = join(homedir(), '.codex')
  const files = [
    ...collectJsonlFiles(join(codexDir, 'sessions')),
    ...collectJsonlFiles(join(codexDir, 'archived_sessions'))
  ]
  return files.find((file) => codexSessionIdFromFile(file) === normalizedId) || null
}

function parseCodexSessionFile(filePath: string): Session | null {
  let lines: string[] = []
  try {
    lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
  } catch {
    return null
  }
  if (!lines.length) return null

  const sessionId = codexSessionIdFromFile(filePath)
  const parsedMessages: ParsedMessage[] = []
  let projectPath = ''
  let projectName = 'codex'
  let firstPrompt = ''
  let lastPrompt = ''
  let promptCount = 0
  let startTime: Date | null = null
  let endTime: Date | null = null
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheTokens = 0
  let totalTokens = 0
  let toolCallCount = 0
  let bashCallCount = 0
  let linesAdded = 0
  let linesRemoved = 0
  let hasError = false

  for (const line of lines) {
    let event: CodexLogEvent
    try {
      event = JSON.parse(line) as CodexLogEvent
    } catch {
      continue
    }

    if (event.timestamp) {
      const ts = new Date(event.timestamp)
      if (!isNaN(ts.getTime())) {
        if (!startTime || ts < startTime) startTime = ts
        if (!endTime || ts > endTime) endTime = ts
      }
    }

    if (event.type === 'session_meta' && event.payload) {
      if (typeof event.payload.cwd === 'string' && event.payload.cwd.trim()) {
        projectPath = event.payload.cwd
        projectName = basename(projectPath) || projectPath
      }
      if (event.payload.timestamp) {
        const ts = new Date(event.payload.timestamp)
        if (!isNaN(ts.getTime())) {
          if (!startTime || ts < startTime) startTime = ts
        }
      }
      continue
    }

    if (event.type === 'response_item' && event.payload?.type === 'message') {
      const role = event.payload.role
      const text = extractCodexContent(event.payload.content)
      if (role === 'user' && isCodexUserPrompt(text)) {
        promptCount++
        const truncated = text.substring(0, 300)
        if (!firstPrompt) firstPrompt = truncated
        lastPrompt = truncated
        parsedMessages.push({
          role: 'user',
          content: text,
          timestamp: event.timestamp
        })
      } else if (role === 'assistant' && text.trim()) {
        parsedMessages.push({
          role: 'assistant',
          content: text,
          timestamp: event.timestamp
        })
      }
    } else if (
      event.type === 'response_item' &&
      (event.payload?.type === 'function_call' || event.payload?.type === 'custom_tool_call')
    ) {
      toolCallCount++
      const toolName = event.payload.name || 'tool'
      if (toolName === 'exec_command') bashCallCount++
      parsedMessages.push({
        role: 'assistant',
        content: `[Tool: ${toolName}]`,
        timestamp: event.timestamp,
        isToolCall: true,
        toolName
      })

      const patchText = event.payload.input || ''
      if (toolName === 'apply_patch' && patchText) {
        for (const patchLine of patchText.split('\n')) {
          if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) linesAdded++
          if (patchLine.startsWith('-') && !patchLine.startsWith('---')) linesRemoved++
        }
      }
    } else if (event.type === 'event_msg' && event.payload?.type === 'agent_message') {
      const text = typeof event.payload.message === 'string' ? event.payload.message.trim() : ''
      if (text) {
        parsedMessages.push({
          role: 'assistant',
          content: text,
          timestamp: event.timestamp
        })
      }
    } else if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const usage = event.payload.info?.total_token_usage
      const lastUsage = event.payload.info?.last_token_usage
      if (usage) {
        totalInputTokens = Math.max(totalInputTokens, usage.input_tokens || 0)
        totalOutputTokens = Math.max(totalOutputTokens, usage.output_tokens || 0)
        totalCacheTokens = Math.max(totalCacheTokens, usage.cached_input_tokens || 0)
        totalTokens = Math.max(totalTokens, usage.total_tokens || 0)
      }
      if (lastUsage && !usage) {
        totalInputTokens += lastUsage.input_tokens || 0
        totalOutputTokens += lastUsage.output_tokens || 0
        totalCacheTokens += lastUsage.cached_input_tokens || 0
        totalTokens += lastUsage.total_tokens || 0
      }
    } else if (event.type === 'error') {
      hasError = true
    }
  }

  if (!projectPath) {
    projectPath = 'Codex'
    projectName = 'Codex'
  }
  if (!startTime) startTime = new Date(statSync(filePath).mtime)
  if (!endTime) endTime = startTime

  if (promptCount === 0 && parsedMessages.length === 0) return null

  return {
    id: `codex:${sessionId}`,
    source: 'codex',
    projectPath,
    projectName,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    firstPrompt: firstPrompt || '(no prompts)',
    lastPrompt: lastPrompt || firstPrompt || '(no prompts)',
    promptCount,
    totalTokens: totalTokens || totalInputTokens + totalOutputTokens,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    status: hasError ? 'error' : promptCount > 15 ? 'debug' : 'success',
    linesAdded,
    linesRemoved,
    messages: parsedMessages
  }
}

function parseCodexSessions(): { sessions: Session[]; projects: ProjectStats[] } {
  const codexDir = join(homedir(), '.codex')
  const files = [
    ...collectJsonlFiles(join(codexDir, 'sessions')),
    ...collectJsonlFiles(join(codexDir, 'archived_sessions'))
  ]
  const seen = new Set<string>()
  const sessions: Session[] = []
  const projectMap = new Map<string, ProjectStats>()

  for (const file of files) {
    const id = codexSessionIdFromFile(file)
    if (seen.has(id)) continue
    seen.add(id)

    const session = parseCodexSessionFile(file)
    if (!session || session.status !== 'success') continue
    sessions.push(session)

    const pKey = projectKey('codex', session.projectPath)
    const existing = projectMap.get(pKey) || {
      name: session.projectName,
      path: session.projectPath,
      source: 'codex',
      totalTokens: 0,
      sessionCount: 0,
      promptCount: 0,
      lastActive: session.endTime,
      toolCallCount: 0,
      bashCallCount: 0,
      toolDensity: 0,
      bashRatio: 0
    }
    existing.totalTokens += session.totalTokens
    existing.sessionCount++
    existing.promptCount += session.promptCount
    existing.toolCallCount += session.messages?.filter((m) => m.isToolCall).length || 0
    existing.bashCallCount += session.messages?.filter((m) => m.toolName === 'exec_command').length || 0
    if (session.endTime > existing.lastActive) existing.lastActive = session.endTime
    projectMap.set(pKey, existing)
  }

  const projects = Array.from(projectMap.values())
  for (const p of projects) {
    p.toolDensity = p.promptCount > 0 ? p.toolCallCount / p.promptCount : 0
    p.bashRatio = p.toolCallCount > 0 ? p.bashCallCount / p.toolCallCount : 0
  }
  return { sessions, projects }
}

function parseTraeSessions(): { sessions: Session[]; projects: ProjectStats[] } {
  const userHome = homedir()
  const traeUserDirs: Array<{ app: DataSource; dir: string }> = [
    { app: 'trae', dir: join(userHome, 'Library', 'Application Support', 'Trae', 'User') },
    { app: 'trae-cn', dir: join(userHome, 'Library', 'Application Support', 'Trae CN', 'User') }
  ]

  const sessions: Session[] = []
  const projectMap = new Map<string, ProjectStats>()

  for (const { app, dir } of traeUserDirs) {
    const workspaceStorageDir = join(dir, 'workspaceStorage')
    if (!existsSync(workspaceStorageDir)) continue

    let workspaceDirs: string[] = []
    try {
      workspaceDirs = readdirSync(workspaceStorageDir).filter((d) => {
        try {
          return statSync(join(workspaceStorageDir, d)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      continue
    }

    for (const workspaceDirName of workspaceDirs) {
      const workspaceDirPath = join(workspaceStorageDir, workspaceDirName)
      const dbPath = join(workspaceDirPath, 'state.vscdb')
      if (!existsSync(dbPath)) continue

      const workspaceJsonPath = join(workspaceDirPath, 'workspace.json')
      let projectPath = workspaceDirName
      if (existsSync(workspaceJsonPath)) {
        try {
          const workspaceJson = parseJsonSafely<{ folder?: string }>(
            readFileSync(workspaceJsonPath, 'utf-8'),
            {}
          )
          if (workspaceJson.folder) {
            projectPath = decodeFileUriPath(workspaceJson.folder)
          }
        } catch {
          // Keep fallback project path
        }
      }
      const projectName = basename(projectPath) || workspaceDirName

      const rows = sqliteQueryAsJson(
        dbPath,
        "SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key='icube-ai-agent-storage-input-history' LIMIT 1;"
      )
      if (rows.length === 0 || typeof rows[0].value !== 'string') continue

      const inputHistory = parseJsonSafely<TraeInputHistoryItem[]>(rows[0].value as string, [])
      if (!Array.isArray(inputHistory) || inputHistory.length === 0) continue

      let dbMtime = new Date()
      try {
        dbMtime = statSync(dbPath).mtime
      } catch {
        // Keep fallback timestamp
      }

      let workspacePromptCount = 0
      for (let i = 0; i < inputHistory.length; i++) {
        const item = inputHistory[i]
        const text = typeof item?.inputText === 'string' ? item.inputText.trim() : ''
        if (!text) continue

        workspacePromptCount++
        const ts = new Date(dbMtime.getTime() - (inputHistory.length - i - 1) * 1000).toISOString()

        sessions.push({
          id: `trae:${app}:${workspaceDirName}:${i}`,
          source: app,
          projectPath,
          projectName,
          startTime: ts,
          endTime: ts,
          firstPrompt: text.substring(0, 300),
          lastPrompt: text.substring(0, 300),
          promptCount: 1,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          status: 'success',
          linesAdded: 0,
          linesRemoved: 0,
          messages: [
            {
              role: 'user',
              content: text,
              timestamp: ts
            }
          ]
        })
      }

      if (workspacePromptCount > 0) {
        const pKey = projectKey(app, projectPath)
        const existing = projectMap.get(pKey) || {
          name: projectName,
          path: projectPath,
          source: app,
          totalTokens: 0,
          sessionCount: 0,
          promptCount: 0,
          lastActive: dbMtime.toISOString(),
          toolCallCount: 0,
          bashCallCount: 0,
          toolDensity: 0,
          bashRatio: 0
        }
        existing.sessionCount += workspacePromptCount
        existing.promptCount += workspacePromptCount
        if (dbMtime.toISOString() > existing.lastActive) {
          existing.lastActive = dbMtime.toISOString()
        }
        projectMap.set(pKey, existing)
      }
    }
  }

  const projects = Array.from(projectMap.values())
  for (const p of projects) {
    p.toolDensity = 0
    p.bashRatio = 0
  }
  return { sessions, projects }
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
  const traeData = parseTraeSessions()
  const codexData = parseCodexSessions()

  if (!existsSync(claudeDir)) {
    const sessions = [...traeData.sessions, ...codexData.sessions]
    const projects = [...traeData.projects, ...codexData.projects]
    return {
      sessions: sessions.sort(
        (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      ),
      projects: projects.sort((a, b) => b.totalTokens - a.totalTokens)
    }
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
    const sessions = [...traeData.sessions, ...codexData.sessions]
    const projects = [...traeData.projects, ...codexData.projects]
    return {
      sessions: sessions.sort(
        (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      ),
      projects: projects.sort((a, b) => b.totalTokens - a.totalTokens)
    }
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

        // Only keep successful sessions in the unified dataset.
        if (status !== 'success') continue

        const session: Session = {
          id: sessionId,
          source: 'claude',
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

        const pKey = projectKey('claude', projectPath)
        const existing = projectMap.get(pKey) || {
          name: projectName,
          path: projectPath,
          source: 'claude',
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
        projectMap.set(pKey, existing)
      } catch {
        // Skip unreadable files
      }
    }
  }

  const projects = Array.from(projectMap.values())
  for (const p of projects) {
    p.toolDensity = p.promptCount > 0 ? p.toolCallCount / p.promptCount : 0
    p.bashRatio = p.toolCallCount > 0 ? p.bashCallCount / p.toolCallCount : 0
  }

  sessions.push(...traeData.sessions)
  sessions.push(...codexData.sessions)
  for (const p of [...traeData.projects, ...codexData.projects]) {
    const pKey = projectKey(p.source, p.path)
    const existing = projectMap.get(pKey)
    if (existing) {
      existing.totalTokens += p.totalTokens
      existing.sessionCount += p.sessionCount
      existing.promptCount += p.promptCount
      existing.toolCallCount += p.toolCallCount
      existing.bashCallCount += p.bashCallCount
      if (p.lastActive > existing.lastActive) {
        existing.lastActive = p.lastActive
      }
      existing.toolDensity = existing.promptCount > 0 ? existing.toolCallCount / existing.promptCount : 0
      existing.bashRatio = existing.toolCallCount > 0 ? existing.bashCallCount / existing.toolCallCount : 0
    } else {
      projectMap.set(pKey, p)
    }
  }

  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
  const mergedProjects = Array.from(projectMap.values())
  mergedProjects.sort((a, b) => b.totalTokens - a.totalTokens)

  return { sessions, projects: mergedProjects }
}

export function parseSessionDetail(sessionId: string, projectDirName?: string): ParsedMessage[] {
  if (sessionId.startsWith('trae:')) {
    const traeSessions = parseTraeSessions().sessions
    const session = traeSessions.find((s) => s.id === sessionId)
    return session?.messages || []
  }

  if (sessionId.startsWith('codex:')) {
    const file = findCodexSessionFile(sessionId)
    if (!file) return []
    return parseCodexSessionFile(file)?.messages || []
  }

  if (!projectDirName) return []
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
