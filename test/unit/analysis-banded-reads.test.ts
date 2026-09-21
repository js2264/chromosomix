/**
 * Reading a diagonal without the square around it.
 *
 * Both scans on the map — the insulation diamond and the chromosight
 * correlation — touch only cells near the diagonal, and both used to read the
 * whole `n × n` square to get at them. That put a ceiling on each that had
 * nothing to do with its arithmetic: one `Float32Array` is refused past 23,170
 * bins whatever the machine has (`MAX_DENSE_ARRAY_BYTES`), which is 116 Mb at
 * 5 kb, and loop calling stopped at a hard-coded 8,192 bins, which is 41 Mb.
 *
 * The two readers here are what replaced that, and the four properties below are
 * what make them a *substitution* rather than an approximation:
 *
 * - the band holds exactly the cells the square held, inside it;
 * - a tile's own bins carry exactly what a whole square would have given them,
 *   which is what lets a goldened kernel keep its golden;
 * - the tiles cover every bin once, so nothing is scored twice or skipped;
 * - neither reader's allocation grows with the sequence.
 */

import { describe, expect, it } from 'vitest'

import { bandFor, cisMarginal, forEachDiagonalTile } from '@/analysis/run/blocks'
import { detectableFromCounts, detectableFromMarginal } from '@/analysis/chromosight'
import { CHROMOSIGHT_TASK, MAX_SCAN_CELLS, scanCellsFor } from '@/analysis/tasks/chromosight'
import type { JobContext } from '@/analysis/job'
import type { AnalysisContext, AnalysisFraming, Params } from '@/analysis/types'
import type { BlockInput } from '@/analysis/worker/protocol'

const BINSIZE = 1000
/** Two sequences, so a cis-only count has something to leave out. */
const CONTIGS = [
  { name: 'I', bins: 40 },
  { name: 'II', bins: 25 },
]
const OFFSET = [0, CONTIGS[0].bins]
const NBINS = CONTIGS[0].bins + CONTIGS[1].bins

/** Distinct per cell and symmetric, so a misplaced cell cannot look right. */
function valueAt(row: number, col: number): number {
  const lo = Math.min(row, col)
  const hi = Math.max(row, col)
  return lo * 1000 + hi
}

interface Read {
  rows: [number, number]
  cols: [number, number]
}

