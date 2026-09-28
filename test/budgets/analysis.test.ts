/**
 * The §12 analysis budgets, as hard assertions.
 *
 * | Operation | Budget |
 * |---|---|
 * | Insulation / coverage / P(s), block already loaded | **0** range requests |
 * | Insulation, block not loaded (remote) | ≤ 5 per contig |
 * | 4C, cis (remote) | ≤ 5 |
 * | APA, k windows, remote | ≤ 2 per *coalesced* window |
 * | Correlation / eigenvectors | 0 beyond the block |
 *
 * Same substitution as `requests.test.ts`, for the same reason: §12 measures a
 * *remote* file, and {@link CountingRangeSource} serves a local one through the
 * production `RemoteRangeSource` — its 1 MiB chunks, its coalescing, its LRU and
 * its counter — so the count is the count the real remote path would produce for
 * the same access pattern.
 *
 * The file is different, and deliberately: `demo/yeast/Yeast_microC_G2M_1kb.cool`
 * is **committed**, so unlike the reference metacool this suite actually runs
 * wherever the repository is checked out. 12,118 bins at 1 kb across sixteen
 * chromosomes, 13.7 M non-zero pixels, 19 MB — nineteen chunks, which is enough
 * that a task reading badly cannot hide inside one.
 *
 * ## The row that is not here, and where it is instead
 *
 * §12's first analysis row — *any analysis task, effect on the view: 0 dropped
 * frames, 0 blocked reader requests* — is a statement about **two workers**, and
 * no count of range requests can express it. It holds because the analysis
 * worker mounts the file itself and the reader worker is never asked for
 * anything during a run (`analysis/worker/`), which is a fact about the message
 * graph rather than about I/O. `analysis-runner.test.ts` is where that is
 * pinned. What this file can prove is the other nine rows, which are about how
 * much a task reads — and those are the ones a careless implementation breaks.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { PileupAccumulator } from '@/analysis/apa'
import {
  correlationMatrix,
  observedOverExpected,
  singleGroupPlan,
  usableBins,
} from '@/analysis/compartments'
import { CoverageAccumulator } from '@/analysis/coverage'
import { ExpectedAccumulator } from '@/analysis/expected'
import { diamondTotals, insulationScore } from '@/analysis/insulation'
import { leadingEigenpairs } from '@/analysis/linalg'
import { MetaCooler } from '@/metacooler/MetaCooler'
import type { DenseMatrix } from '@/types'

import { CountingRangeSource } from '../support/counting'

/** SPECS §12, verbatim. */
const BUDGET = {
  fromLoadedBlock: 0,
  insulationPerContig: 5,
  viewpointCis: 5,
  apaPerWindow: 2,
  eigenvectorsBeyondBlock: 0,
} as const

const COOLER = new URL('../../demo/yeast/Yeast_microC_G2M_1kb.cool', import.meta.url).pathname

/** A middling chromosome: 316 bins, big enough to be a real read and quick to hold. */
const CHROM = 'III'
/** The largest, for the per-contig insulation budget where size is the point. */
const BIG = 'IV'

const suite = existsSync(COOLER) ? describe : describe.skip

async function open(): Promise<{ mc: MetaCooler; source: CountingRangeSource }> {
  const source = await CountingRangeSource.open(COOLER)
  const mc = await MetaCooler.open(COOLER, source)
  return { mc, source }
}

/** One contig's square, as every on-diagonal task asks for it. */
async function square(mc: MetaCooler, chrom: string): Promise<DenseMatrix> {
  const extent = mc.contigExtent(chrom)
  return mc.matrix({ rows: extent, cols: extent, balance: false })
}

