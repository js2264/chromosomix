/**
 * P(s)'s four orientations, from wherever the records are (§18.8).
 *
 * Three roads and one figure. A map **binned from a `.pairs`** had them counted
 * in its own import (§3.7), and the run takes them from there with nothing more
 * read; a `.pairs` **handed to the form** — dropped on it, or chosen through it
 * — arrives as a source beside a name, and is read once, for its records alone;
 * and a name whose file is **no longer held** is said out loud rather than
 * fetched as if it were an address. The first two must draw the same figure
 * from the same records, which is the check that neither road reads them
 * differently.
 */

import { describe, expect, it } from 'vitest'

import type { JobContext } from '@/analysis/job'
import { runExpected } from '@/analysis/run/expected'
import { EXPECTED_TASK } from '@/analysis/tasks/ps'
import { defaultParams, type AnalysisFraming, type CurveOutput, type Params, type TaskOutput } from '@/analysis/types'
import type { TaskInputs } from '@/analysis/worker/protocol'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { importPairs, probePairs } from '@/pairs/import'
import type { ByteSource } from '@/types'
import type { SourceSpec } from '@/worker/protocol'
import { BytesSource, bgzipped, rng } from '../support/pairs'

const LENGTH = 60_000
const BASE = 1_000

/**
 * A library on one sequence: contacts decaying with separation in all four
 * orientations alike, and an inward (`+−`) excess below 2 kb — the undigested
 * fragments the figure exists to find.
 */
