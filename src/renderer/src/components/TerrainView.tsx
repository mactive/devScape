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

import { useRef, useMemo, useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import type { DataSource, Session, ProjectStats } from '../types'

// ── World constants ───────────────────────────────────────────────────────────

const WW = 52      // world width  (X = date)
const WD = 28      // world depth  (Z = hour 0-24)
const X_USE = 0.82
const Z_USE = 0.84
const MAX_H = 8
const MAX_MT = 28
const MAX_RINGS = 10   // contour rings per mountain
const R_CAP_K = 1.55 // max ring radius = R_CAP_K × sigma

const SOURCE_COLORS: Record<DataSource, string> = {
  claude: '#5EAB07',
  trae: '#4cada5',
  'trae-cn': '#acdf2c'
}

function sourceLabel(source: DataSource): string {
  if (source === 'claude') return 'Claude'
  if (source === 'trae') return 'Trae'
  return 'TraeCN'
}

function projectSelectionKey(source: DataSource, projectPath: string): string {
  return `${source}:${projectPath}`
}

// ── Date / hour math ──────────────────────────────────────────────────────────

interface DateRange { minDate: Date; maxDate: Date; daySpan: number }

function getDateRange(sessions: Session[]): DateRange {
  if (!sessions.length) {
    const now = new Date(), ago = new Date(now.getTime() - 60 * 86_400_000)
    return { minDate: ago, maxDate: now, daySpan: 60 }
  }
  const ts = sessions.map(s => new Date(s.startTime).getTime())
  const minT = Math.min(...ts)
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

// ── Mountain repulsion — push overlapping peaks apart ────────────────────────

function repelMountains(mounts: { worldX: number; worldZ: number; sigma: number }[]): void {
  const xBound = WW * X_USE * 0.5
  const zBound = WD * Z_USE * 0.5
  // visual outer ring radius ≈ 0.68 * sigma * 2.15 ≈ 1.46σ
  // so two mountains need dist >= 1.46*(σi+σj) → use 1.5 as multiplier
  for (let iter = 0; iter < 120; iter++) {
    let moved = false
    for (let i = 0; i < mounts.length; i++) {
      for (let j = i + 1; j < mounts.length; j++) {
        const dx = mounts[j].worldX - mounts[i].worldX
        const dz = mounts[j].worldZ - mounts[i].worldZ
        const dist = Math.sqrt(dx * dx + dz * dz) || 1e-6
        const minDist = (mounts[i].sigma + mounts[j].sigma) * 1.5
        if (dist < minDist) {
          const push = (minDist - dist) / dist * 0.55
          mounts[i].worldX = Math.max(-xBound, Math.min(xBound, mounts[i].worldX - dx * push))
          mounts[i].worldZ = Math.max(-zBound, Math.min(zBound, mounts[i].worldZ - dz * push))
          mounts[j].worldX = Math.max(-xBound, Math.min(xBound, mounts[j].worldX + dx * push))
          mounts[j].worldZ = Math.max(-zBound, Math.min(zBound, mounts[j].worldZ + dz * push))
          moved = true
        }
      }
    }
    if (!moved) break
  }
}

// ── Mountain type + layout ────────────────────────────────────────────────────

interface Mountain {
  name: string; worldX: number; worldZ: number
  path: string
  peakHeight: number; sigma: number
  promptCount: number; sessionCount: number; age: number
  toolDensity: number   // tool calls per prompt
  bashRatio: number     // bash / total tool calls, 0..1
  source: DataSource
}

function projectNameKey(source: DataSource, path: string): string {
  return `${source}:${path}`
}

function buildMountains(
  projects: ProjectStats[], sessions: Session[], dr: DateRange, activeProjectKey?: string | null
): Mountain[] {
  if (!projects.length) return []
  const sourcePriority: Record<DataSource, number> = { claude: 0, 'trae-cn': 1, trae: 2 }

  const firstTime = new Map<string, number>()
  for (const s of sessions) {
    const t = new Date(s.startTime).getTime()
    const k = projectNameKey(s.source, s.projectPath)
    if ((firstTime.get(k) ?? Infinity) > t)
      firstTime.set(k, t)
  }

  const sorted = [...projects]
    .filter(p => firstTime.has(projectNameKey(p.source, p.path)))
    .sort(
      (a, b) => {
        const bySource = sourcePriority[a.source] - sourcePriority[b.source]
        if (bySource !== 0) return bySource
        return (
          firstTime.get(projectNameKey(a.source, a.path))! -
          firstTime.get(projectNameKey(b.source, b.path))!
        )
      }
    )
  const visible = sorted.slice(0, MAX_MT)

  if (activeProjectKey) {
    const idx = sorted.findIndex((p) => projectSelectionKey(p.source, p.path) === activeProjectKey)
    const activeProject = idx >= 0 ? sorted[idx] : null
    const alreadyVisible = activeProject
      ? visible.some((p) => projectSelectionKey(p.source, p.path) === activeProjectKey)
      : false
    if (activeProject && !alreadyVisible) {
      if (visible.length < MAX_MT) visible.push(activeProject)
      else visible[visible.length - 1] = activeProject
    }
  }

  if (!visible.length) return []

  const ts = visible.map((p) => firstTime.get(projectNameKey(p.source, p.path))!)
  const minT = Math.min(...ts)
  const maxT = Math.max(...ts)
  const tRange = Math.max(maxT - minT, 1)

  // Sigma base adapts to date range span
  const dayWidth = (WW * X_USE) / dr.daySpan
  const sigmaBase = Math.max(1.6, Math.min(3.2, dayWidth * 3.8))

  // Normalize prompt counts for sigma scaling
  const maxPc = Math.max(...visible.map(p => p.promptCount), 1)

  // Calculate raw heights to find the average
  const rawHeights = visible.map(p => Math.max(0.6, (Math.log(1 + p.promptCount) / Math.log(1500)) * MAX_H))
  const avgHeight = rawHeights.reduce((a, b) => a + b, 0) / (rawHeights.length || 1)

  const result = visible.map((p, index) => {
    const t = firstTime.get(projectNameKey(p.source, p.path))!
    const d = new Date(t)
    const hour = d.getHours() + d.getMinutes() / 60
    const norm = p.promptCount / maxPc

    const sigma = sigmaBase * (1 - 0.55 * norm)

    let peakHeight = rawHeights[index]
    if (peakHeight < avgHeight) {
      peakHeight = avgHeight
    }

    return {
      name: p.name,
      path: p.path,
      worldX: toWorldX(d, dr),
      worldZ: toWorldZ(hour),
      peakHeight,
      sigma,
      promptCount: p.promptCount,
      sessionCount: p.sessionCount,
      age: 1 - (t - minT) / tRange,
      toolDensity: p.toolDensity ?? 0,
      bashRatio: p.bashRatio ?? 0,
      source: p.source
    }
  })

  repelMountains(result)
  return result
}


type V3 = [number, number, number]
type RenderMode = 'contour' | 'simulated'

const SIM_MAX_TREE_INSTANCES = 900

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
    const ang = fhash(s * 11 + i * 7) * Math.PI * 2
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
    const ang = fhash(s * 23 + i * 11) * Math.PI * 2
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
  const f = 1.4 / sigma           // spatial frequency (wider sigma → lower freq)
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
  }
  return 0
}

