/**
 * TerrainView — Date × Hour grid, irregular dashed contour lines
 *
 * Coordinate system:
 *   X = calendar date  (left = oldest, right = most recent, ≤120d window)
 *   Z = hour of day    (front −Z = 0h, back +Z = 24h)
 *   Y = height         (prompt count, log scale)
 *
 * Each mountain origin = project's very first session datetime.
 * Contour rings: one per prompt turn, dashed + marching-ant animation,
 * shape grows more elliptical / terrain-like toward the peak.
 */

import { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Session, ProjectStats } from '../types'

// ── World constants ───────────────────────────────────────────────────────────

const WW        = 52      // world width  (X = date)
const WD        = 28      // world depth  (Z = hour 0-24)
const X_USE     = 0.86
const Z_USE     = 0.88
const MAX_DAYS  = 120     // rolling window, keeps mountains compact
const HFIELD    = 120
const DISP      = 52
const MAX_H     = 7
const MAX_MT    = 24
const MAX_RINGS = 55

// ── Date / hour math ──────────────────────────────────────────────────────────

interface DateRange { minDate: Date; maxDate: Date; daySpan: number }

function getDateRange(sessions: Session[]): DateRange {
  if (!sessions.length) {
    const now = new Date(), ago = new Date(now.getTime() - MAX_DAYS * 86_400_000)
    return { minDate: ago, maxDate: now, daySpan: MAX_DAYS }
  }
  const ts  = sessions.map(s => new Date(s.startTime).getTime())
  const raw = Math.max(...ts)
  // rolling window: last MAX_DAYS from most recent session
  const minT = raw - MAX_DAYS * 86_400_000
  const min  = new Date(minT); min.setHours(0, 0, 0, 0)
  const max  = new Date(raw);  max.setHours(23, 59, 59, 999)
  return { minDate: min, maxDate: max, daySpan: MAX_DAYS }
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
    .filter(p => firstTime.has(p.name) && firstTime.get(p.name)! >= dr.minDate.getTime())
    .sort((a, b) => firstTime.get(a.name)! - firstTime.get(b.name)!)
    .slice(0, MAX_MT)

  if (!visible.length) {
    // fallback: take by promptCount regardless of window
    return [...projects].sort((a,b)=>b.promptCount-a.promptCount).slice(0, MAX_MT).map(p => ({
      name: p.name, worldX: 0, worldZ: 0,
      peakHeight: Math.max(0.5, (Math.log(1+p.promptCount)/Math.log(2000))*MAX_H),
      sigma: 1.0, promptCount: p.promptCount, sessionCount: p.sessionCount, age: 0.5
    }))
  }

  const ts     = visible.map(p => firstTime.get(p.name)!)
  const minT   = Math.min(...ts), maxT = Math.max(...ts)
  const tRange = Math.max(maxT - minT, 1)

  // sigma adapts to window width — keeps bases touching for dense periods
  const dayWidth = (WW * X_USE) / MAX_DAYS
  const sigma    = Math.max(1.0, Math.min(2.2, dayWidth * 2.8))

  return visible.map(p => {
    const t    = firstTime.get(p.name)!
    const d    = new Date(t)
    const hour = d.getHours() + d.getMinutes() / 60
    return {
      name:         p.name,
      worldX:       toWorldX(d, dr),
      worldZ:       toWorldZ(hour),
      peakHeight:   Math.max(0.5, (Math.log(1 + p.promptCount) / Math.log(2000)) * MAX_H),
      sigma,
      promptCount:  p.promptCount,
      sessionCount: p.sessionCount,
      age:          1 - (t - minT) / tRange,
    }
  })
}

// ── Height field ──────────────────────────────────────────────────────────────

function buildHeightField(mounts: Mountain[]): Float32Array {
  const f = new Float32Array(HFIELD * HFIELD)
  for (const m of mounts) {
    const cx = ((m.worldX/WW)+0.5)*(HFIELD-1), cz = ((m.worldZ/WD)+0.5)*(HFIELD-1)
    const sg = (m.sigma/WW)*(HFIELD-1), R = Math.ceil(sg*3.5)
    for (let z = Math.max(0,Math.floor(cz-R)); z<=Math.min(HFIELD-1,Math.ceil(cz+R)); z++)
      for (let x = Math.max(0,Math.floor(cx-R)); x<=Math.min(HFIELD-1,Math.ceil(cx+R)); x++) {
        const dx=x-cx, dz=z-cz
        f[z*HFIELD+x] += m.peakHeight * Math.exp(-(dx*dx+dz*dz)/(2*sg*sg))
      }
  }
  return f
}

