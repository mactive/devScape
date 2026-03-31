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

const WW       = 52      // world width  (X = date)
const WD       = 28      // world depth  (Z = hour 0-24)
const X_USE    = 0.82
const Z_USE    = 0.84
const HFIELD   = 100
const DISP     = 48
const MAX_H    = 8
const MAX_MT   = 28
const MAX_RINGS   = 10   // contour rings per mountain
const R_CAP_K     = 1.55 // max ring radius = R_CAP_K × sigma

// ── Date / hour math ──────────────────────────────────────────────────────────

interface DateRange { minDate: Date; maxDate: Date; daySpan: number }

function getDateRange(sessions: Session[]): DateRange {
  if (!sessions.length) {
    const now = new Date(), ago = new Date(now.getTime() - 60 * 86_400_000)
    return { minDate: ago, maxDate: now, daySpan: 60 }
  }
  const ts   = sessions.map(s => new Date(s.startTime).getTime())
  const minT = Math.min(...ts)
  const maxT = Math.max(...ts)
  // Axis: from actual first session (floored to day) to today
  const min  = new Date(minT); min.setHours(0, 0, 0, 0)
  const max  = new Date();     max.setHours(23, 59, 59, 999)
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

  const ts     = visible.map(p => firstTime.get(p.name)!)
  const minT   = Math.min(...ts), maxT = Math.max(...ts)
  const tRange = Math.max(maxT - minT, 1)

  // Sigma base adapts to date range span
  const dayWidth  = (WW * X_USE) / dr.daySpan
  const sigmaBase = Math.max(1.6, Math.min(3.2, dayWidth * 3.8))

  // Normalize prompt counts for sigma scaling
  const maxPc = Math.max(...visible.map(p => p.promptCount), 1)

  return visible.map(p => {
    const t    = firstTime.get(p.name)!
    const d    = new Date(t)
    const hour = d.getHours() + d.getMinutes() / 60
    const norm = p.promptCount / maxPc   // 0..1

    // Big projects → smaller sigma (steep narrow ribs)
    // Small projects → larger sigma (flat oval contours)
    const sigma = sigmaBase * (1 - 0.55 * norm)

    return {
      name:         p.name,
      worldX:       toWorldX(d, dr),
      worldZ:       toWorldZ(hour),
      peakHeight:   Math.max(0.6, (Math.log(1 + p.promptCount) / Math.log(1500)) * MAX_H),
      sigma,
      promptCount:  p.promptCount,
      sessionCount: p.sessionCount,
      age:          1 - (t - minT) / tRange,
    }
  })
}

// ── Height field (for solid mesh body) ───────────────────────────────────────

function buildHeightField(mounts: Mountain[]): Float32Array {
  const f = new Float32Array(HFIELD * HFIELD)
  for (const m of mounts) {
    const cx = ((m.worldX / WW) + 0.5) * (HFIELD - 1)
    const cz = ((m.worldZ / WD) + 0.5) * (HFIELD - 1)
    const sg = (m.sigma / WW) * (HFIELD - 1)
    const R  = Math.ceil(sg * 3.0)
    for (let z = Math.max(0, Math.floor(cz-R)); z <= Math.min(HFIELD-1, Math.ceil(cz+R)); z++)
      for (let x = Math.max(0, Math.floor(cx-R)); x <= Math.min(HFIELD-1, Math.ceil(cx+R)); x++) {
        const dx = x - cx, dz = z - cz
        f[z * HFIELD + x] += m.peakHeight * Math.exp(-(dx*dx + dz*dz) / (2 * sg*sg))
      }
  }
  return f
}