function library(): Uint8Array {
  const next = rng(7)
  const rows: Array<[number, number, string, string]> = []
  for (let i = 0; i < 6_000; i++) {
    const separation = Math.floor(Math.exp(next() * Math.log(40_000)))
    const pos1 = 1 + Math.floor(next() * (LENGTH - separation - 1))
    const s1 = next() < 0.5 ? '+' : '-'
    const s2 = next() < 0.5 ? '+' : '-'
    rows.push([pos1, pos1 + separation, s1, s2])
  }
  for (let i = 0; i < 3_000; i++) {
    const separation = 50 + Math.floor(next() * 1_950)
    const pos1 = 1 + Math.floor(next() * (LENGTH - separation - 1))
    rows.push([pos1, pos1 + separation, '+', '-'])
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lines = [
    '## pairs format v1.0',
    '#sorted: chr1-chr2-pos1-pos2',
    '#shape: upper triangle',
    `#chromsize: chrI ${LENGTH}`,
    '#columns: readID chr1 pos1 chr2 pos2 strand1 strand2',
    ...rows.map(([pos1, pos2, s1, s2], at) => `r${at}\tchrI\t${pos1}\tchrI\t${pos2}\t${s1}\t${s2}`),
  ]
  return bgzipped(`${lines.join('\n')}\n`)
}

const BYTES = library()

const FRAMING: AnalysisFraming = {
  uri: 'library.pairs.gz',
  label: 'whole file',
  binsize: BASE,
  binsPerCell: 1,
  rows: [0, LENGTH / BASE],
  cols: [0, LENGTH / BASE],
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
}

/** The map, binned from the library as the app's import does, and what that counted. */
async function imported(): Promise<{ mc: MetaCooler; inputs: TaskInputs }> {
  const source = new BytesSource(BYTES, 'library.pairs.gz')
  const probe = await probePairs(source, async () => null)
  const done = await importPairs(source, probe, { base: BASE, rungs: 1 })
  const table = done!.tables.get(BASE)!
  const mc = MetaCooler.fromPairs({
    uri: 'library.pairs.gz',
    header: done!.header,
    pixels: table,
    rungs: done!.rungs,
    indexed: false,
  })
  const counted = table.orientation!
  return {
    mc,
    inputs: { orientation: { edges: counted.edges, counts: counted.counts, total: counted.total } },
  }
}

function params(pairsUri: string): Params {
  return {
    scope: 'contig',
    sequences: null,
    quantity: 'density',
    factor: 1.1,
    minSeparation: 0,
    derivative: false,
    stranded: true,
    pairsUri,
    balance: false,
  }
}

function job(
  mc: MetaCooler,
  pairsUri: string,
  inputs: TaskInputs,
  roads: Pick<JobContext, 'openSource' | 'openBytes' | 'openFile'> = {},
): { job: JobContext; notes: string[] } {
  const notes: string[] = []
  return {
    notes,
    job: {
      mc,
      params: params(pairsUri),
      framing: FRAMING,
      inputs,
      cancelled: () => false,
      throwIfCancelled: () => {},
      breathe: async () => {},
      progress: () => {},
      note: (text) => notes.push(text),
      toBp: (bins) => bins * BASE,
      toBins: (bp) => Math.max(1, Math.round(bp / BASE)),
      ...roads,
    },
  }
}

function orientationOf(outputs: TaskOutput[]): CurveOutput | undefined {
  return outputs.find((output): output is CurveOutput => output.id === 'ps-orientation')
}

describe('P(s) by pair orientation', () => {
  it('takes the curves a map binned from a .pairs counted as it was binned', async () => {
    const { mc, inputs } = await imported()
    const { job: run, notes } = job(mc, '', inputs)
    const figure = orientationOf(await runExpected(run))
    expect(figure?.series.map((series) => series.name)).toEqual(['++', '+−', '−+', '−−'])
    // Whatever it says about convergence, it does not say the curves are missing.
    expect(notes.join(' ')).not.toMatch(/none to count|no longer in hand/)
  })

  it('reads a .pairs handed to the form, through its source, and closes it after', async () => {
    const { mc, inputs } = await imported()
    const { job: fromImport } = job(mc, '', inputs)
    const expected = orientationOf(await runExpected(fromImport))

    // The name is the record of what was dropped; the source is the bytes.
    const dropped: SourceSpec = {
      kind: 'local',
      file: new File([BYTES as BlobPart], 'library.pairs.gz'),
    }
    const opened: SourceSpec[] = []
    let closed = 0
    const { job: handed } = job(
      mc,
      'library.pairs.gz',
      { sources: { pairsUri: dropped } },
      {
        openSource: async (spec): Promise<ByteSource> => {
          opened.push(spec)
          const inner = new BytesSource(BYTES, 'library.pairs.gz')
          return Object.assign(inner, { close: () => void closed++ })
        },
        // A shell's road, which must not be taken while a file is in hand.
        openFile: async () => {
          throw new Error('a dropped file was read as a path')
        },
      },
    )
    const figure = orientationOf(await runExpected(handed))
    expect(opened).toEqual([dropped])
    expect(closed).toBe(1)
    // The same records, the same figure, whichever road they came by.
    expect(figure?.series.map((series) => Array.from(series.y))).toEqual(
      expected?.series.map((series) => Array.from(series.y)),
    )
  })

  it('says so when a dropped file is no longer held', async () => {
    const { mc } = await imported()
    // A worker has no filesystem, and the name alone is not an address.
    const { job: stale, notes } = job(mc, 'library.pairs.gz', {}, { openSource: async () => {
      throw new Error('nothing was handed over')
    } })
    expect(orientationOf(await runExpected(stale))).toBeUndefined()
    expect(notes.join(' ')).toMatch(/no longer in hand/)
  })

  it('names a map that has nothing to count them from, and where a .pairs goes', async () => {
    const { mc } = await imported()
    const { job: bare, notes } = job(mc, '', {})
    expect(orientationOf(await runExpected(bare))).toBeUndefined()
    expect(notes.join(' ')).toMatch(/Drop a \.pairs on the form/)
  })
})

/**
 * The near-diagonal the curve leaves out, and the figure it does not (§18.8).
 *
 * Two bins by default — the diagonal and the one beside it, cooltools'
 * `ignore_diags=2` — which trims the matrix's curve; the four orientations are
 * counted from records below any grid and are drawn from the first one.
 */
describe('P(s)’s minimum separation', () => {
  const run = async (inputs: TaskInputs, mc: MetaCooler, extra: Params): Promise<TaskOutput[]> => {
    const { job: base } = job(mc, '', inputs)
    return runExpected({ ...base, params: { ...base.params, ...extra } })
  }
  const curveOf = (outputs: TaskOutput[]): CurveOutput => {
    const found = outputs.find((output): output is CurveOutput => output.id === 'ps')
    if (found === undefined) throw new Error('no P(s) curve')
    return found
  }

  it('leaves out two bins unless asked otherwise', () => {
    const spec = EXPECTED_TASK.params.find((param) => param.key === 'minSeparation')
    expect(spec?.kind === 'number' && spec.default).toBe(2)
    expect(defaultParams(EXPECTED_TASK.params).minSeparation).toBe(2)
  })

  it('starts the expected at the second diagonal, and keeps the first at 0', async () => {
    const { mc, inputs } = await imported()
    const at = async (minSeparation: number): Promise<number> =>
      curveOf(await run(inputs, mc, { quantity: 'expected', minSeparation })).series[0].x[0]
    // A point's abscissa is the mean separation of the cells behind it: two
    // bins and up, or one bin and up — never the diagonal, which is no contact.
    expect(await at(2)).toBeGreaterThanOrEqual(2 * BASE)
    expect(await at(0)).toBe(BASE)
  })

  it('takes the density’s total over what it keeps', async () => {
    const { mc, inputs } = await imported()
    const kept = curveOf(await run(inputs, mc, { minSeparation: 2 })).series[0]
    const all = curveOf(await run(inputs, mc, { minSeparation: 0 })).series[0]
    // Past the breaks the near-diagonal fell in, every point is the same
    // contacts over a smaller total: higher, and by one factor throughout.
    const factors: number[] = []
    kept.x.forEach((x, i) => {
      const at = Array.from(all.x).indexOf(x)
      if (x >= 10 * BASE && at >= 0 && all.y[at] > 0) factors.push(kept.y[i] / all.y[at])
    })
    expect(factors.length).toBeGreaterThan(5)
    expect(factors[0]).toBeGreaterThan(1)
    for (const factor of factors) expect(factor).toBeCloseTo(factors[0], 9)
  })

  it('draws the four orientations from the first record, whatever it says', async () => {
    const { mc, inputs } = await imported()
    const floored = orientationOf(await run(inputs, mc, { minSeparation: 5 }))
    const whole = orientationOf(await run(inputs, mc, { minSeparation: 0 }))
    expect(floored?.series.map((series) => Array.from(series.x))).toEqual(
      whole?.series.map((series) => Array.from(series.x)),
    )
    // The inward excess this library carries sits below 2 kb, and so does the
    // first point of every curve.
    for (const series of floored?.series ?? []) expect(series.x[0]).toBeLessThan(2 * BASE)
  })
})
