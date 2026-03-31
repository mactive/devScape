import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Text } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Session } from '../types'

const NUM_DAYS = 30
const MAX_PROJECTS = 20
const TERRAIN_WIDTH = 30
const TERRAIN_DEPTH = 20
const MAX_HEIGHT = 6

interface TerrainData {
  grid: number[][]
  projects: string[]
  maxTokens: number
}

function buildTerrainData(sessions: Session[]): TerrainData {
  const now = new Date()
  const tokenGrid: Map<string, number> = new Map()
  const projectSet = new Set<string>()
  const projectTokens = new Map<string, number>()

  for (const session of sessions) {
    const dayIndex = Math.floor(
      (now.getTime() - new Date(session.startTime).getTime()) / (1000 * 60 * 60 * 24)
    )
    if (dayIndex < 0 || dayIndex >= NUM_DAYS) continue

    const col = NUM_DAYS - 1 - dayIndex // col 0 = oldest, col 29 = today
    const key = `${col},${session.projectName}`
    tokenGrid.set(key, (tokenGrid.get(key) || 0) + session.totalTokens)
    projectSet.add(session.projectName)
    projectTokens.set(
      session.projectName,
      (projectTokens.get(session.projectName) || 0) + session.totalTokens
    )
  }

  // Sort projects by total tokens, take top MAX_PROJECTS
  const projects = Array.from(projectSet)
    .sort((a, b) => (projectTokens.get(b) || 0) - (projectTokens.get(a) || 0))
    .slice(0, MAX_PROJECTS)

  const numProjects = Math.max(projects.length, 1)

  // Build 2D grid [col][row]
  const grid: number[][] = Array(NUM_DAYS)
    .fill(null)
    .map((_, col) =>
      Array(numProjects)
        .fill(null)
        .map((__, row) => tokenGrid.get(`${col},${projects[row]}`) || 0)
    )

  // Gaussian smooth
  const smoothed = gaussianSmooth2D(grid, NUM_DAYS, numProjects, 1.5)

  const maxTokens = Math.max(...smoothed.flat(), 1)
  const normalizedGrid = smoothed.map((col) =>
    col.map((v) => (v / maxTokens) * MAX_HEIGHT)
  )

  return { grid: normalizedGrid, projects, maxTokens }
}

function gaussianSmooth2D(grid: number[][], cols: number, rows: number, sigma: number): number[][] {
  const kernelSize = Math.ceil(sigma * 3) * 2 + 1
  const kernel: number[] = []
  let kernelSum = 0

  for (let i = 0; i < kernelSize; i++) {
    const x = i - Math.floor(kernelSize / 2)
    const v = Math.exp((-x * x) / (2 * sigma * sigma))
    kernel.push(v)
    kernelSum += v
  }
  const normKernel = kernel.map((v) => v / kernelSum)

  // Blur along columns
  const tempGrid = Array(cols)
    .fill(null)
    .map((_, c) =>
      Array(rows)
        .fill(null)
        .map((__, r) => {
          let sum = 0
          for (let k = 0; k < kernelSize; k++) {
            const nc = c + k - Math.floor(kernelSize / 2)
            const val = nc >= 0 && nc < cols ? grid[nc][r] : 0
            sum += val * normKernel[k]
          }
          return sum
        })
    )

  // Blur along rows
  return Array(cols)
    .fill(null)
    .map((_, c) =>
      Array(rows)
        .fill(null)
        .map((__, r) => {
          let sum = 0
          for (let k = 0; k < kernelSize; k++) {
            const nr = r + k - Math.floor(kernelSize / 2)
            const val = nr >= 0 && nr < rows ? tempGrid[c][nr] : 0
            sum += val * normKernel[k]
          }
          return sum
        })
    )
}

