import { useEffect } from 'react'
import { useStore } from './store'
import TopBar from './components/TopBar'
import SessionList from './components/SessionList'
import TerrainView from './components/TerrainView'
import ProjectsList from './components/ProjectsList'
import ActivityHeatmap from './components/ActivityHeatmap'
import DrilldownView from './components/DrilldownView'

export default function App(): JSX.Element {
  const { loadSessions, selectedSession } = useStore()

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  return (
    <div
      className="flex flex-col w-screen h-screen bg-cyber-dark overflow-hidden scanlines"
      style={{ fontFamily: "'JetBrains Mono', 'Courier New', monospace" }}
    >
      {/* Top Bar */}
      <TopBar />

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Session List */}
        <div className="w-64 flex-shrink-0 border-r border-cyber-border overflow-hidden flex flex-col">
          <SessionList />
        </div>

        {/* Center: Terrain or Drilldown */}
        <div className="flex-1 min-w-0 overflow-hidden relative">
          <div className={`absolute inset-0 transition-all duration-300 ${selectedSession ? 'opacity-0 pointer-events-none scale-95' : 'opacity-100 scale-100'}`}>
            <TerrainView />
          </div>
          <div className={`absolute inset-0 transition-all duration-300 ${selectedSession ? 'opacity-100 scale-100' : 'opacity-0 pointer-events-none scale-105'}`}>
            {selectedSession && <DrilldownView />}
          </div>
        </div>

        {/* Right: Projects */}
        <div className="w-56 flex-shrink-0 border-l border-cyber-border overflow-hidden flex flex-col">
          <ProjectsList />
        </div>
      </div>

      {/* Bottom: Heatmap */}
      <div className="flex-shrink-0 border-t border-cyber-border" style={{ height: '160px' }}>
        <ActivityHeatmap />
      </div>
    </div>
  )
}
