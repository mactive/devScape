import { useStore } from '../store'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const PROJECT_COLORS = [
  '#aaff00', '#88dd00', '#66bb00', '#449900', '#227700',
  '#00ff88', '#00dd66', '#00bb44', '#009922', '#007700'
]

export default function ProjectsList(): JSX.Element {
  const { projects, sessions, selectedSession, selectSession } = useStore()

  const maxTokens = projects[0]?.totalTokens || 1

  // Get project for selected session
  const activeProject = selectedSession?.projectPath

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
          projects.slice(0, 25).map((project, i) => {
            const pct = (project.totalTokens / maxTokens) * 100
            const color = PROJECT_COLORS[i % PROJECT_COLORS.length]
            const isActive = activeProject === project.path

            return (
              <div
                key={project.path}
                className={`mb-2 cursor-pointer group ${isActive ? 'opacity-100' : 'opacity-80 hover:opacity-100'}`}
                onClick={() => {
                  // Find the most recent session for this project
                  const ps = sessions.find((s) => s.projectPath === project.path)
                  if (ps) selectSession(isActive ? null : ps)
                }}
              >
                {/* Project name */}
                <div className="flex items-center justify-between mb-0.5">
                  <span
                    className="font-mono truncate"
                    style={{
                      fontSize: '9px',
                      color: isActive ? '#aaff00' : '#668866',
                      maxWidth: '120px'
                    }}
                  >
                    {project.name}
                  </span>
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

                {/* Sessions count */}
                <div className="flex items-center gap-2 mt-0.5">
                  <span style={{ fontSize: '8px', color: '#334433' }}>
                    {project.sessionCount}s · {project.promptCount}p
                  </span>
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
