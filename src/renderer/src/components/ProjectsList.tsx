import { useStore } from '../store'
import type { ProjectStats, Session } from '../types'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const PROJECT_COLORS = [
  '#aaff00', '#88dd00', '#66bb00', '#449900', '#227700',
  '#00ff88', '#00dd66', '#00bb44', '#009922', '#007700'
]

const SOURCE_CONFIG = {
  claude: { label: 'Claude', color: '#5EAB07' },
  trae: {
    label: 'Trae', color: '#4cada5'
  },
  'trae-cn': { label: 'TraeCN', color: '#2c9adf' }
} as const

function projectSelectionKey(source: ProjectStats['source'] | Session['source'], projectPath: string): string {
  return `${source}:${projectPath}`
}

export default function ProjectsList(): JSX.Element {
  const { projects, sessions, selectedProjectKey, selectProject, selectSession, selectedSession } = useStore()

  const maxTokens = projects[0]?.totalTokens || 1

  // Determine the active project logic
  const activeProjectKey =
    selectedProjectKey ||
    (selectedSession ? projectSelectionKey(selectedSession.source, selectedSession.projectPath) : null)

  return (
    <div className="flex flex-col h-full bg-cyber-dark">
      {/* Header */}
      <div className="cyber-header flex items-center justify-between flex-shrink-0">
        <span>PROJECTS</span>
        <span className="text-cyber-muted">{projects.length} TOTAL</span>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {projects.length === 0 ? (
          <div className="flex items-center justify-center h-16 text-cyber-text-dim text-xs">
            NO DATA
          </div>
        ) : (
          projects.map((project, i) => {
            const pct = (project.totalTokens / maxTokens) * 100
            const color = PROJECT_COLORS[i % PROJECT_COLORS.length]
            const pKey = projectSelectionKey(project.source, project.path)
            const isActive = activeProjectKey === pKey

            return (
              <div
                key={`${project.path}-${i}`}
                className={`mb-2 cursor-pointer group ${isActive ? 'opacity-100' : 'opacity-80 hover:opacity-100'}`}
                onClick={() => {
                  selectProject(isActive ? null : pKey)
                }}
              >
                {/* Project name */}
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1 overflow-hidden">
                    <span
                      className="font-mono truncate"
                      style={{
                        fontSize: '9px',
                        color: isActive ? '#aaff00' : '#668866',
                        maxWidth: '88px'
                      }}
                    >
                      {project.name}
                    </span>
                    <span
                      className="font-mono border rounded-sm px-1 py-[1px] flex-shrink-0"
                      style={{
                        fontSize: '7px',
                        color: SOURCE_CONFIG[project.source].color,
                        borderColor: `${SOURCE_CONFIG[project.source].color}88`
                      }}
                    >
                      {SOURCE_CONFIG[project.source].label}
                    </span>
                  </div>
                  <span
                    className="font-mono flex-shrink-0 ml-1"
                    style={{ fontSize: '9px', color: '#446644' }}
                  >
                    {formatTokens(project.totalTokens)}
                  </span>
                </div>

                {/* Token bar */}
                <div className="relative h-1 bg-cyber-border rounded-sm overflow-hidden">
                  <div
                    className="h-full transition-all duration-700"
                    style={{
                      width: `${pct}%`,
                      background: color,
                      boxShadow: `0 0 4px ${color}66`,
                      transition: 'width 1s ease-out'
                    }}
                  />
                </div>

                {/* Sessions count and Detail button */}
                <div className="flex items-center justify-between mt-0.5 min-h-[16px]">
                  <span style={{ fontSize: '8px', color: '#334433' }}>
                    {project.sessionCount}s · {project.promptCount}p
                  </span>

                  {isActive && (
                    <button
                      className="bg-cyber-accent text-black font-bold py-[2px] px-4 rounded-sm text-[8px] hover:bg-[#ccee22] transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (
                          selectedSession &&
                          projectSelectionKey(selectedSession.source, selectedSession.projectPath) === pKey
                        ) {
                          selectSession(null)
                        } else {
                          const ps = sessions.find(
                            (s) => s.projectPath === project.path && s.source === project.source
                          )
                          if (ps) selectSession(ps)
                        }
                      }}
                    >
                      {selectedSession &&
                        projectSelectionKey(selectedSession.source, selectedSession.projectPath) === pKey
                        ? 'CLOSE DETAIL'
                        : 'DETAIL'}
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Footer: Tokens by project label */}
      <div className="border-t border-cyber-border px-2 py-1 flex-shrink-0">
        <span className="text-cyber-text-dim tracking-widest" style={{ fontSize: '8px' }}>
          TOKENS BY PROJECT
        </span>
      </div>
    </div>
  )
}
