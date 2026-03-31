/**
 * TerrainView — Date × Hour grid with per-project mountain peaks
 *
 * Coordinate system:
 *   X axis  = calendar date  (left = oldest session, right = most recent)
 *   Z axis  = hour of day    (front/−Z = 0h midnight, back/+Z = 24h midnight)
 *   Y axis  = height         (up = more prompt turns)
 *
 * Each project's mountain origin = datetime of its very first session
 * Contour rings: one ring per conversation prompt (capped at MAX_RINGS)
 * Sigma is kept tight so bases don't bleed into each other
 */

import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Session, ProjectStats } from '../types'

// ── World constants ───────────────────────────────────────────────────────────

const WW       = 60     // world width  (X = date axis)
const WD       = 32     // world depth  (Z = hour axis)
const X_USE    = 0.88   // fraction of WW used for data range
const Z_USE    = 0.88   // fraction of WD used for 0-24h
const HFIELD   = 120    // height-field resolution
const DISP     = 50     // display wireframe mesh resolution
const MAX_H    = 7      // max mountain height
const MAX_MT   = 24     // max mountains drawn
const MAX_RINGS = 55    // ring cap per mountain

// ── Date / hour helpers ───────────────────────────────────────────────────────

interface DateRange {
  minDate: Date
  maxDate: Date
  daySpan: number
}

function getDateRange(sessions: Session[]): DateRange {
  if (!sessions.length) {
    const now = new Date()
    const ago = new Date(now.getTime() - 90 * 86_400_000)
    return { minDate: ago, maxDate: now, daySpan: 90 }
  }
  const ts  = sessions.map(s => new Date(s.startTime).getTime())
  const min = new Date(Math.min(...ts)); min.setHours(0, 0, 0, 0)
  const max = new Date(Math.max(...ts)); max.setHours(23, 59, 59, 999)
  return { minDate: min, maxDate: max,
           daySpan: Math.max(1, Math.ceil((max.getTime() - min.getTime()) / 86_400_000)) }
}

function toWorldX(date: Date, r: DateRange): number {
  const t = (date.getTime() - r.minDate.getTime()) /
            (r.maxDate.getTime() - r.minDate.getTime())
  return (t - 0.5) * WW * X_USE
}

function toWorldZ(hour: number): number {
  return ((hour / 24) - 0.5) * WD * Z_USE
}

// ── Mountain type ─────────────────────────────────────────────────────────────

interface Mountain {
  name:        string
  worldX:      number
  worldZ:      number
  peakHeight:  number
  sigma:       number
  promptCount: number
  sessionCount: number
  age:         number   // 0=newest, 1=oldest
}

// ── Layout ────────────────────────────────────────────────────────────────────

function buildMountains(
  projects: ProjectStats[],
  sessions: Session[],
  dr: DateRange
): Mountain[] {
  if (!projects.length) return []

  // Find first session datetime per project
  const firstTime = new Map<string, number>()
  for (const s of sessions) {
    const t = new Date(s.startTime).getTime()
    const cur = firstTime.get(s.projectName) ?? Infinity
    if (t < cur) firstTime.set(s.projectName, t)
  }

  const topProjects = [...projects]
    .filter(p => firstTime.has(p.name))
    .sort((a, b) => (firstTime.get(a.name)! - firstTime.get(b.name)!))
    .slice(0, MAX_MT)

  const times = topProjects.map(p => firstTime.get(p.name)!)
  const minT  = Math.min(...times)
  const maxT  = Math.max(...times)
  const tRange = Math.max(maxT - minT, 1)

  // Sigma tight enough to prevent heavy base overlap:
  // base at ~5% height = sigma * 2.45 → keep that under 1.5 "day widths"
  const dayWidth = (WW * X_USE) / dr.daySpan
  const sigma    = Math.max(0.30, Math.min(1.20, dayWidth * 1.3))

  return topProjects.map(p => {
    const t       = firstTime.get(p.name)!
    const date    = new Date(t)
    const hour    = date.getHours() + date.getMinutes() / 60
    const worldX  = toWorldX(date, dr)
    const worldZ  = toWorldZ(hour)
    const age     = 1 - (t - minT) / tRange

    const peakHeight = Math.max(0.5, (Math.log(1 + p.promptCount) / Math.log(2000)) * MAX_H)

    return {
      name:         p.name,
      worldX,
      worldZ,
      peakHeight,
      sigma,
      promptCount:  p.promptCount,
      sessionCount: p.sessionCount,
      age,
    }
  })
}

