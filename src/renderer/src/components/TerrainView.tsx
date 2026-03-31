/**
 * TerrainView — Mountain Range Topology
 *
 * Visual metaphor:
 *  - Each project = one Gaussian mountain peak
 *  - Peak height   = log(total prompts)  → depth of work
 *  - Sigma (base)  = grows with session count → wider for longer-running projects
 *  - Contour rings = one ring per session/conversation (equi-height spacing)
 *  - X axis        = time (oldest projects left, newest right)
 *  - Z axis        = staggered rows so mountains cluster into a connected range
 */

import { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Session, ProjectStats } from '../types'

// ── Constants ────────────────────────────────────────────────────────────────

const WORLD_W = 52        // world-space width  (X axis = time)
const WORLD_D = 30        // world-space depth  (Z axis = stagger)
const GRID    = 110       // height-field resolution
const MAX_H   = 7         // max mountain height
const MAX_MOUNTS = 22     // max number of mountains rendered

// ── Types ────────────────────────────────────────────────────────────────────

interface Mountain {
  name:         string
  worldX:       number    // center X in world space
  worldZ:       number    // center Z in world space
  peakHeight:   number    // max Y height
  sigma:        number    // Gaussian spread (world units)
  sessionCount: number    // number of sessions → number of contour rings
  age:          number    // 0 = newest, 1 = oldest (for color tint)
}

// ── Layout ───────────────────────────────────────────────────────────────────

function buildMountains(projects: ProjectStats[], sessions: Session[]): Mountain[] {
  if (projects.length === 0) return []

  // Map sessions → projects, find time bounds
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

  // Sort by last-active, oldest first (→ left on X axis)
  const sorted = projects
    .slice(0, MAX_MOUNTS)
    .sort((a, b) => lastActive(a.name) - lastActive(b.name))

  const times  = sorted.map(p => lastActive(p.name))
  const minT   = times[0]  || 0
  const maxT   = times[times.length - 1] || 1
  const tRange = maxT - minT || 1

  // Four staggered rows, hexagonal-ish packing
  // Row offsets in Z (world units): front → back
  const zRows = [-10, -3.5, 3.5, 10]

  const mountains: Mountain[] = sorted.map((p, i) => {
    // X: proportional to last-active time, with small golden-ratio jitter
    const tFrac   = (times[i] - minT) / tRange                    // 0..1
    const jitter  = ((i * 0.6180339887) % 1 - 0.5) * 4            // ±2 units
    const worldX  = (tFrac - 0.5) * (WORLD_W * 0.82) + jitter

    // Z: cycle through 4 rows, each row slightly offset in X
    const row     = i % zRows.length
    const rowXoff = (row % 2 === 0 ? 0 : 2.5)                     // hex offset
    const worldZ  = zRows[row] + ((i * 0.4) % 2 - 1)              // ±1 fine jitter

    const sc     = p.sessionCount
    const prompts = p.promptCount

    // Height: log scale so huge projects don't dwarf small ones
    const peakHeight = Math.max(0.6, (Math.log(1 + prompts) / Math.log(2000)) * MAX_H)

    // Sigma: base 3 + grows slowly with sessions (wider base = longer project history)
    const sigma = 3.0 + Math.log(1 + sc) * 0.65

    const age = 1 - tFrac   // 0=newest, 1=oldest

    return {
      name:         p.name,
      worldX:       worldX + rowXoff,
      worldZ,
      peakHeight,
      sigma,
      sessionCount: sc,
      age,
    }
  })

  return mountains
}

// ── Height Field ─────────────────────────────────────────────────────────────

function buildHeightField(mountains: Mountain[]): Float32Array {
  const field = new Float32Array(GRID * GRID)

  for (const m of mountains) {
    // Map world coords → grid indices
    const cx = ((m.worldX / WORLD_W) + 0.5) * (GRID - 1)
    const cz = ((m.worldZ / WORLD_D) + 0.5) * (GRID - 1)
    // sigma in grid units
    const sg = (m.sigma / WORLD_W) * (GRID - 1)
    const R  = Math.ceil(sg * 3.2)

    const x0 = Math.max(0, Math.floor(cx - R))
    const x1 = Math.min(GRID - 1, Math.ceil(cx + R))
    const z0 = Math.max(0, Math.floor(cz - R))
    const z1 = Math.min(GRID - 1, Math.ceil(cz + R))

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dz = z - cz
        field[z * GRID + x] += m.peakHeight * Math.exp(-(dx * dx + dz * dz) / (2 * sg * sg))
      }
    }
  }
  return field
}

// ── Contour Ring Geometry ────────────────────────────────────────────────────

/**
 * For each mountain, emit N concentric circles (N = sessionCount).
 * Ring i is placed at height  h_i = (i / (N+1)) * peakHeight
 * and has radius r_i such that  Gaussian(r_i) = h_i
 *   → r_i = sigma * sqrt(-2 * ln(h_i / H))
 *
 * Color: height-based brightness, age-based hue shift
 */
