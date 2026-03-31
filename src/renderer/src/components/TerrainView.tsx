/**
 * TerrainView — Date × Hour floor grid, mountain-ridge terrain
 *
 * Coordinate system:
 *   X = calendar date  (left = earliest session, right = most recent)
 *   Z = hour of day    (front = 0h, back = 24h)
 *   Y = height         (log prompt count)
 *
 * Each mountain = one project, placed at its first session datetime.
 * Rendering: radial ridge lines (ribs from peak to base) + sparse contour rings.
 * Big projects → steep narrow ridges; small projects → flat oval contours.
 */

import { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Session, ProjectStats } from '../types'

// ── World constants ───────────────────────────────────────────────────────────

const WW = 52      // world width  (X = date)
const WD = 28      // world depth  (Z = hour 0-24)
const X_USE = 0.82
const Z_USE = 0.84
const MAX_H = 8
const MAX_MT = 28
const MAX_RINGS = 10   // contour rings per mountain
const R_CAP_K = 1.55 // max ring radius = R_CAP_K × sigma

// ── Date / hour math ──────────────────────────────────────────────────────────

interface DateRange { minDate: Date; maxDate: Date; daySpan: number }

function getDateRange(sessions: Session[]): DateRange {
  if (!sessions.length) {
    const now = new Date(), ago = new Date(now.getTime() - 60 * 86_400_000)
    return { minDate: ago, maxDate: now, daySpan: 60 }
  }
  const ts = sessions.map(s => new Date(s.startTime).getTime())
  const minT = Math.min(...ts)
  const maxT = Math.max(...ts)
  // Axis: from actual first session (floored to day) to today
  const min = new Date(minT); min.setHours(0, 0, 0, 0)
  const max = new Date(); max.setHours(23, 59, 59, 999)
  const daySpan = Math.max(7, Math.ceil((max.getTime() - min.getTime()) / 86_400_000))
  return { minDate: min, maxDate: max, daySpan }
}

function toWorldX(date: Date, r: DateRange): number {
  const t = Math.max(0, Math.min(1,
    (date.getTime() - r.minDate.getTime()) /
    (r.maxDate.getTime() - r.minDate.getTime())))
  return (t - 0.5) * WW * X_USE
}

function toWorldZ(hour: number): number {
  return ((Math.max(0, Math.min(24, hour)) / 24) - 0.5) * WD * Z_USE
}

// ── Mountain type + layout ────────────────────────────────────────────────────

interface Mountain {
  name: string; worldX: number; worldZ: number
  peakHeight: number; sigma: number
  promptCount: number; sessionCount: number; age: number
}

function buildMountains(
  projects: ProjectStats[], sessions: Session[], dr: DateRange
): Mountain[] {
  if (!projects.length) return []

  const firstTime = new Map<string, number>()
  for (const s of sessions) {
    const t = new Date(s.startTime).getTime()
    if ((firstTime.get(s.projectName) ?? Infinity) > t)
      firstTime.set(s.projectName, t)
  }

  const visible = [...projects]
    .filter(p => firstTime.has(p.name))
    .sort((a, b) => firstTime.get(a.name)! - firstTime.get(b.name)!)
    .slice(0, MAX_MT)

  if (!visible.length) return []

  const ts = visible.map(p => firstTime.get(p.name)!)
  const minT = Math.min(...ts), maxT = Math.max(...ts)
  const tRange = Math.max(maxT - minT, 1)

  // Sigma base adapts to date range span
  const dayWidth = (WW * X_USE) / dr.daySpan
  const sigmaBase = Math.max(1.6, Math.min(3.2, dayWidth * 3.8))

  // Normalize prompt counts for sigma scaling
  const maxPc = Math.max(...visible.map(p => p.promptCount), 1)

  return visible.map(p => {
    const t = firstTime.get(p.name)!
    const d = new Date(t)
    const hour = d.getHours() + d.getMinutes() / 60
    const norm = p.promptCount / maxPc   // 0..1

    // Big projects → smaller sigma (steep narrow ribs)
    // Small projects → larger sigma (flat oval contours)
    const sigma = sigmaBase * (1 - 0.55 * norm)

    return {
      name: p.name,
      worldX: toWorldX(d, dr),
      worldZ: toWorldZ(hour),
      peakHeight: Math.max(0.6, (Math.log(1 + p.promptCount) / Math.log(1500)) * MAX_H),
      sigma,
      promptCount: p.promptCount,
      sessionCount: p.sessionCount,
      age: 1 - (t - minT) / tRange,
    }
  })
}