function buildDisplayGeo(f: Float32Array): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(WW, WD, DISP-1, DISP-1)
  g.rotateX(-Math.PI/2)
  const pos = g.attributes.position.array as Float32Array
  for (let row=0; row<DISP; row++) for (let col=0; col<DISP; col++) {
    const fr=(row/(DISP-1))*(HFIELD-1), fc=(col/(DISP-1))*(HFIELD-1)
    const r0=Math.min(Math.floor(fr),HFIELD-2), c0=Math.min(Math.floor(fc),HFIELD-2)
    const tr=fr-r0, tc=fc-c0
    const h = f[r0*HFIELD+c0]*(1-tr)*(1-tc) + f[(r0+1)*HFIELD+c0]*tr*(1-tc)
            + f[r0*HFIELD+c0+1]*(1-tr)*tc   + f[(r0+1)*HFIELD+c0+1]*tr*tc
    pos[(row*DISP+col)*3+1] = h
  }
  g.attributes.position.needsUpdate = true
  g.computeVertexNormals()
  return g
}

// ── Irregular / elliptical ring generator ────────────────────────────────────

/** Fast deterministic hash  n → [0,1) */
function fhash(n: number): number {
  const x = Math.sin(n * 127.1 + n * 0.3 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
function nameHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff
  return h
}

/**
 * Generate a single closed ring as a polyline (segs+1 points, last = first).
 * frac=0 → nearly circular, frac→1 → elliptical + terrain-like harmonics.
 */
function ringPoints(
  cx: number, h: number, cz: number,
  r: number, frac: number, seed: number, segs: number
): [number, number, number][] {
  const h0 = fhash(seed),      h1 = fhash(seed+1)
  const h2 = fhash(seed+2),    h3 = fhash(seed+3)
  const h4 = fhash(seed+4),    h5 = fhash(seed+5)

  // Ellipse: aspect ratio and rotation grow with frac
  const aspect  = 1 + frac * 0.65 * (h0 * 2 - 1)   // 0.35..1.65 at peak
  const axRot   = h1 * Math.PI
  const cosA    = Math.cos(axRot), sinA = Math.sin(axRot)
  const rx      = r * Math.max(0.55, aspect)
  const rz      = r / Math.max(0.55, aspect)

  // Harmonic terrain noise — amplitude grows with frac
  const amp   = frac * 0.22 * r
  const freq1 = 2 + Math.floor(h2 * 4)    // 2-5
  const freq2 = 4 + Math.floor(h3 * 5)    // 4-8
  const ph1   = h4 * Math.PI * 2
  const ph2   = h5 * Math.PI * 2

  const pts: [number, number, number][] = []
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2

    // Ellipse in rotated frame
    const ex = rx * Math.cos(a), ez = rz * Math.sin(a)
    let dx = ex * cosA - ez * sinA
    let dz = ex * sinA + ez * cosA

    // Radial noise: push outward along the local normal
    const nr   = Math.hypot(dx, dz) || 1
    const noise = amp * (
      Math.sin(freq1 * a + ph1) * 0.55 +
      Math.sin(freq2 * a + ph2) * 0.30 +
      Math.sin((freq1 + freq2) * a) * 0.15
    )
    dx += (dx / nr) * noise
    dz += (dz / nr) * noise

    pts.push([cx + dx, h, cz + dz])
  }
  return pts   // closed: pts[segs] === pts[0] (≈)
}

// ── Contour data for Line (continuous polyline + NaN breaks) ─────────────────

type V3 = [number, number, number]

function buildContourData(mounts: Mountain[]): { pts: V3[]; cols: V3[] } {
  const pts: V3[] = [], cols: V3[] = []

  for (const m of mounts) {
    const N    = Math.min(m.promptCount, MAX_RINGS)
    if (!N) continue
    const seed = nameHash(m.name)
    const bR   = THREE.MathUtils.lerp(0.67, 0.18, m.age)
    const bG   = THREE.MathUtils.lerp(1.00, 0.38, m.age)

    for (let s = 1; s <= N; s++) {
      const frac = s / (N + 1)
      const h    = frac * m.peakHeight
      const r    = m.sigma * Math.sqrt(-2 * Math.log(frac))
      if (!isFinite(r) || r < 0.08 || r > 20) continue

      const br = 0.28 + 0.72 * frac
      const cr = bR * br, cg = bG * br

      const segs = Math.max(24, Math.min(64, Math.round(r * 10)))
      const ring = ringPoints(m.worldX, h, m.worldZ, r, frac, seed * 100 + s, segs)

      for (const p of ring) { pts.push(p); cols.push([cr, cg, 0]) }
      // NaN separator breaks the polyline between rings
      pts.push([NaN, NaN, NaN]); cols.push([0, 0, 0])
    }
  }
  return { pts, cols }
}

// ── Grid geometry ─────────────────────────────────────────────────────────────

