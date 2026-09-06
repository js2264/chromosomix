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
import {
  adaptiveSmoothValues,
  MAX_ADAPTIVE_CELLS,
  parseSmooth,
  SMOOTH_CHOICES,
  SMOOTH_RADII,
  smoothLabel,
  smoothToken,
  smoothValues,
} from '@/render/smooth'

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
    expect(deriveBlock(b, { smooth: '1' }, NO_RUNS).label).toBe('counts · smoothed 3 × 3')
    expect(deriveBlock(b, { smooth: '2' }, NO_RUNS).label).toBe('counts · smoothed 5 × 5')
  })

  it('leaves the block untouched at radius 0', () => {
    const b = block(3, 3, new Array<number>(9).fill(1))
    expect(deriveBlock(b, { smooth: '0' }, NO_RUNS).values).toBe(b.values)
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
      { ...a, values: deriveBlock(a, { smooth: '1' }, NO_RUNS).values },
      { ...b, values: deriveBlock(b, { smooth: '1' }, NO_RUNS).values },
      { op: 'ratio' },
    )
    for (const v of smoothed.values) expect(Number.isFinite(v)).toBe(true)
  })
})

/**
 * The window that sizes itself, and the four things that make it worth having.
 *
 * The fixed filter above is tested for its kernel. This one is tested for its
 * *bandwidth*, because the kernel is the same box mean and the bandwidth is the
 * whole idea: a window that stays narrow where the counts are thick and widens
 * where they thin out, which is what a fixed window cannot do and why a map
 * smoothed with one is still noisy away from the diagonal.
 */
describe('adaptiveSmoothValues', () => {
  const LIGHT = { kind: 'adaptive', target: 50, floor: 1, name: 'light' } as const

  /**
   * How far a lone spike reaches, which is the width of its neighbours' windows.
   *
   * Scanned only as far as `maxD`, which each caller sets to keep the walk
   * inside the half it is measuring: the step between the two halves is itself a
   * difference from the local base, and a scan that crossed it would report the
   * distance to the step rather than the width of a window.
   */
  function spread(
    out: Float32Array,
    n: number,
    row: number,
    col: number,
    base: number,
    maxD: number,
  ): number {
    let far = 0
    for (let d = 1; d <= maxD && col + d < n; d++) {
      if (Math.abs(out[row * n + col + d] - base) > base * 1e-3) far = d
    }
    return far
  }

  /**
   * A field thick on the left and thin on the right, with a spike in each half.
   * The spike reaches exactly as far as the windows around it are wide.
   */
  function twoHalves(n: number, thick: number, thin: number) {
    const values = new Float32Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) values[r * n + c] = c < n / 2 ? thick : thin
    }
    return values
  }

  it('widens the window where the counts thin out, and not where they do not', () => {
    const n = 121
    const values = twoHalves(n, 10, 1)
    const mid = 60
    values[mid * n + 30] = 100
    values[mid * n + 90] = 10
    const b = { ...block(n, n, []), values, nrows: n, ncols: n }
    const { values: out, applied, scope } = adaptiveSmoothValues(b, values, LIGHT)

    expect(applied).toEqual(LIGHT)
    expect(scope).toBeNull()

    // Each walk stays well inside its own half and clear of the block edge, so
    // what it measures is the width of a window rather than the distance to a
    // cell whose window widened for some other reason.
    const thickReach = spread(out, n, mid, 30, 10, 12)
    const thinReach = spread(out, n, mid, 90, 1, 25)
    // Both halves are smoothed; the thin one is smoothed over several times the
    // area, which is the entire point and the thing a fixed radius cannot do.
    expect(thickReach).toBeGreaterThan(0)
    expect(thinReach).toBeGreaterThan(thickReach + 2)
  })

  it('sizes the window on the counts, not on the values being averaged', () => {
    // The values carry the same structure everywhere, so anything that varies
    // across the picture came from `counts` — which is the separation that lets
    // this run on an O/E map, whose own values are near 1 by construction and
    // would size every window the same.
    const n = 121
    const counts = twoHalves(n, 10, 1)
    const values = new Float32Array(n * n).fill(1)
    const mid = 60
    values[mid * n + 30] = 5
    values[mid * n + 90] = 5
    const b = { ...block(n, n, []), values, nrows: n, ncols: n }
    const out = adaptiveSmoothValues(b, counts, LIGHT).values

    expect(spread(out, n, mid, 90, 1, 25)).toBeGreaterThan(spread(out, n, mid, 30, 1, 12) + 2)
  })

  it('leaves the centre out, so a lone spike is removed rather than reduced', () => {
    const n = 21
    const values = new Float32Array(n * n).fill(1)
    const centre = 10 * n + 10
    values[centre] = 500
    const b = { ...block(n, n, []), values, nrows: n, ncols: n }
    const out = adaptiveSmoothValues(b, values, LIGHT).values
    expect(out[centre]).toBeCloseTo(1, 3)
  })

  it('keeps a missing cell missing', () => {
    const n = 21
    const values = new Float32Array(n * n).fill(1)
    const hole = 10 * n + 10
    values[hole] = Number.NaN
    const b = { ...block(n, n, []), values, nrows: n, ncols: n }
    const out = adaptiveSmoothValues(b, values, LIGHT).values
    expect(Number.isNaN(out[hole])).toBe(true)
    // and its neighbours are divided by what actually contributed, not by the
    // window's nominal size, so the hole leaves no dark ring around itself.
    expect(out[hole + 1]).toBeCloseTo(1, 6)
  })

  it('falls back to the floor above the cell cap, and says which it used', () => {
    const n = 1415
    expect(n * n).toBeGreaterThan(MAX_ADAPTIVE_CELLS)
    const values = new Float32Array(n * n).fill(1)
    const b = { ...block(1, 1, []), values, nrows: n, ncols: n }
    const strong = { kind: 'adaptive', target: 800, floor: 3, name: 'strong' } as const
    const { applied, scope } = adaptiveSmoothValues(b, values, strong)
    expect(applied).toEqual({ kind: 'fixed', radius: 3 })
    expect(scope).toBe('adaptive smoothing not applied — block too large')
  })
})