function sampleMountainHeight(
  lx: number,
  lz: number,
  m: Mountain,
  bumps: Bump[],
  seed: number
): number {
  const peak = Math.max(evalHW(0, 0, bumps, m.sigma, seed), 0.001)
  const raw = Math.max(0, evalHW(lx, lz, bumps, m.sigma, seed))
  const natural = (raw / peak) * m.peakHeight
  const radiusNorm = Math.min(1, Math.sqrt(lx * lx + lz * lz) / (m.sigma * R_CAP_K * 1.4))
  const eroded = natural * (1 - Math.pow(radiusNorm, 2.6) * 0.28)
  const terraceStep = Math.max(0.34, m.peakHeight / (7 + Math.min(6, Math.floor(m.sessionCount / 2))))
  const terraceMix = THREE.MathUtils.clamp(0.18 + m.sessionCount * 0.018, 0.18, 0.46)
  const terraced = Math.floor(eroded / terraceStep) * terraceStep +
    Math.pow((eroded % terraceStep) / terraceStep, 0.58) * terraceStep
  return Math.max(0, THREE.MathUtils.lerp(eroded, terraced, terraceMix))
}

function terrainColorAt(height: number, radial: number, slope: number, m: Mountain): THREE.Color {
  const h = THREE.MathUtils.clamp(height / Math.max(m.peakHeight, 0.001), 0, 1)
  const sourceTint = new THREE.Color(SOURCE_COLORS[m.source] || SOURCE_COLORS.claude)
  const valleyMoss = new THREE.Color('#3d6a42')
  const grass = new THREE.Color('#6f913f')
  const upland = new THREE.Color('#93aa55')
  const sunlitRidge = new THREE.Color('#d6d37a')
  const forestShadow = new THREE.Color('#17382f')
  const coolShadow = new THREE.Color('#0f2a2e')
  const stone = new THREE.Color('#777552')

  let color = valleyMoss.clone().lerp(grass, Math.min(1, h * 1.45))
  if (h > 0.28) color.lerp(upland, (h - 0.28) / 0.54)
  if (h > 0.58) color.lerp(sunlitRidge, (h - 0.58) / 0.42)
  if (radial > 0.72 && h < 0.36) color.lerp(coolShadow, (radial - 0.72) / 0.28)
  if (slope > 0.2) color.lerp(stone, THREE.MathUtils.clamp((slope - 0.2) * 1.75 + m.bashRatio * 0.32, 0, 0.42))
  if (h > 0.1 && h < 0.58 && slope < 0.24) color.lerp(forestShadow, THREE.MathUtils.clamp(0.12 + m.toolDensity * 0.08, 0.12, 0.34))
  color.lerp(sourceTint, 0.025)
  return color
}

interface MountainSampler {
  m: Mountain
  seed: number
  bumps: Bump[]
  radius: number
  influenceRadius: number
}

interface RangeLink {
  a: MountainSampler
  b: MountainSampler
  width: number
  strength: number
}

interface RangeSample {
  height: number
  dominant: MountainSampler | null
}

interface TreeInstance {
  position: V3
  scale: number
  color: string
}

interface PondInstance {
  position: V3
  scale: [number, number, number]
  rotationY: number
}

