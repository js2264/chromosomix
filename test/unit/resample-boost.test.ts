/**
 * The Boost-HiC port (§6.5), held against Boost-HiC's own Python.
 *
 * `scripts/make_boost_golden.py` runs `main.py`'s steps — `get_outliers`, `SCN`,
 * `fastFloyd` on `1/SCN**alpha`, `adjustPdS` — through the `HiCutils` module of
 * `LeopoldC/Boost-HiC` itself, on a thinned 100 kb of the demo's chromosome I,
 * and writes every intermediate. Each is compared here, so a divergence names
 * the step it starts in.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BOOST_ALPHA,
  boostHiC,
  boostSteps,
  contactWindows,
  floydKernelAvailable,
  floydWarshall,
  kdeOutliers,
} from '../../src/metacooler/boost'
import { FLOYD_SOURCE_SHA256 } from '../../src/metacooler/wasm/floyd.generated'
import { analysisGoldensPresent, loadAnalysisGolden } from '../support/analysisGoldens'

interface BoostGolden {
  n: number
  alpha: number
  pixels: Array<[number, number, number]>
  kept: number[]
  scn: number[]
  boosted: number[]
  tolerance: number
}

function denseOf(golden: BoostGolden): Float64Array {
  const { n } = golden
  const matrix = new Float64Array(n * n)
  for (const [r, c, v] of golden.pixels) {
    matrix[r * n + c] = v
    matrix[c * n + r] = v
  }
  return matrix
}

/** Every cell within `tolerance` of the golden, relative to the larger of the two. */
function expectClose(actual: Float64Array, expected: readonly number[], tolerance: number): void {
  expect(actual.length).toBe(expected.length)
  let worst = 0
  let at = -1
  for (let i = 0; i < expected.length; i++) {
    const scale = Math.max(Math.abs(actual[i]), Math.abs(expected[i]), 1e-300)
    const error = Math.abs(actual[i] - expected[i]) / scale
    if (error > worst) {
      worst = error
      at = i
    }
  }
  expect(worst, `worst relative error at cell ${at}`).toBeLessThan(tolerance)
}

describe.skipIf(!analysisGoldensPresent())('Boost-HiC against its own Python', () => {
  const golden = loadAnalysisGolden<BoostGolden>('boost_hic')

  it('runs at main.py’s alpha', () => {
    expect(golden.alpha).toBe(BOOST_ALPHA)
  })

  it('filters the same bins as get_outliers', () => {
    const steps = boostSteps(denseOf(golden), golden.n, golden.alpha)
    expect(steps).not.toBeNull()
    expect(Array.from(steps!.kept)).toEqual(golden.kept)
  })

  it('normalises as SCN does', () => {
    const steps = boostSteps(denseOf(golden), golden.n, golden.alpha)!
    expectClose(steps.scn, golden.scn, golden.tolerance)
  })

  it('boosts as fastFloyd and adjustPdS do', () => {
    const steps = boostSteps(denseOf(golden), golden.n, golden.alpha)!
    expectClose(steps.boosted, golden.boosted, golden.tolerance)
  })

  it('comes back in counts: dense where the map was, filled in where it was not', () => {
    const matrix = denseOf(golden)
    const boosted = boostHiC(new Float64Array(matrix), golden.n, golden.alpha)!
    const size = boosted.kept.length
    let holes = 0
    let filled = 0
    let stored = 0
    let drawn = 0
    for (let i = 0; i < size; i++) {
      for (let j = i; j < size; j++) {
        const observed = matrix[boosted.kept[i] * golden.n + boosted.kept[j]]
        const value = boosted.counts[i * size + j]
        expect(value).toBeGreaterThanOrEqual(0)
        stored += observed
        drawn += value
        if (observed === 0) {
          holes++
          if (value > 0) filled++
        }
      }
    }
    // The thinned map has holes, and the shortest paths reach into most of
    // them. Not all: `adjustPdS` scales each window of diagonals to the SCN
    // map's mean there, and a far window the thinned map holds nothing in is
    // scaled to nothing — Boost-HiC's Python does the same (the golden above).
    expect(holes).toBeGreaterThan(0)
    expect(filled / holes).toBeGreaterThan(0.8)
    // Back in counts means back at the map's own order of magnitude.
    expect(drawn / stored).toBeGreaterThan(0.2)
    expect(drawn / stored).toBeLessThan(5)
  })
})

describe('windowssize2', () => {
  it('pools one diagonal per window for seventy windows, then two, and covers every diagonal', () => {
    for (const n of [2, 3, 69, 70, 71, 150, 1532]) {
      const { window, sizes } = contactWindows(n)
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n)
      expect(window.length).toBe(n)
      expect(window[n - 1]).toBe(sizes.length - 1)
    }
    const { sizes } = contactWindows(1532)
    expect(sizes.slice(0, 69).every((size) => size === 1)).toBe(true)
    expect(sizes[70]).toBe(2)
  })
})

describe('get_outliers', () => {
  it('drops the empty bins and the tails of the coverage, and keeps the middle', () => {
    const coverage = new Float64Array(200)
    for (let i = 0; i < coverage.length; i++) coverage[i] = 20_000 + ((i * 7919) % 97) * 50
    coverage[3] = 0
    coverage[10] = 400
    coverage[20] = 900_000
    const out = kdeOutliers(coverage)
    expect(out[3]).toBe(1)
    expect(out[10]).toBe(1)
    expect(out[20]).toBe(1)
    const kept = out.reduce((a, b) => a + (b === 0 ? 1 : 0), 0)
    expect(kept).toBeGreaterThan(150)
  })

  it('leaves out every bin of a map with no contacts', () => {
    expect(Array.from(kdeOutliers(new Float64Array(5)))).toEqual([1, 1, 1, 1, 1])
  })
})

describe('Floyd–Warshall', () => {
  it('runs the SIMD kernel here, built from the floyd.c in this tree', () => {
    expect(floydKernelAvailable()).toBe(true)
    const source = readFileSync(new URL('../../src/metacooler/wasm/floyd.c', import.meta.url))
    expect(createHash('sha256').update(source).digest('hex'), 'run `npm run wasm:floyd`').toBe(
      FLOYD_SOURCE_SHA256,
    )
  })

  it('gives the JavaScript loop’s numbers to the bit, holes and odd widths included', () => {
    for (const n of [1, 2, 7, 64, 131]) {
      const d = new Float64Array(n * n)
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          d[i * n + j] =
            (i + 2 * j) % 11 === 0 && i !== j
              ? Number.POSITIVE_INFINITY
              : 0.3 + Math.abs(i - j) * 0.07 + ((i * 31 + j * 17) % 13) * 0.11
        }
      }
      const inWasm = new Float64Array(d)
      const inJs = new Float64Array(d)
      expect(floydWarshall(inWasm, n)).toBe('wasm')
      expect(floydWarshall(inJs, n, undefined, 'js')).toBe('js')
      expect(Array.from(inWasm)).toEqual(Array.from(inJs))
    }
  })
})
