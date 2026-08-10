/**
 * The spec §12 request budgets, as hard assertions (M2 harness, M4 criterion).
 *
 * | Operation | Budget |
 * |---|---|
 * | Open + render genomes table | ≤ 20 range requests |
 * | Load one MAG's matrix | ≤ 5 |
 * | Genome-pair block | ≤ 5 |
 * | Pan/zoom within the block in hand | **0** |
 * | Refine, after a settled zoom | ≤ 5 |
 *
 * ## The row that changed, and why it is two rows
 *
 * §12 used to say *pan/zoom within a loaded genome: 0 requests*, full stop, and
 * the test below asserted it with the comment that *"there is no tiling and no
 * progressive refine precisely because this costs nothing"*. There is now a
 * progressive refine (`ui/refine.ts`), so that sentence had to be re-earned
 * rather than deleted: **a gesture still costs nothing**, and what costs a read
 * is the *settled* zoom afterwards — once, when the picture has stopped moving,
 * bounded by the same window a region load already pays for. The first row is
 * therefore unchanged and still asserted at exactly zero; the second is new.
 *
 * ## The substitution
 *
 * §12 measures a *remote* file and no bucket exists yet (M5). These numbers are
 * therefore measured through {@link CountingRangeSource}, which serves a local
 * file but drives every byte through the production
 * `RemoteRangeSource` — its 1 MiB chunks, its coalescing, its LRU and its
 * counter — so the count is the count the real remote path would produce for
 * the same access pattern. Only the HTTP transport is stubbed, at the bottom,
 * by a synchronous `XMLHttpRequest` that answers a `Range` header out of a
 * buffer. See `test/support/counting.ts` for why the bytes cannot be served
 * through h5wasm's own lazy-file node under Node.
 *
 * Every assertion is `toBeLessThanOrEqual` against the *spec's* number, with
 * the measured number printed on failure — so a regression that stays inside
 * the budget does not fail, and one that leaves it says by how much.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { rasterize } from '@/render/heatmap'
import type { DenseMatrix, Extent } from '@/types'
import { CountingRangeSource } from '../support/counting'
import { FIXTURE_DIR } from '../support/goldens'

/** Spec §12, verbatim. */
const BUDGET = {
  openAndGenomes: 20,
  genomeMatrix: 5,
  pairMatrix: 5,
  panZoom: 0,
  refine: 5,
} as const

const REFERENCE = new URL('../../data/Hum53.metacool', import.meta.url).pathname

interface Session {
  mc: MetaCooler
  source: CountingRangeSource
}

async function open(path: string): Promise<Session> {
  const source = await CountingRangeSource.open(path)
  const mc = await MetaCooler.open(path, source)
  return { mc, source }
}

/**
 * What the landing view costs beyond the open itself: the density proxy for
 * every displayable genome (spec §4, §5.1). `handleGenomes` in the worker does
 * exactly this loop, and it is two `bin1_offset` lookups per genome — the
 * reason the column is free is that they all fall in chunks already fetched.
 */
function renderGenomesTable(mc: MetaCooler): number {
  let sum = 0
  for (const index of mc.displayGenomes()) sum += mc.genomeDensity(index)
  return sum
}

/** Crop a loaded block, the way a zoomed viewport reads out of it. No I/O. */
function crop(m: DenseMatrix, rows: Extent, cols: Extent): DenseMatrix {
  const nrows = rows[1] - rows[0]
  const ncols = cols[1] - cols[0]
  const values = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      values[r * ncols + c] = m.values[(rows[0] + r) * m.ncols + (cols[0] + c)]
    }
  }
  return {
    nrows,
    ncols,
    values,
    rowExtent: [m.rowExtent[0] + rows[0], m.rowExtent[0] + rows[1]],
    colExtent: [m.colExtent[0] + cols[0], m.colExtent[0] + cols[1]],
  }
}

