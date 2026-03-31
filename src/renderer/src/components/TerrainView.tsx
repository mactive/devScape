/**
 * TerrainView — Mountain Range Topology
 *
 * Visual metaphor:
 *  - Each project = one Gaussian mountain peak
 *  - Peak height   = log(total prompts) → depth of work
 *  - Base width    = grows with session count (longer history = wider footprint)
 *  - Contour rings = one ring per prompt/conversation turn (equi-height spacing)
 *  - X axis        = time (oldest left, newest right)
 *  - Z axis        = 4 staggered rows for connected range feel
 */

import { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Session, ProjectStats } from '../types'

// ── Constants ────────────────────────────────────────────────────────────────

const WORLD_W    = 52    // world-space width  (X = time axis)
const WORLD_D    = 30    // world-space depth  (Z = stagger)
const HFIELD     = 110   // height-field resolution for terrain computation
const DISP_GRID  = 44    // display mesh subdivision (lower = more visible wires)
const MAX_H      = 7     // max mountain height
const MAX_MOUNTS = 22    // number of mountains shown
const MAX_RINGS  = 60    // ring cap per mountain (avoid drawing thousands of rings)

// ── Types ────────────────────────────────────────────────────────────────────

interface Mountain {
  name:         string
  worldX:       number
  worldZ:       number
  peakHeight:   number
  sigma:        number    // Gaussian spread in world units
  sessionCount: number
  promptCount:  number    // determines how many contour rings
  age:          number    // 0 = newest, 1 = oldest
}

// ── Layout ───────────────────────────────────────────────────────────────────

function buildMountains(projects: ProjectStats[], sessions: Session[]): Mountain[] {
  if (projects.length === 0) return []

  const byProject = new Map<string, Session[]>()
  for (const s of sessions) {
    const arr = byProject.get(s.projectName) ?? []
    arr.push(s)
    byProject.set(s.projectName, arr)
  }

  const lastActive = (name: string): number => {
    const arr = byProject.get(name)
    if (!arr?.length) return 0
    return Math.max(...arr.map(s => new Date(s.startTime).getTime()))
  }

  const sorted = projects
    .slice(0, MAX_MOUNTS)
    .sort((a, b) => lastActive(a.name) - lastActive(b.name))  // oldest → left

  const times  = sorted.map(p => lastActive(p.name))
  const minT   = times[0]  ?? 0
  const maxT   = times[times.length - 1] ?? 1
  const tRange = Math.max(maxT - minT, 1)

  // Four Z rows — hex-offset for organic clustering
  const zRows = [-10.5, -3.5, 3.5, 10.5]

  return sorted.map((p, i) => {
    const tFrac  = (times[i] - minT) / tRange
    // golden-ratio jitter on X so they don't line up perfectly
    const jitter = ((i * 0.6180339887) % 1 - 0.5) * 3.5
    const row    = i % zRows.length
    const xOff   = row % 2 === 0 ? 0 : 2.2   // hex row offset

    const worldX = (tFrac - 0.5) * (WORLD_W * 0.82) + jitter + xOff
    const worldZ = zRows[row] + ((i * 0.37) % 2 - 1) * 1.2

    const sc     = p.sessionCount
    const pc     = p.promptCount

    const peakHeight = Math.max(0.6, (Math.log(1 + pc) / Math.log(2000)) * MAX_H)
    const sigma      = 3.0 + Math.log(1 + sc) * 0.7

    return {
      name:  p.name,
      worldX,
      worldZ,
      peakHeight,
      sigma,
      sessionCount: sc,
      promptCount:  pc,
      age: 1 - tFrac,
    }
  })
}

// ── Height Field ─────────────────────────────────────────────────────────────

function buildHeightField(mountains: Mountain[]): Float32Array {
  const field = new Float32Array(HFIELD * HFIELD)
  for (const m of mountains) {
    const cx  = ((m.worldX / WORLD_W) + 0.5) * (HFIELD - 1)
    const cz  = ((m.worldZ / WORLD_D) + 0.5) * (HFIELD - 1)
    const sg  = (m.sigma / WORLD_W) * (HFIELD - 1)
    const R   = Math.ceil(sg * 3.2)
    const x0  = Math.max(0, Math.floor(cx - R)), x1 = Math.min(HFIELD - 1, Math.ceil(cx + R))
    const z0  = Math.max(0, Math.floor(cz - R)), z1 = Math.min(HFIELD - 1, Math.ceil(cz + R))
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dz = z - cz
        field[z * HFIELD + x] += m.peakHeight * Math.exp(-(dx*dx + dz*dz) / (2*sg*sg))
      }
  }
  return field
}