interface RangeModel {
  geometry: THREE.BufferGeometry
  contourSegments: V3[]
  pathLines: V3[][]
  trees: TreeInstance[]
  ponds: PondInstance[]
}

function makeMountainSamplers(mounts: Mountain[]): MountainSampler[] {
  return mounts.map((m) => ({
    m,
    seed: nameHash(m.name),
    bumps: makeBumps(m.name, m.peakHeight, m.sigma),
    radius: m.sigma * R_CAP_K * 1.45,
    influenceRadius: m.sigma * R_CAP_K * 3.35
  }))
}

function buildRangeLinks(samplers: MountainSampler[]): RangeLink[] {
  const links: RangeLink[] = []
  const seen = new Set<string>()
  for (let i = 0; i < samplers.length; i++) {
    const a = samplers[i]
    const neighbors = samplers
      .map((b, j) => ({
        b,
        j,
        dist: Math.hypot(b.m.worldX - a.m.worldX, b.m.worldZ - a.m.worldZ)
      }))
      .filter((item) => item.j !== i)
      .sort((u, v) => u.dist - v.dist)
      .slice(0, 2)

    for (const { b, j, dist } of neighbors) {
      if (dist > 22) continue
      const key = [Math.min(i, j), Math.max(i, j)].join(':')
      if (seen.has(key)) continue
      seen.add(key)
      links.push({
        a,
        b,
        width: Math.max(1.25, Math.min(a.m.sigma, b.m.sigma) * 1.18 + dist * 0.05),
        strength: 0.18 + fhash(a.seed + b.seed) * 0.12
      })
    }
  }
  return links
}

function sampleSamplerHeight(x: number, z: number, sampler: MountainSampler): number {
  const lx = x - sampler.m.worldX
  const lz = z - sampler.m.worldZ
  const dist = Math.hypot(lx, lz)
  const fade = 1 - THREE.MathUtils.smoothstep(dist, sampler.influenceRadius * 0.68, sampler.influenceRadius)
  if (fade <= 0) return 0
  return sampleMountainHeight(lx * 0.78, lz * 0.78, sampler.m, sampler.bumps, sampler.seed) * fade
}

function sampleLinkHeight(x: number, z: number, link: RangeLink): number {
  const ax = link.a.m.worldX, az = link.a.m.worldZ
  const bx = link.b.m.worldX, bz = link.b.m.worldZ
  const dx = bx - ax, dz = bz - az
  const lenSq = dx * dx + dz * dz || 1
  const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / lenSq, 0, 1)
  const px = ax + dx * t, pz = az + dz * t
  const sideDist = Math.hypot(x - px, z - pz)
  const along = Math.pow(Math.sin(t * Math.PI), 0.55)
  const saddle = Math.min(link.a.m.peakHeight, link.b.m.peakHeight) * link.strength +
    Math.max(link.a.m.peakHeight, link.b.m.peakHeight) * 0.055
  return saddle * along * Math.exp(-(sideDist * sideDist) / (2 * link.width * link.width))
}

function sampleLowlandHeight(x: number, z: number): number {
  return 0.10 +
    Math.sin(x * 0.19 + z * 0.11) * 0.045 +
    Math.sin(x * 0.43 - z * 0.28) * 0.028 +
    Math.sin(x * 0.08 + z * 0.39) * 0.022
}

function sampleRangeHeight(
  x: number,
  z: number,
  samplers: MountainSampler[],
  links: RangeLink[]
): RangeSample {
  let top = 0
  let second = 0
  let dominant: MountainSampler | null = null

  for (const sampler of samplers) {
    const h = sampleSamplerHeight(x, z, sampler)
    if (h > top) {
      second = top
      top = h
      dominant = sampler
    } else if (h > second) {
      second = h
    }
  }

  let bridge = 0
  for (const link of links) bridge = Math.max(bridge, sampleLinkHeight(x, z, link))

  const relief = Math.max(top + second * 0.2, bridge) * 0.72
  let height = relief + sampleLowlandHeight(x, z)

  const terraceStep = 0.34
  const frac = (height % terraceStep) / terraceStep
  const terraced = Math.floor(height / terraceStep) * terraceStep + Math.pow(frac, 0.5) * terraceStep
  height = THREE.MathUtils.lerp(height, terraced, relief > 0.32 ? 0.26 : 0.1)

  return { height: Math.max(0, height), dominant: relief > 0.18 ? dominant : null }
}

function rangeTerrainColorAt(height: number, maxHeight: number, slope: number, dominant: MountainSampler | null): THREE.Color {
  if (dominant) return terrainColorAt(height, 0.48, slope, dominant.m)

  const h = THREE.MathUtils.clamp(height / Math.max(maxHeight, 0.001), 0, 1)
  const low = new THREE.Color('#365d42')
  const grass = new THREE.Color('#668a43')
  const warm = new THREE.Color('#9baa55')
  const color = low.lerp(grass, 0.38 + h * 0.82).lerp(warm, Math.max(0, h - 0.28) * 0.55)
  if (slope > 0.18) color.lerp(new THREE.Color('#25483d'), Math.min(0.22, slope * 0.08))
  return color
}