function TerrainMesh({ terrainData }: { terrainData: TerrainData }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const origHeights = useRef<Float32Array>(new Float32Array(0))

  const { grid, projects } = terrainData
  const numCols = NUM_DAYS
  const numRows = Math.max(projects.length, 1)

  const geometry = useMemo(() => {
    // Use 2x resolution for smoother terrain
    const segCols = numCols * 2 - 1
    const segRows = numRows * 2 - 1

    const geo = new THREE.PlaneGeometry(
      TERRAIN_WIDTH,
      TERRAIN_DEPTH,
      segCols,
      segRows
    )
    geo.rotateX(-Math.PI / 2)

    const positions = geo.attributes.position.array as Float32Array
    const vertCols = segCols + 1
    const vertRows = segRows + 1
    const heights = new Float32Array(vertCols * vertRows)

    for (let vr = 0; vr < vertRows; vr++) {
      for (let vc = 0; vc < vertCols; vc++) {
        // Map vertex to data coordinates (bilinear interpolation)
        const dataCol = (vc / segCols) * (numCols - 1)
        const dataRow = (vr / segRows) * (numRows - 1)

        const c0 = Math.floor(dataCol)
        const c1 = Math.min(c0 + 1, numCols - 1)
        const r0 = Math.floor(dataRow)
        const r1 = Math.min(r0 + 1, numRows - 1)
        const tc = dataCol - c0
        const tr = dataRow - r0

        const h00 = grid[c0]?.[r0] ?? 0
        const h10 = grid[c1]?.[r0] ?? 0
        const h01 = grid[c0]?.[r1] ?? 0
        const h11 = grid[c1]?.[r1] ?? 0

        const h = h00 * (1 - tc) * (1 - tr) + h10 * tc * (1 - tr) + h01 * (1 - tc) * tr + h11 * tc * tr

        const idx = (vr * vertCols + vc) * 3 + 1
        positions[idx] = h
        heights[vr * vertCols + vc] = h
      }
    }

    geo.attributes.position.needsUpdate = true
    geo.computeVertexNormals()
    origHeights.current = heights
    return geo
  }, [grid, numCols, numRows])

  useFrame(({ clock }) => {
    if (!meshRef.current || !geometry) return
    const t = clock.getElapsedTime()
    const positions = geometry.attributes.position.array as Float32Array
    const n = origHeights.current.length

    for (let i = 0; i < n; i++) {
      const base = origHeights.current[i]
      const breathe = Math.sin(t * 0.6 + i * 0.07) * 0.04 * (base + 0.3)
      positions[i * 3 + 1] = base + breathe
    }
    geometry.attributes.position.needsUpdate = true
  })

  return (
    <mesh ref={meshRef} geometry={geometry}>
      <meshBasicMaterial wireframe color={new THREE.Color('#aaff00')} />
    </mesh>
  )
}

function PeakLabels({ terrainData }: { terrainData: TerrainData }) {
  const { grid, projects } = terrainData
  const peaks: Array<{ x: number; z: number; label: string; height: number }> = []

  const numCols = NUM_DAYS
  const numRows = projects.length

  // Find peak for each project
  for (let r = 0; r < Math.min(numRows, 8); r++) {
    let maxH = 0
    let maxC = 0
    for (let c = 0; c < numCols; c++) {
      const h = grid[c]?.[r] ?? 0
      if (h > maxH) { maxH = h; maxC = c }
    }
    if (maxH > 0.5) {
      const x = -TERRAIN_WIDTH / 2 + (maxC / (numCols - 1)) * TERRAIN_WIDTH
      const z = -TERRAIN_DEPTH / 2 + (r / Math.max(numRows - 1, 1)) * TERRAIN_DEPTH
      peaks.push({ x, z, label: projects[r].toUpperCase(), height: maxH })
    }
  }

  return (
    <>
      {peaks.map((peak, i) => (
        <Text
          key={i}
          position={[peak.x, peak.height + 0.8, peak.z]}
          fontSize={0.5}
          color="#aaff00"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.05}
          outlineColor="#000000"
          maxWidth={6}
        >
          {peak.label}
        </Text>
      ))}
    </>
  )
}

function GridFloor() {
  return (
    <gridHelper
      args={[TERRAIN_WIDTH + 4, 20, '#1a2a1a', '#0d180d']}
      position={[0, -0.05, 0]}
    />
  )
}

function AxisLabels() {
  const today = new Date()
  const labels = []

  for (let i = 0; i <= 4; i++) {
    const daysAgo = Math.round((4 - i) * 7)
    const date = new Date(today)
    date.setDate(date.getDate() - daysAgo)
    const label = `${date.getMonth() + 1}/${date.getDate()}`
    const x = -TERRAIN_WIDTH / 2 + (i / 4) * TERRAIN_WIDTH

    labels.push(
      <Text
        key={`day-${i}`}
        position={[x, -0.2, TERRAIN_DEPTH / 2 + 1.5]}
        fontSize={0.4}
        color="#446644"
        anchorX="center"
        anchorY="top"
      >
        {label}
      </Text>
    )
  }

  return <>{labels}</>
}

export default function TerrainView(): JSX.Element {
  const { sessions } = useStore()

  const terrainData = useMemo(() => buildTerrainData(sessions), [sessions])

  return (
    <div className="w-full h-full bg-cyber-dark relative">
      {/* Corner label */}
      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>

      {/* Day range label */}
      <div className="absolute top-2 right-2 z-10 text-xs font-mono text-cyber-text-dim">
        LAST 30 DAYS · {terrainData.projects.length} PROJECTS
      </div>

      <Canvas
        camera={{ position: [0, 12, 20], fov: 50 }}
        style={{ background: '#0a0a0a' }}
        gl={{ antialias: true }}
      >
        <ambientLight intensity={0.1} />
        <TerrainMesh terrainData={terrainData} />
        <PeakLabels terrainData={terrainData} />
        <GridFloor />
        <AxisLabels />
        <OrbitControls
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          maxPolarAngle={Math.PI / 2}
          minDistance={5}
          maxDistance={50}
          target={[0, 0, 0]}
        />
        <fog attach="fog" args={['#0a0a0a', 30, 80]} />
      </Canvas>

      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-cyber-text-dim">
            <p className="text-sm font-mono mb-2">NO SESSION DATA</p>
            <p className="text-xs" style={{ fontSize: '10px' }}>
              Ensure ~/.claude/projects/ exists
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
