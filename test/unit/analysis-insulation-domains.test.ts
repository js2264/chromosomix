/**
 * The domains insulation calls beside its boundaries.
 *
 * A boundary set is a set of *points* and nearly everything downstream wants an
 * interval: a scaled pileup over domains is the domain APA, an overlap counts
 * what sits inside one, and a BED of them is what leaves for another tool. So
 * the task produces both, and this pins the four things that decide whether the
 * second one means what it says.
 *
 * **Per sequence.** "Consecutive" is a property of a chromosome. The last call
 * on one and the first on the next are adjacent in any sorted list and are not
 * two ends of anything, so a runner that flattened the calls would invent a
 * domain spanning a whole chromosome break.
 *
 * **They tile.** One domain ends where the next begins, which is what makes the
 * lane read as a segmentation — the picture the compartment track makes — and
 * what puts a domain's two corners on the bins the calls were actually made at.
 *
 * **Clamped to the sequence.** It leaves as a BED, and a BED that runs past the
 * end of a chromosome is one every tool downstream complains about, or worse,
 * does not.
 *
 * **Two overlays, not one.** The boundaries row is unchanged and the domains row
 * is beside it, so a reader who wants the points still has them.
 */

import { describe, expect, it } from 'vitest'

import { runInsulation } from '@/analysis/run/insulation'
import type { JobContext } from '@/analysis/job'
import type { AnalysisFraming, IntervalsOutput, Params, TaskOutput } from '@/analysis/types'
import type { FeatureSet } from '@/annotations/types'

const BINSIZE = 1000

/** Two sequences, and where each one's perfect boundaries are. */
const CONTIGS = [
  { name: 'I', bins: 60, at: [10, 25, 40] },
  // One call, so it has no interior with both its edges — and it is the reason
  // a domain is never made from the last call of one sequence to the first of
  // the next.
  { name: 'II', bins: 40, at: [15] },
]

const OFFSET = [0, CONTIGS[0].bins]
const NBINS = CONTIGS[0].bins + CONTIGS[1].bins

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'whole file',
  binsize: BINSIZE,
  binsPerCell: 1,
  rows: [0, NBINS],
  cols: [0, NBINS],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/**
 * Ones, with a cross of *nearly* zero through each boundary bin: the contact
 * between the two sides of it, the bin itself belonging to both.
 *
 * What a domain boundary is, near enough the limit. Across the bin rather than
 * between two bins, because the diamond is cornered on the bin it scores: an
 * edge falling *between* bins `b − 1` and `b` leaves both of them the same mean,
 * a flat floor of two bins, and cooltools calls no minimum on a flat floor. Not
 * exactly zero either, and that is not fussiness: `insulationScore` is a log2
 * ratio and leaves a bin whose diamond averages zero as a gap rather than as
 * minus infinity, so a perfect boundary is `NaN` and never gets called.
 *
 * **Each a different depth**, as real ones are: three troughs of exactly one
 * depth tie for the deepest, and cooltools measures the prominence of only the
 * first of equally high peaks.
 */
const ACROSS = [0.05, 0.1, 0.2]

function valueAt(row: number, col: number): number {
  for (let c = 0; c < CONTIGS.length; c++) {
    const from = OFFSET[c]
    const to = from + CONTIGS[c].bins
    if (row < from || row >= to || col < from || col >= to) continue
    for (let i = 0; i < CONTIGS[c].at.length; i++) {
      const bin = from + CONTIGS[c].at[i]
      if ((row < bin && col > bin) || (col < bin && row > bin)) return ACROSS[i]
    }
    return 1
  }
  // Trans, which insulation never reads: it takes one on-diagonal square per
  // sequence.
  return 0
}

