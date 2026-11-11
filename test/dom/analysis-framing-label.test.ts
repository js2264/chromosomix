// @vitest-environment jsdom
/**
 * The line a computed track carries under its name, and the two things it said
 * that were not true.
 *
 * `AnalysisFraming.label` is the whole of what a reader is told about *what a
 * result is a measurement of*. It is printed on the drawer's header, on the
 * exported figure's caption, and — where it matters most, because it outlives
 * both — as the provenance line of every synthetic track the run produced. A
 * loop set exported to a collaborator is defended by that line and nothing else.
 *
 * Two of its parts were wrong, and both were wrong in the direction that reads
 * as plausible:
 *
 * - **The bin size was the screen's, not the file's.** `binsPerCell` is how many
 *   bins the view sums into one drawn cell when it is zoomed out, and it was
 *   multiplied into the reported bin size — so a 20 kb file looked at four bins
 *   to the cell reported `80.0 kb bins`. No task is ever computed at that
 *   number: `run/blocks.ts` refuses a pooled block outright and every task reads
 *   the file at its own resolution. The line named a resolution that never
 *   existed, on results that were not measured at it.
 *
 * - **A turned map's rows were read as positions.** Rotating a map puts
 *   separation on the vertical axis, and the subject was built from that axis —
 *   giving `16:49,540,000--20,000`, a chromosome locus with a negative end.
 *
 * Both are asserted through the panel's own `analysisFraming`, which is the
 * seam the runner takes, so what is pinned is the string a result would actually
 * be stamped with.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { analysisGridOf, carryExtent, offsetsOf } from '@/metacooler/coarsen'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
})

/** An on-diagonal square of one contig, pooled however the view would pool it. */
function block(bins: number, binsPerCell = 1): MatrixResult {
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins),
    rowExtent: [0, bins],
    colExtent: [0, bins],
    rowGroups: [{ label: '16', start: 0, end: bins, unitStart: 0 }],
    colGroups: [{ label: '16', start: 0, end: bins, unitStart: 0 }],
    level: 'bin',
    binsPerCell,
  } as unknown as MatrixResult
}

function panelAt(binsize: number): MatrixPanel {
  const panel = new MatrixPanel({ binsize, detachedControls: true, hideTitle: true })
  built.push(panel)
  document.body.append(panel.el)
  return panel
}

/** The label's parts, which is how it is written and how it reads. */
function parts(panel: MatrixPanel): string[] {
  const framing = panel.analysisFraming('f.mcool')
  expect(framing, 'the panel has no framing to report').not.toBeNull()
  return framing!.label.split(' · ')
}

describe('the bin size a framing reports', () => {
  it('is the file’s own, on a view drawn cell for bin', () => {
    const panel = panelAt(20_000)
    panel.setData(block(64), '16')
    // `20 kb`, not `20.0 kb`: a bin size is a round number by construction and
    // takes `resolutionLabel` (§26.2), so the crumb, this line and the map's
    // key spell one number one way. The decimal stays on a measured span.
    expect(parts(panel)).toContain('20 kb bins')
  })

  it('is still the file’s own when the view pools bins into cells', () => {
    // The regression: `20,000 × 4` came out as `80 kb bins`, and every loop
    // set called from this picture was stamped with it.
    const panel = panelAt(20_000)
    panel.setData(block(64, 4), '16')
    const written = parts(panel)
    expect(written).toContain('20 kb bins')
    expect(written).not.toContain('80 kb bins')
  })

  it('says the pooling separately, because it is a fact about the picture', () => {
    const panel = panelAt(20_000)
    panel.setData(block(64, 4), '16')
    expect(parts(panel)).toContain('4 per drawn cell')
    // …and says nothing at all where there is no pooling, which is every view a
    // reader is zoomed into and the case the line must stay short for.
    const plain = panelAt(20_000)
    plain.setData(block(64), '16')
    expect(parts(plain).some((part) => part.includes('per drawn cell'))).toBe(false)
  })

  it('records the pooling as a number of its own, for the tasks that check it', () => {
    // The field is separate from the label and always was; what changed is that
    // the label no longer folds it into the bin size. Both are needed: a task
    // reads this to decline the view's block (`run/blocks.ts`).
    const panel = panelAt(20_000)
    panel.setData(block(64, 4), '16')
    const framing = panel.analysisFraming('f.mcool')!
    expect(framing.binsize).toBe(20_000)
    expect(framing.binsPerCell).toBe(4)
  })
})

describe('the region a framing names', () => {
  it('is the subject itself when the whole sequence is on screen', () => {
    const panel = panelAt(20_000)
    panel.setData(block(64), '16')
    expect(parts(panel)[0]).toBe('16')
  })

  it('never writes a locus that runs backwards', () => {
    // A turned map is where this went wrong, and the assertion is written as the
    // invariant rather than as one string: whatever the picture, the subject is
    // either a name or a range that reads forwards from a position that exists.
    const panel = panelAt(20_000)
    // The turn is a setting the block is derived under, so it goes in before
    // the block does — `setTurn`'s own note says why.
    panel.setTurn({ on: true, direction: 'up' })
    panel.setData(block(64), '16')
    const subject = parts(panel)[0]
    const range = /^(?<name>.+):(?<from>-?[\d,]+)-(?<to>-?[\d,]+)$/.exec(subject)
    if (range !== null) {
      const from = Number(range.groups!.from.replace(/,/g, ''))
      const to = Number(range.groups!.to.replace(/,/g, ''))
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeGreaterThan(from)
    }
    expect(subject).not.toContain('--')
  })
})