function job(reads: Read[] = [], params: Params = {}): JobContext {
  const mc = {
    nBins: NBINS,
    nContigs: CONTIGS.length,
    binsize: BINSIZE,
    hasGenomes: false,
    contigGenomeIds: new Int32Array(CONTIGS.length),
    chromnames: CONTIGS.map((contig) => contig.name),
    chromsizes: new Map(CONTIGS.map((contig) => [contig.name, contig.bins * BINSIZE])),
    contigExtent: (cid: number) =>
      [OFFSET[cid], OFFSET[cid] + CONTIGS[cid].bins] as [number, number],
    matrix: async (query: Read) => {
      reads.push({ rows: [...query.rows], cols: [...query.cols] })
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          values[r * ncols + c] = valueAt(query.rows[0] + r, query.cols[0] + c)
        }
      }
      return {
        values,
        nrows,
        ncols,
        rowExtent: [...query.rows] as [number, number],
        colExtent: [...query.cols] as [number, number],
      }
    },
    scanPixels: async (options: {
      onChunk: (chunk: { length: number; bin1: Int32Array; bin2: Int32Array; count: Float64Array }) => void
    }) => {
      // The upper triangle of the whole file, including one trans block, which
      // a cis marginal must leave out.
      const bin1: number[] = []
      const bin2: number[] = []
      const count: number[] = []
      for (let r = 0; r < NBINS; r++) {
        for (let c = r; c < NBINS; c++) {
          // A hole at bin 3 of contig I, so the marginal is not simply the width.
          if (r === 3 || c === 3) continue
          bin1.push(r)
          bin2.push(c)
          count.push(1)
        }
      }
      options.onChunk({
        length: bin1.length,
        bin1: Int32Array.from(bin1),
        bin2: Int32Array.from(bin2),
        count: Float64Array.from(count),
      })
    },
  }
  return {
    mc: mc as never,
    params,
    framing: {} as AnalysisFraming,
    inputs: {} as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

const SPAN = { from: OFFSET[0], to: OFFSET[0] + CONTIGS[0].bins }
const READ = { block: null, balance: false, value: 'count' }

describe('bandFor', () => {
  it('holds exactly the cells the square held, inside the band', async () => {
    const band = await bandFor(job(), SPAN, { hi: 5, ...READ })
    for (let r = 0; r < band.n; r++) {
      for (let c = 0; c < band.n; c++) {
        const offset = c - r
        // Inside: the file's own number. Outside: zero, which is what the
        // sparse original never stored either.
        expect(band.at(r, c)).toBe(offset >= 0 && offset <= 5 ? valueAt(r, c) : 0)
      }
    }
  })

  it('reads each row once, in tiles, and never the whole square', async () => {
    const reads: Read[] = []
    await bandFor(job(reads), SPAN, { hi: 5, ...READ })
    // Every row of the sequence covered exactly once by the tiles' row ranges.
    const rows = new Int32Array(CONTIGS[0].bins)
    for (const read of reads) {
      for (let r = read.rows[0]; r < read.rows[1]; r++) rows[r - SPAN.from]++
    }
    expect(Array.from(rows).every((seen) => seen === 1)).toBe(true)
    // And no read is the square: each is at most `tile + hi` wide.
    for (const read of reads) {
      expect(read.cols[1] - read.cols[0]).toBeLessThanOrEqual(
        read.rows[1] - read.rows[0] + 5,
      )
    }
  })

  it('takes the band out of the block on screen without reading at all', async () => {
    const n = CONTIGS[0].bins
    const values = new Float32Array(n * n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) values[r * n + c] = valueAt(r, c)
    const block: BlockInput = {
      nrows: n,
      ncols: n,
      values,
      rowExtent: [SPAN.from, SPAN.to],
      colExtent: [SPAN.from, SPAN.to],
      binsPerCell: 1,
    }
    const reads: Read[] = []
    const band = await bandFor(job(reads), SPAN, { hi: 4, ...READ, block })
    expect(reads).toHaveLength(0)
    expect(band.at(7, 10)).toBe(valueAt(7, 10))
    expect(band.at(7, 30)).toBe(0)
  })

  it('never keeps more than the band, whatever the sequence', async () => {
    const band = await bandFor(job(), SPAN, { hi: 3, ...READ })
    expect(band.values.length).toBe(4 * CONTIGS[0].bins)
  })

  it('clamps a band wider than the sequence rather than over-reading', async () => {
    const band = await bandFor(job(), SPAN, { hi: 10_000, ...READ })
    expect(band.hi).toBe(CONTIGS[0].bins - 1)
    expect(band.at(0, CONTIGS[0].bins - 1)).toBe(valueAt(0, CONTIGS[0].bins - 1))
  })

  it('answers past the end of a linear sequence with a gap, not a zero', async () => {
    const band = await bandFor(job(), SPAN, { hi: 5, ...READ })
    // A cell that does not exist and a cell that was not read are both gaps to
    // `forward`, which is the accessor the banded kernels count with — a zero
    // there would be counted as a measurement of no contact.
    expect(band.forward(CONTIGS[0].bins - 1, 1)).toBeNaN()
    expect(band.forward(-1, 1)).toBeNaN()
    expect(band.forward(0, 6)).toBeNaN()
    expect(band.forward(3, 2)).toBe(valueAt(3, 5))
    // And `at`, which chromosight is written against, is unchanged: outside the
    // band it is still the zero the sparse original never stored.
    expect(band.at(3, 30)).toBe(0)
  })
})

/**
 * The circular band, and the one extra read it costs.
 *
 * The cells joining the end of a circular sequence to its beginning are nowhere
 * near the diagonal — they are the top-right corner of the contig's own square —
 * so a band walk that merely changed its accessor would answer `NaN` for every
 * bin within `hi` of the junction. That is the one place the flag was set to fix,
 * and the failure would look exactly like a real feature there.
 */
describe('bandFor, on a circular sequence', () => {
  const n = CONTIGS[0].bins

  it('wraps past the last bin, with the file’s own numbers', async () => {
    const band = await bandFor(job(), SPAN, { hi: 5, ...READ, circular: true })
    expect(band.circular).toBe(true)
    // The bin after the last one is the first one, and the cell joining them is
    // the one the matrix stores at `(0, n − 1)`.
    expect(band.forward(n - 1, 1)).toBe(valueAt(0, n - 1))
    expect(band.forward(n - 3, 5)).toBe(valueAt(2, n - 3))
    // And a negative offset is the same cell read from the other end.
    expect(band.forward(1, -2)).toBe(valueAt(n - 1, 1))
  })

  it('costs exactly one more read than the linear band', async () => {
    const linear: Read[] = []
    await bandFor(job(linear), SPAN, { hi: 5, ...READ })
    const circular: Read[] = []
    await bandFor(job(circular), SPAN, { hi: 5, ...READ, circular: true })
    expect(circular).toHaveLength(linear.length + 1)
    // And the extra one is the corner: the first `hi` rows against the last `hi`
    // columns, which is `hi²` cells whatever the sequence is.
    const corner = circular[circular.length - 1]
    expect(corner.rows).toEqual([SPAN.from, SPAN.from + 5])
    expect(corner.cols).toEqual([SPAN.to - 5, SPAN.to])
  })

  it('takes the corner out of the block on screen without reading at all', async () => {
    const values = new Float32Array(n * n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) values[r * n + c] = valueAt(r, c)
    const block: BlockInput = {
      nrows: n,
      ncols: n,
      values,
      rowExtent: [SPAN.from, SPAN.to],
      colExtent: [SPAN.from, SPAN.to],
      binsPerCell: 1,
    }
    const reads: Read[] = []
    const band = await bandFor(job(reads), SPAN, { hi: 4, ...READ, block, circular: true })
    expect(reads).toHaveLength(0)
    expect(band.forward(n - 1, 1)).toBe(valueAt(0, n - 1))
    expect(band.forward(n - 2, 3)).toBe(valueAt(1, n - 2))
  })

  it('never reaches further than half the circle', async () => {
    const band = await bandFor(job(), SPAN, { hi: n - 1, ...READ, circular: true })
    // Past half way the short way round is the other way, so a wider band would
    // hold every cell twice and a curve plotted past it would fold back on itself.
    expect(band.hi).toBe(Math.floor(n / 2))
  })
})

describe('forEachDiagonalTile', () => {
  it('gives every bin to exactly one tile', async () => {
    const owned = new Int32Array(CONTIGS[0].bins)
    await forEachDiagonalTile(job(), SPAN, { halo: 3, ...READ }, (tile) => {
      for (let local = tile.ownFrom; local < tile.ownTo; local++) owned[local]++
    })
    expect(Array.from(owned).every((seen) => seen === 1)).toBe(true)
  })

  it('holds the whole halo around every bin it owns', async () => {
    // The property the insulation diamond depends on, and the only one that
    // decides whether a tiled score equals a whole-square one: a bin's window
    // reaches `halo` each side, so a tile that owns the bin must hold both.
    const halo = 3
    await forEachDiagonalTile(job(), SPAN, { halo, ...READ }, (tile) => {
      for (let local = tile.ownFrom; local < tile.ownTo; local++) {
        const inTile = local - tile.from
        // Clipped at the sequence's own ends, where a partial window is the
        // right answer — and is `NaN` from a whole square too.
        if (local >= halo) expect(inTile - halo).toBeGreaterThanOrEqual(0)
        if (local + halo <= CONTIGS[0].bins) expect(inTile + halo).toBeLessThanOrEqual(tile.size)
      }
    })
  })

  it('hands over the file’s own cells, placed where the tile says', async () => {
    await forEachDiagonalTile(job(), SPAN, { halo: 2, ...READ }, (tile) => {
      for (let r = 0; r < tile.size; r++) {
        for (let c = 0; c < tile.size; c++) {
          expect(tile.values[r * tile.size + c]).toBe(valueAt(tile.from + r, tile.from + c))
        }
      }
    })
  })
})

describe('cisMarginal', () => {
  it('counts what a mirrored dense square would have counted, per bin', async () => {
    const sums = await cisMarginal(job())
    // The dense square of contig I, mirrored, counted the way
    // `detectableFromCounts` does it.
    const n = CONTIGS[0].bins
    const dense = new Float64Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) dense[r * n + c] = r === 3 || c === 3 ? 0 : 1
    }
    const fromSquare = detectableFromCounts(dense, n, 5)
    const fromScan = detectableFromMarginal(sums.subarray(0, n), 5)
    expect(Array.from(fromScan)).toEqual(Array.from(fromSquare))
    // And the number itself, not only the cut it produces.
    for (let bin = 0; bin < n; bin++) {
      let expected = 0
      for (let c = 0; c < n; c++) if (bin !== 3 && c !== 3) expected++
      expect(sums[bin]).toBe(expected)
    }
  })

  it('leaves trans pixels out, because the square it replaces was one contig’s', async () => {
    const sums = await cisMarginal(job())
    // Bin 0 of contig II sees only contig II: 25 bins, none of them the hole,
    // which is on contig I.
    expect(sums[OFFSET[1]]).toBe(CONTIGS[1].bins)
  })
})