function buildDisplayGeo(f: Float32Array): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(WW, WD, DISP-1, DISP-1)
  g.rotateX(-Math.PI / 2)
  const pos    = g.attributes.position.array as Float32Array
  const colors = new Float32Array(DISP * DISP * 3)

  for (let row = 0; row < DISP; row++) for (let col = 0; col < DISP; col++) {
    const fr = (row / (DISP-1)) * (HFIELD-1), fc = (col / (DISP-1)) * (HFIELD-1)
    const r0 = Math.min(Math.floor(fr), HFIELD-2), c0 = Math.min(Math.floor(fc), HFIELD-2)
    const tr = fr - r0, tc = fc - c0
    const h  = f[r0*HFIELD+c0]*(1-tr)*(1-tc) + f[(r0+1)*HFIELD+c0]*tr*(1-tc)
             + f[r0*HFIELD+c0+1]*(1-tr)*tc   + f[(r0+1)*HFIELD+c0+1]*tr*tc
    const idx = row * DISP + col
    pos[idx * 3 + 1] = h

    // Vertex color: #021709 at base → brighter green at peaks
    const t = Math.min(1, Math.max(0, h / MAX_H))
    colors[idx * 3]     = 0.008 + t * 0.028   // R: 2/255 → ~9/255
    colors[idx * 3 + 1] = 0.090 + t * 0.200   // G: 23/255 → ~74/255
    colors[idx * 3 + 2] = 0.035 + t * 0.065   // B: 9/255 → ~26/255
  }

  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.attributes.position.needsUpdate = true
  g.computeVertexNormals()
  return g
}

type V3 = [number, number, number]

// ── Contour rings — one closed circle per ring level ─────────────────────────

interface ContourRing { pts: V3[]; color: string }

// #5EAB07 = rgb(94, 171, 7)
const CONTOUR_R = 94, CONTOUR_G = 171, CONTOUR_B = 7

function buildContourRings(mounts: Mountain[]): ContourRing[] {
  const rings: ContourRing[] = []
  for (const m of mounts) {
    for (let s = 1; s <= MAX_RINGS; s++) {
      const frac = s / (MAX_RINGS + 1)
      const h    = frac * m.peakHeight
      const rRaw = m.sigma * Math.sqrt(-2 * Math.log(frac))
      const r    = Math.min(rRaw, m.sigma * R_CAP_K)
      if (!isFinite(r) || r < 0.06) continue

      // Dim at base, full #5EAB07 near peak
      const bright = 0.35 + 0.65 * frac
      const cr = Math.round(CONTOUR_R * bright)
      const cg = Math.round(CONTOUR_G * bright)
      const segs = Math.max(48, Math.min(96, Math.round(r * 18)))

      const pts: V3[] = []
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2
        pts.push([m.worldX + r * Math.cos(a), h, m.worldZ + r * Math.sin(a)])
      }
      const cb = Math.round(CONTOUR_B * bright)
      rings.push({ pts, color: `rgb(${cr},${cg},${cb})` })
    }
  }
  return rings
}

// ── Grid geometry ─────────────────────────────────────────────────────────────

function buildGridGeo(dr: DateRange) {
  const xMin = toWorldX(dr.minDate, dr), xMax = toWorldX(dr.maxDate, dr)
  const zMin = toWorldZ(0),              zMax = toWorldZ(24)
  const dayStep  = dr.daySpan <= 30 ? 3 : dr.daySpan <= 60 ? 7 : dr.daySpan <= 120 ? 14 : 21
  const majorV: number[] = [], minorV: number[] = []

  for (let d = 0; d <= dr.daySpan; d++) {
    const x = toWorldX(new Date(dr.minDate.getTime() + d * 86_400_000), dr)
    ;(d % dayStep === 0 ? majorV : minorV).push(x, 0, zMin, x, 0, zMax)
  }
  for (let h = 0; h <= 24; h++) {
    const z = toWorldZ(h)
    ;(h % 3 === 0 ? majorV : minorV).push(xMin, 0, z, xMax, 0, z)
  }
  const make = (v: number[]) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
    return g
  }
  return { major: make(majorV), minor: make(minorV) }
}

// ── React components ──────────────────────────────────────────────────────────

function DateTimeGrid({ dr }: { dr: DateRange }) {
  const { major, minor } = useMemo(() => buildGridGeo(dr), [dr])
  return (
    <>
      <lineSegments geometry={minor}><lineBasicMaterial color={0x0d200d} /></lineSegments>
      <lineSegments geometry={major}><lineBasicMaterial color={0x183018} /></lineSegments>
    </>
  )
}

function CoordinateAxes({ dr }: { dr: DateRange }) {
  const xMin = toWorldX(dr.minDate, dr), xMax = toWorldX(dr.maxDate, dr)
  const zMin = toWorldZ(0),              zMax = toWorldZ(24)
  const OFF  = 1.8

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
      <Line points={[[xMax+OFF-0.5,0,zMax+OFF+0.35],[xMax+OFF,0,zMax+OFF],[xMax+OFF-0.5,0,zMax+OFF-0.35]] as V3[]} color="#44aa44" lineWidth={1.4} />
      <Line points={[[xMin-OFF-0.35,0,zMin-OFF+0.5],[xMin-OFF,0,zMin-OFF],[xMin-OFF+0.35,0,zMin-OFF+0.5]] as V3[]} color="#44aa44" lineWidth={1.4} />
    </>
  )
}