describe('a view at a resolution the reader added (§3.4)', () => {
  /** 3 kb*: a 1 kb file's sequence of 300 bins, summed three at a time. */
  const derived = analysisGridOf([300_000], { name: '1000', binsize: 1000 }, 3).grid

  it('is framed in its own bins, with the * the picker gives it', () => {
    const panel = panelAt(1000)
    panel.setData(block(300, 3), '16')
    const framing = panel.analysisFraming('f.mcool', derived)!
    // Every task reads the map summed to it, so the window is counted in its
    // bins and the bin size is the one with the asterisk.
    expect(framing.binsize).toBe(3000)
    expect(framing.coarsen).toBe(3000)
    expect(framing.rows).toEqual([0, 100])
    expect(framing.cols).toEqual([0, 100])
    expect(framing.binsPerCell).toBe(1)
    const written = framing.label.split(' · ')
    expect(written).toContain('3 kb* bins')
    expect(written).not.toContain('1 kb bins')
    expect(written.some((part) => part.includes('per drawn cell'))).toBe(false)
  })

  it('counts the cells a zoomed-out picture sums in those bins too', () => {
    const panel = panelAt(1000)
    panel.setData(block(300, 6), '16')
    const framing = panel.analysisFraming('f.mcool', derived)!
    expect(framing.binsPerCell).toBe(2)
    expect(framing.label.split(' · ')).toContain('2 per drawn cell')
  })

  it('carries a window onto the coarse grid, covering every bin of it', () => {
    const panel = panelAt(1000)
    panel.setData({ ...block(300, 3), rowExtent: [30, 90], colExtent: [60, 151] } as MatrixResult, '16')
    const framing = panel.analysisFraming('f.mcool', derived)!
    expect(framing.rows).toEqual([10, 30])
    expect(framing.cols).toEqual([20, 51])
  })

  it('is the file’s own, as it was, at a rung the file stores', () => {
    const panel = panelAt(1000)
    panel.setData(block(300, 3), '16')
    const framing = panel.analysisFraming('f.mcool')!
    expect(framing.binsize).toBe(1000)
    expect(framing.coarsen).toBeUndefined()
    expect(framing.rows).toEqual([0, 300])
  })
})

describe('a view at a rung the crumb row names (§3.4)', () => {
  /**
   * A 10 kb map of two sequences, 1.25 Mb and 0.8 Mb: 125 and 80 bins at 10 kb,
   * 50 and 32 at 25 kb — so carrying a window between the two is not a division
   * past the first sequence.
   */
  const LENGTHS = [1_250_000, 800_000]

  it('is framed in the picked rung’s bins, read from its own entry', () => {
    // 25 kb picked over a file open at 10 kb, and drawn at it: the block is the
    // 25 kb rung's, and so is every number a task is framed by.
    const { grid, nBins } = analysisGridOf(LENGTHS, { name: '25000', binsize: 25_000 })
    expect(nBins).toBe(82)
    const panel = panelAt(10_000)
    panel.setData({ ...block(82), binsize: 25_000 } as MatrixResult, '16')
    const framing = panel.analysisFraming('f.mcool::resolutions/25000', grid)!
    expect(framing.uri).toBe('f.mcool::resolutions/25000')
    expect(framing.binsize).toBe(25_000)
    expect(framing.rows).toEqual([0, 82])
    expect(framing.binsPerCell).toBe(1)
    expect(framing.coarsen).toBeUndefined()
    expect(framing.label.split(' · ')).toContain('25 kb bins')
  })

  it('carries a coarser block onto the pick, for a window too wide to draw at it', () => {
    // 10 kb picked over a file open at 25 kb, and the window drawn at 25 kb: the
    // second sequence's first 25 kb bin is the 125th 10 kb one, not the 50th
    // times two and a half.
    const { grid } = analysisGridOf(LENGTHS, { name: '10000', binsize: 10_000 })
    const panel = panelAt(25_000)
    panel.setData({ ...block(82), rowExtent: [50, 82], colExtent: [0, 82] } as MatrixResult, '16')
    const framing = panel.analysisFraming('f.mcool::resolutions/10000', grid)!
    expect(framing.binsize).toBe(10_000)
    expect(framing.rows).toEqual([125, 205])
    expect(framing.cols).toEqual([0, 205])
    // Two and a half of its bins to a drawn cell, said as the nearest whole.
    expect(framing.binsPerCell).toBe(3)
  })

  it('carries an extent through base pairs, one sequence at a time', () => {
    const ten = { binsize: 10_000, offsets: offsetsOf(LENGTHS, 10_000) }
    const quarter = { binsize: 25_000, offsets: offsetsOf(LENGTHS, 25_000) }
    // The last 10 kb bin of the first sequence is in its last, part-filled
    // 25 kb one; the second's first bins start a bin of their own.
    expect(carryExtent([124, 126], ten, quarter, LENGTHS)).toEqual([49, 51])
    // Back the other way: 1,225,000–1,250,000 of the first and 0–25,000 of the
    // second are 10 kb bins 122–124 and 125–127.
    expect(carryExtent([49, 51], quarter, ten, LENGTHS)).toEqual([122, 128])
    // Clamped to the map, and empty where it is empty.
    expect(carryExtent([0, 10_000], ten, quarter, LENGTHS)).toEqual([0, 82])
    expect(carryExtent([7, 7], ten, quarter, LENGTHS)).toEqual([2, 2])
  })
})