// ── Height field (sum of Gaussians) ──────────────────────────────────────────

function buildHeightField(mounts: Mountain[]): Float32Array {
  const f = new Float32Array(HFIELD * HFIELD)
  for (const m of mounts) {
    const cx = ((m.worldX / WW) + 0.5) * (HFIELD - 1)
    const cz = ((m.worldZ / WD) + 0.5) * (HFIELD - 1)
    const sg = (m.sigma / WW) * (HFIELD - 1)
    const R  = Math.ceil(sg * 3.5)
    for (let z = Math.max(0, Math.floor(cz - R)); z <= Math.min(HFIELD-1, Math.ceil(cz+R)); z++)
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(HFIELD-1, Math.ceil(cx+R)); x++) {
        const dx = x - cx, dz = z - cz
        f[z * HFIELD + x] += m.peakHeight * Math.exp(-(dx*dx + dz*dz) / (2*sg*sg))
      }
  }
  return f
}

function buildDisplayGeo(f: Float32Array): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(WW, WD, DISP - 1, DISP - 1)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position.array as Float32Array
  for (let row = 0; row < DISP; row++) {
    for (let col = 0; col < DISP; col++) {
      const fr = (row / (DISP-1)) * (HFIELD-1), fc = (col / (DISP-1)) * (HFIELD-1)
      const r0 = Math.min(Math.floor(fr), HFIELD-2), c0 = Math.min(Math.floor(fc), HFIELD-2)
      const tr = fr - r0, tc = fc - c0
      const h = f[r0*HFIELD+c0]*(1-tr)*(1-tc) + f[(r0+1)*HFIELD+c0]*tr*(1-tc)
              + f[r0*HFIELD+c0+1]*(1-tr)*tc   + f[(r0+1)*HFIELD+c0+1]*tr*tc
      pos[(row*DISP+col)*3+1] = h
    }
  }
  g.attributes.position.needsUpdate = true
  g.computeVertexNormals()
  return g
}

// ── Contour ring data ─────────────────────────────────────────────────────────

type V3 = [number, number, number]

function buildContourData(mounts: Mountain[]): { pts: V3[], cols: V3[] } {
  const pts: V3[] = [], cols: V3[] = []

  for (const m of mounts) {
    const N = Math.min(m.promptCount, MAX_RINGS)
    if (!N) continue
    const σ = m.sigma
    const H = m.peakHeight
    const bR = THREE.MathUtils.lerp(0.67, 0.18, m.age)
    const bG = THREE.MathUtils.lerp(1.00, 0.38, m.age)

    for (let s = 1; s <= N; s++) {
      const frac = s / (N + 1)
      const h = frac * H
      const r = σ * Math.sqrt(-2 * Math.log(frac))
      if (!isFinite(r) || r < 0.08 || r > 18) continue

      const br = 0.28 + 0.72 * frac
      const cr = bR * br, cg = bG * br

      const segs = Math.max(18, Math.min(56, Math.round(r * 8)))
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2, a1 = ((i+1) / segs) * Math.PI * 2
        pts.push([m.worldX + r*Math.cos(a0), h, m.worldZ + r*Math.sin(a0)])
        cols.push([cr, cg, 0])
        pts.push([m.worldX + r*Math.cos(a1), h, m.worldZ + r*Math.sin(a1)])
        cols.push([cr, cg, 0])
      }
    }
  }
  return { pts, cols }
}

// ── Grid geometry ─────────────────────────────────────────────────────────────