function buildRangeContourSegments(
  heights: number[],
  xs: number[],
  zs: number[],
  nx: number,
  nz: number,
  maxHeight: number
): V3[] {
  const segments: V3[] = []
  const levels: number[] = []
  for (let h = 0.34; h < maxHeight * 0.92; h += 0.34) levels.push(h)

  const interp = (x1: number, z1: number, h1: number, x2: number, z2: number, h2: number, level: number): V3 => {
    const t = THREE.MathUtils.clamp((level - h1) / (h2 - h1 || 1), 0, 1)
    return [THREE.MathUtils.lerp(x1, x2, t), level + 0.035, THREE.MathUtils.lerp(z1, z2, t)]
  }

  for (const level of levels) {
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * (nx + 1) + ix
        const b = a + 1
        const c = a + (nx + 1)
        const d = c + 1
        const pts: V3[] = []
        const x0 = xs[ix], x1 = xs[ix + 1]
        const z0 = zs[iz], z1 = zs[iz + 1]
        const ha = heights[a], hb = heights[b], hc = heights[c], hd = heights[d]

        if ((ha < level) !== (hb < level)) pts.push(interp(x0, z0, ha, x1, z0, hb, level))
        if ((hb < level) !== (hd < level)) pts.push(interp(x1, z0, hb, x1, z1, hd, level))
        if ((hd < level) !== (hc < level)) pts.push(interp(x1, z1, hd, x0, z1, hc, level))
        if ((hc < level) !== (ha < level)) pts.push(interp(x0, z1, hc, x0, z0, ha, level))

        if (pts.length === 2) segments.push(pts[0], pts[1])
        else if (pts.length === 4) segments.push(pts[0], pts[1], pts[2], pts[3])
      }
    }
  }
  return segments
}

function buildRangePathLines(samplers: MountainSampler[], links: RangeLink[]): V3[][] {
  return links.slice(0, 18).map((link, i) => {
    const pts: V3[] = []
    const seed = link.a.seed + link.b.seed + i * 97
    const ax = link.a.m.worldX, az = link.a.m.worldZ
    const bx = link.b.m.worldX, bz = link.b.m.worldZ
    const dx = bx - ax, dz = bz - az
    const len = Math.hypot(dx, dz) || 1
    const nx = -dz / len, nz = dx / len

    for (let s = 0; s <= 40; s++) {
      const t = s / 40
      const wave = Math.sin(t * Math.PI * 2.2 + fhash(seed) * Math.PI) * len * 0.035
      const x = THREE.MathUtils.lerp(ax, bx, t) + nx * wave
      const z = THREE.MathUtils.lerp(az, bz, t) + nz * wave
      const h = sampleRangeHeight(x, z, samplers, links).height
      pts.push([x, h + 0.05, z])
    }
    return pts
  })
}

function buildRangeTrees(samplers: MountainSampler[], links: RangeLink[], maxHeight: number): TreeInstance[] {
  const trees: TreeInstance[] = []
  const seed = samplers.reduce((acc, sampler) => acc + sampler.seed, 17)
  const tries = 2200
  const xMin = GRID_X_MIN - 3.2, xMax = GRID_X_MAX + 3.2
  const zMin = GRID_Z_MIN - 3.0, zMax = GRID_Z_MAX + 3.0

  for (let i = 0; i < tries && trees.length < SIM_MAX_TREE_INSTANCES; i++) {
    const x = THREE.MathUtils.lerp(xMin, xMax, fhash(seed + i * 11))
    const z = THREE.MathUtils.lerp(zMin, zMax, fhash(seed + i * 13))
    const sample = sampleRangeHeight(x, z, samplers, links)
    const hn = sample.height / Math.max(maxHeight, 0.001)
    if (sample.height < 0.16 || hn > 0.42) continue
    if (fhash(seed + i * 17) < hn * 0.7) continue

    const scale = 0.055 + fhash(seed + i * 19) * 0.125
    const color = fhash(seed + i * 23) > 0.78
      ? '#7f9650'
      : fhash(seed + i * 29) > 0.48 ? '#315f45' : '#173f34'
    trees.push({
      position: [x, sample.height + scale * 0.35, z],
      scale,
      color
    })
  }
  return trees
}

function buildRangePonds(samplers: MountainSampler[], links: RangeLink[], maxHeight: number): PondInstance[] {
  const ponds: PondInstance[] = []
  const seed = samplers.reduce((acc, sampler) => acc ^ sampler.seed, 911)
  const xMin = GRID_X_MIN - 3.4, xMax = GRID_X_MAX + 3.4
  const zMin = GRID_Z_MIN - 3.2, zMax = GRID_Z_MAX + 3.2

  for (let i = 0; i < 1100 && ponds.length < 30; i++) {
    const x = THREE.MathUtils.lerp(xMin, xMax, fhash(seed + i * 31))
    const z = THREE.MathUtils.lerp(zMin, zMax, fhash(seed + i * 37))
    const sample = sampleRangeHeight(x, z, samplers, links)
    const hn = sample.height / Math.max(maxHeight, 0.001)
    if (sample.height < 0.04 || hn > 0.34) continue

    const h1 = sampleRangeHeight(x + 0.22, z, samplers, links).height
    const h2 = sampleRangeHeight(x, z + 0.22, samplers, links).height
    if (Math.abs(h1 - sample.height) + Math.abs(h2 - sample.height) > 0.24) continue

    const sx = 0.34 + fhash(seed + i * 41) * 0.95
    const sz = 0.2 + fhash(seed + i * 43) * 0.55
    ponds.push({
      position: [x, sample.height + 0.028, z],
      scale: [sx, sz, 1],
      rotationY: fhash(seed + i * 47) * Math.PI
    })
  }
  return ponds
}

