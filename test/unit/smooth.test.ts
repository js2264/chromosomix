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
  ADAPTIVE_MAX_RADIUS,
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

  it('replaces a cell by the mean of its window, itself included', () => {
    // A single spike in a field of ones. The centre keeps a ninth of its own
    // excess rather than being annihilated: a lone cell on a sparse map is the
    // only measurement there is, not an outlier to be rejected.
    const values = new Array<number>(25).fill(1)
    values[12] = 100
    const out = smoothValues(block(5, 5, values), 1)
    expect(out[12]).toBeCloseTo((8 * 1 + 100) / 9, 5)
    // Still suppressed by most of its excess, which is the despeckling that
    // survives the centre going back in.
    expect(out[12]).toBeLessThan(1 + 99 / 8)
  })

  it('leaves no hole where a lone count was', () => {
    // The artefact that put the centre back: a zero-centre kernel turned every
    // isolated contact into a ring of eight with a blank in the middle, which on
    // a sparse map is most of the picture.
    const values = new Array<number>(25).fill(0)
    values[12] = 9
    const out = smoothValues(block(5, 5, values), 1)
    // The centre is the brightest cell of the block, not the dimmest.
    expect(out[12]).toBeCloseTo(1, 6)
    for (const i of [7, 11, 13, 17]) expect(out[i]).toBeCloseTo(1, 6)
    expect(out[12]).toBeGreaterThanOrEqual(out[7])
    // A cell two away never sees it.
    expect(out[2]).toBe(0)
  })

  it('divides a corner by the cells it has, not by the ones it does not', () => {
    // A corner's window holds 4 cells, not 9. `terra::focal` would divide by the
    // nominal size; that bias is the dark frame this does not draw.
    const out = smoothValues(block(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1]), 1)
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

  it('keeps the centre in, and still suppresses a lone spike', () => {
    const n = 21
    const values = new Float32Array(n * n).fill(1)
    const centre = 10 * n + 10
    values[centre] = 500
    const b = { ...block(n, n, []), values, nrows: n, ncols: n }
    const out = adaptiveSmoothValues(b, values, LIGHT).values
    // The window stays at the floor here, and for the right reason: the spike is
    // itself the evidence the bandwidth is looking for, so it is met inside
    // 3 × 3 and the cell is diluted by nine rather than by hundreds. Suppressed
    // without being erased, and without the hole a zero-centre kernel would
    // leave in its place.
    expect(out[centre]).toBeCloseTo((8 * 1 + 500) / 9, 3)
    expect(out[centre]).toBeGreaterThan(1)
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

  it('gives the same answer either side of a band boundary', () => {
    // The tables are built for a band of rows at a time, not for the block, so
    // every window is read out of a table whose first row is not row zero. An
    // origin off by a band is the whole failure mode of that, and it is invisible
    // on a uniform field — so the block is made **periodic in its rows** with a
    // period of exactly one band, and two rows one period apart, both clear of
    // the block's edges, must come out identical. They sit in different bands.
    const ncols = 6000
    const period = Math.max(1, Math.floor(4_000_000 / (ncols + 1)) - 2 * ADAPTIVE_MAX_RADIUS)
    const nrows = period * 2 + ADAPTIVE_MAX_RADIUS + 100
    const values = new Float32Array(nrows * ncols)
    for (let r = 0; r < nrows; r++) {
      const k = r % period
      for (let c = 0; c < ncols; c++) {
        // Occupancy falls off along the row, so the window has to widen as it
        // goes and the radius search is actually exercised rather than pinned.
        const density = 90 - Math.floor((85 * c) / ncols)
        const hit = (k * 31 + c * 17 + ((k * c) % 13)) % 100 < density
        values[r * ncols + c] = hit ? ((k + c) % 5) + 1 : 0
      }
    }
    const b = { ...block(1, 1, []), nrows, ncols, values }
    const out = adaptiveSmoothValues(b, values, LIGHT).values

    const first = ADAPTIVE_MAX_RADIUS + 8
    const second = first + period
    expect(second + ADAPTIVE_MAX_RADIUS).toBeLessThan(nrows)
    // Different bands, or the test is asserting nothing.
    expect(Math.floor(first / period)).not.toBe(Math.floor(second / period))
    for (let c = 0; c < ncols; c++) {
      expect(out[second * ncols + c]).toBeCloseTo(out[first * ncols + c], 5)
    }
    // …and the row is not simply flat, which would make the equality free.
    const row = Array.from(out.subarray(first * ncols, first * ncols + ncols))
    expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(0.1)
  })

  it('falls back to the floor above the cell cap, and says which it used', () => {
    const n = 4001
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
    expect(parseSmooth('a50')).toMatchObject({ kind: 'adaptive', target: 50, floor: 1 })
    expect(parseSmooth('0')).toBeNull()
    expect(parseSmooth(undefined)).toBeNull()
    // The ladder of adaptive strengths is gone; a link that carried one lands on
    // the plain map, which is what every other unrecognised value does.
    expect(parseSmooth('a200')).toBeNull()
    expect(parseSmooth('a800')).toBeNull()
    expect(parseSmooth('lots')).toBeNull()
  })

  it('marks the adaptive setting as the one that wants the O/E', () => {
    // `app/Session.ts` reads exactly this to decide whether picking a setting
    // should also turn the O/E on. Pinned here so the rule has a name rather
    // than living only as a `kind` comparison at the call site — the wiring
    // itself needs a session to exercise and is not covered.
    expect(parseSmooth('a50')?.kind).toBe('adaptive')
    for (const id of ['0', '1', '2', '3']) {
      expect(parseSmooth(id)?.kind ?? 'off').not.toBe('adaptive')
    }
  })

  it('round-trips every choice through its token', () => {
    for (const choice of SMOOTH_CHOICES) {
      expect(smoothToken(choice.smoothing)).toBe(choice.id)
      expect(parseSmooth(choice.id)).toEqual(choice.smoothing)
    }
  })

  it('captions an adaptive map as adaptive, because it has no one window to give', () => {
    const b = block(9, 9, new Array<number>(81).fill(1))
    expect(deriveBlock(b, { smooth: 'a50' }, NO_RUNS).label).toBe('counts · smoothed adaptively')
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

/**
 * The two things a reader reported, pinned at the level they were seen.
 *
 * Both were invisible to every test above, because both are about where the
 * filter sits rather than about what the kernel computes — and the kernel was
 * doing exactly what it was asked to.
 */
describe('the despeckle, where a reader meets it', () => {
  /** A sparse map with a steep decay: most cells empty away from the diagonal. */
  function sparse(n: number) {
    // mulberry32, as `analysis/random.ts` uses. The LCG the kernel test above
    // uses would lose precision here: `seed * 1103515245` passes 2^53 and the
    // sequence degenerates, which on a block this size is not random enough to
    // build a decay out of.
    let a = 7
    const next = (): number => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const values = new Float32Array(n * n)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const lambda = (2000 / n) * Math.pow(Math.abs(i - j) + 1, -1.1)
        let k = 0
        let p = 1
        const limit = Math.exp(-lambda)
        while (p > limit && k < 50) {
          p *= next()
          k++
        }
        values[i * n + j] = Math.max(0, k - 1)
      }
    }
    return {
      nrows: n,
      ncols: n,
      values,
      rowExtent: [0, n] as [number, number],
      colExtent: [0, n] as [number, number],
    }
  }

  /** What fraction of a separation band the map actually draws. */
  function drawn(out: Float32Array, n: number, lo: number, hi: number): number {
    let finite = 0
    let total = 0
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        const d = i - j
        if (d < lo || d >= hi) continue
        total++
        if (Number.isFinite(out[i * n + j])) finite++
      }
    }
    return finite / total
  }

  function mean(out: Float32Array, n: number, lo: number, hi: number): number {
    let sum = 0
    let seen = 0
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        const d = i - j
        if (d < lo || d >= hi) continue
        const v = out[i * n + j]
        if (Number.isFinite(v)) {
          sum += v
          seen++
        }
      }
    }
    return sum / seen
  }

  it('does not punch a hole where a lone contact was', () => {
    // Reported as "weird squares, with the center pixel being the pixel where
    // there is an actual count". A zero-centre kernel spread an isolated count
    // into its eight neighbours and replaced it with the mean of the eight
    // zeros, so the one cell holding a measurement was the one cell drawn blank.
    const n = 9
    const values = new Array<number>(n * n).fill(0)
    const lone = 4 * n + 4
    values[lone] = 5
    const out = deriveBlock(block(n, n, values), { smooth: '1' }, NO_RUNS).values
    for (const neighbour of [lone - n - 1, lone - n, lone - 1, lone + 1, lone + n, lone + n + 1]) {
      expect(out[lone]).toBeGreaterThanOrEqual(out[neighbour])
    }
    expect(out[lone]).toBeGreaterThan(0)
  })

  it('fills in an O/E map away from the diagonal instead of leaving it blank', () => {
    // Reported as no difference between any of the six settings. The O/E draws a
    // cell where nothing was observed as paper, and away from the diagonal that
    // is almost every cell — so an O/E computed *before* the filter handed it a
    // field of `NaN`, which no despeckle will touch, and every setting drew the
    // same picture.
    const n = 180
    const b = sparse(n)
    const at = (id: string): Float32Array =>
      deriveBlock(b, { smooth: id, expected: true }, NO_RUNS).values

    const off = drawn(at('0'), n, 40, 90)
    // A tenth of the band, and the nine tenths that are missing are the cells
    // where nothing was seen — not cells the file has nothing to say about.
    expect(off).toBeLessThan(0.2)
    // Each wider window recovers more of it, and a self-sizing one recovers it
    // all. Ordered, so a reader moving down the picker sees the map change.
    expect(drawn(at('1'), n, 40, 90)).toBeGreaterThan(off + 0.3)
    expect(drawn(at('3'), n, 40, 90)).toBeGreaterThan(drawn(at('1'), n, 40, 90))
    expect(drawn(at('a50'), n, 40, 90)).toBeGreaterThan(0.99)
  })

  it('divides by a baseline from the same windows, so the ratio stays centred on 1', () => {
    // Smoothing the map and dividing it by an unsmoothed curve reads as a real
    // enrichment near the diagonal that is produced entirely by the filter: the
    // decay is steep there, so a window spanning it averages cells whose
    // baselines differ several-fold.
    const n = 180
    const b = sparse(n)
    for (const id of ['1', '2', '3', 'a50']) {
      const out = deriveBlock(b, { smooth: id, expected: true }, NO_RUNS).values
      expect(mean(out, n, 1, 12)).toBeGreaterThan(0.95)
      expect(mean(out, n, 1, 12)).toBeLessThan(1.05)
    }
  })
})