function buildGridGeo(dr: DateRange) {
  const xMin = toWorldX(dr.minDate, dr), xMax = toWorldX(dr.maxDate, dr)
  const zMin = toWorldZ(0),              zMax = toWorldZ(24)
  const dayStep  = MAX_DAYS <= 30 ? 3 : MAX_DAYS <= 60 ? 7 : 14
  const majorV: number[] = [], minorV: number[] = []

  for (let d = 0; d <= MAX_DAYS; d++) {
    const x = toWorldX(new Date(dr.minDate.getTime() + d * 86_400_000), dr)
    ;(d % dayStep === 0 ? majorV : minorV).push(x,0,zMin, x,0,zMax)
  }
  for (let h = 0; h <= 24; h++) {
    const z = toWorldZ(h)
    ;(h % 3 === 0 ? majorV : minorV).push(xMin,0,z, xMax,0,z)
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
      <lineSegments geometry={minor}><lineBasicMaterial color={0x091509} /></lineSegments>
      <lineSegments geometry={major}><lineBasicMaterial color={0x122812} /></lineSegments>
    </>
  )
}

/** Prominent coordinate axes drawn on the floor plane */
function CoordinateAxes({ dr }: { dr: DateRange }) {
  const xMin = toWorldX(dr.minDate, dr), xMax = toWorldX(dr.maxDate, dr)
  const zMin = toWorldZ(0),              zMax = toWorldZ(24)
  const OFF  = 2.0   // offset from grid edge

  // X axis line (date) — runs along the front (z = zMax + OFF)
  const xLine: V3[] = [[xMin, 0, zMax+OFF], [xMax + OFF, 0, zMax+OFF]]
  // Z axis line (hour) — runs along the left  (x = xMin - OFF)
  const zLine: V3[] = [[xMin-OFF, 0, zMax], [xMin-OFF, 0, zMin - OFF]]

  // Date tick marks
  const dayStep = MAX_DAYS <= 30 ? 3 : MAX_DAYS <= 60 ? 7 : 14
  const xTicks: V3[] = []
  for (let d = 0; d <= MAX_DAYS; d += dayStep) {
    const x = toWorldX(new Date(dr.minDate.getTime() + d * 86_400_000), dr)
    xTicks.push([x, 0, zMax+OFF-0.4], [x, 0, zMax+OFF+0.4])
  }

  // Hour tick marks
  const zTicks: V3[] = []
  for (let h = 0; h <= 24; h += 3) {
    const z = toWorldZ(h)
    zTicks.push([xMin-OFF-0.4, 0, z], [xMin-OFF+0.4, 0, z])
  }

  return (
    <>
      <Line points={xLine} color="#2a6a2a" lineWidth={1.8} />
      <Line points={zLine} color="#2a6a2a" lineWidth={1.8} />
      <Line points={xTicks} color="#235523" lineWidth={1.2} segments />
      <Line points={zTicks} color="#235523" lineWidth={1.2} segments />
      {/* Arrow heads (simple extra lines) */}
      <Line points={[[xMax+OFF-0.6,0,zMax+OFF+0.4],[xMax+OFF,0,zMax+OFF],[xMax+OFF-0.6,0,zMax+OFF-0.4]] as V3[]} color="#44aa44" lineWidth={1.5} />
      <Line points={[[xMin-OFF-0.4,0,zMin-OFF+0.6],[xMin-OFF,0,zMin-OFF],[xMin-OFF+0.4,0,zMin-OFF+0.6]] as V3[]} color="#44aa44" lineWidth={1.5} />
    </>
  )
}

/** Date labels along the front axis */
function DateLabels({ dr }: { dr: DateRange }) {
  const dayStep = MAX_DAYS <= 30 ? 3 : MAX_DAYS <= 60 ? 7 : 14
  const zFront  = toWorldZ(24) + 3.8
  const items: JSX.Element[] = []
  for (let d = 0; d <= MAX_DAYS; d += dayStep) {
    const date = new Date(dr.minDate.getTime() + d * 86_400_000)
    const x    = toWorldX(date, dr)
    items.push(
      <Billboard key={d} position={[x, 0, zFront]}>
        <Text fontSize={0.34} color="#3a7a3a" anchorX="center" anchorY="top">
          {`${date.getMonth()+1}/${date.getDate()}`}
        </Text>
      </Billboard>
    )
  }
  // Axis title
  items.push(
    <Billboard key="xt" position={[0, 0, zFront + 1.5]}>
      <Text fontSize={0.42} color="#55aa55" anchorX="center">DATE →</Text>
    </Billboard>
  )
  return <>{items}</>
}