type V3 = [number, number, number]

// ── Deterministic hash ────────────────────────────────────────────────────────

function fhash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
function nameHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff
  return h
}

// ── Organic terrain: sum-of-Gaussians + domain warping ───────────────────────

interface Bump { dx: number; dz: number; amp: number; sig: number }

/**
 * 1 main peak + 4-5 additive secondary bumps (ridges) + 1-2 negative bumps
 * (valleys). Secondary bumps are spread up to 1.8σ from centre.
 */
function makeBumps(name: string, peakH: number, sigma: number): Bump[] {
  const s = nameHash(name)
  const bumps: Bump[] = []

  // Main peak — slight asymmetric offset
  const mAng = fhash(s * 3) * Math.PI * 2
  bumps.push({
    dx: sigma * 0.14 * Math.cos(mAng),
    dz: sigma * 0.14 * Math.sin(mAng),
    amp: peakH * 0.55, sig: sigma
  })

  // 4-5 additive secondary bumps spread further out
  const nAdd = 4 + (s & 1)
  for (let i = 0; i < nAdd; i++) {
    const ang  = fhash(s * 11 + i * 7) * Math.PI * 2
    // push secondaries 0.6–1.8σ from centre (was 0–0.72σ)
    const dist = sigma * (0.6 + fhash(s * 13 + i * 5) * 1.2)
    bumps.push({
      dx: dist * Math.cos(ang),
      dz: dist * Math.sin(ang),
      amp: peakH * (0.16 + fhash(s * 17 + i * 3) * 0.30),   // 16–46%
      sig: sigma * (0.28 + fhash(s * 19 + i * 9) * 0.55)
    })
  }

  // 1-2 negative bumps → concave bays / valleys in the contours
  const nSub = 1 + (s & 1)
  for (let i = 0; i < nSub; i++) {
    const ang  = fhash(s * 23 + i * 11) * Math.PI * 2
    const dist = sigma * (0.35 + fhash(s * 29 + i * 7) * 0.9)
    bumps.push({
      dx: dist * Math.cos(ang),
      dz: dist * Math.sin(ang),
      amp: -peakH * (0.12 + fhash(s * 31 + i * 13) * 0.16),  // −12..−28%
      sig: sigma * (0.22 + fhash(s * 37 + i * 17) * 0.32)
    })
  }
  return bumps
}

/** Raw Gaussian sum at local (lx, lz) */
function evalH(lx: number, lz: number, bumps: Bump[]): number {
  let h = 0
  for (const b of bumps) {
    const dx = lx - b.dx, dz = lz - b.dz
    h += b.amp * Math.exp(-(dx * dx + dz * dz) / (2 * b.sig * b.sig))
  }
  return h
}

/**
 * Domain warping: offset sample coords by a low-frequency sinusoidal field.
 * Transforms smooth ellipses into flowing, organic isocurves (ref image look).
 */
function warp(lx: number, lz: number, sigma: number, seed: number): [number, number] {
  const str = sigma * 0.55          // warp strength ≈ 55% of sigma
  const f   = 1.4 / sigma           // spatial frequency (wider sigma → lower freq)
  const p0 = fhash(seed * 41) * Math.PI * 2
  const p1 = fhash(seed * 43) * Math.PI * 2
  const p2 = fhash(seed * 47) * Math.PI * 2
  const p3 = fhash(seed * 53) * Math.PI * 2
  return [
    lx + str * (Math.sin(f * lz + p0) * 0.65 + Math.sin(f * 0.71 * lx + p1) * 0.35),
    lz + str * (Math.sin(f * lx + p2) * 0.65 + Math.sin(f * 0.83 * lz + p3) * 0.35)
  ]
}

function evalHW(lx: number, lz: number, bumps: Bump[], sigma: number, seed: number): number {
  const [wx, wz] = warp(lx, lz, sigma, seed)
  return evalH(wx, wz, bumps)
}

/**
 * Find the radius along `angle` where evalHW == targetH.
 * Coarse scan first (handles non-monotonic fields from negative bumps + warp),
 * then binary refinement.
 */