function buildRangeModel(mounts: Mountain[]): RangeModel {
  const samplers = makeMountainSamplers(mounts)
  const links = buildRangeLinks(samplers)
  const nx = 152
  const nz = 88
  const xMin = GRID_X_MIN - 3.4, xMax = GRID_X_MAX + 3.4
  const zMin = GRID_Z_MIN - 3.2, zMax = GRID_Z_MAX + 3.2
  const xs = Array.from({ length: nx + 1 }, (_, i) => THREE.MathUtils.lerp(xMin, xMax, i / nx))
  const zs = Array.from({ length: nz + 1 }, (_, i) => THREE.MathUtils.lerp(zMin, zMax, i / nz))
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const heights: number[] = []
  const dominants: (MountainSampler | null)[] = []

  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const sample = sampleRangeHeight(xs[ix], zs[iz], samplers, links)
      heights.push(sample.height)
      dominants.push(sample.dominant)
      positions.push(xs[ix], sample.height, zs[iz])
    }
  }

  const maxHeight = Math.max(...heights, 1)

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * (nx + 1) + ix
      const b = a + 1
      const c = a + (nx + 1)
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const idx = iz * (nx + 1) + ix
      const left = heights[iz * (nx + 1) + Math.max(0, ix - 1)]
      const right = heights[iz * (nx + 1) + Math.min(nx, ix + 1)]
      const front = heights[Math.max(0, iz - 1) * (nx + 1) + ix]
      const back = heights[Math.min(nz, iz + 1) * (nx + 1) + ix]
      const slope = Math.abs(right - left) / ((xMax - xMin) / nx) + Math.abs(back - front) / ((zMax - zMin) / nz)
      const color = rangeTerrainColorAt(heights[idx], maxHeight, slope, dominants[idx])
      colors.push(color.r, color.g, color.b)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setIndex(indices)
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  geometry.computeVertexNormals()

  return {
    geometry,
    contourSegments: buildRangeContourSegments(heights, xs, zs, nx, nz, maxHeight),
    pathLines: buildRangePathLines(samplers, links),
    trees: buildRangeTrees(samplers, links, maxHeight),
    ponds: buildRangePonds(samplers, links, maxHeight)
  }
}

// ── Contour ring builder ──────────────────────────────────────────────────────

interface ContourRing { pts: V3[]; color: string; mountainKey: string }

