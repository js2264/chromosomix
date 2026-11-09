/**
 * yapc's kernels and IDR's, each against the definition it ports.
 *
 * `analysis-peaks-golden.test.ts` holds both ports to their upstreams' own
 * output on the demo data. What is here is the part a golden cannot isolate: the
 * edge rules each port inherits, stated one at a time on inputs small enough to
 * see, and the two properties the streaming depends on — that a run-wise
 * convolution is numpy's `'same'` convolution, alignment and `NaN` included, and
 * that a sequence scanned in windows gives exactly what it gives whole.
 */

import { describe, expect, it } from 'vitest'

import { erf, fminbound, globalIdr, idrRanks, pseudoValuePair, pseudoValues, scaledIdr } from '@/analysis/idr'
import { numpyMean, numpySum } from '@/analysis/stats'
import {
  CONCAVE_TOLERANCE,
  ConcaveScan,
  StrongestRegions,
  concaveMask,
  convolutionCentre,
  convolutionReach,
  convolveSame,
  descendingRanks,
  peakBounds,
  pooledRuns,
  runsOver,
  scaledThreshold,
  strongestRegions,
  yapcKernel,
  type ConcaveRegions,
  type Runs,
  type YapcKernel,
} from '@/analysis/yapc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `np.convolve(x, kernel, mode='same')`, spelled out the slow way — with, per
 * position, the sum of the terms' sizes, which is what a float64 sum of them is
 * accurate to.
 */
function numpySame(x: Float64Array, kernel: Float64Array): { values: Float64Array; sizes: Float64Array } {
  const n = x.length
  const taps = kernel.length
  // numpy centres `'same'` on the shorter of the two arguments.
  const centre = (Math.min(n, taps) - 1) >> 1
  const values = new Float64Array(n)
  const sizes = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let total = 0
    let size = 0
    for (let k = 0; k < taps; k++) {
      const j = i + centre - k
      if (j < 0 || j >= n) continue
      total += x[j] * kernel[k]
      size += Math.abs(x[j] * kernel[k])
    }
    values[i] = total
    sizes[i] = size
  }
  return { values, sizes }
}

/** One value per base, as the constant pieces a bigWig would store it in. */
function runsOf(x: Float64Array, from = 0, to = x.length): Runs {
  const starts: number[] = []
  const ends: number[] = []
  const values: number[] = []
  for (let i = from; i < to; i++) {
    const last = values.length - 1
    const same = last >= 0 && (values[last] === x[i] || (Number.isNaN(values[last]) && Number.isNaN(x[i])))
    if (same && ends[last] === i) ends[last] = i + 1
    else {
      starts.push(i)
      ends.push(i + 1)
      values.push(x[i])
    }
  }
  return {
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    values: Float64Array.from(values),
    length: starts.length,
  }
}

/** A deterministic signal: bumps of several widths on a low floor, with a hole. */
function signal(length: number, hole: [number, number] | null = [1_900, 2_050]): Float64Array {
  const x = new Float64Array(length)
  let seed = 12345
  const random = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < length; i++) {
    let value = 2 + Math.floor(random() * 3)
    for (const [at, height, sd] of [
      [600, 120, 60],
      [1_300, 60, 30],
      [1_420, 45, 30],
      [3_100, 200, 90],
    ]) {
      value += height * Math.exp(-((i - at) ** 2) / (2 * sd * sd))
    }
    // Stored as a bigWig stores it: float32, and in steps of a few bases.
    x[i] = Math.fround(Math.round(value))
  }
  if (hole !== null) for (let i = hole[0]; i < Math.min(length, hole[1]); i++) x[i] = Number.NaN
  return x
}

/**
 * Equal to within a few units in the last place of the *terms* — not of the
 * result, which near a change of sign is a small difference of large numbers and
 * has no relative accuracy to speak of in either implementation.
 */
function expectClose(
  actual: Float64Array,
  expected: { values: Float64Array; sizes: Float64Array },
  label: string,
): void {
  expect(actual.length, `${label}: length`).toBe(expected.values.length)
  for (let i = 0; i < expected.values.length; i++) {
    const a = actual[i]
    const b = expected.values[i]
    if (Number.isNaN(b) || Number.isNaN(a)) {
      expect(Number.isNaN(a), `${label}: a gap at ${i}`).toBe(Number.isNaN(b))
      continue
    }
    expect(Math.abs(a - b), `${label}: at ${i}`).toBeLessThanOrEqual(1e-13 * expected.sizes[i])
  }
}

