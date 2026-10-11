/**
 * The matrix-coordinate ↔ (contig, base pair) map (spec §8.4).
 *
 * The property that matters is that it agrees with the readout, which is a
 * different implementation of the same arithmetic (`blockAxes.bpWithin`): if
 * these two ever disagree, a track and the tooltip above it disagree, and
 * neither is obviously the wrong one. So the numbers here are checked against
 * that formula rather than against what this module happens to return.
 */

import { describe, expect, it } from 'vitest'

import { locusAxisFrom, type AxisRun } from '../../src/render/locus'

/** `blockAxes.bpWithin`, restated: the readout's own arithmetic. */
function bpWithin(run: AxisRun, offset: number, blockStart: number, binsize: number): number {
  const first = run.unitStart ?? blockStart + run.start
  return (blockStart + offset - first) * binsize
}

const lengths: Record<string, number> = {
  I: 230218,
  II: 813184,
  IV: 1531933,
  VII: 1090940,
}
const lengthOf = (name: string): number | undefined => lengths[name]

describe('a whole-genome axis', () => {
  // Three chromosomes laid end to end at 1 kb, as `view=whole` renders them.
  const runs: AxisRun[] = [
    { label: 'I', start: 0, end: 231, unitStart: 0, unitLength: 230218 },
    { label: 'II', start: 231, end: 1045, unitStart: 231, unitLength: 813184 },
    { label: 'IV', start: 1045, end: 2577, unitStart: 1045, unitLength: 1531933 },
  ]
  const axis = locusAxisFrom({
    runs,
    blockStart: 0,
    level: 'bin',
    binsize: 1000,
    contigLength: lengthOf,
  })

  it('places a cell on the contig it belongs to', () => {
    expect(axis?.unitToLocus(0)).toEqual({ contig: 'I', bp: 0 })
    expect(axis?.unitToLocus(231)).toEqual({ contig: 'II', bp: 0 })
    expect(axis?.unitToLocus(1045.5)).toEqual({ contig: 'IV', bp: 500 })
  })

  it('agrees with the hover readout, cell for cell', () => {
    for (const offset of [0, 1, 230, 231, 400, 1044, 1045, 2000]) {
      const run = runs.find((candidate) => offset >= candidate.start && offset < candidate.end)
      expect(run).toBeDefined()
      const expected = bpWithin(run as AxisRun, offset, 0, 1000)
      expect(axis?.unitToLocus(offset)?.bp).toBe(expected)
    }
  })

  it('round-trips a locus back to the same coordinate', () => {
    expect(axis?.locusToUnit('II', 0)).toBe(231)
    expect(axis?.locusToUnit('IV', 500_000)).toBe(1045 + 500)
    expect(axis?.locusToUnit('nope', 0)).toBeNull()
  })

  it('is null outside the block', () => {
    expect(axis?.unitToLocus(-1)).toBeNull()
    expect(axis?.unitToLocus(2577)).toBeNull()
  })

  // The last bin of a contig is partial: chromosome I is 230,218 bp in 231
  // bins, so the run spans 231,000 bp of coordinate for 230,218 bp of sequence.
  // Fitting the run to the true length would shrink every bin by 0.34% and put
  // the far end of the chromosome ~780 bp out.
  it('keeps bins exactly one bin wide despite a partial last bin', () => {
    expect(axis?.unitToLocus(230)?.bp).toBe(230_000)
    // Clamped only at the very edge, which is where the sequence actually stops.
    expect(axis?.unitToLocus(230.99)?.bp).toBe(230_218)
  })

  it('splits a visible window into one query per contig it touches', () => {
    const windows = axis?.windows([200, 300]) ?? []
    expect(windows.map((window) => window.contig)).toEqual(['I', 'II'])
    expect(windows[0]).toMatchObject({ start: 200_000, end: 230_218, unitFrom: 200, unitTo: 231 })
    expect(windows[1]).toMatchObject({ start: 0, end: 69_000, unitFrom: 231, unitTo: 300 })
  })

  it('pads a window without running off the end of the contig', () => {
    const [window] = axis?.windows([0, 100], 1) ?? []
    expect(window.start).toBe(0)
    expect(window.end).toBe(200_000)
  })
})

describe('a region axis', () => {
  // `VII:139005-199005` — a block that starts 139 bins into its contig, which
  // is the case that makes `unitStart` load-bearing.
  const axis = locusAxisFrom({
    runs: [{ label: 'VII', start: 0, end: 60, unitStart: 0, unitLength: 1_090_940 }],
    blockStart: 139,
    level: 'bin',
    binsize: 1000,
    contigLength: lengthOf,
  })

  it('reports a position in the contig, not in the picture', () => {
    expect(axis?.unitToLocus(0)).toEqual({ contig: 'VII', bp: 139_000 })
    expect(axis?.unitToLocus(30)).toEqual({ contig: 'VII', bp: 169_000 })
  })

  it('round-trips through the block offset', () => {
    expect(axis?.locusToUnit('VII', 139_000)).toBe(0)
    expect(axis?.locusToUnit('VII', 199_000)).toBe(60)
  })

  it('reports the bin size as uniform', () => {
    expect(axis?.uniformBpPerUnit).toBe(1000)
  })
})

describe('an aggregated axis', () => {
  // At contig level the reader sends one cell per contig and no `unitStart`,
  // so the length has to come from the contigs table.
  const runs: AxisRun[] = [
    { label: 'I', start: 0, end: 1 },
    { label: 'II', start: 1, end: 2 },
  ]

  it('spreads a whole contig across its single cell', () => {
    const axis = locusAxisFrom({
      runs,
      blockStart: 0,
      level: 'contig',
      binsize: 1000,
      contigLength: lengthOf,
    })
    expect(axis?.unitToLocus(0.5)).toEqual({ contig: 'I', bp: 115_109 })
    expect(axis?.unitToLocus(1)).toEqual({ contig: 'II', bp: 0 })
    expect(axis?.uniformBpPerUnit).toBeNull()
  })

  // A track drawn over an invented length is worse than one that is absent.
  it('drops a contig whose length nothing knows', () => {
    const axis = locusAxisFrom({
      runs,
      blockStart: 0,
      level: 'contig',
      binsize: 1000,
      contigLength: (name) => (name === 'I' ? 230_218 : undefined),
    })
    expect(axis?.contigs()).toEqual(['I'])
  })
})

describe('refusals', () => {
  it('has no axis at genome level (§8.4)', () => {
    expect(
      locusAxisFrom({
        runs: [{ label: 'MAG_1', start: 0, end: 1 }],
        blockStart: 0,
        level: 'genome',
        binsize: 1000,
        contigLength: () => 1000,
      }),
    ).toBeNull()
  })

  it('has no axis without a bin size', () => {
    expect(
      locusAxisFrom({
        runs: [{ label: 'I', start: 0, end: 10 }],
        blockStart: 0,
        level: 'bin',
        binsize: 0,
        contigLength: lengthOf,
      }),
    ).toBeNull()
  })

  it('has no axis with no runs', () => {
    expect(
      locusAxisFrom({ runs: [], blockStart: 0, level: 'bin', binsize: 1000, contigLength: lengthOf }),
    ).toBeNull()
  })
})