function buildContourRings(mounts: Mountain[]): ContourRing[] {
  const rings: ContourRing[] = []
  for (const m of mounts) {
    const seed = nameHash(m.name)
    const bumps = makeBumps(m.name, m.peakHeight, m.sigma)
    const peak = evalHW(0, 0, bumps, m.sigma, seed)
    const maxR = m.sigma * R_CAP_K * 2.0

    for (let s = 1; s <= MAX_RINGS; s++) {
      const frac = s / (MAX_RINGS + 1)
      const targetH = frac * peak
      const worldH = frac * m.peakHeight

      const SEGS = 90
      const pts: V3[] = []
      let skip = false

      for (let i = 0; i <= SEGS; i++) {
        const angle = (i / SEGS) * Math.PI * 2
        const rRaw = findRadius(angle, targetH, bumps, m.sigma, seed, maxR)
        const r = rRaw * 0.68   // shrink visual radius 60%, height stays the same
        if (r < 0.02) { skip = true; break }
        pts.push([m.worldX + r * Math.cos(angle), worldH, m.worldZ + r * Math.sin(angle)])
      }
      if (skip) continue

      const bright = 0.30 + 0.70 * frac
      const base = new THREE.Color(SOURCE_COLORS[m.source] || SOURCE_COLORS.claude)
      rings.push({
        pts,
        color: `rgb(${Math.round(base.r * 255 * bright)},${Math.round(base.g * 255 * bright)},${Math.round(base.b * 255 * bright)})`,
        mountainKey: projectSelectionKey(m.source, m.path)
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
          <meshBasicMaterial color={0x7FB77E} />
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
function ContourLines({
  mounts,
  activeMountainKey,
  mode = 'contour'
}: {
  mounts: Mountain[]
  activeMountainKey: string | null
  mode?: RenderMode
}) {
  const groupRef = useRef<THREE.Group>(null)
  const lineRefs = useRef<any[]>([])
  const rings = useMemo(() => {
    lineRefs.current = []
    return buildContourRings(mounts)
  }, [mounts])

  const offsets = useRef<number[]>([])

  useFrame((state, delta) => {
    if (offsets.current.length !== rings.length) {
      offsets.current = new Array(rings.length).fill(0)
    }

    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i]
      const isActive = ring.mountainKey === activeMountainKey
      const speed = isActive ? 0.36 : 0.18
      offsets.current[i] -= delta * speed

      const line = lineRefs.current[i]
      if (line?.material) {
        line.material.dashOffset = offsets.current[i]
      }
    }

    if (groupRef.current) {
      const t = state.clock.getElapsedTime()
      groupRef.current.position.y = Math.sin(t * 0.36) * 0.05
    }
  })

  if (!rings.length) return null
  return (
    <group ref={groupRef}>
      {rings.map((ring, i) => (
        <Line
          key={i}
          ref={(el: any) => { lineRefs.current[i] = el }}
          points={ring.pts}
          color={mode === 'simulated' ? '#d7ead4' : ring.color}
          lineWidth={mode === 'simulated' ? 0.65 : 1.0}
          dashed={mode === 'contour'}
          dashSize={mode === 'contour' ? 0.2 : 1}
          gapSize={mode === 'contour' ? 0.2 : 0}
          transparent
          opacity={mode === 'simulated' ? 0.42 : 1}
        />
      ))}
    </group>
  )
}

// ── Tool Density Particles ────────────────────────────────────────────────────
// Floating particles above peak — count scales with toolDensity.
// Each mountain emits up to 32 particles drifting upward in a slow spiral.

function ToolParticles({ m, isActive }: { m: Mountain, isActive?: boolean }) {
  const COUNT = Math.max(1, Math.min(160, Math.round(m.toolDensity * 20)))
  const seed = nameHash(m.name)

  // Static per-particle offsets (angle, radius, phase, speed, color)
  const params = useMemo(() => {
    const bumps = makeBumps(m.name, m.peakHeight, m.sigma)
    const peak = evalHW(0, 0, bumps, m.sigma, seed)
    const maxR = m.sigma * R_CAP_K * 2.0
    const frac = MAX_RINGS / (MAX_RINGS + 1)
    const targetH = frac * peak
    const worldH = frac * m.peakHeight

    const colors = ['#B4D3D9', '#E8DBB3', '#FFFDEB']

    return Array.from({ length: COUNT }, (_, i) => {
      const angle = fhash(seed * 7 + i * 13) * Math.PI * 2
      const maxTopR = findRadius(angle, targetH, bumps, m.sigma, seed, maxR) * 0.68
      const radius = maxTopR * Math.sqrt(fhash(seed * 11 + i * 17))

      return {
        angle,
        radius,
        phase: fhash(seed * 19 + i * 23) * Math.PI * 2,
        speed: 0.22 + fhash(seed * 29 + i * 31) * 0.38,
        yBase: worldH,
        yRange: 0.4 + fhash(seed * 43 + i * 47) * 1.0,
        color: colors[Math.floor(fhash(seed * 53 + i * 59) * colors.length)]
      }
    })
  }, [m.peakHeight, COUNT, seed, m.name, m.sigma])

  const meshRefs = useRef<(THREE.Mesh | null)[]>([])
  const accumulatedTime = useRef(0)

  useFrame((_, delta) => {
    // Speed up 2x if isActive
    const timeMultiplier = isActive ? 2.0 : 1.0
    accumulatedTime.current += delta * timeMultiplier
    const effectiveT = accumulatedTime.current

    for (let i = 0; i < COUNT; i++) {
      const mesh = meshRefs.current[i]
      if (!mesh) continue
      const p = params[i]

      const currentAngle = p.angle + effectiveT * p.speed * 0.2
      const life = (effectiveT * p.speed * 0.5 + p.phase) % 1.0
      const currentR = p.radius + life * 0.2

      mesh.position.set(
        m.worldX + Math.cos(currentAngle) * currentR,
        p.yBase + life * p.yRange,
        m.worldZ + Math.sin(currentAngle) * currentR
      )

      // Pulse scale to simulate appearing and fading out like an eruption
      const pulse = Math.sin(life * Math.PI) * 1.2
      mesh.scale.setScalar(Math.max(0.001, pulse))
    }
  })

  return (
    <>
      {params.map((p, i) => (
        <mesh key={i} ref={el => { meshRefs.current[i] = el }}>
          <sphereGeometry args={[0.045, 5, 5]} />
          <meshBasicMaterial color={p.color} />
        </mesh>
      ))}
    </>
  )
}

function EffectLayer({ mounts, activeMountainKey }: { mounts: Mountain[]; activeMountainKey: string | null }) {
  return (
    <>
      {mounts.map((m, i) => (
        <ToolParticles
          key={i}
          m={m}
          isActive={projectSelectionKey(m.source, m.path) === activeMountainKey}
        />
      ))}
    </>
  )
}

function SimulatedRangeSurface({ model }: { model: RangeModel }) {
  return (
    <mesh geometry={model.geometry} castShadow receiveShadow>
      <meshStandardMaterial
        vertexColors
        roughness={0.94}
        metalness={0.02}
        flatShading={false}
      />
    </mesh>
  )
}

function ProceduralForest({ trees }: { trees: TreeInstance[] }) {
  const canopyRef = useRef<THREE.InstancedMesh>(null)
  const trunkRef = useRef<THREE.InstancedMesh>(null)

  useEffect(() => {
    const canopy = canopyRef.current
    const trunk = trunkRef.current
    if (!canopy || !trunk) return

    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const color = new THREE.Color()

    trees.forEach((tree, i) => {
      position.set(tree.position[0], tree.position[1], tree.position[2])
      scale.set(tree.scale * 1.25, tree.scale * 0.9, tree.scale * 1.25)
      matrix.compose(position, quaternion, scale)
      canopy.setMatrixAt(i, matrix)
      canopy.setColorAt(i, color.set(tree.color))

      position.set(tree.position[0], tree.position[1] - tree.scale * 0.55, tree.position[2])
      scale.set(tree.scale * 0.16, tree.scale * 0.85, tree.scale * 0.16)
      matrix.compose(position, quaternion, scale)
      trunk.setMatrixAt(i, matrix)
    })

    canopy.instanceMatrix.needsUpdate = true
    trunk.instanceMatrix.needsUpdate = true
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true
  }, [trees])

  if (!trees.length) return null
  return (
    <>
      <instancedMesh ref={trunkRef} args={[undefined, undefined, trees.length]} castShadow receiveShadow>
        <cylinderGeometry args={[1, 1, 1, 5]} />
        <meshStandardMaterial color="#5b4528" roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={canopyRef} args={[undefined, undefined, trees.length]} castShadow receiveShadow>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#ffffff" roughness={0.88} />
      </instancedMesh>
    </>
  )
}

function SimulatedRangeContours({ points }: { points: V3[] }) {
  if (!points.length) return null
  return (
    <Line
      points={points}
      color="#d7ead4"
      lineWidth={0.56}
      segments
      transparent
      opacity={0.34}
    />
  )
}

function SimulatedPonds({ ponds }: { ponds: PondInstance[] }) {
  return (
    <>
      {ponds.map((pond, i) => (
        <mesh
          key={i}
          position={pond.position}
          rotation={[-Math.PI / 2, 0, pond.rotationY]}
          scale={pond.scale}
          receiveShadow
        >
          <circleGeometry args={[1, 32]} />
          <meshStandardMaterial
            color="#68b9b2"
            emissive="#0d3f47"
            emissiveIntensity={0.24}
            roughness={0.22}
            metalness={0.04}
            transparent
            opacity={0.82}
          />
        </mesh>
      ))}
    </>
  )
}

function SimulatedFeatureLines({ lines }: { lines: V3[][] }) {
  return (
    <>
      {lines.map((pts, i) => (
        <Line key={i} points={pts} color="#c9bf73" lineWidth={1.05} transparent opacity={0.58} />
      ))}
    </>
  )
}

function SimulatedTerrain({ mounts }: { mounts: Mountain[] }) {
  const model = useMemo(() => buildRangeModel(mounts), [mounts])

  return (
    <>
      <ambientLight intensity={0.58} />
      <hemisphereLight args={['#d1dea1', '#071a22', 1.35]} />
      <directionalLight
        position={[-18, 24, 16]}
        intensity={2.15}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.035, 0]} receiveShadow>
        <planeGeometry args={[WW * X_USE * 1.18, WD * Z_USE * 1.22, 1, 1]} />
        <meshStandardMaterial color="#365d42" roughness={0.96} metalness={0.02} />
      </mesh>
      <SimulatedRangeSurface model={model} />
      <SimulatedRangeContours points={model.contourSegments} />
      <SimulatedPonds ponds={model.ponds} />
      <ProceduralForest trees={model.trees} />
      <SimulatedFeatureLines lines={model.pathLines} />
    </>
  )
}

function CameraRig({ activeMountain }: { activeMountain?: Mountain }) {
  const { camera, controls } = useThree()
  const isAnimating = useRef(false)
  const targetPos = useRef(new THREE.Vector3())
  const targetLookAt = useRef(new THREE.Vector3())

  useEffect(() => {
    isAnimating.current = true
    if (activeMountain) {
      targetLookAt.current.set(activeMountain.worldX, activeMountain.peakHeight * 0.4, activeMountain.worldZ)
      targetPos.current.set(activeMountain.worldX + 2, Math.max(activeMountain.peakHeight + 6, 12), activeMountain.worldZ + 12)
    } else {
      targetLookAt.current.set(0, 1, 0)
      targetPos.current.set(2, 22, 30)
    }
  }, [activeMountain])

  useEffect(() => {
    if (!controls) return undefined
    const onStart = () => { isAnimating.current = false }
    controls.addEventListener('start', onStart)
    return () => { controls.removeEventListener('start', onStart) }
  }, [controls])

  useFrame(() => {
    if (controls) {
      const ctrl = controls as any
      if (isAnimating.current) {
        let moved = false
        if (ctrl.target) {
          const dTarget = ctrl.target.distanceTo(targetLookAt.current)
          if (dTarget > 0.05) {
            ctrl.target.lerp(targetLookAt.current, 0.05)
            moved = true
          } else {
            ctrl.target.copy(targetLookAt.current)
          }
        }

        const dPos = camera.position.distanceTo(targetPos.current)
        if (dPos > 0.05) {
          camera.position.lerp(targetPos.current, 0.03)
          moved = true
        } else {
          camera.position.copy(targetPos.current)
        }

        if (!moved) {
          isAnimating.current = false
        }
      }
      ctrl.update()
    }
  })
  return null
}

/** HUD-style peak labels: vertical stem line + bracket box */
function PeakLabels({ mounts }: { mounts: Mountain[] }) {
  const top = [...mounts].sort((a, b) => b.peakHeight - a.peakHeight)
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
  const { sessions, projects, selectedProjectKey, selectedSession, sourceFilter } = useStore()
  const [renderMode, setRenderMode] = useState<RenderMode>(() => {
    const saved = window.localStorage.getItem('devscape-render-mode')
    return saved === 'simulated' ? 'simulated' : 'contour'
  })

  useEffect(() => {
    window.localStorage.setItem('devscape-render-mode', renderMode)
  }, [renderMode])

  const visibleSessions = useMemo(
    () => sourceFilter === 'ALL' ? sessions : sessions.filter((s) => s.source === sourceFilter),
    [sessions, sourceFilter]
  )
  const visibleProjects = useMemo(
    () => sourceFilter === 'ALL' ? projects : projects.filter((p) => p.source === sourceFilter),
    [projects, sourceFilter]
  )

  const dr = useMemo(() => getDateRange(visibleSessions), [visibleSessions])
  const activeProjectKey =
    selectedProjectKey ||
    (selectedSession ? projectSelectionKey(selectedSession.source, selectedSession.projectPath) : null)
  const mounts = useMemo(
    () => buildMountains(visibleProjects, visibleSessions, dr, activeProjectKey),
    [visibleProjects, visibleSessions, dr, activeProjectKey]
  )
  const activeMountain = useMemo(
    () => mounts.find((m) => projectSelectionKey(m.source, m.path) === activeProjectKey),
    [mounts, activeProjectKey]
  )

  const firstDate = dr.minDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
  const lastDate = dr.maxDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })

  return (
    <div className="w-full h-full bg-cyber-dark relative">
      <div className="absolute top-2 left-2 z-10 cyber-header text-cyber-text-dim py-1">
        ACTIVITY TERRAIN
      </div>
      <div
        className="absolute top-12 left-2 z-10 flex border border-cyber-border bg-cyber-dark/90"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => setRenderMode('contour')}
          className={`px-3 py-1 text-xs font-mono transition-colors ${renderMode === 'contour' ? 'bg-cyber-border text-neon-green' : 'text-cyber-text-dim hover:text-neon-green'}`}
        >
          CONTOUR
        </button>
        <button
          onClick={() => setRenderMode('simulated')}
          className={`px-3 py-1 text-xs font-mono border-l border-cyber-border transition-colors ${renderMode === 'simulated' ? 'bg-cyber-border text-neon-green' : 'text-cyber-text-dim hover:text-neon-green'}`}
        >
          SIM
        </button>
      </div>
      {activeProjectKey && (
        <button
          onClick={() => {
            useStore.getState().selectProject(null)
            useStore.getState().selectSession(null)
          }}
          className="absolute top-24 left-2 z-10 px-3 py-1 bg-cyber-dark border border-cyber-green text-cyber-green text-xs font-mono rounded hover:bg-cyber-green/20 transition-colors cursor-pointer"
        >
          ← GLOBAL VIEW
        </button>
      )}
      <div className="absolute top-2 right-2 z-10 font-mono text-cyber-text-dim" style={{ fontSize: '10px' }}>
        TOKEN USAGE · {firstDate} – {lastDate} · {dr.daySpan} DAYS
      </div>
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-3 font-mono"
        style={{ fontSize: '9px', color: '#3a6a3a' }}>
        <span><span style={{ color: '#aaff00' }}>X</span>=date</span>
        <span><span style={{ color: '#aaff00' }}>Z</span>=hour</span>
        <span><span style={{ color: '#aaff00' }}>↑</span>=prompts</span>
        <span><span style={{ color: SOURCE_COLORS.claude }}>●</span>={sourceLabel('claude')}</span>
        <span><span style={{ color: SOURCE_COLORS.trae }}>●</span>={sourceLabel('trae')}</span>
        <span><span style={{ color: SOURCE_COLORS['trae-cn'] }}>●</span>={sourceLabel('trae-cn')}</span>
        <span><span style={{ color: '#88ddff' }}>●</span>=tool density</span>
        <span><span style={{ color: '#ff6414' }}>○</span>=bash ratio</span>
      </div>

      <Canvas
        shadows={renderMode === 'simulated'}
        camera={{ position: [2, 22, 30], fov: 44 }}
        style={{ background: renderMode === 'simulated' ? '#061923' : '#020702' }}
        gl={{ antialias: true }}
      >
        <CameraRig activeMountain={activeMountain} />
        {renderMode === 'simulated' ? (
          <SimulatedTerrain mounts={mounts} />
        ) : null}
        {renderMode === 'contour' && <DateTimeGrid />}
        {renderMode === 'contour' && <GridDots />}
        <CoordinateAxes dr={dr} />
        <DateLabels dr={dr} />
        <HourLabels dr={dr} />
        {renderMode === 'contour' && (
          <ContourLines mounts={mounts} activeMountainKey={activeProjectKey} mode={renderMode} />
        )}
        <EffectLayer mounts={mounts} activeMountainKey={activeProjectKey} />
        <PeakLabels mounts={mounts} />

        <OrbitControls enablePan enableZoom enableRotate makeDefault
          maxPolarAngle={Math.PI / 2 - 0.03} minDistance={6} maxDistance={100}
          target={[0, 1, 0]} />
        <fog attach="fog" args={[renderMode === 'simulated' ? '#061923' : '#020702', 48, 118]} />
      </Canvas>

      {visibleSessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-cyber-text-dim">
            <p className="text-sm font-mono">NO SESSION DATA</p>
            <p className="text-xs mt-1" style={{ fontSize: '10px' }}>
              {sourceFilter === 'ALL'
                ? 'Ensure Claude/Trae local history exists'
                : `No data for ${sourceLabel(sourceFilter)}`
              }
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