/**
 * The convolution as it was summed before it went piece by piece: a position at a
 * time, its pieces left to right. `convolveSame` is held to this bit for bit.
 */
function positionAtATime(
  runs: Runs,
  kernel: YapcKernel,
  length: number,
  from: number,
  to: number,
  flat: Uint8Array,
): Float64Array {
  const taps = kernel.values.length
  const values = kernel.values
  const cumulative = kernel.cumulative
  const centre = convolutionCentre(kernel, length)
  const out = new Float64Array(Math.max(0, to - from))
  let first = 0
  for (let i = from; i < to; i++) {
    const reach = i + centre - (taps - 1)
    const low = Math.max(0, reach)
    const high = Math.min(length, i + centre + 1)
    while (first < runs.length && runs.ends[first] <= low) first++
    if (
      reach >= 0 &&
      i + centre + 1 <= length &&
      first < runs.length &&
      runs.starts[first] <= low &&
      runs.ends[first] >= high
    ) {
      flat[i - from] = 1
    }
    const anchor = i + centre + 1
    let total = 0
    for (let r = first; r < runs.length; r++) {
      const start = runs.starts[r]
      if (start >= high) break
      const value = runs.values[r]
      if (value !== value) {
        total = Number.NaN
        break
      }
      const s = start > low ? start : low
      const end = runs.ends[r]
      const e = end < high ? end : high
      total += e - s === 1 ? value * values[anchor - 1 - s] : value * (cumulative[anchor - s] - cumulative[anchor - e])
    }
    out[i - from] = total
  }
  return out
}

/** A seeded uniform draw in `[0, 1)`. */
function uniform(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 16807) % 2147483647
    return state / 2147483647
  }
}

/**
 * Pieces of every kind a bigWig has, over `[0, length)`: one base wide, a few,
 * longer than the kernel; zeros, float32 levels, and the odd missing stretch.
 */
function randomRuns(length: number, seed: number): Runs {
  const random = uniform(seed)
  const starts: number[] = []
  const ends: number[] = []
  const values: number[] = []
  for (let at = 0; at < length; ) {
    const kind = random()
    const width = kind < 0.3 ? 1 : kind < 0.8 ? 2 + Math.floor(random() * 30) : 1 + Math.floor(random() * 1_500)
    const end = Math.min(length, at + width)
    const draw = random()
    starts.push(at)
    ends.push(end)
    values.push(draw < 0.02 ? Number.NaN : draw < 0.2 ? 0 : Math.fround(random() * 50))
    at = end
  }
  return {
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    values: Float64Array.from(values),
    length: starts.length,
  }
}

/** The pieces of `runs` over `[from, to)`, cut at its two ends: what a window reads. */
function runsOverRange(runs: Runs, from: number, to: number): Runs {
  return runsOver(runs.starts, runs.ends, runs.values, from, to)
}

/** Bit for bit, `NaN` being `NaN`. */
function sameBits(a: number, b: number): boolean {
  return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))
}

/** Scan a sequence of pooled second derivatives, fed in windows of `window`. */
function scanned(d2: Float64Array, window: number) {
  const scan = new ConcaveScan('chr', d2.length, [false])
  for (let from = 0; from < d2.length; from += window) {
    const part = d2.subarray(from, Math.min(d2.length, from + window))
    scan.feed(from, part, [part])
  }
  return scan.finish()
}

function regionsOf(d2: number[]): Array<[number, number]> {
  const found = scanned(Float64Array.from(d2), 1_000)
  return Array.from(found.starts, (start, i) => [start, found.ends[i]])
}

// ---------------------------------------------------------------------------
// The convolution
// ---------------------------------------------------------------------------

