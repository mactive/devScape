import { useStore } from '../store'
import { useEffect, useState } from 'react'

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function AnimatedNumber({ value, format = formatCount }: { value: number; format?: (n: number) => string }) {
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    if (value === 0) { setDisplay(0); return }
    const steps = 20
    const increment = value / steps
    let current = 0
    let step = 0
    const timer = setInterval(() => {
      step++
      current = Math.min(current + increment, value)
      setDisplay(current)
      if (step >= steps) clearInterval(timer)
    }, 30)
    return () => clearInterval(timer)
  }, [value])

  return <span className="neon-text">{format(Math.round(display))}</span>
}

export default function TopBar(): JSX.Element {
  const { totalSessions, totalPrompts, totalTokens, totalLinesAdded, totalLinesRemoved, loading, loadSessions } = useStore()
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const sessions = totalSessions()
  const prompts = totalPrompts()
  const tokens = totalTokens()
  const added = totalLinesAdded()
  const removed = totalLinesRemoved()

  const dateStr = `${String(time.getMonth() + 1).padStart(2, '0')}/${String(time.getDate()).padStart(2, '0')}`
  const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`

  return (
    <div
      className="flex items-center justify-between border-b border-cyber-border bg-cyber-gray px-4 flex-shrink-0"
      style={{ height: '42px', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: Title */}
      <div className="flex items-center gap-4">
        <span
          className="text-neon-green font-mono font-bold tracking-widest text-sm glitch-text neon-text"
          style={{ letterSpacing: '0.2em' }}
        >
          SESSION PULSER
        </span>
        {loading && (
          <span className="text-cyber-text-dim text-xs blink">LOADING...</span>
        )}
      </div>

      {/* Center: Metrics */}
      <div
        className="flex items-center gap-6 text-xs font-mono"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <MetricItem label="sessions" value={sessions} format={String} />
        <MetricSep />
        <MetricItem label="prompts" value={prompts} />
        <MetricSep />
        <MetricItem label="added" value={added} color="#00ff88" />
        <MetricSep />
        <MetricItem label="removed" value={removed} color="#ff4444" />
        <MetricSep />
        <MetricItem label="tokens" value={tokens} />
      </div>

      {/* Right: Date/Time + Window Controls */}
      <div
        className="flex items-center gap-4 text-xs font-mono"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span className="text-cyber-text-dim">
          {dateStr} <span className="text-cyber-muted">|</span> <span className="text-neon-green">{timeStr}</span>
        </span>
        <button
          className="text-cyber-text-dim hover:text-neon-green transition-colors px-1"
          onClick={loadSessions}
          title="Refresh"
        >
          ↻
        </button>
        <WindowControls />
      </div>
    </div>
  )
}

function MetricSep() {
  return <span className="text-cyber-border-bright">|</span>
}

function MetricItem({
  label,
  value,
  format = formatCount,
  color
}: {
  label: string
  value: number
  format?: (n: number) => string
  color?: string
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-cyber-text-dim">{label}:</span>
      <span style={{ color: color || '#aaff00', textShadow: `0 0 8px ${color || '#aaff00'}66` }}>
        <AnimatedNumber value={value} format={format} />
      </span>
    </span>
  )
}

function WindowControls() {
  return (
    <div className="flex items-center gap-2">
      <button
        className="w-3 h-3 rounded-full bg-cyber-muted hover:bg-neon-debug transition-colors"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onClick={() => (window as any).api?.windowMinimize()}
        title="Minimize"
      />
      <button
        className="w-3 h-3 rounded-full bg-cyber-muted hover:bg-neon-green transition-colors"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onClick={() => (window as any).api?.windowMaximize()}
        title="Maximize"
      />
      <button
        className="w-3 h-3 rounded-full bg-cyber-muted hover:bg-neon-error transition-colors"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onClick={() => (window as any).api?.windowClose()}
        title="Close"
      />
    </div>
  )
}