function buildContourGeometry(mountains: Mountain[]): THREE.BufferGeometry {
  const verts:  number[] = []
  const colors: number[] = []

  for (const m of mountains) {
    const N = Math.min(m.sessionCount, 35)
    if (N === 0) continue
    const H = m.peakHeight
    const σ = m.sigma

    // Age tint: newest = pure #aaff00, oldest = muted #336622
    const baseR = THREE.MathUtils.lerp(0.67, 0.2,  m.age)
    const baseG = THREE.MathUtils.lerp(1.00, 0.40, m.age)
    const baseB = 0.0

    for (let s = 1; s <= N; s++) {
      const frac = s / (N + 1)          // 0 < frac < 1, evenly spaced heights
      const h    = frac * H             // world Y of this contour ring

      // Radius on the isolated Gaussian at height h
      const ratio = frac                // = h / H (since H = m.peakHeight)
      if (ratio <= 0.02 || ratio >= 0.99) continue
      const r = σ * Math.sqrt(-2.0 * Math.log(ratio))
      if (!isFinite(r) || r > 22 || r < 0.15) continue

      // Rings closer to peak are brighter + more opaque
      const bright = 0.25 + 0.75 * frac
      const cr = baseR * bright
      const cg = baseG * bright
      const cb = baseB

      // Segments: more for larger circles (looks smoother)
      const segs = Math.max(18, Math.min(52, Math.round(r * 7)))

      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2
        const a1 = ((i + 1) / segs) * Math.PI * 2
        // Two endpoints of this line segment
        verts.push(
          m.worldX + r * Math.cos(a0), h, m.worldZ + r * Math.sin(a0),
          m.worldX + r * Math.cos(a1), h, m.worldZ + r * Math.sin(a1),
        )
        colors.push(cr, cg, cb, cr, cg, cb)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts),  3))
  geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors), 3))
  return geo
}

// ── React Components ─────────────────────────────────────────────────────────

/** Dark filled base mesh built from summed Gaussians */
function TerrainBase({ field }: { field: Float32Array }) {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(WORLD_W, WORLD_D, GRID - 1, GRID - 1)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position.array as Float32Array
    for (let i = 0; i < GRID * GRID; i++) pos[i * 3 + 1] = field[i]
    g.attributes.position.needsUpdate = true
    g.computeVertexNormals()
    return g
  }, [field])

  return (
    <mesh geometry={geo} receiveShadow>
      <meshBasicMaterial color={new THREE.Color(0x040c04)} />
    </mesh>
  )
}

/** All contour rings as one merged LineSegments draw call */
function ContourLines({ mountains }: { mountains: Mountain[] }) {
  const ref   = useRef<THREE.Group>(null)
  const geo   = useMemo(() => buildContourGeometry(mountains), [mountains])

  // Very subtle breathing — whole group bobs gently
  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.position.y = Math.sin(clock.getElapsedTime() * 0.35) * 0.06
    }
  })

  return (
    <group ref={ref}>
      <lineSegments geometry={geo}>
        <lineBasicMaterial vertexColors />
      </lineSegments>
    </group>
  )
}

/** Billboard labels above each peak */
function PeakLabels({ mountains }: { mountains: Mountain[] }) {
  // Show top 12 peaks
  const peaks = [...mountains]
    .sort((a, b) => b.peakHeight - a.peakHeight)
    .slice(0, 12)

  return (
    <>
      {peaks.map((m, i) => (
        <Billboard key={i} position={[m.worldX, m.peakHeight + 1.1, m.worldZ]}>
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
          {/* small tick down to peak */}
          <Text
            fontSize={0.28}
            color={m.age < 0.4 ? '#668844' : '#334422'}
            anchorX="center"
            anchorY="top"
            position={[0, -0.05, 0]}
          >
            {m.sessionCount}s · {m.peakHeight.toFixed(1)}
          </Text>
        </Billboard>
      ))}
    </>
  )
}

/** Subtle floor grid — gives scale and depth */
function GridFloor() {
  return (
    <>
      <gridHelper
        args={[WORLD_W + 10, 30, 0x0f200f, 0x0a150a]}
        position={[0, -0.02, 0]}
      />
      {/* Outer boundary frame */}
      <lineSegments>
        <edgesGeometry
          args={[new THREE.PlaneGeometry(WORLD_W + 0.5, WORLD_D + 0.5).rotateX(-Math.PI / 2) as THREE.BufferGeometry]}
        />
        <lineBasicMaterial color={0x1a3a1a} />
      </lineSegments>
    </>
  )
}

/** X-axis time ticks */
function TimeAxis({ mountains }: { mountains: Mountain[] }) {
  if (mountains.length < 2) return null

  // oldest and newest
  const oldest = mountains.reduce((a, b) => a.worldX < b.worldX ? a : b)
  const newest = mountains.reduce((a, b) => a.worldX > b.worldX ? a : b)

  return (
    <>
      <Billboard position={[oldest.worldX, -0.4, WORLD_D / 2 + 2]}>
        <Text fontSize={0.38} color="#335533" anchorX="center">OLDER</Text>
      </Billboard>
      <Billboard position={[newest.worldX, -0.4, WORLD_D / 2 + 2]}>
        <Text fontSize={0.38} color="#77bb44" anchorX="center">RECENT</Text>
      </Billboard>
    </>
  )
}

// ── Main Export ───────────────────────────────────────────────────────────────

export default function TerrainView(): JSX.Element {
  const { sessions, projects } = useStore()

  const mountains  = useMemo(() => buildMountains(projects, sessions),  [projects, sessions])
  const heightField = useMemo(() => buildHeightField(mountains), [mountains])

  const totalRings = mountains.reduce((s, m) => s + Math.min(m.sessionCount, 35), 0)

  return (
    <div className="w-full h-full bg-cyber-dark relative">

      {/* HUD labels */}
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
        <span>
          <span style={{ color: '#aaff00' }}>↑</span> height = prompt depth
        </span>
        <span>
          <span style={{ color: '#aaff00' }}>○</span> 1 ring = 1 session
        </span>
        <span>
          <span style={{ color: '#aaff00' }}>→</span> left=old · right=new
        </span>
      </div>

      <Canvas
        camera={{ position: [8, 16, 26], fov: 44 }}
        style={{ background: '#040904' }}
        gl={{ antialias: true }}
      >
        <TerrainBase    field={heightField} />
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
          maxDistance={75}
          target={[0, 1, 0]}
        />
        <fog attach="fog" args={['#040904', 45, 95]} />
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
