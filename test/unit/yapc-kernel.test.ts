/**
 * yapc's WebAssembly kernel (`analysis/wasm/yapc.c`) against the TypeScript it
 * is a second home for, bit for bit.
 *
 * The kernel does to a window everything `run/peaks.ts`'s TypeScript does —
 * pieces, pooling, both convolutions and the flat mask, the concave mask, and the
 * concave regions with their summits and scores — and is held here to give the
 * same regions to the last bit, on every kind of window a bigWig makes: pieces
 * one base wide and wider than the kernel, explicit zeros longer than the kernel
 * (flat, concave, and a megabase of ties in a real file), missing stretches,
 * seams between windows, a sequence shorter than the kernel, and a track without
 * the sequence. `analysis-peaks-golden.test.ts` holds the whole run, through the
 * kernel, to yapc's and IDR's own output.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { TrackJobContext } from '@/analysis/job'
import { scanSequence } from '@/analysis/run/peaks'
import type { AnalysisFraming } from '@/analysis/types'
import { YAPC_SOURCE_SHA256 } from '@/analysis/wasm/yapc.generated'
import {
  concaveMask,
  convolutionReach,
  convolveSame,
  pooledRuns,
  runsOver,
  yapcKernel,
  type ConcaveRegions,
  type YapcKernel,
} from '@/analysis/yapc'
import { KernelScan, yapcKernelAvailable } from '@/analysis/yapcKernel'
import type { Region, TrackSampleSet } from '@/annotations/types'

const FRAMING: AnalysisFraming = {
  uri: 'tracks',
  rows: [0, 0],
  cols: [0, 0],
  binsize: 0,
  binsPerCell: 1,
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
  label: 'loaded tracks, no contact map',
}

/** One value per base for each sequence a fake track has; `NaN` where it has no interval. */
type Track = Record<string, Float32Array>

/** A seeded uniform draw in `[0, 1)`. */
function uniform(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 16807) % 2147483647
    return state / 2147483647
  }
}

/**
 * A coverage track of every kind of stretch: bumps on a noisy floor, values
 * changing every base, runs of explicit zeros longer than the kernel, and
 * stretches with no interval at all.
 */
function track(length: number, seed: number): Float32Array {
  const random = uniform(seed)
  const values = new Float32Array(length)
  let at = 0
  while (at < length) {
    const kind = random()
    const width = Math.min(length - at, 1 + Math.floor(random() * (kind < 0.1 ? 3_000 : 800)))
    for (let i = at; i < at + width; i++) {
      if (kind < 0.05) values[i] = 0
      else if (kind < 0.08) values[i] = Number.NaN
      else if (kind < 0.5) values[i] = Math.round(2 + random() * 3 + 200 * Math.exp(-(((i - at - width / 2) / 60) ** 2)))
      else values[i] = Math.fround(random() * 10)
    }
    at += width
  }
  return values
}

/** A track's answer to one `sample`, as the annotations worker gives it at base resolution. */
function answer(source: Track, regions: Region[], basesPerPixel: number): TrackSampleSet {
  const out: TrackSampleSet['regions'] = []
  for (const region of regions) {
    const values = source[region.contig]
    if (values === undefined) continue
    const starts: number[] = []
    const ends: number[] = []
    const kept: number[] = []
    for (let i = region.start; i < Math.min(region.end, values.length); i++) {
      if (Number.isNaN(values[i])) continue
      const last = kept.length - 1
      if (last >= 0 && ends[last] === i && kept[last] === values[i]) ends[last] = i + 1
      else {
        starts.push(i)
        ends.push(i + 1)
        kept.push(values[i])
      }
    }
    out.push({
      contig: region.contig,
      start: region.start,
      end: region.end,
      starts: Int32Array.from(starts),
      ends: Int32Array.from(ends),
      values: Float32Array.from(kept),
      min: null,
      max: null,
      variant: null,
      summary: false,
    })
  }
  return { basesPerPixel, regions: out, extent: null }
}

