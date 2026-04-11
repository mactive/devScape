import { useState, useMemo } from 'react'
import { useStore } from '../store'
import SessionCard from './SessionCard'
import type { DataSource, ProjectStats, Session } from '../types'

const SOURCE_CONFIG = {
  claude: { label: 'Claude', color: '#5EAB07' },
  trae: {
    label: 'Trae', color: '#4cada5'
  },
  'trae-cn': { label: 'TraeCN', color: '#acdf2c' }
} as const

function projectSelectionKey(source: ProjectStats['source'] | Session['source'], projectPath: string): string {
  return `${source}:${projectPath}`
}

export default function SessionList(): JSX.Element {
  const {
    projects,
    sessions,
    selectedSession,
    selectedProjectKey,
    selectProject,
    searchQuery,
    setSearchQuery,
    sourceFilter,
    setSourceFilter
  } = useStore()
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  const toggleProject = (projectKey: string) => {
    const newExpanded = new Set(expandedProjects)
    if (newExpanded.has(projectKey)) {
      newExpanded.delete(projectKey)
    } else {
      newExpanded.add(projectKey)
    }
    setExpandedProjects(newExpanded)
  }

  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      if (sourceFilter !== 'ALL' && p.source !== sourceFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [projects, searchQuery, sourceFilter])

  const getFilteredSessionsForProject = (project: ProjectStats) => {
    return sessions.filter(
      (s) => s.projectPath === project.path && s.source === project.source
    )
  }

  const sourceTabs: Array<{ value: 'ALL' | DataSource; label: string; short: string }> = [
    { value: 'ALL', label: 'ALL', short: 'ALL' },
    { value: 'claude', label: 'Claude', short: 'CLD' },
    { value: 'trae', label: 'Trae', short: 'TRAE' },
    { value: 'trae-cn', label: 'TraeCN', short: 'TCN' }
  ]

  return (
    <div className="flex flex-col h-full bg-cyber-dark">
      {/* Header */}
      <div className="cyber-header flex items-center justify-between flex-shrink-0">
        <span>PROJECTS</span>
        <span className="text-cyber-muted">{filteredProjects.length} TOTAL</span>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-cyber-border flex-shrink-0">
        <input
          type="text"
          placeholder="search projects..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-transparent text-xs font-mono text-cyber-text placeholder-cyber-text-dim outline-none border border-cyber-border px-2 py-1"
          style={{ fontSize: '10px' }}
        />
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-cyber-border flex-shrink-0">
        {sourceTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setSourceFilter(tab.value)}
            className={`flex-1 py-1 text-xs font-mono transition-colors ${sourceFilter === tab.value
              ? 'text-neon-green bg-cyber-border'
              : 'text-cyber-text-dim hover:text-cyber-text'
              }`}
            title={tab.label}
            style={{ fontSize: '9px' }}
          >
            {tab.short}
          </button>
        ))}
      </div>

      {/* Project & Session list */}
      <div className="flex-1 overflow-y-auto">
        {filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-cyber-text-dim text-xs">
            <span>NO PROJECTS</span>
            <span className="text-cyber-border-bright mt-1" style={{ fontSize: '9px' }}>
              {searchQuery ? 'No project matched' : 'Check ~/.claude/projects/'}
            </span>
          </div>
        ) : (
          filteredProjects.map((project) => {
            const projectSessions = getFilteredSessionsForProject(project)
            if (projectSessions.length === 0) return null

            const pKey = projectSelectionKey(project.source, project.path)
            const isExpanded = expandedProjects.has(pKey)
            const isProjectActive = Boolean(
              selectedProjectKey === pKey ||
              (selectedSession &&
                projectSelectionKey(selectedSession.source, selectedSession.projectPath) === pKey)
            )

            return (
              <div key={pKey} className="border-b border-cyber-border border-opacity-50">
                {/* Project Header */}
                <div
                  className={`px-3 py-2 flex items-center justify-between cursor-pointer transition-colors ${isProjectActive ? 'bg-cyber-border bg-opacity-30' : 'hover:bg-cyber-gray'
                    }`}
                  onClick={() => {
                    selectProject(pKey)
                  }}
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleProject(pKey)
                      }}
                      className="text-cyber-text-dim hover:text-cyber-text w-4 h-4 flex items-center justify-center focus:outline-none"
                    >
                      {isExpanded ? '▼' : '▶'}
                    </button>
                    <span
                      className="text-xs font-mono truncate font-bold"
                      style={{ color: isProjectActive ? '#aaff00' : '#88bb88' }}
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
                  <span className="text-cyber-text-dim" style={{ fontSize: '9px' }}>
                    {projectSessions.length} sess
                  </span>
                </div>

                {/* Expanded Sessions */}
                {isExpanded && (
                  <div className="bg-black bg-opacity-20 pl-2">
                    {projectSessions.map((session) => {
                      const isSelected = selectedSession?.id === session.id

                      return (
                        <SessionCard
                          key={session.id}
                          session={session}
                          isSelected={isSelected}
                          isProjectSelected={isProjectActive}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
