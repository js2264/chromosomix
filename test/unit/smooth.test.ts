/**
 * The despeckle, and the three things about it that are easy to get wrong.
 *
 * The kernel itself is a box mean and there is not much to assert about it. What
 * is worth pinning is the shape of the operation:
 *
 * 1. **The centre is left out.** That is the whole difference between a
 *    despeckle and a blur, and a filter that kept a ninth of a wild pixel would
 *    still look like it was working.
 * 2. **The divisor is what contributed.** The block boundary is the viewport, so
 *    the alternative — `terra::focal`'s fixed `(2r+1)² - 1` — is a dark frame
 *    that moves when the map is panned.
 * 3. **`NaN` is not a value.** It is what an unbalanced bin leaves behind, and
 *    filling it from the neighbours paints a measurement over the one place the
 *    map is saying it has none.
 *
 * The fourth is not about the kernel at all: applied per file and before two are
 * combined, it removes the `Infinity` cells of a sparse ratio by making them not
 * happen, which is why the order in `deriveBlock` matters more than the weights
 * do.
 */

import { describe, expect, it } from 'vitest'

import { combine } from '@/render/compare'
import { deriveBlock } from '@/render/derive'
import { SMOOTH_RADII, smoothLabel, smoothValues } from '@/render/smooth'

function block(nrows: number, ncols: number, values: number[]) {
  return {
    nrows,
    ncols,
    values: Float32Array.from(values),
    rowExtent: [0, nrows] as [number, number],
    colExtent: [0, ncols] as [number, number],
  }
}

const NO_RUNS = { rows: [], cols: [] }

describe('smoothValues', () => {
  it('leaves the block alone at radius 0, without copying it', () => {
    const b = block(2, 2, [1, 2, 3, 4])
    expect(smoothValues(b, 0)).toBe(b.values)
  })

  it('replaces a cell by the mean of its neighbours, excluding itself', () => {
    // A single spike in a field of ones. The centre becomes the mean of its
    // eight neighbours — all 1 — so the spike is removed outright rather than
    // reduced, which is what excluding the centre buys.
    const values = new Array<number>(25).fill(1)
    values[12] = 100
    const out = smoothValues(block(5, 5, values), 1)
    expect(out[12]).toBeCloseTo(1, 6)
  })

  it('spreads the spike into the ring around it, and no further', () => {
    const values = new Array<number>(25).fill(0)
    values[12] = 9
    const out = smoothValues(block(5, 5, values), 1)
    // Each of the eight neighbours sees the spike once out of its own eight.
    expect(out[7]).toBeCloseTo(9 / 8, 6)
    expect(out[11]).toBeCloseTo(9 / 8, 6)
    // A cell two away never sees it.
    expect(out[2]).toBe(0)
  })

  it('divides a corner by the neighbours it has, not by the ones it does not', () => {
    // A corner cell has 3 neighbours, not 8. `terra::focal` would divide this
    // by 8 and return 3/8; that bias is the dark frame this does not draw.
    const out = smoothValues(block(3, 3, [0, 1, 1, 1, 1, 1, 1, 1, 1]), 1)
    expect(out[0]).toBeCloseTo(1, 6)
  })

  it('is exactly the mean of a uniform field, everywhere including the edges', () => {
    const out = smoothValues(block(4, 6, new Array<number>(24).fill(7)), 1)
    for (const v of out) expect(v).toBeCloseTo(7, 6)
  })

  it('keeps a cell that has no value blank, and drops it from its neighbours’ means', () => {
    const values = [1, 1, 1, 1, Number.NaN, 1, 1, 1, 1]
    const out = smoothValues(block(3, 3, values), 1)
    // The hole stays a hole…
    expect(out[4]).toBeNaN()
    // …and the corner, which has 3 neighbours of which one is the hole, is the
    // mean of the 2 that remain rather than a NaN or a value divided by 3.
    expect(out[0]).toBeCloseTo(1, 6)
  })

  it('despeckles an infinite cell instead of spreading it', () => {
    const values = new Array<number>(25).fill(2)
    values[12] = Number.POSITIVE_INFINITY
    const out = smoothValues(block(5, 5, values), 1)
    expect(out[12]).toBeCloseTo(2, 6)
    // Every other cell is finite: an Infinity that entered a running sum could
    // never be subtracted back out, and would have made the rest of the block NaN.
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })

  it('agrees with the direct kernel at every radius offered', () => {
    // The implementation is an incremental sliding window; this is the
    // definition it is an optimisation of.
    const n = 11
    let seed = 3
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const values = Array.from({ length: n * n }, () => Math.round(next() * 40))
    const b = block(n, n, values)

    for (const radius of SMOOTH_RADII.filter((r) => r > 0)) {
      const out = smoothValues(b, radius)
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          let sum = 0
          let count = 0
          for (let dr = -radius; dr <= radius; dr++) {
            for (let dc = -radius; dc <= radius; dc++) {
              if (dr === 0 && dc === 0) continue
              const rr = r + dr
              const cc = c + dc
              if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue
              sum += values[rr * n + cc]
              count++
            }
          }
          expect(out[r * n + c]).toBeCloseTo(sum / count, 4)
        }
      }
    }
  })

  it('names the window, which is what the picker offers', () => {
    expect(smoothLabel(1)).toBe('3 × 3')
    expect(smoothLabel(3)).toBe('7 × 7')
  })
})

describe('smoothing inside the derivation', () => {
  it('says so in the label, so an exported figure carries the word', () => {
    const b = block(3, 3, new Array<number>(9).fill(1))
    expect(deriveBlock(b, {}, NO_RUNS).label).toBe('counts')
    expect(deriveBlock(b, { smooth: 1 }, NO_RUNS).label).toBe('counts · smoothed 3 × 3')
    expect(deriveBlock(b, { smooth: 2 }, NO_RUNS).label).toBe('counts · smoothed 5 × 5')
  })

  it('leaves the block untouched at radius 0', () => {
    const b = block(3, 3, new Array<number>(9).fill(1))
    expect(deriveBlock(b, { smooth: 0 }, NO_RUNS).values).toBe(b.values)
  })

  it('stops a sparse ratio from producing infinities at all', () => {
    // Two files with contacts in the same neighbourhood but not the same cells —
    // the thing a 5 kb ratio is mostly made of. Unsmoothed, every cell where one
    // file is empty is 0 or Infinity; smoothed first, none of them is.
    const a = block(5, 5, [1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 2, 0, 1, 0, 1, 0, 1])
    const b = block(5, 5, [0, 1, 0, 1, 0, 1, 0, 2, 0, 1, 0, 2, 0, 2, 0, 1, 0, 2, 0, 1, 0, 1, 0, 1, 0])

    const raw = combine(a, b, { op: 'ratio' })
    const wild = [...raw.values].filter((v) => !Number.isFinite(v)).length
    expect(wild).toBeGreaterThan(10)

    const smoothed = combine(
      { ...a, values: deriveBlock(a, { smooth: 1 }, NO_RUNS).values },
      { ...b, values: deriveBlock(b, { smooth: 1 }, NO_RUNS).values },
      { op: 'ratio' },
    )
    for (const v of smoothed.values) expect(Number.isFinite(v)).toBe(true)
  })
})