function findRadius(
  angle: number, targetH: number,
  bumps: Bump[], sigma: number, seed: number, maxR: number
): number {
  const cosA = Math.cos(angle), sinA = Math.sin(angle)
  if (evalHW(0, 0, bumps, sigma, seed) <= targetH) return 0

  const SCAN = 48
  const step = maxR / SCAN
  let prevH = evalHW(0, 0, bumps, sigma, seed)

  for (let i = 1; i <= SCAN; i++) {
    const r = i * step
    const h = evalHW(r * cosA, r * sinA, bumps, sigma, seed)
    if (h <= targetH) {
      // Refine crossing between (i-1)*step and r
      let lo = (i - 1) * step, hi = r
      for (let j = 0; j < 22; j++) {
        const mid = (lo + hi) * 0.5
        if (evalHW(mid * cosA, mid * sinA, bumps, sigma, seed) > targetH) lo = mid
        else hi = mid
      }
      return (lo + hi) * 0.5
    }
    prevH = h
  }
  return 0
}

// ── Contour ring builder ──────────────────────────────────────────────────────

interface ContourRing { pts: V3[]; color: string }

// #5EAB07 = rgb(94, 171, 7)
const CONTOUR_R = 94, CONTOUR_G = 171, CONTOUR_B = 7

function buildContourRings(mounts: Mountain[]): ContourRing[] {
  const rings: ContourRing[] = []
  for (const m of mounts) {
    const seed  = nameHash(m.name)
    const bumps = makeBumps(m.name, m.peakHeight, m.sigma)
    const peak  = evalHW(0, 0, bumps, m.sigma, seed)
    const maxR  = m.sigma * R_CAP_K * 2.0

    for (let s = 1; s <= MAX_RINGS; s++) {
      const frac    = s / (MAX_RINGS + 1)
      const targetH = frac * peak
      const worldH  = frac * m.peakHeight

      const SEGS = 90
      const pts: V3[] = []
      let skip = false

      for (let i = 0; i <= SEGS; i++) {
        const angle = (i / SEGS) * Math.PI * 2
        const r = findRadius(angle, targetH, bumps, m.sigma, seed, maxR)
        if (r < 0.05) { skip = true; break }
        pts.push([m.worldX + r * Math.cos(angle), worldH, m.worldZ + r * Math.sin(angle)])
      }
      if (skip) continue

      const bright = 0.30 + 0.70 * frac
      rings.push({
        pts,
        color: `rgb(${Math.round(CONTOUR_R*bright)},${Math.round(CONTOUR_G*bright)},${Math.round(CONTOUR_B*bright)})`
      })
    }
  }
  return rings
}

// ── Grid geometry — fixed 64×24 square cells ─────────────────────────────────

const GRID_NX = 64   // cells in X (date axis)
const GRID_NZ = 24   // cells in Z (hour axis, 1 cell = 1 hour)

const GRID_X_MIN = -WW * X_USE / 2, GRID_X_MAX = WW * X_USE / 2
const GRID_Z_MIN = -WD * Z_USE / 2, GRID_Z_MAX = WD * Z_USE / 2

function buildSquareGridGeo(): THREE.BufferGeometry {
  const verts: number[] = []
  for (let i = 0; i <= GRID_NX; i++) {
    const x = GRID_X_MIN + (i / GRID_NX) * (GRID_X_MAX - GRID_X_MIN)
    verts.push(x, 0, GRID_Z_MIN, x, 0, GRID_Z_MAX)
  }
  for (let j = 0; j <= GRID_NZ; j++) {
    const z = GRID_Z_MIN + (j / GRID_NZ) * (GRID_Z_MAX - GRID_Z_MIN)
    verts.push(GRID_X_MIN, 0, z, GRID_X_MAX, 0, z)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  return g
}

// ── React components ──────────────────────────────────────────────────────────

function DateTimeGrid() {
  const geo = useMemo(() => buildSquareGridGeo(), [])
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={0xffffff} transparent opacity={0.18} />
    </lineSegments>
  )
}

/** White dots at every 4×4 grid intersection */
function GridDots() {
  const positions = useMemo(() => {
    const pts: [number, number, number][] = []
    for (let i = 0; i <= GRID_NX; i += 4) {
      for (let j = 0; j <= GRID_NZ; j += 4) {
        const x = GRID_X_MIN + (i / GRID_NX) * (GRID_X_MAX - GRID_X_MIN)
        const z = GRID_Z_MIN + (j / GRID_NZ) * (GRID_Z_MAX - GRID_Z_MIN)
        pts.push([x, 0.02, z])
      }
    }
    return pts
  }, [])

  return (
    <>
      {positions.map(([x, y, z], i) => (
        <mesh key={i} position={[x, y, z]}>
          <sphereGeometry args={[0.05, 7, 7]} />
          <meshBasicMaterial color={0xBCCFBC} />
        </mesh>
      ))}
    </>
  )
}