function DateLabels({ dr }: { dr: DateRange }) {
  const dayStep = dr.daySpan <= 30 ? 3 : dr.daySpan <= 60 ? 7 : dr.daySpan <= 120 ? 14 : 21
  const zFront  = toWorldZ(24) + 3.2
  const items: JSX.Element[] = []
  for (let d = 0; d <= dr.daySpan; d += dayStep) {
    const date = new Date(dr.minDate.getTime() + d * 86_400_000)
    const x    = toWorldX(date, dr)
    items.push(
      <Billboard key={d} position={[x, 0, zFront]}>
        <Text fontSize={0.32} color="#3a7a3a" anchorX="center" anchorY="top">
          {`${date.getMonth()+1}/${date.getDate()}`}
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

function TerrainBody({ field }: { field: Float32Array }) {
  const geo = useMemo(() => buildDisplayGeo(field), [field])
  return (
    <>
      {/* Black fill */}
      <mesh geometry={geo}><meshBasicMaterial color={0x000000} /></mesh>
      {/* Wireframe overlay #0E6E30 */}
      <mesh geometry={geo}><meshBasicMaterial color={0x0E6E30} wireframe /></mesh>
    </>
  )
}

/** Contour lines — each ring is its own closed Line for guaranteed continuity.
 *  All materials share the same dashOffset, driven by a single useFrame. */
function ContourLines({ mounts }: { mounts: Mountain[] }) {
  const groupRef  = useRef<THREE.Group>(null)
  const lineRefs  = useRef<any[]>([])
  const rings = useMemo(() => {
    lineRefs.current = []
    return buildContourRings(mounts)
  }, [mounts])

  useFrame(({ clock }) => {
    const t      = clock.getElapsedTime()
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

  const dr          = useMemo(() => getDateRange(sessions),                 [sessions])
  const mounts      = useMemo(() => buildMountains(projects, sessions, dr), [projects, sessions, dr])
  const heightField = useMemo(() => buildHeightField(mounts),               [mounts])

  const firstDate = dr.minDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
  const lastDate  = dr.maxDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })

  return (
    <div className="w-full h-full bg-cyber-dark relative">
      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>
      <div className="absolute top-2 right-2 z-10 font-mono text-cyber-text-dim" style={{fontSize:'10px'}}>
        TOKEN USAGE · {firstDate} – {lastDate} · {dr.daySpan} DAYS
      </div>
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-3 font-mono"
           style={{fontSize:'9px', color:'#3a6a3a'}}>
        <span><span style={{color:'#aaff00'}}>X</span>=date created</span>
        <span><span style={{color:'#aaff00'}}>Z</span>=hour of day</span>
        <span><span style={{color:'#aaff00'}}>↑</span>=prompts</span>
        <span><span style={{color:'#aaff00'}}>≡</span>=1 ridge=1 session</span>
      </div>

      <Canvas camera={{position:[2, 22, 30], fov:44}} style={{background:'#020702'}} gl={{antialias:true}}>
        {/* Dark green ground plane */}
        <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, -0.02, 0]}>
          <planeGeometry args={[WW * 1.15, WD * 1.15]} />
          <meshBasicMaterial color={0x061206} />
        </mesh>
        <DateTimeGrid   dr={dr} />
        <CoordinateAxes dr={dr} />
        <DateLabels     dr={dr} />
        <HourLabels     dr={dr} />
        <TerrainBody    field={heightField} />
        <ContourLines   mounts={mounts} />
        <PeakLabels     mounts={mounts} />

        <OrbitControls enablePan enableZoom enableRotate
          maxPolarAngle={Math.PI / 2 - 0.03} minDistance={6} maxDistance={100}
          target={[0, 1, 0]} />
        <fog attach="fog" args={['#020702', 55, 120]} />
      </Canvas>

      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-cyber-text-dim">
            <p className="text-sm font-mono">NO SESSION DATA</p>
            <p className="text-xs mt-1" style={{fontSize:'10px'}}>Ensure ~/.claude/projects/ exists</p>
          </div>
        </div>
      )}
    </div>
  )
}