/**
 * The budget suite, run against whichever files are available.
 *
 * `basic.metacool` always runs, so CI without the 26 MB reference file still
 * asserts the shape of the cost. The reference file is where the numbers are
 * meaningful: 4395 genomes, 154468 contigs, 422967 bins, a 26 MB file that no
 * chunk cache can accidentally hold in one request.
 */
function budgetSuite(label: string, path: string): void {
  describe(label, () => {
    it(`opens and renders the genomes table in ≤ ${BUDGET.openAndGenomes} requests`, async () => {
      const source = await CountingRangeSource.open(path)
      const mc = await MetaCooler.open(path, source)
      try {
        renderGenomesTable(mc)
        const { requests, bytes } = source.stats()
        // The stub would silently fall back to the real file if the read
        // interception missed, and every count would then be zero.
        expect(source.rawReads, 'reads were intercepted').toBeGreaterThan(0)
        expect(
          requests,
          `open + genomes table cost ${requests} requests / ${bytes} bytes ` +
            `(raw HDF5 reads: ${source.rawReads})`,
        ).toBeLessThanOrEqual(BUDGET.openAndGenomes)
      } finally {
        mc.close()
      }
    })

    it(`loads one MAG's matrix in ≤ ${BUDGET.genomeMatrix} requests`, async () => {
      const { mc, source } = await open(path)
      try {
        renderGenomesTable(mc)
        // Measure the view change on its own: everything the landing view
        // already paid for is cached, which is the point of the budget.
        source.resetStats()
        const genome = mc.genomeNames[mc.displayGenomes()[0]]
        const block = await mc.genomeMatrix(genome)
        expect(block.nrows).toBeGreaterThan(0)
        const { requests, bytes } = source.stats()
        expect(
          requests,
          `${genome} (${block.nrows}×${block.ncols}) cost ${requests} requests / ${bytes} bytes`,
        ).toBeLessThanOrEqual(BUDGET.genomeMatrix)
      } finally {
        mc.close()
      }
    })

    it(`loads a genome-pair block in ≤ ${BUDGET.pairMatrix} requests`, async () => {
      const { mc, source } = await open(path)
      try {
        renderGenomesTable(mc)
        const display = mc.displayGenomes()
        const rowGenome = mc.genomeNames[display[0]]
        const colGenome = mc.genomeNames[display[display.length - 1]]
        source.resetStats()
        const block = await mc.genomePairMatrix(rowGenome, colGenome)
        expect(block.nrows).toBeGreaterThan(0)
        const forward = source.stats().requests
        expect(
          forward,
          `${rowGenome}×${colGenome} cost ${forward} requests`,
        ).toBeLessThanOrEqual(BUDGET.pairMatrix)

        // The transposed orientation reads the *other* genome's band, so it is
        // a separate bounded read and gets its own budget rather than riding
        // on the first one's cache.
        source.resetStats()
        await mc.genomePairMatrix(colGenome, rowGenome)
        const reverse = source.stats().requests
        expect(
          reverse,
          `${colGenome}×${rowGenome} (transposed) cost ${reverse} requests`,
        ).toBeLessThanOrEqual(BUDGET.pairMatrix)
      } finally {
        mc.close()
      }
    })

    it('refines a settled zoom in ≤ ' + String(BUDGET.refine) + ' requests', async () => {
      const { mc, source } = await open(path)
      try {
        const genome = mc.genomeNames[mc.displayGenomes()[0]]
        const [lo, hi] = mc.genomeExtent(genome)
        await mc.matrix({ rows: [lo, hi] })

        // What a refine asks for: the middle half of what is on screen, padded
        // by half a window on each side (`ui/refine.ts`'s REFINE_PAD) — so a
        // window of half the genome, which is the first step of the staircase.
        const span = hi - lo
        const window: Extent = [lo + Math.floor(span / 4), hi - Math.floor(span / 4)]
        source.resetStats()
        await mc.matrix({ rows: window })

        const { requests, bytes } = source.stats()
        expect(
          requests,
          `a refine cost ${requests} requests / ${bytes} bytes`,
        ).toBeLessThanOrEqual(BUDGET.refine)
      } finally {
        mc.close()
      }
    })

    it('does zero I/O while panning, zooming and toggling level', async () => {
      const { mc, source } = await open(path)
      try {
        const genome = mc.genomeNames[mc.displayGenomes()[0]]
        const block = await mc.genomeMatrix(genome)
        expect(block.nrows).toBeGreaterThan(1)

        source.resetStats()
        // A pan/zoom session: eight viewports at four zoom levels, each
        // rasterised, plus both level toggles. All of it is arithmetic over the
        // block already in memory (§2, §5.2).
        //
        // This is still exactly zero, and it is the half of §12 that the refine
        // did not change: `HeatmapView` holds no reader and `MatrixPanel` holds
        // no reader client, so nothing a *gesture* does can reach a byte. What
        // reaches a byte is the policy above the panel, once the window has
        // settled, and it is measured by the test before this one — deliberately
        // as a separate budget, because the property worth protecting is that
        // the two are separable at all.
        for (const divisor of [1, 2, 4, 8]) {
          const span = Math.max(1, Math.floor(block.nrows / divisor))
          for (const offset of [0, block.nrows - span]) {
            const window = crop(block, [offset, offset + span], [offset, offset + span])
            rasterize(window, { vmin: 0, vmax: 10, transform: 'log1p', colormap: 'afmhot_r' })
          }
        }
        mc.aggregate(block, 'contig')
        mc.aggregate(block, 'genome')

        const { requests, bytes } = source.stats()
        expect(source.rawReads, 'HDF5 was not even asked').toBe(0)
        expect(requests, `pan/zoom issued ${requests} requests / ${bytes} bytes`).toBe(
          BUDGET.panZoom,
        )
      } finally {
        mc.close()
      }
    })
  })
}