describe('the smoothing picker', () => {
  it('reads both vocabularies, and refuses what this build does not offer', () => {
    expect(parseSmooth('2')).toEqual({ kind: 'fixed', radius: 2 })
    expect(parseSmooth(2)).toEqual({ kind: 'fixed', radius: 2 })
    expect(parseSmooth('a200')).toEqual({ kind: 'adaptive', target: 200, floor: 2, name: 'medium' })
    expect(parseSmooth('0')).toBeNull()
    expect(parseSmooth(undefined)).toBeNull()
    expect(parseSmooth('a999')).toBeNull()
    expect(parseSmooth('lots')).toBeNull()
  })

  it('round-trips every choice through its token', () => {
    for (const choice of SMOOTH_CHOICES) {
      expect(smoothToken(choice.smoothing)).toBe(choice.id)
      expect(parseSmooth(choice.id)).toEqual(choice.smoothing)
    }
  })

  it('captions an adaptive map by its name, because it has no one window to give', () => {
    const b = block(9, 9, new Array<number>(81).fill(1))
    expect(deriveBlock(b, { smooth: 'a200' }, NO_RUNS).label).toBe(
      'counts · smoothed adaptively (medium)',
    )
    expect(deriveBlock(b, { smooth: '2' }, NO_RUNS).label).toBe('counts · smoothed 5 × 5')
  })
})

describe('adaptiveSmoothValues, on the shapes a real block arrives in', () => {
  const LIGHT = { kind: 'adaptive', target: 50, floor: 1, name: 'light' } as const

  it('ignores a padded tail when it measures the block', () => {
    // `BlockValues.values` is documented as *at least* `nrows * ncols` long, and
    // a reader that walked the whole array would let padding it must not see set
    // the scale that sizes every window on the picture.
    const n = 41
    const cells = n * n
    const centre = 20 * n + 20
    const exact = new Float32Array(cells).fill(1)
    exact[centre] = 200
    // The same block with a tail of large values behind it. A scale taken over
    // the whole array would be hundreds of times too big, every window would run
    // to the cap to reach it, and the spike would smear across the picture — so
    // the block has to carry a feature for this to be able to fail.
    const padded = new Float32Array(cells + 500)
    padded.set(exact.subarray(0, cells))
    padded.fill(1000, cells)

    const b = { ...block(1, 1, []), nrows: n, ncols: n, values: exact }
    const withTail = { ...b, values: padded }
    const plain = adaptiveSmoothValues(b, exact, LIGHT).values
    const tailed = adaptiveSmoothValues(withTail, padded, LIGHT).values
    for (let i = 0; i < cells; i++) expect(tailed[i]).toBeCloseTo(plain[i], 4)
  })
})