function buildGridGeo(dr: DateRange): { major: THREE.BufferGeometry; minor: THREE.BufferGeometry } {
  const xMin = toWorldX(dr.minDate, dr), xMax = toWorldX(dr.maxDate, dr)
  const zMin = toWorldZ(0),              zMax = toWorldZ(24)

  // Decide intervals based on day span
  const dayStep  = dr.daySpan <= 14 ? 1 : dr.daySpan <= 60 ? 7 : dr.daySpan <= 120 ? 14 : 30
  const hourStep = 3   // every 3h

  const majorV: number[] = [], minorV: number[] = []

  // Date lines (vertical, along Z)
  for (let d = 0; d <= dr.daySpan; d++) {
    const date = new Date(dr.minDate.getTime() + d * 86_400_000)
    const x    = toWorldX(date, dr)
    const isMajor = d % dayStep === 0
    ;(isMajor ? majorV : minorV).push(x, 0, zMin, x, 0, zMax)
  }

  // Hour lines (horizontal, along X)
  for (let h = 0; h <= 24; h++) {
    const z = toWorldZ(h)
    const isMajor = h % hourStep === 0
    ;(isMajor ? majorV : minorV).push(xMin, 0, z, xMax, 0, z)
  }

  const make = (verts: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    return g
  }
  return { major: make(majorV), minor: make(minorV) }
}

// ── React components ──────────────────────────────────────────────────────────

function DateTimeGrid({ dr }: { dr: DateRange }) {
  const { major, minor } = useMemo(() => buildGridGeo(dr), [dr])

  return (
    <>
      {/* Minor grid: daily + every hour */}
      <lineSegments geometry={minor}>
        <lineBasicMaterial color={0x0a1c0a} transparent opacity={0.8} />
      </lineSegments>
      {/* Major grid: weekly/biweekly + every 3h */}
      <lineSegments geometry={major}>
        <lineBasicMaterial color={0x163016} transparent opacity={0.9} />
      </lineSegments>
    </>
  )
}

/** Date labels along the front edge (z = 24h line) */
function DateLabels({ dr }: { dr: DateRange }) {
  const dayStep  = dr.daySpan <= 14 ? 1 : dr.daySpan <= 60 ? 7 : dr.daySpan <= 120 ? 14 : 30
  const zFront   = toWorldZ(24) + 2.0
  const labels: JSX.Element[] = []

  for (let d = 0; d <= dr.daySpan; d += dayStep) {
    const date = new Date(dr.minDate.getTime() + d * 86_400_000)
    const x    = toWorldX(date, dr)
    const label = `${date.getMonth()+1}/${date.getDate()}`
    labels.push(
      <Billboard key={d} position={[x, 0.05, zFront]}>
        <Text fontSize={0.38} color="#3a6a3a" anchorX="center" anchorY="top">
          {label}
        </Text>
      </Billboard>
    )
  }
  return <>{labels}</>
}

/** Hour labels along the left edge (x = minDate line) */
function HourLabels({ dr }: { dr: DateRange }) {
  const xLeft = toWorldX(dr.minDate, dr) - 2.2
  const labels: JSX.Element[] = []

  for (let h = 0; h <= 21; h += 3) {
    const z     = toWorldZ(h)
    const label = `${String(h).padStart(2,'0')}h`
    const bright = h === 0 || h === 12 ? '#55aa55' : '#2e5a2e'
    labels.push(
      <Billboard key={h} position={[xLeft, 0.05, z]}>
        <Text fontSize={0.38} color={bright} anchorX="right" anchorY="middle">
          {label}
        </Text>
      </Billboard>
    )
  }
  return <>{labels}</>
}

/** Axis title labels */
function AxisTitles({ dr }: { dr: DateRange }) {
  const xMid  = 0
  const zFront = toWorldZ(24) + 4.2
  const xLeft  = toWorldX(dr.minDate, dr) - 4.5
  return (
    <>
      <Billboard position={[xMid, 0.1, zFront]}>
        <Text fontSize={0.45} color="#558855" anchorX="center">DATE →</Text>
      </Billboard>
      <Billboard position={[xLeft, 0.1, 0]}>
        <Text fontSize={0.45} color="#558855" anchorX="center">HOUR</Text>
      </Billboard>
    </>
  )
}

