import type { Session } from '../types'
import { useStore } from '../store'

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const STATUS_CONFIG = {
  success: { color: '#00ff88', label: 'OK' },
  debug: { color: '#ffcc00', label: 'DBG' },
  error: { color: '#ff4444', label: 'ERR' }
}

interface Props {
  session: Session
  isSelected: boolean
}

export default function SessionCard({ session, isSelected }: Props): JSX.Element {
  const { selectSession } = useStore()
  const statusCfg = STATUS_CONFIG[session.status]

  return (
    <div
      className={`px-3 py-2 border-b border-cyber-border cursor-pointer transition-all group ${
        isSelected
          ? 'bg-cyber-border border-l-2 border-l-neon-green'
          : 'hover:bg-cyber-gray border-l-2 border-l-transparent'
      }`}
      onClick={() => selectSession(isSelected ? null : session)}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {/* Status dot */}
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: statusCfg.color,
              boxShadow: `0 0 4px ${statusCfg.color}`
            }}
          />
          {/* Project name */}
          <span
            className="text-xs font-mono truncate"
            style={{
              color: isSelected ? '#aaff00' : '#88bb88',
              maxWidth: '120px'
            }}
          >
            {session.projectName}
          </span>
        </div>
        <span className="text-cyber-text-dim text-xs flex-shrink-0 ml-1">
          {formatRelativeTime(session.startTime)}
        </span>
      </div>

      {/* First prompt */}
      <p
        className="text-xs font-mono mb-1 leading-relaxed"
        style={{
          color: '#668866',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          fontSize: '10px',
          lineHeight: '1.4'
        }}
      >
        {session.firstPrompt}
      </p>

      {/* Footer row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-cyber-text-dim" style={{ fontSize: '9px' }}>
            {session.promptCount}p
          </span>
          <span className="text-cyber-text-dim" style={{ fontSize: '9px' }}>
            {formatTokens(session.totalTokens)}t
          </span>
        </div>
        <span
          className="text-xs font-mono"
          style={{ color: statusCfg.color, fontSize: '9px', opacity: 0.8 }}
        >
          {statusCfg.label}
        </span>
      </div>
    </div>
  )
}