budgetSuite('basic.metacool', `${FIXTURE_DIR}basic.metacool`)

describe.skipIf(!existsSync(REFERENCE))('Hum53.metacool (26 MB, 4395 genomes)', () => {
  budgetSuite('reference file', REFERENCE)

  /**
   * A tripwire, not a §12 budget.
   *
   * §4's cost table calls opening a file "kilobytes". On this real MetaTOR
   * file it is **megabytes**: measured at 16 requests and 17.1 MB of a 26.5 MB
   * file, because `/contigs` carries 16 optional MetaTOR columns over 154 468
   * rows and `readTable` reads every column the creator wrote (§5.1 wants
   * exactly that). The request budget is comfortably met — it is the *bytes*
   * the spec is optimistic about, and on a slow connection that is the
   * difference between the ≤ 3 s time-to-interactive target and missing it.
   *
   * That fix has since landed: `MetaCooler.fromHandle` reads only the columns
   * the reader itself uses, and the table views read the full width when they
   * open. So the bound below is a *per-row* one rather than a round number —
   * loose enough not to be brittle, tight enough that reading the optional
   * metadata eagerly again would fail it, which the old 20 MB ceiling would
   * have let straight through.
   */
  it('records what opening the reference file actually costs', async () => {
    const { mc, source } = await open(REFERENCE)
    try {
      renderGenomesTable(mc)
      const { requests, bytes } = source.stats()
      expect(mc.nGenomes).toBe(4395)
      expect(mc.nContigs).toBe(154_468)
      expect(
        bytes,
        `open + genomes table read ${bytes} bytes in ${requests} requests, of a ` +
          `${source.size}-byte file`,
      ).toBeLessThan(source.size)
      // The pixel table is 4.57 M pixels; not scanning it is what keeps the
      // open bounded at all, and it is the one thing that must never regress.
      expect(bytes).toBeLessThan(20 * 1024 * 1024)
      // And a bound that scales with the file rather than with a guess: the
      // reader needs a name, a length and a genome id per contig, plus the two
      // offset arrays. Anything materially past that is a column being decoded
      // that nothing is about to show.
      const perRow = bytes / mc.nContigs
      expect(
        perRow,
        `open + genomes table read ${perRow.toFixed(1)} bytes per contig`,
      ).toBeLessThan(64)
    } finally {
      mc.close()
    }
  })
})