function CoordinateAxes({ dr }: { dr: DateRange }) {
  const xMin = toWorldX(dr.minDate, dr), xMax = toWorldX(dr.maxDate, dr)
  const zMin = toWorldZ(0), zMax = toWorldZ(24)
  const OFF = 1.8

  const xLine: V3[] = [[xMin, 0, zMax + OFF], [xMax + OFF, 0, zMax + OFF]]
  const zLine: V3[] = [[xMin - OFF, 0, zMax], [xMin - OFF, 0, zMin - OFF]]

  const dayStep = dr.daySpan <= 30 ? 3 : dr.daySpan <= 60 ? 7 : dr.daySpan <= 120 ? 14 : 21
  const xTicks: V3[] = []
  for (let d = 0; d <= dr.daySpan; d += dayStep) {
    const x = toWorldX(new Date(dr.minDate.getTime() + d * 86_400_000), dr)
    xTicks.push([x, 0, zMax + OFF - 0.35], [x, 0, zMax + OFF + 0.35])
  }
  const zTicks: V3[] = []
  for (let h = 0; h <= 24; h += 3) {
    const z = toWorldZ(h)
    zTicks.push([xMin - OFF - 0.35, 0, z], [xMin - OFF + 0.35, 0, z])
  }

  return (
    <>
      <Line points={xLine} color="#267026" lineWidth={1.6} />
      <Line points={zLine} color="#267026" lineWidth={1.6} />
      <Line points={xTicks} color="#1e5a1e" lineWidth={1.1} segments />
      <Line points={zTicks} color="#1e5a1e" lineWidth={1.1} segments />
      <Line points={[[xMax + OFF - 0.5, 0, zMax + OFF + 0.35], [xMax + OFF, 0, zMax + OFF], [xMax + OFF - 0.5, 0, zMax + OFF - 0.35]] as V3[]} color="#44aa44" lineWidth={1.4} />
      <Line points={[[xMin - OFF - 0.35, 0, zMin - OFF + 0.5], [xMin - OFF, 0, zMin - OFF], [xMin - OFF + 0.35, 0, zMin - OFF + 0.5]] as V3[]} color="#44aa44" lineWidth={1.4} />
    </>
  )
}

function DateLabels({ dr }: { dr: DateRange }) {
  const dayStep = dr.daySpan <= 30 ? 3 : dr.daySpan <= 60 ? 7 : dr.daySpan <= 120 ? 14 : 21
  const zFront = toWorldZ(24) + 3.2
  const items: JSX.Element[] = []
  for (let d = 0; d <= dr.daySpan; d += dayStep) {
    const date = new Date(dr.minDate.getTime() + d * 86_400_000)
    const x = toWorldX(date, dr)
    items.push(
      <Billboard key={d} position={[x, 0, zFront]}>
        <Text fontSize={0.32} color="#3a7a3a" anchorX="center" anchorY="top">
          {`${date.getMonth() + 1}/${date.getDate()}`}
        </Text>
      </Billboard>
    )
  }
  items.push(
    <Billboard key="xt" position={[0, 0, zFront + 1.3]}>
      <Text fontSize={0.38} color="#55aa55" anchorX="center">DATE →</Text>
    </Billboard>
  )
  return <>{items}</>
}

function HourLabels({ dr }: { dr: DateRange }) {
  const xLeft = toWorldX(dr.minDate, dr) - 3.4
  const items: JSX.Element[] = []
  for (let h = 0; h <= 21; h += 3) {
    items.push(
      <Billboard key={h} position={[xLeft, 0, toWorldZ(h)]}>
        <Text
          fontSize={0.30}
          color={h === 0 || h === 12 ? '#55aa55' : '#2a6a2a'}
          anchorX="right" anchorY="middle"
        >
          {`${String(h).padStart(2, '0')}:00`}
        </Text>
      </Billboard>
    )
  }
  items.push(
    <Billboard key="zt" position={[xLeft - 1.2, 0, 0]}>
      <Text fontSize={0.38} color="#55aa55" anchorX="center">HOUR →</Text>
    </Billboard>
  )
  return <>{items}</>
}

/** Contour lines — each ring is its own closed Line for guaranteed continuity.
 *  All materials share the same dashOffset, driven by a single useFrame. */
