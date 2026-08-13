/**
 * What a metagenome's whole-file views answer with, and what they refuse.
 *
 * Four rules, and they are one rule seen from four sides: **on a metacool the
 * unit is the MAG**. A click on any of the three whole-file levels opens a
 * genome, an anchor may *be* a genome, a pick on an axis of genomes names one,
 * and the two features that assume a shared coordinate system with a second
 * file — the lower-left triangle and the deck — are not offered at all.
 *
 * The DOM halves are pinned in `test/dom/`; what is here is the arithmetic each
 * of them dispatches on, which is where the rules can be stated once and read.
 */

import { describe, expect, it } from 'vitest'

import { FOURC_TASK } from '@/analysis/tasks/fourc'
import type { AnalysisContext, AnalysisFraming } from '@/analysis/types'
import { LocusAxis } from '@/render/locus'
import { bandRegion } from '@/ui/MatrixPanel'
import { locusText } from '@/ui/mapPick'
import { overviewTarget } from '@/ui/Overview'

/** Two MAGs of two contigs each, as the analysis layer sees them. */
function context(over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    uri: 'gut.metacool',
    layout: 'metacool',
    hasMap: true,
    hasGenomes: true,
    hasWeights: false,
    scoreColumns: [],
    binsize: 1000,
    nBins: 40,
    contigs: [
      { name: 'NODE_1', startBin: 0, bins: 10, length: 10_000, genome: 0 },
      { name: 'NODE_2', startBin: 10, bins: 10, length: 10_000, genome: 0 },
      { name: 'NODE_3', startBin: 20, bins: 20, length: 20_000, genome: 1 },
    ],
    genomes: [
      { name: 'MAG_1', extent: [0, 20], contigs: 2 },
      { name: 'MAG_2', extent: [20, 40], contigs: 1 },
    ],
    entries: [],
    framing: null,
    blockLoaded: false,
    blockBytes: 0,
    ...over,
  }
}

function framing(level: 'bin' | 'contig' | 'genome', rows: [number, number]): AnalysisFraming {
  return {
    uri: 'gut.metacool',
    label: 'whole metagenome',
    binsize: 1000,
    binsPerCell: 1,
    rows,
    cols: rows,
    balance: false,
    value: 'count',
    normalise: null,
    level,
  }
}

describe('a click on a whole-file picture', () => {
  // The rule the bin × bin level was missing: its cells are bins and its runs
  // are contigs, but the axis is divided and labelled by genome, and the two
  // coarser levels have always opened one. `WholeView` dispatches on this.
  it('opens one genome when both axes are inside it', () => {
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: 'NODE_1',
        colLabel: 'NODE_2',
        rowGenome: 'MAG_1',
        colGenome: 'MAG_1',
      }),
    ).toEqual({ kind: 'genome', genome: 'MAG_1' })
  })

  it('falls through to the sequence where there are no genomes at all', () => {
    // A cooler reaches the same code with no genome runs behind it, and there
    // the answer has always been — and stays — the chromosome.
    expect(
      overviewTarget({ level: 'contig', rowLabel: 'chrIV', colLabel: 'chrIV' }),
    ).toEqual({ kind: 'contig', rowContig: 'chrIV' })
  })
})

describe('a pick on an axis with no coordinates inside it', () => {
  it('is written as the bare name of the unit', () => {
    // A genome × genome map has one cell per MAG and no base pair anywhere in
    // it, so the honest answer is a name — and a name is what every range
    // grammar here already takes for the whole of a unit.
    expect(locusText({ contig: 'MAG_2', start: 0, end: 0, whole: true })).toBe('MAG_2')
  })

  it('is written as a span everywhere else', () => {
    expect(locusText({ contig: 'NODE_1', start: 999, end: 2000 })).toBe('NODE_1:1000-2000')
  })
})