function jobOver(tracks: Record<string, Track>, lengths: Record<string, number>): TrackJobContext {
  return {
    params: {},
    framing: FRAMING,
    inputs: { contigLengths: lengths },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: () => {},
    sample: async (entry, regions, basesPerPixel) => answer(tracks[entry], regions, basesPerPixel),
    lengthOf: (contig) => lengths[contig],
  }
}

/** Both engines' regions for one sequence, and how many bases each reported. */
async function bothWays(
  tracks: Record<string, Track>,
  entries: string[],
  contig: string,
  length: number,
  kernel: YapcKernel,
): Promise<{ kernel: ConcaveRegions; js: ConcaveRegions; absent: boolean[] }> {
  // The kernel opens for this case, so the first scan below is the kernel's and
  // not the TypeScript standing in for it.
  expect(KernelScan.open(kernel, contig, length, entries.length, 1 << 18)).not.toBeNull()
  const job = jobOver(tracks, { [contig]: length })
  const fast = await scanSequence(job, entries, contig, length, kernel, () => {})
  const slow = await scanSequence(job, entries, contig, length, kernel, () => {}, 'js')
  if (typeof fast === 'string' || typeof slow === 'string') throw new Error('a track refused to be read')
  expect(fast.absent).toEqual(slow.absent)
  return { kernel: fast.regions, js: slow.regions, absent: fast.absent }
}

/** Every region, summit, flag and score the same; scores by `Object.is`, so −0 is not 0. */
function expectSame(a: ConcaveRegions, b: ConcaveRegions, label: string): void {
  expect(a.contig, label).toBe(b.contig)
  expect(Array.from(a.starts), `${label}: starts`).toEqual(Array.from(b.starts))
  expect(Array.from(a.ends), `${label}: ends`).toEqual(Array.from(b.ends))
  expect(Array.from(a.modes), `${label}: summits`).toEqual(Array.from(b.modes))
  expect(Array.from(a.flat), `${label}: flat`).toEqual(Array.from(b.flat))
  expect(a.scores.length, `${label}: tracks`).toBe(b.scores.length)
  a.scores.forEach((column, t) => {
    const other = b.scores[t]
    for (let i = 0; i < column.length; i++) {
      if (!Object.is(column[i], other[i])) expect(column[i], `${label}: score ${t} of region ${i}`).toBe(other[i])
    }
  })
}