function ContourLines({ mounts }: { mounts: Mountain[] }) {
  const groupRef = useRef<THREE.Group>(null)
  const lineRefs = useRef<any[]>([])
  const rings = useMemo(() => {
    lineRefs.current = []
    return buildContourRings(mounts)
  }, [mounts])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const offset = -(t * 0.18)
    for (const line of lineRefs.current) {
      if (line?.material) line.material.dashOffset = offset
    }
    if (groupRef.current)
      groupRef.current.position.y = Math.sin(t * 0.36) * 0.05
  })

  if (!rings.length) return null
  return (
    <group ref={groupRef}>
      {rings.map((ring, i) => (
        <Line
          key={i}
          ref={(el: any) => { lineRefs.current[i] = el }}
          points={ring.pts}
          color={ring.color}
          lineWidth={2.0}
          dashed
          dashSize={0.5}
          gapSize={0.22}
        />
      ))}
    </group>
  )
}

/** HUD-style peak labels: vertical stem line + bracket box */
function PeakLabels({ mounts }: { mounts: Mountain[] }) {
  const top = [...mounts].sort((a, b) => b.peakHeight - a.peakHeight).slice(0, 14)
  return (
    <>
      {top.map((m, i) => {
        const stemH = m.peakHeight + 1.8
        const stemTop: V3 = [m.worldX, stemH, m.worldZ]
        const stemBot: V3 = [m.worldX, m.peakHeight + 0.1, m.worldZ]
        const tipColor = m.age < 0.35 ? '#aaff00' : m.age < 0.7 ? '#77cc22' : '#3d7a1a'
        return (
          <group key={i}>
            {/* Vertical stem */}
            <Line points={[stemBot, stemTop]} color={tipColor} lineWidth={1.0} />
            {/* Billboard text at stem top */}
            <Billboard position={[m.worldX, stemH + 0.1, m.worldZ]}>
              <Text
                fontSize={0.38}
                color={tipColor}
                anchorX="center" anchorY="bottom"
                outlineWidth={0.08} outlineColor="#000"
                maxWidth={9}
              >
                {m.name.toUpperCase().slice(0, 18)}
              </Text>
              <Text
                fontSize={0.24}
                color={m.age < 0.5 ? '#557730' : '#2a4418'}
                anchorX="center" anchorY="top"
                position={[0, -0.06, 0]}
              >
                {`${m.promptCount}p · ${m.sessionCount}s`}
              </Text>
            </Billboard>
          </group>
        )
      })}
    </>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function TerrainView(): JSX.Element {
  const { sessions, projects } = useStore()

  const dr = useMemo(() => getDateRange(sessions), [sessions])
  const mounts = useMemo(() => buildMountains(projects, sessions, dr), [projects, sessions, dr])

  const firstDate = dr.minDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
  const lastDate = dr.maxDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })

  return (
    <div className="w-full h-full bg-cyber-dark relative">
      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>
      <div className="absolute top-2 right-2 z-10 font-mono text-cyber-text-dim" style={{ fontSize: '10px' }}>
        TOKEN USAGE · {firstDate} – {lastDate} · {dr.daySpan} DAYS
      </div>
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-3 font-mono"
        style={{ fontSize: '9px', color: '#3a6a3a' }}>
        <span><span style={{ color: '#aaff00' }}>X</span>=date created</span>
        <span><span style={{ color: '#aaff00' }}>Z</span>=hour of day</span>
        <span><span style={{ color: '#aaff00' }}>↑</span>=prompts</span>
        <span><span style={{ color: '#aaff00' }}>≡</span>=1 ridge=1 session</span>
      </div>

      <Canvas camera={{ position: [2, 22, 30], fov: 44 }} style={{ background: '#020702' }} gl={{ antialias: true }}>
        <DateTimeGrid />
        <GridDots />
        <CoordinateAxes dr={dr} />
        <DateLabels dr={dr} />
        <HourLabels dr={dr} />
        <ContourLines mounts={mounts} />
        <PeakLabels mounts={mounts} />

        <OrbitControls enablePan enableZoom enableRotate
          maxPolarAngle={Math.PI / 2 - 0.03} minDistance={6} maxDistance={100}
          target={[0, 1, 0]} />
        <fog attach="fog" args={['#020702', 55, 120]} />
      </Canvas>

      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-cyber-text-dim">
            <p className="text-sm font-mono">NO SESSION DATA</p>
            <p className="text-xs mt-1" style={{ fontSize: '10px' }}>Ensure ~/.claude/projects/ exists</p>
          </div>
        </div>
      )}
    </div>
  )
}
