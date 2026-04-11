import { useRef, useEffect } from 'react'
import { useStore } from '../store'

function formatTime(timestamp?: string): string {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function formatTokens(n?: number): string {
  if (!n) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export default function DrilldownView(): JSX.Element {
  const { selectedSession, selectSession, loadingDetail } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [selectedSession?.messages?.length])

  if (!selectedSession) return <></>

  const messages = selectedSession.messages || []
  const sourceConfig = {
    claude: { label: 'CLAUDE CODE', color: '#5EAB07' },
    trae: { label: 'TRAE', color: '#4cada5' },
    'trae-cn': { label: 'TRAE CN', color: '#2c9adf' }
  } as const
  const activeSource = sourceConfig[selectedSession.source]

  return (
    <div className="flex flex-col h-full bg-cyber-dark">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-cyber-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-neon-green font-mono text-xs font-bold tracking-widest">
            <span style={{ color: activeSource.color }}>{activeSource.label}</span>
          </span>
          <span className="text-cyber-muted font-mono text-xs">|</span>
          <span className="text-cyber-text font-mono text-xs truncate max-w-xs">
            {selectedSession.projectName.toUpperCase()}
          </span>
          <span className="text-cyber-muted font-mono text-xs">|</span>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-neon-success" style={{ boxShadow: '0 0 6px #00ff88' }} />
            <span className="text-neon-success font-mono text-xs">CONNECTED</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-cyber-text-dim font-mono text-xs">
            {messages.length} msgs · {selectedSession.promptCount} prompts
          </span>
          <button
            onClick={() => selectSession(null)}
            className="cyber-btn px-2 py-0.5"
            style={{ fontSize: '10px' }}
          >
            ✕ CLOSE
          </button>
        </div>
      </div>

      {/* Prompt summary */}
      <div className="px-4 py-2 border-b border-cyber-border flex-shrink-0 bg-cyber-gray">
        <p className="text-xs font-mono text-cyber-text-dim mb-0.5">FIRST PROMPT</p>
        <p className="text-xs font-mono text-cyber-text leading-relaxed" style={{ color: '#88bb88' }}>
          {selectedSession.firstPrompt}
        </p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loadingDetail ? (
          <div className="flex items-center justify-center h-32">
            <span className="text-cyber-text-dim text-sm blink">LOADING MESSAGES...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-cyber-text-dim text-sm">
            NO MESSAGES
          </div>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))
        )}
      </div>

      {/* Footer metrics */}
      <div className="flex items-center gap-4 px-4 py-1.5 border-t border-cyber-border flex-shrink-0 text-xs font-mono">
        <MetricChip label="IN" value={`${(selectedSession.inputTokens / 1000).toFixed(1)}K`} color="#668866" />
        <MetricChip label="OUT" value={`${(selectedSession.outputTokens / 1000).toFixed(1)}K`} color="#aaff00" />
        <MetricChip label="CACHE" value={`${(selectedSession.cacheTokens / 1000).toFixed(1)}K`} color="#ffcc00" />
        <MetricChip label="TOTAL" value={`${(selectedSession.totalTokens / 1000).toFixed(1)}K`} color="#00ff88" />
        <div
          className="ml-auto px-2 py-0.5 border"
          style={{
            borderColor: selectedSession.status === 'success' ? '#00ff88' : selectedSession.status === 'error' ? '#ff4444' : '#ffcc00',
            color: selectedSession.status === 'success' ? '#00ff88' : selectedSession.status === 'error' ? '#ff4444' : '#ffcc00',
            fontSize: '9px'
          }}
        >
          {selectedSession.status.toUpperCase()}
        </div>
      </div>
    </div>
  )
}

function MetricChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className="text-cyber-text-dim">
      {label}:{' '}
      <span style={{ color, textShadow: `0 0 6px ${color}66` }}>{value}</span>
    </span>
  )
}

interface MsgProps {
  msg: {
    role: string
    content: string
    timestamp?: string
    inputTokens?: number
    outputTokens?: number
    isToolCall?: boolean
    toolName?: string
  }
}

function MessageBubble({ msg }: MsgProps) {
  const isUser = msg.role === 'user'
  const isToolCall = msg.isToolCall

  if (isToolCall) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="text-cyber-muted font-mono" style={{ fontSize: '9px' }}>▸</span>
        <span
          className="font-mono px-2 py-0.5 border border-cyber-border"
          style={{ fontSize: '9px', color: '#446644' }}
        >
          TOOL: {msg.toolName?.toUpperCase() || 'CALL'}
        </span>
        <span className="text-cyber-text-dim font-mono" style={{ fontSize: '9px', maxWidth: '200px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {msg.content.replace('[Tool call: ', '').replace(']', '')}
        </span>
      </div>
    )
  }

  return (
    <div className={`flex flex-col ${isUser ? 'items-start' : 'items-start'}`}>
      {/* Role indicator */}
      <div className="flex items-center gap-2 mb-1">
        <span
          className="font-mono tracking-wider"
          style={{
            fontSize: '9px',
            color: isUser ? '#668866' : '#446644'
          }}
        >
          {isUser ? '▸ USER' : '◆ CLAUDE'}
        </span>
        {msg.timestamp && (
          <span className="text-cyber-text-dim font-mono" style={{ fontSize: '8px' }}>
            {formatTime(msg.timestamp)}
          </span>
        )}
        {(msg.inputTokens || msg.outputTokens) && (
          <span className="text-cyber-text-dim font-mono" style={{ fontSize: '8px' }}>
            [{formatTokens(msg.inputTokens)}in/{formatTokens(msg.outputTokens)}out]
          </span>
        )}
      </div>

      {/* Content */}
      <div
        className={`font-mono leading-relaxed px-3 py-2 border-l-2 w-full ${isUser
          ? 'border-l-cyber-border-bright text-cyber-text'
          : 'border-l-neon-green'
          }`}
        style={{
          fontSize: '11px',
          lineHeight: '1.6',
          color: isUser ? '#668866' : '#aaff00',
          background: isUser ? 'transparent' : 'rgba(170,255,0,0.02)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '300px',
          overflow: 'hidden',
          maskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)'
        }}
      >
        {msg.content}
      </div>
    </div>
  )
}