describe('the 4C anchor', () => {
  const estimate = (anchor: string, over: Partial<AnalysisContext> = {}) =>
    FOURC_TASK.estimate?.(context(over), { anchor, cis: true })

  it('takes a genome, which is what a click on a genome × genome map means', () => {
    // The runner has always resolved one — cis is then the whole MAG — and the
    // estimate refused it, so the name the picture is labelled with could not
    // be used on the picture it came from.
    const cost = estimate('MAG_2')
    expect(cost?.refusal).toBeUndefined()
    expect(cost?.class).toBe('bounded')
    expect(cost?.note).toContain('the whole of MAG_2')
    expect(cost?.note).toContain('20 bins')
  })

  it('still takes a sequence, and prices it as it did', () => {
    const cost = estimate('NODE_3')
    expect(cost?.refusal).toBeUndefined()
    expect(cost?.note).toContain('NODE_3')
    expect(cost?.note).not.toContain('the whole of')
  })

  it('refuses a name that is neither, and says both words on a metagenome', () => {
    expect(estimate('nothing_here')?.refusal).toBe(
      'This file has no sequence or genome called nothing_here.',
    )
  })

  it('says only “sequence” on a file that has no genomes', () => {
    expect(estimate('nothing_here', { genomes: null, hasGenomes: false })?.refusal).toBe(
      'This file has no sequence called nothing_here.',
    )
  })

  it('is free when the block on screen already covers the genome', () => {
    // The same test the contig path gets: a whole-MAG anchor is exactly the
    // block a genome view is showing, and reading it again would be a second
    // read for a picture already in memory.
    const cost = estimate('MAG_1', { blockLoaded: true, framing: framing('bin', [0, 20]) })
    expect(cost?.class).toBe('free')
  })
})

describe('a band dragged across a whole-file picture', () => {
  /**
   * Three sequences of a whole-metagenome view, at 50 kb per cell.
   *
   * The shape that produced `Genomic region out of bounds: [1, 260000)`: cells
   * are coarse enough that a short drag crosses two boundaries, and the first
   * sequence is shorter than where the drag ends.
   */
  const axis = new LocusAxis([
    { contig: 'NODE_1', unitStart: 0, unitEnd: 4, bpStart: 0, bpPerUnit: 50_000, contigLength: 200_000 },
    { contig: 'NODE_2', unitStart: 4, unitEnd: 6, bpStart: 0, bpPerUnit: 50_000, contigLength: 90_000 },
    { contig: 'NODE_3', unitStart: 6, unitEnd: 9, bpStart: 0, bpPerUnit: 50_000, contigLength: 150_000 },
  ])

  it('stays inside the sequence the hand went down on', () => {
    // Cells 0–6 span three contigs. The answer is the first of them, whole —
    // never its name against the third's coordinate, which is what made the
    // range parser refuse the 4C anchor picked on this very picture.
    expect(bandRegion(axis, [0, 7])).toEqual({ contig: 'NODE_1', start: 0, end: 200_000 })
  })

  it('never runs past the end of it, though the last cell would', () => {
    // NODE_2 is 90 kb — under two whole 50 kb cells — so the second cell's own
    // width would put the end at 100 kb, past a sequence that stops at 90.
    expect(bandRegion(axis, [4, 6])).toEqual({ contig: 'NODE_2', start: 0, end: 90_000 })
  })

  it('reports a drag inside one sequence as the stretch it covered', () => {
    expect(bandRegion(axis, [1, 3])).toEqual({ contig: 'NODE_1', start: 50_000, end: 150_000 })
  })

  it('is a whole cell wide when the drag was one cell', () => {
    expect(bandRegion(axis, [2, 3])).toEqual({ contig: 'NODE_1', start: 100_000, end: 150_000 })
  })

  it('has nothing to say off the end of the axis', () => {
    expect(bandRegion(axis, [12, 14])).toBeNull()
  })
})

describe('the 4C form', () => {
  it('offers the anchor and the balance switch, and nothing else', () => {
    // *Cis only* and *Normalisation* were switches over what the task is for,
    // and the profile a reader comes here for is the cis one. The arithmetic
    // behind both is kept and still goldened; what changed is what is asked.
    expect(FOURC_TASK.params.map((param) => param.key)).toEqual(['anchor', 'balance'])
  })
})