function sampleField(field: Float32Array, row: number, col: number): number {
  const r = Math.max(0, Math.min(HFIELD - 1, row))
  const c = Math.max(0, Math.min(HFIELD - 1, col))
  return field[r * HFIELD + c]
}

// Build geometry from field, sampled at displayGrid resolution
function buildDisplayGeo(field: Float32Array): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_D, DISP_GRID - 1, DISP_GRID - 1)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position.array as Float32Array

  for (let row = 0; row < DISP_GRID; row++) {
    for (let col = 0; col < DISP_GRID; col++) {
      // bilinear sample
      const fr  = (row / (DISP_GRID - 1)) * (HFIELD - 1)
      const fc  = (col / (DISP_GRID - 1)) * (HFIELD - 1)
      const r0  = Math.floor(fr), r1 = Math.min(r0 + 1, HFIELD - 1)
      const c0  = Math.floor(fc), c1 = Math.min(c0 + 1, HFIELD - 1)
      const tr  = fr - r0, tc = fc - c0
      const h   = sampleField(field, r0, c0) * (1-tr) * (1-tc)
                + sampleField(field, r1, c0) * tr    * (1-tc)
                + sampleField(field, r0, c1) * (1-tr) * tc
                + sampleField(field, r1, c1) * tr    * tc
      pos[(row * DISP_GRID + col) * 3 + 1] = h
    }
  }
  geo.attributes.position.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

// ── Contour Data ─────────────────────────────────────────────────────────────

type Vec3Tuple  = [number, number, number]

/**
 * For each mountain:
 *  N = min(promptCount, MAX_RINGS) contour rings
 *  Ring s at height h_s = (s/(N+1)) * peakHeight
 *  Radius from Gaussian inverse: r_s = sigma * sqrt(-2 * ln(h_s / H))
 *
 * Returns flat arrays of line-segment pairs (for drei <Line segments>)
 */
function buildContourData(mountains: Mountain[]): { points: Vec3Tuple[], colors: Vec3Tuple[] } {
  const pts: Vec3Tuple[]  = []
  const cols: Vec3Tuple[] = []

  for (const m of mountains) {
    // One ring per prompt, capped at MAX_RINGS
    const N = Math.min(m.promptCount, MAX_RINGS)
    if (N === 0) continue

    const H = m.peakHeight
    const σ = m.sigma

    // Newest = bright #aaff00 → Oldest = muted #336622
    const baseR = THREE.MathUtils.lerp(0.67, 0.20, m.age)
    const baseG = THREE.MathUtils.lerp(1.00, 0.40, m.age)

    for (let s = 1; s <= N; s++) {
      const frac = s / (N + 1)          // evenly spaced height fractions
      const h    = frac * H

      // Radius on the Gaussian at this height
      const r = σ * Math.sqrt(-2.0 * Math.log(frac))
      if (!isFinite(r) || r < 0.12 || r > 24) continue

      // Higher rings = brighter
      const bright = 0.28 + 0.72 * frac
      const cr = baseR * bright
      const cg = baseG * bright

      // Circle resolution: more segments for wider rings
      const segs = Math.max(22, Math.min(60, Math.round(r * 7)))

      for (let i = 0; i < segs; i++) {
        const a0 = (i       / segs) * Math.PI * 2
        const a1 = ((i + 1) / segs) * Math.PI * 2
        // Segment start
        pts.push([m.worldX + r * Math.cos(a0), h, m.worldZ + r * Math.sin(a0)])
        cols.push([cr, cg, 0])
        // Segment end
        pts.push([m.worldX + r * Math.cos(a1), h, m.worldZ + r * Math.sin(a1)])
        cols.push([cr, cg, 0])
      }
    }
  }

  return { points: pts, colors: cols }
}

// ── React Components ─────────────────────────────────────────────────────────

/**
 * Mountain body: solid dark fill + lighter wireframe overlay.
 * Two meshes share the same geometry (built once).
 */
function TerrainBody({ field }: { field: Float32Array }) {
  const geo = useMemo(() => buildDisplayGeo(field), [field])

  return (
    <>
      {/* Solid fill — blocks grid showing through steep flanks */}
      <mesh geometry={geo}>
        <meshBasicMaterial color={0x050c05} />
      </mesh>
      {/* Wireframe overlay — reveals mountain topology */}
      <mesh geometry={geo}>
        <meshBasicMaterial color={0x1f421f} wireframe />
      </mesh>
    </>
  )
}

/**
 * All contour rings across all mountains in one draw call.
 * Uses drei <Line segments lineWidth> so rings have real pixel width.
 */