/** Hour labels along the left axis */
function HourLabels({ dr }: { dr: DateRange }) {
  const xLeft = toWorldX(dr.minDate, dr) - 3.8
  const items: JSX.Element[] = []
  for (let h = 0; h <= 21; h += 3) {
    items.push(
      <Billboard key={h} position={[xLeft, 0, toWorldZ(h)]}>
        <Text fontSize={0.34} color={h===0||h===12 ? '#55aa55' : '#2e6a2e'} anchorX="right" anchorY="middle">
          {`${String(h).padStart(2,'0')}h`}
        </Text>
      </Billboard>
    )
  }
  items.push(
    <Billboard key="zt" position={[xLeft - 1.5, 0, 0]}>
      <Text fontSize={0.42} color="#55aa55" anchorX="center">HOUR</Text>
    </Billboard>
  )
  return <>{items}</>
}

/** Mountain body: solid fill + wireframe */
function TerrainBody({ field }: { field: Float32Array }) {
  const geo = useMemo(() => buildDisplayGeo(field), [field])
  return (
    <>
      <mesh geometry={geo}><meshBasicMaterial color={0x050c05} /></mesh>
      <mesh geometry={geo}><meshBasicMaterial color={0x1c3e1c} wireframe /></mesh>
    </>
  )
}

/** Dashed contour lines with marching-ant animation */
function ContourLines({ mounts }: { mounts: Mountain[] }) {
  const groupRef = useRef<THREE.Group>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineRef  = useRef<any>(null)

  const { pts, cols } = useMemo(() => buildContourData(mounts), [mounts])

  useFrame(({ clock }) => {
    // Marching-ant dash animation
    if (lineRef.current?.material) {
      lineRef.current.material.dashOffset = -(clock.getElapsedTime() * 0.12)
    }
    // Gentle group breathing
    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(clock.getElapsedTime() * 0.38) * 0.06
    }
  })

  if (!pts.length) return null

  return (
    <group ref={groupRef}>
      <Line
        ref={lineRef}
        points={pts}
        vertexColors={cols}
        lineWidth={2.2}
        dashed
        dashSize={0.55}
        gapSize={0.28}
      />
    </group>
  )
}

/** Billboard labels above each peak */
function PeakLabels({ mounts }: { mounts: Mountain[] }) {
  const top = [...mounts].sort((a,b)=>b.peakHeight-a.peakHeight).slice(0, 14)
  return (
    <>
      {top.map((m, i) => (
        <Billboard key={i} position={[m.worldX, m.peakHeight+1.15, m.worldZ]}>
          <Text
            fontSize={0.40}
            color={m.age<0.3 ? '#aaff00' : m.age<0.65 ? '#66bb33' : '#3d6626'}
            anchorX="center" anchorY="bottom"
            outlineWidth={0.07} outlineColor="#000"
            maxWidth={8}
          >
            {m.name.toUpperCase().slice(0, 20)}
          </Text>
          <Text
            fontSize={0.26}
            color={m.age<0.5 ? '#557730' : '#2e4420'}
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

  const dr          = useMemo(() => getDateRange(sessions),                    [sessions])
  const mounts      = useMemo(() => buildMountains(projects, sessions, dr),    [projects, sessions, dr])
  const heightField = useMemo(() => buildHeightField(mounts),                  [mounts])

  const totalRings = mounts.reduce((s, m) => s + Math.min(m.promptCount, MAX_RINGS), 0)

  return (
    <div className="w-full h-full bg-cyber-dark relative">
      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>
      <div className="absolute top-2 right-2 z-10 font-mono text-cyber-text-dim" style={{fontSize:'10px'}}>
        {mounts.length} PEAKS · {totalRings} RINGS · {MAX_DAYS}d WINDOW
      </div>
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-3 font-mono"
           style={{fontSize:'9px', color:'#3a6a3a'}}>
        <span><span style={{color:'#aaff00'}}>X</span>=date created</span>
        <span><span style={{color:'#aaff00'}}>Z</span>=hour of day</span>
        <span><span style={{color:'#aaff00'}}>↑</span>=prompts</span>
        <span><span style={{color:'#aaff00'}}>○─</span>1 ring=1 turn</span>
      </div>

      <Canvas camera={{position:[0,20,28], fov:46}} style={{background:'#020702'}} gl={{antialias:true}}>
        <DateTimeGrid   dr={dr} />
        <CoordinateAxes dr={dr} />
        <DateLabels     dr={dr} />
        <HourLabels     dr={dr} />
        <TerrainBody    field={heightField} />
        <ContourLines   mounts={mounts} />
        <PeakLabels     mounts={mounts} />

        <OrbitControls enablePan enableZoom enableRotate
          maxPolarAngle={Math.PI/2 - 0.03} minDistance={6} maxDistance={90}
          target={[0, 1, 0]} />
        <fog attach="fog" args={['#020702', 52, 110]} />
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