// ---------------------------------------------------------------------------
// What the band costs, and when it is refused
// ---------------------------------------------------------------------------

describe('the scan gate', () => {
  /** mm10-ish chromosomes, in bins at the resolution given. */
  function mouse(binsize: number): AnalysisContext {
    const lengths: Array<[string, number]> = [
      ['chr1', 195_471_971],
      ['chr9', 124_595_110],
      ['chr18', 90_702_639],
      ['chr19', 61_431_566],
    ]
    return {
      hasMap: true,
      hasGenomes: false,
      blockLoaded: false,
      binsize,
      contigs: lengths.map(([name, bp]) => ({ name, bins: Math.ceil(bp / binsize) })),
      entries: [],
      framing: null,
    } as unknown as AnalysisContext
  }

  // No `sequences` key at all means every sequence, which is the default the
  // form leaves it at.
  const loops: Params = { pattern: 'loops', thresholds: 'preset' }

  it('counts the band and not the square', () => {
    // `(min(maxDist, n) + kernel + 1) × n` — the three arrays the scan holds are
    // each this many cells, and none of them is ever `n²`.
    expect(scanCellsFor(1000, 400, 17)).toBe(418 * 1000)
    // A short sequence with a scan distance longer than itself is bounded by
    // itself, which is what stops a small contig being priced as a deep one.
    expect(scanCellsFor(100, 5000, 17)).toBe(118 * 100)
  })

  it('lets the whole mouse genome through at 5 kb, which it refused before', () => {
    // The old gate was 8,192 bins: at 5 kb that is 41 Mb, so every one of these
    // was skipped in silence. chr1 is 39,094 bins and its band is 16 million
    // cells — a fortieth of what a scan may hold.
    const estimate = CHROMOSIGHT_TASK.estimate(mouse(5000), loops)
    expect(estimate.refusal).toBeUndefined()
    expect(scanCellsFor(Math.ceil(195_471_971 / 5000), 400, 17)).toBeLessThan(MAX_SCAN_CELLS)
  })

  it('still refuses a deep scan on a fine grid, and says which two things to change', () => {
    // chr1 at 1 kb reaching 2 Mb is 394 million cells, which is three gigabytes
    // of band. Both ways out are settings rather than hardware, so the refusal
    // names them.
    const estimate = CHROMOSIGHT_TASK.estimate(mouse(1000), {
      ...loops,
      sequences: ['chr1'],
      thresholds: 'custom',
      maxDist: 2_000_000,
    })
    // Named by the label the control actually carries, which is lowercase now
    // (§26.4) — and quoted rather than asterisked, since Markdown in a string
    // that reaches the DOM reaches it as asterisks.
    expect(estimate.refusal).toMatch(/“furthest from the diagonal”/)
    expect(estimate.refusal).toMatch(/coarser resolution/)
  })

  it('lets the same chromosome through at 1 kb once the scan distance comes down', () => {
    const estimate = CHROMOSIGHT_TASK.estimate(mouse(1000), {
      ...loops,
      sequences: ['chr1'],
      thresholds: 'custom',
      maxDist: 400_000,
    })
    expect(estimate.refusal).toBeUndefined()
  })
})