function ContourLines({ mountains }: { mountains: Mountain[] }) {
  const groupRef = useRef<THREE.Group>(null)
  const { points, colors } = useMemo(() => buildContourData(mountains), [mountains])

  // Gentle whole-group breathing
  useFrame(({ clock }) => {
    if (groupRef.current)
      groupRef.current.position.y = Math.sin(clock.getElapsedTime() * 0.38) * 0.07
  })

  if (points.length === 0) return null

  return (
    <group ref={groupRef}>
      <Line
        points={points}
        vertexColors={colors}
        lineWidth={2.2}
        segments
      />
    </group>
  )
}

/** Billboard labels above each peak (top 12 by height) */
function PeakLabels({ mountains }: { mountains: Mountain[] }) {
  const top = [...mountains].sort((a, b) => b.peakHeight - a.peakHeight).slice(0, 12)

  return (
    <>
      {top.map((m, i) => (
        <Billboard key={i} position={[m.worldX, m.peakHeight + 1.2, m.worldZ]}>
          <Text
            fontSize={0.42}
            color={m.age < 0.25 ? '#aaff00' : m.age < 0.6 ? '#77cc44' : '#446633'}
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.07}
            outlineColor="#000000"
            maxWidth={9}
          >
            {m.name.toUpperCase().slice(0, 20)}
          </Text>
          <Text
            fontSize={0.27}
            color={m.age < 0.5 ? '#557733' : '#334422'}
            anchorX="center"
            anchorY="top"
            position={[0, -0.05, 0]}
          >
            {`${m.promptCount}p · ${m.sessionCount}s`}
          </Text>
        </Billboard>
      ))}
    </>
  )
}

function GridFloor() {
  return (
    <gridHelper
      args={[WORLD_W + 10, 28, 0x0e220e, 0x0a170a]}
      position={[0, -0.03, 0]}
    />
  )
}

function TimeAxis({ mountains }: { mountains: Mountain[] }) {
  if (mountains.length < 2) return null
  const oldest = mountains.reduce((a, b) => a.worldX < b.worldX ? a : b)
  const newest = mountains.reduce((a, b) => a.worldX > b.worldX ? a : b)
  const zFront  = WORLD_D / 2 + 2.2
  return (
    <>
      <Billboard position={[oldest.worldX, -0.5, zFront]}>
        <Text fontSize={0.37} color="#335533" anchorX="center">OLDER</Text>
      </Billboard>
      <Billboard position={[newest.worldX, -0.5, zFront]}>
        <Text fontSize={0.37} color="#77bb44" anchorX="center">RECENT</Text>
      </Billboard>
    </>
  )
}

// ── Main Export ───────────────────────────────────────────────────────────────

export default function TerrainView(): JSX.Element {
  const { sessions, projects } = useStore()

  const mountains   = useMemo(() => buildMountains(projects, sessions),  [projects, sessions])
  const heightField = useMemo(() => buildHeightField(mountains), [mountains])

  const totalRings = mountains.reduce((s, m) => s + Math.min(m.promptCount, MAX_RINGS), 0)

  return (
    <div className="w-full h-full bg-cyber-dark relative">

      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>
      <div className="absolute top-2 right-2 z-10 text-xs font-mono text-cyber-text-dim">
        {mountains.length} PEAKS · {totalRings} RINGS
      </div>
      <div
        className="absolute bottom-2 left-2 z-10 flex items-center gap-3 font-mono"
        style={{ fontSize: '9px', color: '#446644' }}
      >
        <span><span style={{ color: '#aaff00' }}>↑</span> height = prompt depth</span>
        <span><span style={{ color: '#aaff00' }}>○</span> 1 ring = 1 conversation turn</span>
        <span><span style={{ color: '#aaff00' }}>→</span> time: old → new</span>
      </div>

      <Canvas
        camera={{ position: [8, 16, 26], fov: 44 }}
        style={{ background: '#030803' }}
        gl={{ antialias: true }}
      >
        <TerrainBody    field={heightField} />
        <ContourLines   mountains={mountains} />
        <PeakLabels     mountains={mountains} />
        <TimeAxis       mountains={mountains} />
        <GridFloor />

        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          maxPolarAngle={Math.PI / 2 - 0.03}
          minDistance={5}
          maxDistance={80}
          target={[0, 1.5, 0]}
        />
        <fog attach="fog" args={['#030803', 48, 100]} />
      </Canvas>

      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-cyber-text-dim">
            <p className="text-sm font-mono">NO SESSION DATA</p>
            <p className="text-xs mt-1" style={{ fontSize: '10px' }}>
              Ensure ~/.claude/projects/ exists
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