function job(params: Params): JobContext {
  const mc = {
    nBins: NBINS,
    nContigs: CONTIGS.length,
    binsize: BINSIZE,
    hasGenomes: false,
    contigGenomeIds: new Int32Array(CONTIGS.length),
    chromnames: CONTIGS.map((contig) => contig.name),
    chromsizes: new Map(CONTIGS.map((contig) => [contig.name, contig.bins * BINSIZE])),
    hasContig: (name: string) => CONTIGS.some((contig) => contig.name === name),
    contigId: (name: string) => CONTIGS.findIndex((contig) => contig.name === name),
    contigExtent: (cid: number) => [OFFSET[cid], OFFSET[cid] + CONTIGS[cid].bins] as [number, number],
    names: { find: () => null },
    matrix: async (query: { rows: [number, number]; cols: [number, number] }) => {
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
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
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

const SETTINGS: Params = {
  window: 5,
  scales: 1,
  // Unanswered, which is every sequence — the tick boxes' own convention, and
  // what the `region: ''` this replaces used to mean.
  sequences: null,
  ignoreDiags: 0,
  minValid: 0,
  balance: false,
  call: true,
  prominence: 0.2,
  spacing: 0,
  domains: true,
}

function intervals(outputs: TaskOutput[], id: string): FeatureSet | null {
  const found = outputs.find(
    (output): output is IntervalsOutput => output.kind === 'intervals' && output.id === id,
  )
  if (found === undefined || found.payload.kind !== 'features') return null
  return found.payload.data
}

function spans(set: FeatureSet): Array<[string, number, number]> {
  return Array.from({ length: set.length }, (_, i) => [
    set.contigs[set.contig[i]],
    set.start[i],
    set.end[i],
  ])
}

describe('the domains insulation calls beside its boundaries', () => {
  it('is the span from each call to the next, on its own sequence', async () => {
    const outputs = await runInsulation(job(SETTINGS))
    const boundaries = intervals(outputs, 'insulation-boundaries')
    const domains = intervals(outputs, 'insulation-domains')
    expect(boundaries).not.toBeNull()
    expect(domains).not.toBeNull()

    // Four calls: three on I and one on II.
    expect(spans(boundaries!).map(([contig, start]) => `${contig}:${start}`)).toEqual([
      'I:10000',
      'I:25000',
      'I:40000',
      'II:15000',
    ])
    // Two domains, both on I. The one call on II makes none — and nothing spans
    // the break between the two sequences, which a flattened call list would.
    expect(spans(domains!)).toEqual([
      ['I', 10_000, 25_000],
      ['I', 25_000, 40_000],
    ])
  })

  it('tiles: one ends exactly where the next begins', async () => {
    const domains = intervals(await runInsulation(job(SETTINGS)), 'insulation-domains')!
    expect(domains.end[0]).toBe(domains.start[1])
  })

  it('carries the weaker of its two edges as its score', async () => {
    const outputs = await runInsulation(job(SETTINGS))
    const boundaries = intervals(outputs, 'insulation-boundaries')!
    const domains = intervals(outputs, 'insulation-domains')!
    for (let i = 0; i < domains.length; i++) {
      expect(domains.score[i]).toBeCloseTo(Math.min(boundaries.score[i], boundaries.score[i + 1]), 12)
    }
  })

  it('stays inside the sequence it came from', async () => {
    const domains = intervals(await runInsulation(job(SETTINGS)), 'insulation-domains')!
    for (let i = 0; i < domains.length; i++) {
      const length = CONTIGS.find((contig) => contig.name === domains.contigs[domains.contig[i]])!
      expect(domains.start[i]).toBeGreaterThanOrEqual(0)
      expect(domains.end[i]).toBeLessThanOrEqual(length.bins * BINSIZE)
      expect(domains.end[i]).toBeGreaterThan(domains.start[i])
    }
  })

  it('leaves the boundaries row alone when it is turned off', async () => {
    const outputs = await runInsulation(job({ ...SETTINGS, domains: false }))
    expect(intervals(outputs, 'insulation-boundaries')).not.toBeNull()
    expect(intervals(outputs, 'insulation-domains')).toBeNull()
  })

  it('makes neither when the calls themselves are turned off', async () => {
    const outputs = await runInsulation(job({ ...SETTINGS, call: false }))
    expect(outputs.every((output) => output.kind !== 'intervals')).toBe(true)
  })

  it('says why rather than adopting an empty overlay', async () => {
    // A prominence nothing reaches on II alone: one call, so no domain has both
    // of its edges. The row is absent and the reason is said out loud, because a
    // reader who left the tickbox on is owed one.
    const said: string[] = []
    // One sequence is one ticked box now, where it used to be a region string.
    const context = job({ ...SETTINGS, sequences: ['II'] })
    const outputs = await runInsulation({ ...context, note: (text) => said.push(text) })
    expect(intervals(outputs, 'insulation-boundaries')).not.toBeNull()
    expect(intervals(outputs, 'insulation-domains')).toBeNull()
    expect(said.join(' ')).toMatch(/no domain has both of its edges/)
  })
})

/**
 * **Which sequences a run is over, now that it is asked with tick boxes.**
 *
 * The five near-diagonal tasks took a region string, where `''` meant *every
 * sequence* and a name meant one; they take a list of ticked names, and the
 * three answers a list can give are not the two a string could. Pinned here
 * because the two old readings have to survive the change unaltered — that is
 * the whole claim of it — and because the third is new and is a state a reader
 * reaches with one press of **none**.
 */
describe('the sequences a run is ticked for', () => {
  const named = (outputs: TaskOutput[]): string[] => {
    const set = intervals(outputs, 'insulation-boundaries')
    return set === null ? [] : [...new Set(spans(set).map(([contig]) => contig))]
  }

  it('reads every sequence when nothing was answered, as an empty region did', async () => {
    expect(named(await runInsulation(job({ ...SETTINGS, sequences: null })))).toEqual(['I', 'II'])
  })

  it('reads one ticked sequence and no other, as a named region did', async () => {
    expect(named(await runInsulation(job({ ...SETTINGS, sequences: ['I'] })))).toEqual(['I'])
  })

  it('reads two of two, which a dropdown had no way to ask for', async () => {
    expect(named(await runInsulation(job({ ...SETTINGS, sequences: ['II', 'I'] })))).toEqual([
      'I',
      'II',
    ])
  })

  // Empty is **not** every sequence: it is a reader who pressed *none*, and the
  // one thing it must not be is indistinguishable from a genome-wide run.
  it('runs over nothing when the list is empty, and says so', async () => {
    const said: string[] = []
    const context = job({ ...SETTINGS, sequences: [] })
    const outputs = await runInsulation({ ...context, note: (text) => said.push(text) })
    expect(outputs).toEqual([])
    expect(said.join(' ')).toMatch(/No sequence is ticked/)
  })

  // A deck holds files of different assemblies on purpose and a batch asks every
  // panel of it for one reader's list (§5.9), so a name this file has not got is
  // a fact about the pair of files. What it must never be is silently dropped.
  it('names a ticked sequence this file has not got, and runs the rest', async () => {
    const said: string[] = []
    const context = job({ ...SETTINGS, sequences: ['I', 'chrZ'] })
    const outputs = await runInsulation({ ...context, note: (text) => said.push(text) })
    expect(named(outputs)).toEqual(['I'])
    expect(said.join(' ')).toMatch(/chrZ/)
  })

  it('says the file has none of them when none of them is in it', async () => {
    const said: string[] = []
    const context = job({ ...SETTINGS, sequences: ['chrZ'] })
    const outputs = await runInsulation({ ...context, note: (text) => said.push(text) })
    expect(outputs).toEqual([])
    expect(said.join(' ')).toMatch(/no sequence called chrZ/)
  })
})