/** Mountain body: solid fill + wireframe overlay */
function TerrainBody({ field }: { field: Float32Array }) {
  const geo = useMemo(() => buildDisplayGeo(field), [field])
  return (
    <>
      <mesh geometry={geo}>
        <meshBasicMaterial color={0x050c05} />
      </mesh>
      <mesh geometry={geo}>
        <meshBasicMaterial color={0x1c3e1c} wireframe />
      </mesh>
    </>
  )
}

/** All contour rings in one LineSegments2 draw call */
function ContourLines({ mounts }: { mounts: Mountain[] }) {
  const ref = useRef<THREE.Group>(null)
  const { pts, cols } = useMemo(() => buildContourData(mounts), [mounts])

  useFrame(({ clock }) => {
    if (ref.current)
      ref.current.position.y = Math.sin(clock.getElapsedTime() * 0.38) * 0.06
  })

  if (!pts.length) return null
  return (
    <group ref={ref}>
      <Line points={pts} vertexColors={cols} lineWidth={2.0} segments />
    </group>
  )
}

/** Billboard labels above each peak */
function PeakLabels({ mounts }: { mounts: Mountain[] }) {
  const top = [...mounts].sort((a,b) => b.peakHeight - a.peakHeight).slice(0, 14)
  return (
    <>
      {top.map((m, i) => (
        <Billboard key={i} position={[m.worldX, m.peakHeight + 1.1, m.worldZ]}>
          <Text
            fontSize={0.40}
            color={m.age < 0.3 ? '#aaff00' : m.age < 0.65 ? '#66bb33' : '#3d6626'}
            anchorX="center" anchorY="bottom"
            outlineWidth={0.07} outlineColor="#000"
            maxWidth={8}
          >
            {m.name.toUpperCase().slice(0, 20)}
          </Text>
          <Text
            fontSize={0.26}
            color={m.age < 0.5 ? '#557730' : '#2e4420'}
            anchorX="center" anchorY="top"
            position={[0, -0.04, 0]}
          >
            {`${m.promptCount}p · ${m.sessionCount}s`}
          </Text>
        </Billboard>
      ))}
    </>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function TerrainView(): JSX.Element {
  const { sessions, projects } = useStore()

  const dr         = useMemo(() => getDateRange(sessions), [sessions])
  const mounts     = useMemo(() => buildMountains(projects, sessions, dr), [projects, sessions, dr])
  const heightField = useMemo(() => buildHeightField(mounts), [mounts])

  const totalRings = mounts.reduce((s, m) => s + Math.min(m.promptCount, MAX_RINGS), 0)

  return (
    <div className="w-full h-full bg-cyber-dark relative">
      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>
      <div className="absolute top-2 right-2 z-10 font-mono text-cyber-text-dim" style={{ fontSize: '10px' }}>
        {mounts.length} PROJECTS · {totalRings} RINGS · {dr.daySpan}d SPAN
      </div>
      <div
        className="absolute bottom-2 left-2 z-10 flex items-center gap-3 font-mono"
        style={{ fontSize: '9px', color: '#3a6a3a' }}
      >
        <span><span style={{ color: '#aaff00' }}>X</span> = date created</span>
        <span><span style={{ color: '#aaff00' }}>Z</span> = hour of day</span>
        <span><span style={{ color: '#aaff00' }}>↑</span> = prompt depth</span>
        <span><span style={{ color: '#aaff00' }}>○</span> 1 ring = 1 prompt</span>
      </div>

      <Canvas
        camera={{ position: [0, 20, 30], fov: 46 }}
        style={{ background: '#020702' }}
        gl={{ antialias: true }}
      >
        <DateTimeGrid dr={dr} />
        <DateLabels   dr={dr} />
        <HourLabels   dr={dr} />
        <AxisTitles   dr={dr} />
        <TerrainBody  field={heightField} />
        <ContourLines mounts={mounts} />
        <PeakLabels   mounts={mounts} />

        <OrbitControls
          enablePan enableZoom enableRotate
          maxPolarAngle={Math.PI / 2 - 0.03}
          minDistance={6} maxDistance={90}
          target={[0, 1, 0]}
        />
        <fog attach="fog" args={['#020702', 50, 105]} />
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