describe('the run-wise convolution', () => {
  const kernels: Array<[string, YapcKernel]> = [
    ['yapc’s default, 456 taps', yapcKernel(150, 3)],
    ['an odd one, 13 taps', yapcKernel(5, 1)],
    ['the bare stencil', yapcKernel(150, 0)],
  ]

  for (const [name, kernel] of kernels) {
    it(`is numpy’s 'same' convolution, gaps and ends included — ${name}`, () => {
      const x = signal(4_000)
      const expected = numpySame(x, kernel.values)
      expectClose(convolveSame(runsOf(x), kernel, x.length, 0, x.length), expected, name)
    })
  }

  it('centres on the sequence where the sequence is shorter than the kernel', () => {
    // yapc writes the kernel's length of values into a shorter sequence and
    // pyBigWig keeps the first of them — numpy's own alignment for that case.
    const kernel = yapcKernel(150, 3)
    const x = signal(300, null)
    expectClose(convolveSame(runsOf(x), kernel, x.length, 0, x.length), numpySame(x, kernel.values), 'short')
  })

  it('computes a window exactly as the whole sequence does, given its halo', () => {
    const kernel = yapcKernel(150, 3)
    const x = signal(4_000)
    const whole = convolveSame(runsOf(x), kernel, x.length, 0, x.length)
    const { left, right } = convolutionReach(kernel, x.length)
    for (const [from, to] of [
      [0, 700],
      [1_234, 2_345],
      [3_500, 4_000],
    ]) {
      const lo = Math.max(0, from - left)
      const hi = Math.min(x.length, to + right)
      const part = convolveSame(runsOf(x, lo, hi), kernel, x.length, from, to)
      expect(Array.from(part)).toEqual(Array.from(whole.subarray(from, to)))
    }
  })

  it('gives a flat window what numpy gives it: zero for zeros, the kernel’s sum otherwise', () => {
    // The kernel's float64 sum is not zero, so constant coverage is very slightly
    // concave — which is why a flat stretch is a concave region in yapc.
    const kernel = yapcKernel(150, 3)
    const zeros = convolveSame(runsOf(new Float64Array(2_000)), kernel, 2_000, 1_000, 1_001)
    expect(zeros[0]).toBe(0)
    const threes = convolveSame(runsOf(new Float64Array(2_000).fill(3)), kernel, 2_000, 1_000, 1_001)
    expect(threes[0]).toBe(3 * kernel.cumulative[kernel.values.length])
    expect(threes[0]).toBeLessThan(0)
    expect(threes[0]).toBeGreaterThan(-1e-9)
    expect(threes[0] < CONCAVE_TOLERANCE).toBe(true)
  })

  it('adds each position’s terms in the order a position at a time did, bit for bit', () => {
    // Piece by piece, each position still receives one term per piece, left to
    // right, as the same products of the same differences — so not one value
    // moves in its last place: pieces inside the window and across either end
    // of it, one base wide or wider than the kernel, at both ends of the
    // sequence, and on a sequence shorter than the kernel.
    const cases: Array<[YapcKernel, number]> = [
      [yapcKernel(150, 3), 6_000],
      [yapcKernel(5, 1), 3_000],
      [yapcKernel(150, 0), 2_000],
      [yapcKernel(150, 3), 300],
    ]
    cases.forEach(([kernel, length], c) => {
      const runs = randomRuns(length, 101 + c)
      const { left, right } = convolutionReach(kernel, length)
      for (const [from, to] of [
        [0, length],
        [0, Math.min(length, 700)],
        [Math.floor(length / 3), Math.floor((2 * length) / 3)],
        [Math.max(0, length - 500), length],
      ]) {
        // What a window reads: its pieces cut at its ends, and abutting ones of
        // one value merged, as `runsOver` gives them to both.
        const window = runsOverRange(runs, Math.max(0, from - left), Math.min(length, to + right))
        const flatBefore = new Uint8Array(to - from)
        const expected = positionAtATime(window, kernel, length, from, to, flatBefore)
        const flat = new Uint8Array(to - from)
        const actual = convolveSame(window, kernel, length, from, to, flat)
        for (let k = 0; k < expected.length; k++) {
          if (!sameBits(actual[k], expected[k])) {
            expect(actual[k], `case ${c}, [${from}, ${to}), at ${from + k}`).toBe(expected[k])
          }
        }
        expect(Array.from(flat), `case ${c}, [${from}, ${to}), flat`).toEqual(Array.from(flatBefore))
        if (length > 2_000) expect(flat.includes(1), `case ${c}: some window is flat`).toBe(true)
      }
    })
  })

  it('computes only the positions asked for, each as it would be computed anyway', () => {
    const kernel = yapcKernel(150, 3)
    const runs = randomRuns(5_000, 7)
    const whole = convolveSame(runs, kernel, 5_000, 0, 5_000)
    const random = uniform(99)
    // Stretches of a few hundred, as concave regions are, and single positions.
    const only = new Uint8Array(5_000)
    for (let k = 0; k < only.length; ) {
      const width = random() < 0.3 ? 1 : Math.floor(random() * 400)
      only.fill(random() < 0.5 ? 1 : 0, k, Math.min(only.length, k + width))
      k += Math.max(1, width)
    }
    const some = convolveSame(runs, kernel, 5_000, 0, 5_000, undefined, only)
    for (let k = 0; k < only.length; k++) {
      if (only[k] === 1 ? !sameBits(some[k], whole[k]) : !Number.isNaN(some[k])) {
        expect(some[k], `at ${k}`).toBe(only[k] === 1 ? whole[k] : Number.NaN)
      }
    }
    // The pooled track's concave positions, as the scan asks for them.
    const mask = concaveMask(whole)
    expect(mask.reduce((a, b) => a + b, 0)).toBeGreaterThan(100)
    for (let k = 0; k < mask.length; k++) expect(mask[k]).toBe(Math.fround(whole[k]) < CONCAVE_TOLERANCE ? 1 : 0)
  })
})