suite('§12 — analysis over a remote cooler', () => {
  it('costs nothing at all when the block is already loaded', async () => {
    // The row three tasks share, and the reason `run/blocks.ts` exists. A reader
    // who presses Run while looking at the thing they want measured must not pay
    // for a second read of it — which is a claim about the *decision*, so all
    // three are run against one block and the counter is read once at the end.
    const { mc, source } = await open()
    try {
      const dense = await square(mc, CHROM)
      expect(source.rawReads, 'reads were intercepted').toBeGreaterThan(0)
      source.resetStats()

      const expected = new ExpectedAccumulator(dense.nrows - 1)
      expected.addBlock(dense)
      expected.finish()

      insulationScore(
        diamondTotals({ size: dense.nrows, values: dense.values }, { window: 10, ignoreDiags: 2 }),
      )

      const coverage = new CoverageAccumulator(dense.nrows, new Int32Array(dense.nrows))
      coverage.addBlock({
        nrows: dense.nrows,
        ncols: dense.ncols,
        values: dense.values,
        rowExtent: [0, dense.nrows],
        colExtent: [0, dense.ncols],
      })
      coverage.finish()

      const { requests } = source.stats()
      expect(requests, `P(s) + insulation + coverage cost ${requests} requests`).toBe(
        BUDGET.fromLoadedBlock,
      )
    } finally {
      mc.close()
    }
  })

  it(`reads a contig for insulation in ≤ ${BUDGET.insulationPerContig} requests`, async () => {
    // The block-not-loaded path: one bounded read of one contig's square, and
    // nothing else. The largest chromosome in the file, because a budget that
    // only holds for a small one is a budget that holds by accident.
    const { mc, source } = await open()
    try {
      await square(mc, CHROM)
      source.resetStats()
      const dense = await square(mc, BIG)
      insulationScore(
        diamondTotals({ size: dense.nrows, values: dense.values }, { window: 25, ignoreDiags: 2 }),
      )
      const { requests, bytes } = source.stats()
      expect(
        requests,
        `insulation over ${BIG} (${dense.nrows} bins) cost ${requests} requests / ${bytes} bytes`,
      ).toBeLessThanOrEqual(BUDGET.insulationPerContig)
    } finally {
      mc.close()
    }
  })

  it(`reads a cis 4C anchor in ≤ ${BUDGET.viewpointCis} requests`, async () => {
    // Cis 4C is a band of rows over one contig, which is a sub-rectangle of that
    // contig's square — never wider than the square itself, which is what makes
    // this the same budget as a genome-pair block rather than a scan.
    const { mc, source } = await open()
    try {
      const [from, to] = mc.contigExtent(CHROM)
      await square(mc, BIG)
      source.resetStats()
      const anchor = Math.floor((from + to) / 2)
      await mc.matrix({ rows: [anchor, anchor + 5], cols: [from, to], balance: false })
      const { requests, bytes } = source.stats()
      expect(requests, `4C cost ${requests} requests / ${bytes} bytes`).toBeLessThanOrEqual(
        BUDGET.viewpointCis,
      )
    } finally {
      mc.close()
    }
  })

  it(`reads k APA windows in ≤ ${BUDGET.apaPerWindow} requests each`, async () => {
    // Windows are coalesced by being cut out of the contig square they all sit
    // in — which is why the budget is per *coalesced* window and why eight
    // windows on one chromosome cost one read rather than eight. A future
    // implementation that reads each window separately would still pass a
    // per-window budget and would be eight times slower over HTTP; the assertion
    // below is therefore against the total, with the count stated.
    const { mc, source } = await open()
    try {
      await square(mc, BIG)
      source.resetStats()
      const dense = await square(mc, CHROM)
      const width = 11
      const flank = 5
      const accumulator = new PileupAccumulator(width, width)
      let windows = 0
      for (let anchor = 20; anchor + 60 + width < dense.nrows; anchor += 25) {
        const r0 = anchor - flank
        const c0 = anchor + 60 - flank
        const window = new Float32Array(width * width)
        for (let r = 0; r < width; r++) {
          for (let c = 0; c < width; c++) {
            window[r * width + c] = dense.values[(r0 + r) * dense.ncols + (c0 + c)]
          }
        }
        accumulator.add(window)
        windows++
      }
      expect(windows, 'the loop produced windows to pile up').toBeGreaterThan(4)
      const { requests } = source.stats()
      expect(
        requests,
        `${windows} windows cost ${requests} requests in total`,
      ).toBeLessThanOrEqual(BUDGET.apaPerWindow * windows)
      // And the stronger claim the coalescing actually buys.
      expect(requests, 'windows on one contig coalesce into one read').toBeLessThanOrEqual(
        BUDGET.insulationPerContig,
      )
    } finally {
      mc.close()
    }
  })

  /**
   * What the analysis worker's own byte source costs, as a number.
   *
   * `TASKS_PLAN.md` open question 1: the analysis worker mounts the file itself
   * (§18.3), so it has a `RemoteRangeSource` of its own and a chunk cache of its
   * own, and a chunk the view has already fetched is fetched a second time. The
   * question was whether that is small. It has no answer from inspection —
   * whether it is small depends entirely on how much of what a task reads the
   * view was already looking at — so it is measured here rather than argued
   * about.
   *
   * The measurement is a difference, which is what makes it exact. One source
   * does the view's read and then the analysis reads, which is what a *shared*
   * cache would cost; two independent sources do the same two things, which is
   * what the split actually costs. Their difference is the duplicated bytes, and
   * nothing else is.
   *
   * **The measured answer, when this was written: 1,048,576 bytes — exactly one
   * 1 MiB chunk.** 9.0 % of the 11.6 MB the shared cache would have moved, against
   * a view block of 6.4 MB. So the duplication is not proportional to what the
   * analysis reads and is not proportional to what the view holds either: it is
   * the chunks where the two access patterns overlap, at chunk granularity, and
   * on a file where the view is sitting on one of the four chromosomes being
   * scanned that is one chunk. Open question 1 is answered, and the `SharedWorker`
   * fallback it named is not warranted.
   *
   * The assertion is a ceiling rather than that figure, since the figure depends
   * on which chromosome the reader happened to be looking at. What it pins is the
   * shape of the answer: overlap is bounded by the view's own block, so the
   * duplication cannot exceed one map's worth however long the scan runs — which
   * is the property that makes the second source affordable, and the one that
   * would stop holding if a task ever re-read the view's region per contig.
   */
  it('duplicates no more than the view’s own block across the two workers', async () => {
    const analysisReads = async (mc: MetaCooler): Promise<void> => {
      // Per-contig insulation over four chromosomes, one of which the view is on.
      for (const chrom of [CHROM, BIG, 'VI', 'I']) await square(mc, chrom)
    }

    const shared = await open()
    let sharedBytes = 0
    let viewBytes = 0
    try {
      await square(shared.mc, CHROM)
      viewBytes = shared.source.stats().bytes
      await analysisReads(shared.mc)
      sharedBytes = shared.source.stats().bytes
    } finally {
      shared.mc.close()
    }

    const reader = await open()
    const analysis = await open()
    let splitBytes = 0
    try {
      await square(reader.mc, CHROM)
      await analysisReads(analysis.mc)
      splitBytes = reader.source.stats().bytes + analysis.source.stats().bytes
    } finally {
      reader.mc.close()
      analysis.mc.close()
    }

    const duplicated = splitBytes - sharedBytes
    const percent = ((duplicated / sharedBytes) * 100).toFixed(1)
    expect(
      duplicated,
      `the second source re-fetched ${duplicated} bytes (${percent}% of ${sharedBytes})`,
    ).toBeGreaterThanOrEqual(0)
    // Bounded by what the view had, not by what the analysis reads: the only
    // chunks that can be duplicated are the ones the view already holds.
    expect(
      duplicated,
      `duplicated ${duplicated} bytes against a view block of ${viewBytes}`,
    ).toBeLessThanOrEqual(viewBytes)
  })

  it('computes eigenvectors with no request beyond the block', async () => {
    const { mc, source } = await open()
    try {
      const dense = await square(mc, CHROM)
      source.resetStats()
      const index = usableBins(dense.values, dense.nrows)
      const curve = new ExpectedAccumulator(dense.nrows - 1)
      curve.addBlock(dense)
      const oe = observedOverExpected(
        dense.values,
        dense.nrows,
        index,
        singleGroupPlan(dense.nrows, curve.finish()),
      )
      const pairs = leadingEigenpairs(await correlationMatrix(oe, index.length), index.length, 2)
      expect(pairs.length, 'the solver produced components to be free about').toBe(2)
      const { requests } = source.stats()
      expect(requests, `the compartment chain cost ${requests} requests`).toBe(
        BUDGET.eigenvectorsBeyondBlock,
      )
    } finally {
      mc.close()
    }
  })
})
