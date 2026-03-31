import { useState, useMemo } from 'react'
import { useStore } from '../store'
import SessionCard from './SessionCard'

export default function SessionList(): JSX.Element {
  const { sessions, selectedSession, searchQuery, setSearchQuery } = useStore()
  const [filter, setFilter] = useState<'ALL' | 'success' | 'debug' | 'error'>('ALL')

  const filtered = useMemo(() => {
    let result = sessions
    if (filter !== 'ALL') {
      result = result.filter((s) => s.status === filter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (s) =>
          s.firstPrompt.toLowerCase().includes(q) ||
          s.lastPrompt.toLowerCase().includes(q) ||
          s.projectName.toLowerCase().includes(q)
      )
    }
    return result
  }, [sessions, filter, searchQuery])

  return (
    <div className="flex flex-col h-full bg-cyber-dark">
      {/* Header */}
      <div className="cyber-header flex items-center justify-between flex-shrink-0">
        <span>SESSIONS</span>
        <span className="text-cyber-muted">{sessions.length} TOTAL</span>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-cyber-border flex-shrink-0">
        <input
          type="text"
          placeholder="search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-transparent text-xs font-mono text-cyber-text placeholder-cyber-text-dim outline-none border border-cyber-border px-2 py-1"
          style={{ fontSize: '10px' }}
        />
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-cyber-border flex-shrink-0">
        {(['ALL', 'success', 'debug', 'error'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-1 py-1 text-xs font-mono transition-colors ${
              filter === f
                ? 'text-neon-green bg-cyber-border'
                : 'text-cyber-text-dim hover:text-cyber-text'
            }`}
            style={{ fontSize: '9px' }}
          >
            {f === 'ALL' ? 'ALL' : f.toUpperCase().slice(0, 3)}
          </button>
        ))}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-cyber-text-dim text-xs">
            <span>NO SESSIONS</span>
            <span className="text-cyber-border-bright mt-1" style={{ fontSize: '9px' }}>
              {searchQuery ? 'No match found' : 'Check ~/.claude/projects/'}
            </span>
          </div>
        ) : (
          filtered.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isSelected={selectedSession?.id === session.id}
            />
          ))
        )}
      </div>
    </div>
  )
}