describe('pooling tracks', () => {
  it('is the float32 of their mean, and missing wherever one of them is', () => {
    const a = runsOver([0, 5], [5, 10], [1, 2], 0, 12)
    const b = runsOver([0, 3], [3, 12], [0.1, 0.2], 0, 12)
    const pooled = pooledRuns([a, b], 0, 12)
    expect(Array.from(pooled.starts)).toEqual([0, 3, 5, 10])
    expect(Array.from(pooled.values)).toEqual([
      Math.fround((1 + 0.1) / 2),
      Math.fround((1 + 0.2) / 2),
      Math.fround((2 + 0.2) / 2),
      Number.NaN,
    ])
  })
})

// ---------------------------------------------------------------------------
// Concave regions
// ---------------------------------------------------------------------------

describe('concave regions', () => {
  it('finds the same regions, summits and scores however the sequence is cut', () => {
    const kernel = yapcKernel(150, 3)
    const x = signal(4_000)
    const d2 = convolveSame(runsOf(x), kernel, x.length, 0, x.length)
    const whole = scanned(d2, d2.length)
    expect(whole.starts.length).toBeGreaterThan(3)
    for (const window of [1, 97, 1_000]) {
      const cut = scanned(d2, window)
      expect(Array.from(cut.starts), `starts, window ${window}`).toEqual(Array.from(whole.starts))
      expect(Array.from(cut.ends), `ends, window ${window}`).toEqual(Array.from(whole.ends))
      expect(Array.from(cut.modes), `summits, window ${window}`).toEqual(Array.from(whole.modes))
      expect(Array.from(cut.scores[0]), `scores, window ${window}`).toEqual(Array.from(whole.scores[0]))
    }
  })

  it('puts a summit at each bump', () => {
    const kernel = yapcKernel(150, 3)
    const x = signal(4_000, null)
    const found = scanned(convolveSame(runsOf(x), kernel, x.length, 0, x.length), 4_000)
    const summits = Array.from(found.modes).filter((_, i) => found.scores[0][i] > 1_000)
    for (const bump of [600, 3_100]) {
      expect(summits.some((summit) => Math.abs(summit - bump) <= 3), `a summit near ${bump}`).toBe(true)
    }
  })

  it('closes a region at each falling edge and opens one at each rising edge', () => {
    expect(regionsOf([1, -1, 1, -1, -1, 1])).toEqual([
      [1, 2],
      [3, 5],
    ])
  })

  it('gives a region open at the first base a start of 0, once a rising edge exists', () => {
    expect(regionsOf([-1, -1, 1, 1, -1, -1, 1])).toEqual([
      [0, 2],
      [4, 6],
    ])
  })

  it('reports nothing for a sequence with no rising edge, as yapc returns early', () => {
    // Concave from the first base and never again: yapc's `if len(s) == 0`
    // returns before either end is patched, so even the region at 0 goes.
    expect(regionsOf([-1, -1, 1, 1])).toEqual([])
    expect(regionsOf([-1, -1, -1])).toEqual([])
  })

  it('runs a region with no falling edge to the end, where yapc raises', () => {
    expect(regionsOf([1, 1, -1, -1])).toEqual([[2, 4]])
  })

  it('never counts a gap as concave', () => {
    expect(regionsOf([Number.NaN, -1, -1, Number.NaN, -1])).toEqual([
      [1, 3],
      [4, 5],
    ])
  })

  it('takes the middle of a tie for the summit, and ties in float32', () => {
    // `nanargmax_median`: the positions equal to the maximum, and the one at
    // `len // 2` of them. The last two values differ in float64 and not once
    // rounded to float32, which is where yapc compares them.
    const found = scanned(Float64Array.from([1, -1, -2, -2, -2, -1, 1]), 10)
    expect(Array.from(found.modes)).toEqual([3])
    const tied = scanned(Float64Array.from([1, -1, -2, -2 - 1e-12, -1, 1]), 10)
    expect(Array.from(tied.modes)).toEqual([3])
  })

  it('marks a region flat where the signal is constant across a whole window, and no other', () => {
    // Zeros for three kilobases: yapc calls a concave region there, scored by
    // whatever the kernel's ringing leaves at its edges. The bumps are regions
    // too, and none of them is flat.
    const kernel = yapcKernel(150, 3)
    const x = signal(6_000, null)
    x.fill(0, 4_000, 5_800)
    const flat = new Uint8Array(x.length)
    const d2 = convolveSame(runsOf(x), kernel, x.length, 0, x.length, flat)
    const scan = new ConcaveScan('chr', x.length, [false])
    scan.feed(0, d2, [d2], flat)
    const found = scan.finish()
    const marked = Array.from(found.flat.entries()).filter(([, value]) => value === 1).map(([i]) => i)
    expect(marked).toHaveLength(1)
    const [i] = marked
    expect(found.starts[i]).toBeGreaterThan(4_000)
    expect(found.ends[i]).toBeLessThan(5_800)
    expect(found.scores[0][i]).toBeLessThan(1e-3)
    expect(found.scores[0].filter((_, k) => found.flat[k] === 0).some((score) => score > 1_000)).toBe(true)
  })

  it('scores a region by minus the mean of its second derivative, in numpy’s order', () => {
    const found = scanned(Float64Array.from([1, -0.5, -2, -1.5, 1]), 10)
    expect(found.scores[0][0]).toBe(-numpyMean([-0.5, -2, -1.5]))
  })
})