describe('yapc’s WebAssembly kernel', () => {
  it('runs here, and was built from this source', () => {
    expect(yapcKernelAvailable()).toBe(true)
    // A `yapc.c` that was not rebuilt fails here rather than shipping the old
    // kernel under the new source.
    const source = readFileSync(new URL('../../src/analysis/wasm/yapc.c', import.meta.url))
    expect(createHash('sha256').update(source).digest('hex'), 'run `npm run wasm:yapc`').toBe(YAPC_SOURCE_SHA256)
  })

  it('pools, convolves and masks each window as the TypeScript does, value for value', () => {
    // Regions are decided by float32 comparisons and scored by each track's own
    // curvature, so a pooled track off in its last place could pass a test of
    // regions alone: the window's arrays themselves are compared here.
    const length = 600_000
    const window = 1 << 18
    const kernel = yapcKernel(150, 3)
    const values = [track(length, 41), track(length, 42)]
    const scan = KernelScan.open(kernel, 's', length, 2, window)
    expect(scan).not.toBeNull()
    const { left, right } = convolutionReach(kernel, length)
    let compared = 0
    for (let from = 0; from < length; from += window) {
      const to = Math.min(length, from + window)
      const lo = Math.max(0, from - left)
      const hi = Math.min(length, to + right)
      const answers = values.map((v) => answer({ s: v }, [{ contig: 's', start: lo, end: hi }], 1).regions[0])
      scan?.window(from, to, lo, hi, answers)
      const got = scan!.lastWindow(to - from)
      const runs = answers.map((a) => runsOver(a.starts, a.ends, a.values, lo, hi))
      const flat = new Uint8Array(to - from)
      const pooled = convolveSame(pooledRuns(runs, lo, hi), kernel, length, from, to, flat)
      const mask = concaveMask(pooled)
      const own = runs.map((r) => convolveSame(r, kernel, length, from, to, undefined, mask))
      const label = `window at ${from}`
      for (let k = 0; k < pooled.length; k++) {
        if (!Object.is(got.pooled[k], pooled[k])) expect(got.pooled[k], `${label}: pooled at ${from + k}`).toBe(pooled[k])
        for (let t = 0; t < 2; t++) {
          if (!Object.is(got.own[t][k], own[t][k])) expect(got.own[t][k], `${label}: track ${t} at ${from + k}`).toBe(own[t][k])
        }
      }
      expect(Array.from(got.flat), `${label}: flat`).toEqual(Array.from(flat))
      compared += pooled.length
    }
    expect(compared).toBe(length)
  })

  it('scans two tracks as the TypeScript does, across three windows and their seams', async () => {
    const length = 600_000
    const tracks = { a: { chr1: track(length, 3) }, b: { chr1: track(length, 4) } }
    const { kernel, js } = await bothWays(tracks, ['a', 'b'], 'chr1', length, yapcKernel(150, 3))
    expect(js.starts.length).toBeGreaterThan(500)
    expect(Array.from(js.flat).some((flag) => flag === 1)).toBe(true)
    expectSame(kernel, js, 'two tracks')
  })

  it('scans one track as the TypeScript does, its own curvature its score', async () => {
    const length = 400_000
    const tracks = { a: { chr1: track(length, 11) } }
    const { kernel, js } = await bothWays(tracks, ['a'], 'chr1', length, yapcKernel(150, 3))
    expect(js.starts.length).toBeGreaterThan(300)
    expectSame(kernel, js, 'one track')
  })

  it('reads a track without the sequence as zeros, and scores it −∞ there', async () => {
    const length = 300_000
    const tracks = { a: { chr1: track(length, 21) }, b: { chr2: track(1_000, 22) } }
    const { kernel, js, absent } = await bothWays(tracks, ['a', 'b'], 'chr1', length, yapcKernel(150, 3))
    expect(absent).toEqual([false, true])
    expect(Array.from(js.scores[1]).every((score) => score === Number.NEGATIVE_INFINITY)).toBe(true)
    expectSame(kernel, js, 'absent track')
  })

  it('scans with other kernels, and a sequence shorter than the kernel', async () => {
    const cases: Array<[YapcKernel, number, number]> = [
      [yapcKernel(5, 1), 300_000, 31],
      [yapcKernel(150, 0), 270_000, 32],
      [yapcKernel(150, 3), 300, 33],
      [yapcKernel(150, 3), 457, 34],
    ]
    for (const [kernel, length, seed] of cases) {
      const tracks = { a: { s: track(length, seed) }, b: { s: track(length, seed + 100) } }
      const label = `${kernel.values.length} taps, ${length} bases`
      const both = await bothWays(tracks, ['a', 'b'], 's', length, kernel)
      expectSame(both.kernel, both.js, `${label}, two tracks`)
      const one = await bothWays(tracks, ['a'], 's', length, kernel)
      expectSame(one.kernel, one.js, `${label}, one track`)
    }
  })

  it('reports nothing for a sequence with no rising edge, as yapc returns early', async () => {
    // A parabola falling to zero at the far end: the step up from the padding
    // before the first base curves down there, so a region opens at base 0, and
    // the rest is convex to the end, so it closes once and nothing opens after.
    const length = 5_000
    const values = Float32Array.from({ length }, (_, i) => Math.fround(((length - i) / 100) ** 2))
    const { kernel, js } = await bothWays({ a: { s: values } }, ['a'], 's', length, yapcKernel(150, 3))
    expect(js.starts.length).toBe(0)
    expectSame(kernel, js, 'no rising edge')
  })
})
