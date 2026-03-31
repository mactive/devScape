import { useMemo } from 'react'
import { useStore } from '../store'
import type { HeatmapMode, HeatmapTimeRange } from '../types'

const DAYS_TO_SHOW = 365
const WEEKS_TO_SHOW = 53

function getIntensityColor(value: number, max: number): string {
  if (max === 0 || value === 0) return '#0d120d'
  const t = Math.min(value / max, 1)
  // Interpolate from #0d120d (dark) to #aaff00 (neon green)
  const r = Math.round(13 + t * (170 - 13))
  const g = Math.round(18 + t * (255 - 18))
  const b = Math.round(13 + t * (0 - 13))
  return `rgb(${r},${g},${b})`
}

interface DayData {
  date: Date
  sessions: number
  tokens: number
  files: number
}

export default function ActivityHeatmap(): JSX.Element {
  const { sessions, heatmapMode, heatmapTimeRange, heatmapProject, setHeatmapMode, setHeatmapTimeRange, setHeatmapProject, projects } = useStore()

  const dayMap = useMemo(() => {
    const map = new Map<string, DayData>()
    const now = new Date()

    for (const session of sessions) {
      if (heatmapProject !== 'ALL PROJECTS' && session.projectName !== heatmapProject) continue

      const dayIndex = Math.floor(
        (now.getTime() - new Date(session.startTime).getTime()) / (1000 * 60 * 60 * 24)
      )
      if (dayIndex < 0 || dayIndex >= DAYS_TO_SHOW) continue

      const date = new Date(now)
      date.setDate(date.getDate() - dayIndex)
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

      const existing = map.get(key) || { date, sessions: 0, tokens: 0, files: 0 }
      existing.sessions++
      existing.tokens += session.totalTokens
      existing.files += session.linesAdded || 0
      map.set(key, existing)
    }
    return map
  }, [sessions, heatmapProject])

  const { cells, maxValue } = useMemo(() => {
    const now = new Date()
    // Start from the most recent Sunday (or Monday)
    const startOfGrid = new Date(now)
    startOfGrid.setDate(startOfGrid.getDate() - (WEEKS_TO_SHOW * 7 - 1))

    const allCells: Array<{ date: Date; value: number; dayOfWeek: number; weekIndex: number }> = []
    let maxVal = 0

    for (let week = 0; week < WEEKS_TO_SHOW; week++) {
      for (let day = 0; day < 7; day++) {
        const cellDate = new Date(startOfGrid)
        cellDate.setDate(cellDate.getDate() + week * 7 + day)

        if (cellDate > now) continue

        const key = `${cellDate.getFullYear()}-${cellDate.getMonth()}-${cellDate.getDate()}`
        const data = dayMap.get(key)

        let value = 0
        if (data) {
          if (heatmapMode === 'SESSIONS') value = data.sessions
          else if (heatmapMode === 'TOKENS') value = data.tokens
          else if (heatmapMode === 'FILES') value = data.files
        }

        if (value > maxVal) maxVal = value
        allCells.push({ date: cellDate, value, dayOfWeek: day, weekIndex: week })
      }
    }

    return { cells: allCells, maxValue: maxVal }
  }, [dayMap, heatmapMode])

  const projectOptions = ['ALL PROJECTS', ...projects.slice(0, 20).map((p) => p.name)]

  return (
    <div className="flex flex-col h-full bg-cyber-dark">
      {/* Header controls */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-cyber-border flex-shrink-0">
        <span className="cyber-header border-0 px-0 py-0">ACTIVITY</span>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center gap-1">
            {(['SESSIONS', 'FILES', 'TOKENS'] as HeatmapMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setHeatmapMode(m)}
                className={`cyber-btn py-0.5 ${heatmapMode === m ? 'cyber-btn-active' : ''}`}
                style={{ fontSize: '9px', padding: '2px 6px' }}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Time range toggle */}
          <div className="flex items-center gap-1">
            {(['DAY', 'WEEK', 'MONTH'] as HeatmapTimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setHeatmapTimeRange(r)}
                className={`cyber-btn py-0.5 ${heatmapTimeRange === r ? 'cyber-btn-active' : ''}`}
                style={{ fontSize: '9px', padding: '2px 6px' }}
              >
                {r}
              </button>
            ))}
          </div>

          {/* Project filter */}
          <select
            value={heatmapProject}
            onChange={(e) => setHeatmapProject(e.target.value)}
            className="bg-cyber-gray border border-cyber-border text-cyber-text font-mono outline-none cursor-pointer"
            style={{ fontSize: '9px', padding: '2px 6px', color: '#668866' }}
          >
            {projectOptions.map((p) => (
              <option key={p} value={p} style={{ background: '#111811' }}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Heatmap grid */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden px-3 py-2">
        <div className="flex h-full items-start gap-0">
          {/* Day labels */}
          <div className="flex flex-col justify-around mr-1 flex-shrink-0" style={{ height: '84px' }}>
            {['M', '', 'W', '', 'F', '', 'S'].map((d, i) => (
              <span
                key={i}
                className="text-cyber-text-dim font-mono"
                style={{ fontSize: '8px', lineHeight: '12px', height: '12px' }}
              >
                {d}
              </span>
            ))}
          </div>

          {/* Grid */}
          <div
            className="grid gap-px flex-shrink-0"
            style={{
              gridTemplateColumns: `repeat(${WEEKS_TO_SHOW}, 12px)`,
              gridTemplateRows: 'repeat(7, 12px)',
              height: '84px'
            }}
          >
            {cells.map((cell, i) => (
              <div
                key={i}
                className="rounded-sm cursor-default transition-all"
                style={{
                  gridColumn: cell.weekIndex + 1,
                  gridRow: cell.dayOfWeek + 1,
                  background: getIntensityColor(cell.value, maxValue),
                  boxShadow: cell.value > 0 ? `0 0 3px ${getIntensityColor(cell.value, maxValue)}88` : 'none',
                  width: '11px',
                  height: '11px'
                }}
                title={`${cell.date.toLocaleDateString()}: ${cell.value} ${heatmapMode.toLowerCase()}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1 px-3 pb-1 flex-shrink-0">
        <span className="text-cyber-text-dim font-mono" style={{ fontSize: '8px' }}>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <div
            key={t}
            className="rounded-sm"
            style={{
              width: '10px',
              height: '10px',
              background: getIntensityColor(t * maxValue, maxValue)
            }}
          />
        ))}
        <span className="text-cyber-text-dim font-mono" style={{ fontSize: '8px' }}>More</span>
      </div>
    </div>
  )
}