// ---------------------------------------------------------------------------
// From regions to peaks
// ---------------------------------------------------------------------------

describe('from regions to peaks', () => {
  it('ranks descending, ties sharing the mean of their ranks', () => {
    expect(Array.from(descendingRanks(Float64Array.from([3, 1, 3, 2])))).toEqual([1.5, 4, 1.5, 3])
  })

  it('keeps each region’s best rank across tracks, and hands IDR yapc’s order', () => {
    const contigs = ['II', 'I', 'I', 'II']
    const starts = Int32Array.from([50, 10, 90, 5])
    const ends = Int32Array.from([60, 20, 99, 9])
    // Region 2 is last on the first track and first on the second.
    const scores = [Float64Array.from([4, 3, 1, 2]), Float64Array.from([1, 2, 9, 3])]
    // Best ranks: 1, 2, 1, 2 — the cut at three keeps both firsts, then the
    // earlier of the two seconds by name and position ('I' before 'II').
    const kept = strongestRegions(contigs, starts, ends, scores, 3)
    expect(Array.from(kept)).toEqual([1, 2, 0])
  })

  it('keeps the same strongest, in the same order, holding only what can be among them', () => {
    // Scores drawn from a few dozen values, so ranks tie everywhere — at the cut
    // too — and a track absent from a sequence scores −∞ throughout it.
    for (const tracks of [1, 2]) {
      for (const [count, limit] of [
        [3_000, 100],
        [3_000, 1],
        [3_000, 2_999],
        [3_000, 3_000],
        [3_000, 5_000],
        [500, 37],
      ]) {
        const random = uniform(count + limit + tracks)
        const sequences = ['chr2', 'chr10', 'chr1', 'chrX'].map((contig, c) => {
          const n = Math.floor(count / 4)
          const regions: ConcaveRegions = {
            contig,
            starts: Int32Array.from({ length: n }, (_, i) => i * 300),
            ends: Int32Array.from({ length: n }, (_, i) => i * 300 + 75 + Math.floor(random() * 200)),
            modes: Int32Array.from({ length: n }, (_, i) => i * 300 + 10),
            scores: Array.from({ length: tracks }, (_, t) =>
              Float64Array.from({ length: n }, () =>
                t === 1 && c === 3 ? Number.NEGATIVE_INFINITY : Math.floor(random() * 40) / 4 - 1,
              ),
            ),
            flat: Uint8Array.from({ length: n }, () => (random() < 0.05 ? 1 : 0)),
          }
          return regions
        })
        // Everything, as the cut was made before.
        const all = {
          contig: sequences.flatMap((s) => Array.from(s.starts, () => s.contig)),
          starts: Int32Array.from(sequences.flatMap((s) => Array.from(s.starts))),
          ends: Int32Array.from(sequences.flatMap((s) => Array.from(s.ends))),
          scores: Array.from({ length: tracks }, (_, t) =>
            Float64Array.from(sequences.flatMap((s) => Array.from(s.scores[t]))),
          ),
        }
        const expected = strongestRegions(all.contig, all.starts, all.ends, all.scores, limit)
        const streaming = new StrongestRegions(tracks, limit, { below: tracks === 1 })
        for (const s of sequences) for (let i = 0; i < s.starts.length; i++) streaming.add(s, i)
        const held = streaming.finish()
        const label = `${tracks} track(s), ${count} regions, limit ${limit}`
        expect(held.exact, label).toBe(true)
        // Where the cut is well above the weakest, most of them were let go.
        if (limit <= count / 10) expect(held.starts.length, label).toBeLessThan(count / 2)
        const key = (contig: string, start: number): string => `${contig}:${start}`
        expect(
          Array.from(held.tested, (i) => key(held.contig[i], held.starts[i])),
          label,
        ).toEqual(Array.from(expected, (i) => key(all.contig[i], all.starts[i])))
        expect(Array.from(held.tested, (i) => held.scores[0][i]), label).toEqual(
          Array.from(expected, (i) => all.scores[0][i]),
        )
        if (tracks === 1) {
          // What the one-track figure draws below the cut: every candidate never
          // tested, positive and not flat, whether let go or held to the end.
          const flat = Uint8Array.from(sequences.flatMap((s) => Array.from(s.flat)))
          const tested = new Set(Array.from(expected))
          const want = all.scores[0].filter((v, i) => !tested.has(i) && v > 0 && flat[i] === 0)
          const inHeld = new Set(Array.from(held.tested))
          const got = [
            ...held.scores[0].filter((v, i) => !inHeld.has(i) && v > 0 && held.flat[i] === 0),
            ...held.below,
          ]
          expect(Float64Array.from(got).sort(), label).toEqual(want.sort())
        }
      }
    }
  })

  it('says when a NaN score leaves no cut but over everything, and holds everything when asked', () => {
    const regions = (scores: number[]): ConcaveRegions => ({
      contig: 'chr1',
      starts: Int32Array.from(scores, (_, i) => i * 100),
      ends: Int32Array.from(scores, (_, i) => i * 100 + 80),
      modes: Int32Array.from(scores, (_, i) => i * 100 + 40),
      scores: [Float64Array.from(scores)],
      flat: new Uint8Array(scores.length),
    })
    const many = regions(Array.from({ length: 5_000 }, (_, i) => (i * 7919) % 1_000))
    const late = regions([Number.NaN, 3, 2])
    const pruned = new StrongestRegions(1, 10)
    for (let i = 0; i < many.starts.length; i++) pruned.add(many, i)
    for (let i = 0; i < late.starts.length; i++) pruned.add(late, i)
    expect(pruned.finish().exact).toBe(false)
    const whole = new StrongestRegions(1, 10, { prune: false })
    for (let i = 0; i < many.starts.length; i++) whole.add(many, i)
    for (let i = 0; i < late.starts.length; i++) whole.add(late, i)
    const held = whole.finish()
    expect(held.exact).toBe(true)
    expect(held.starts.length).toBe(5_003)
  })

  it('bounds a peak by its region, or by a half-width about its summit, cut at the ends', () => {
    expect(peakBounds(100, 300, 180, 0, 1_000)).toEqual([100, 300])
    expect(peakBounds(100, 300, 180, 50, 1_000)).toEqual([130, 231])
    expect(peakBounds(0, 40, 10, 50, 1_000)).toEqual([0, 61])
    expect(peakBounds(960, 1_000, 990, 50, 1_000)).toEqual([940, 1_000])
  })

  it('writes a threshold as yapc does, one place short at 0.001', () => {
    expect(scaledThreshold(0.001)).toBe(2.9999999999999996)
    expect(scaledIdr(0.001)).toBe(3)
    expect(scaledIdr(0.001) >= scaledThreshold(0.001)).toBe(true)
    expect(scaledIdr(1e-9)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// The pieces of numpy, libm and SciPy the ports lean on
// ---------------------------------------------------------------------------

describe('what the ports borrow', () => {
  it('sums pairwise, as numpy does, where adding left to right gives another number', () => {
    // A 10¹⁶ absorbs a run of ones added one at a time, and not in blocks.
    const values = [1e16, ...new Array<number>(300).fill(1), -1e16, ...new Array<number>(13).fill(0.1)]
    expect(numpySum(values)).toBe(292.0)
    expect(numpyMean(values)).toBe(0.926984126984127)
  })

  it('computes erf to within one unit in the last place of glibc’s', () => {
    // From `math.erf` in the golden's own environment, one value per branch of
    // fdlibm's five.
    const cases: Array<[number, number]> = [
      [0.1, 0.1124629160182849],
      [0.5, 0.5204998778130465],
      [0.84375, 0.7672256612323416],
      [1.0, 0.8427007929497149],
      [1.25, 0.9229001282564582],
      [2.0, 0.9953222650189527],
      [3.5, 0.9999992569016276],
      [-0.7, -0.6778011938374184],
      [5.9, 0.9999999999999999],
    ]
    for (const [x, expected] of cases) {
      expect(Math.abs(erf(x) - expected), `erf(${x})`).toBeLessThanOrEqual(Math.abs(expected) * 2 ** -52)
    }
  })

  it('minimises as SciPy’s fminbound does', () => {
    // From SciPy 1.10 in the golden's environment.
    expect(fminbound((t) => Math.abs(t - 0.25) + 0.01 * t, 0, 1)).toBe(0.24999853633525534)
    expect(fminbound((t) => (t - 1.3) ** 2 + 0.1 * Math.sin(5 * t), -3, 4)).toBeCloseTo(
      1.1123158053690676,
      12,
    )
  })

  it('gives a tie of local IDRs the global IDR of its last member', () => {
    // `rankdata(…, method='max')`: both 0.1s are averaged over both of them.
    const global = globalIdr(Float64Array.from([0.3, 0.1, 0.1]))
    expect(global[1]).toBe(0.1)
    expect(global[2]).toBe(0.1)
    expect(global[0]).toBeCloseTo(0.5 / 3, 15)
  })

  it('ranks for IDR from the lowest score, ties by position', () => {
    expect(Array.from(idrRanks(Float64Array.from([5, 1, 5, 3])))).toEqual([2, 0, 3, 1])
  })

  it('finds two replicates’ pseudo-values from one bisection, each as its own would', () => {
    const random = uniform(5)
    const r1 = idrRanks(Float64Array.from({ length: 2_000 }, () => random()))
    const r2 = idrRanks(Float64Array.from({ length: 2_000 }, () => random()))
    for (const [mu, sigma, p, eps] of [
      [0.1, 1.0, 0.5, 1e-8],
      [2.75, 0.88, 0.06, 1e-12],
    ]) {
      const [z1, z2] = pseudoValuePair(r1, r2, mu, sigma, p, eps)
      expect(Array.from(z1)).toEqual(Array.from(pseudoValues(r1, mu, sigma, p, eps)))
      expect(Array.from(z2)).toEqual(Array.from(pseudoValues(r2, mu, sigma, p, eps)))
    }
  })
})
