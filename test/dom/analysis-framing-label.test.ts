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
    expect(parts(panel)).toContain('20.0 kb bins')
  })

  it('is still the file’s own when the view pools bins into cells', () => {
    // The regression: `20,000 × 4` came out as `80.0 kb bins`, and every loop
    // set called from this picture was stamped with it.
    const panel = panelAt(20_000)
    panel.setData(block(64, 4), '16')
    const written = parts(panel)
    expect(written).toContain('20.0 kb bins')
    expect(written).not.toContain('80.0 kb bins')
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
