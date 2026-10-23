/**
 * Pairs QC (§18.8): a library's records, from wherever they are.
 *
 * Three roads to one set of figures. A map **binned from a `.pairs`** had its
 * `pairtools stats` and its four orientation curves counted by its import
 * (§3.7), and the run draws them with nothing read; with a **digest** it reads
 * the map's own file once more, for the fragments; and a map **opened as a
 * matrix** has no records, so the run reads the `.pairs` the form names — and
 * draws from it exactly what the import would have.
 *
 * The restriction half is held to a second reading of the same records: the
 * contract's `RestrictionCounter` fed straight from the text, line by line, the
 * slow and obvious way. What this file checks is the wiring — that the pass
 * hands every record over with its names, positions, strands and duplicate
 * mark intact — since the arithmetic is `genome/restriction.ts`' and has goldens
 * of its own.
 */

import { describe, expect, it } from 'vitest'

import type { JobContext, SequenceReader, TrackJobContext } from '@/analysis/job'
import { runPairsQc } from '@/analysis/run/pairsqc'
import { runRestriction } from '@/analysis/run/restriction'
import { spearman } from '@/analysis/stats'
import { PAIRS_QC_TASK, restrictionParams } from '@/analysis/tasks/pairsqc'
import { taskById } from '@/analysis/registry'
import { RUNNERS } from '@/analysis/run/index'
import {
  defaultParams,
  type AnalysisContext,
  type AnalysisFraming,
  type CurveOutput,
  type ParamValue,
  type Params,
  type TableOutput,
  type TaskOutput,
  type TaskResult,
} from '@/analysis/types'
import type { TaskInputs } from '@/analysis/worker/protocol'
import { RestrictionCounter, cutsOfResult, type RestrictionStats } from '@/genome/restriction'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { importPairs, probePairs } from '@/pairs/import'
import { convergenceOf } from '@/pairs/stats'
import type { ByteSource } from '@/types'
import type { SourceSpec } from '@/worker/protocol'
import { BytesSource, bgzipped, rng } from '../support/pairs'

const BASE = 1_000
const LENGTHS = { chrI: 60_000, chrII: 30_000 } as const

/** A reference with chrI alone: chrII's pairs are on a sequence it has not got. */
function reference(): Uint8Array {
  const next = rng(11)
  const bases = new Uint8Array(LENGTHS.chrI)
  const letters = [0x41, 0x43, 0x47, 0x54]
  for (let i = 0; i < bases.length; i++) bases[i] = letters[Math.floor(next() * 4)]
  return bases
}

const REFERENCE = reference()

/**
 * The library's text: contacts decaying with separation on chrI, some on chrII
 * and some between the two, a share of duplicates, records unmapped on one side
 * or both, and two naming a sequence the header does not declare.
 */
function libraryText(): string {
  const next = rng(5)
  const strand = (): string => (next() < 0.5 ? '+' : '-')
  const rows: string[] = []
  const add = (c1: string, p1: number, c2: string, p2: number, s1: string, s2: string, type: string): void => {
    rows.push(`r${rows.length}\t${c1}\t${p1}\t${c2}\t${p2}\t${s1}\t${s2}\t${type}`)
  }
  for (let i = 0; i < 4_000; i++) {
    const separation = Math.floor(Math.exp(next() * Math.log(30_000)))
    const pos1 = 1 + Math.floor(next() * (LENGTHS.chrI - separation - 1))
    add('chrI', pos1, 'chrI', pos1 + separation, strand(), strand(), next() < 0.08 ? 'DD' : 'UU')
  }
  for (let i = 0; i < 600; i++) {
    const pos1 = 1 + Math.floor(next() * (LENGTHS.chrII - 2_000))
    add('chrII', pos1, 'chrII', pos1 + 1 + Math.floor(next() * 1_500), strand(), strand(), 'UU')
  }
  for (let i = 0; i < 300; i++) {
    const pos1 = 1 + Math.floor(next() * LENGTHS.chrI)
    const pos2 = 1 + Math.floor(next() * LENGTHS.chrII)
    add('chrI', pos1, 'chrII', pos2, strand(), strand(), 'UR')
  }
  for (let i = 0; i < 120; i++) {
    add('!', 0, 'chrI', 1 + Math.floor(next() * LENGTHS.chrI), '-', strand(), 'NU')
  }
  for (let i = 0; i < 40; i++) add('!', 0, '!', 0, '-', '-', 'WW')
  add('chrUn', 10, 'chrUn', 400, '+', '-', 'UU')
  add('chrI', 500, 'chrUn', 20, '-', '+', 'UU')
  return [
    '## pairs format v1.0',
    '#shape: upper triangle',
    `#chromsize: chrI ${LENGTHS.chrI}`,
    `#chromsize: chrII ${LENGTHS.chrII}`,
    '#columns: readID chrom1 pos1 chrom2 pos2 strand1 strand2 pair_type',
    ...rows,
  ].join('\n') + '\n'
}

const TEXT = libraryText()
const BYTES = bgzipped(TEXT)

const FRAMING: AnalysisFraming = {
  uri: 'library.pairs.gz',
  label: 'whole file',
  binsize: BASE,
  binsPerCell: 1,
  rows: [0, 90],
  cols: [0, 90],
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
}

/** The map, binned as the app's import bins it, and what that pass counted. */
async function imported(): Promise<{ mc: MetaCooler; held: TaskInputs }> {
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
    held: {
      orientation: { edges: counted.edges, counts: counted.counts, total: counted.total },
      pairsStats: table.stats!,
    },
  }
}

/** The restriction step, run as the annotations venue runs it, over {@link REFERENCE}. */
async function digest(enzyme: string, mc: MetaCooler): Promise<TaskResult> {
  const reader: SequenceReader = {
    contigs: [{ name: 'chrI', length: LENGTHS.chrI }],
    bases: (contig) => (contig === 'chrI' ? REFERENCE : undefined),
  }
  const params: Params = { sequence: 'ref.fa', sequences: null, enzyme, sites: '' }
  const job: TrackJobContext = {
    params,
    framing: FRAMING,
    inputs: { contigLengths: Object.fromEntries(mc.chromsizes) },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: () => {},
    sample: async () => {
      throw new Error('no tracks here')
    },
    lengthOf: (contig) => mc.chromsizes.get(contig),
    residues: () => reader,
  }
  const outputs = await runRestriction(job)
  return {
    outputs,
    provenance: {
      task: 'restriction',
      taskVersion: 1,
      params,
      framing: FRAMING,
      app: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    notes: [],
    ms: 0,
  }
}

interface Ran {
  outputs: TaskOutput[]
  notes: string[]
  /** How many times a source was opened, by road. */
  opened: { own: number; named: number }
}

async function run(
  mc: MetaCooler,
  params: Record<string, ParamValue>,
  inputs: TaskInputs,
): Promise<Ran> {
  const notes: string[] = []
  const opened = { own: 0, named: 0 }
  const job: JobContext = {
    mc,
    params: { ...defaultParams(PAIRS_QC_TASK.params), reference: '', ...params },
    framing: FRAMING,
    inputs,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: (text) => notes.push(text),
    toBp: (bins) => bins * BASE,
    toBins: (bp) => Math.max(1, Math.round(bp / BASE)),
    openSource: async (spec: SourceSpec): Promise<ByteSource> => {
      if (spec === inputs.mapSource) opened.own++
      else opened.named++
      return new BytesSource(BYTES, 'library.pairs.gz')
    },
  }
  return { outputs: await runPairsQc(job), notes, opened }
}

const OWN: SourceSpec = { kind: 'remote', url: 'file:///library.pairs.gz' }
const DROPPED: SourceSpec = { kind: 'local', file: new File([BYTES as BlobPart], 'library.pairs.gz') }

const ids = (outputs: readonly TaskOutput[]): string[] => outputs.map((output) => output.id)
function curve(outputs: readonly TaskOutput[], id: string): CurveOutput {
  const found = outputs.find((output): output is CurveOutput => output.kind === 'curve' && output.id === id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}
function table(outputs: readonly TaskOutput[], id: string): TableOutput {
  const found = outputs.find((output): output is TableOutput => output.kind === 'table' && output.id === id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}
const PAIRTOOLS = ['pairsqc-orientation', 'pairsqc-types', 'pairsqc-cis', 'pairsqc-stats']
const RESTRICTION = [
  'pairsqc-classes',
  'pairsqc-classes-table',
  'pairsqc-distance',
  'pairsqc-fragments',
  'pairsqc-sites',
]

/**
 * The fragment statistics counted the slow way: every line of the text, split
 * on tabs and handed to a counter of its own.
 */
function oracle(cuts: ReturnType<typeof cutsOfResult>): RestrictionStats {
  const counter = new RestrictionCounter(cuts!, new Map(Object.entries(LENGTHS)), 'DpnII')
  for (const line of TEXT.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const [, c1, p1, c2, p2, s1, s2, type] = line.split('\t')
    counter.add(c1, Number(p1), s1, c2, Number(p2), s2, type === 'DD')
  }
  return counter.result()
}

describe('Pairs QC on a map binned from a .pairs', () => {
  it('is offered beside P(s), and has a runner', () => {
    expect(taskById('pairsqc')).toBe(PAIRS_QC_TASK)
    expect(RUNNERS.pairsqc).toBe(runPairsQc)
    expect(PAIRS_QC_TASK.requires).toEqual(['restriction'])
  })

  it('draws the import’s own counts, and reads nothing', async () => {
    const { mc, held } = await imported()
    const ran = await run(mc, {}, { ...held, mapSource: OWN })
    expect(ids(ran.outputs)).toEqual(PAIRTOOLS)
    expect(ran.opened).toEqual({ own: 0, named: 0 })
    const stats = held.pairsStats!
    // The summary, as pairtools spells it.
    const rows = table(ran.outputs, 'pairsqc-stats').rows
    expect(rows.find((row) => row.statistic === 'total')?.value).toBe(String(stats.total))
    expect(rows.find((row) => row.statistic === 'total_dups')?.value).toBe(String(stats.totalDups))
    expect(rows.some((row) => String(row.statistic).startsWith('chrom_freq/'))).toBe(false)
    // Every pair type, most common first, named on the axis.
    const types = curve(ran.outputs, 'pairsqc-types')
    expect(types.xTicks).toEqual(stats.pairTypes.map(([type]) => type))
    expect(Array.from(types.series[0].y)).toEqual(stats.pairTypes.map(([, count]) => count))
    // Shares of the pairs mapped and not duplicated, by pairtools' keys.
    const cis = curve(ran.outputs, 'pairsqc-cis')
    expect(cis.xTicks).toEqual(['cis', 'trans', 'cis_1kb+', 'cis_2kb+', 'cis_4kb+', 'cis_10kb+', 'cis_20kb+', 'cis_40kb+'])
    expect(cis.series[0].y[0]).toBeCloseTo(stats.cis / stats.totalNodups, 12)
    expect(cis.series[0].y[1]).toBeCloseTo(stats.trans / stats.totalNodups, 12)
    expect(curve(ran.outputs, 'pairsqc-orientation').series.map((series) => series.name)).toEqual([
      '++',
      '+−',
      '−+',
      '−−',
    ])
    expect(ran.notes.join(' ')).toMatch(/counted as library\.pairs\.gz was binned/)
    // Where the four meet is pairtools' answer, the one the table prints — and
    // never the figure's own tenth-of-a-decade rule beside it.
    const converged = convergenceOf(stats)
    const said = rows.find((row) => row.statistic === 'summary/dist_freq_convergence/convergence_dist')?.value
    expect(said).toBe(String(converged.distance))
    expect(ran.notes.join(' ')).toContain(
      `converge at ${converged.distance!.toLocaleString('en-US')} bp by pairtools' rule`,
    )
    expect(ran.notes.join(' ')).not.toMatch(/within a tenth|converge at about/)
  })

  it('reads the map’s own file once more for a digest, and places every record as the text does', async () => {
    const { mc, held } = await imported()
    const restriction = await digest('DpnII', mc)
    const ran = await run(
      mc,
      { reference: 'ref.fa', enzyme: 'DpnII' },
      { ...held, mapSource: OWN, upstream: { restriction } },
    )
    expect(ids(ran.outputs)).toEqual([...PAIRTOOLS, ...RESTRICTION])
    expect(ran.opened).toEqual({ own: 1, named: 0 })

    const expected = oracle(cutsOfResult(restriction))
    // Nothing counted twice, nothing dropped: duplicates, the unmapped and the
    // pairs off the reference are the counter's to set aside, and are.
    expect(expected.counted).toBeGreaterThan(3_000)
    expect(expected.unassigned).toBe(600 + 300 + 2)
    const classes = table(ran.outputs, 'pairsqc-classes-table')
    for (const row of classes.rows) {
      const name = row.class as keyof RestrictionStats['classes']
      expect(row.pairs, name).toBe(expected.classes[name])
      for (const orientation of ['++', '+-', '-+', '--'] as const) {
        expect(row[orientation], `${name} ${orientation}`).toBe(expected.byOrientation[name][orientation])
      }
    }
    const stacked = curve(ran.outputs, 'pairsqc-classes')
    expect(stacked.series.map((series) => series.name)).toEqual(['++', '+-', '-+', '--'])
    expect(stacked.series.every((series) => series.stack === 'orientation' && series.mark === 'bars')).toBe(true)

    const distance = curve(ran.outputs, 'pairsqc-distance')
    const at = Array.from(distance.series[0].x, (x) => expected.distanceEdges.indexOf(x))
    expect(at.every((index) => index > 0)).toBe(true)
    expect(Array.from(distance.series[0].y)).toEqual(at.map((index) => expected.distance['+'][index]))
    expect(Array.from(distance.series[1].y)).toEqual(at.map((index) => expected.distance['-'][index]))
    // Every end is in a bin the figure draws.
    const drawn = Array.from(distance.series[0].y).reduce((a, b) => a + b, 0) +
      Array.from(distance.series[1].y).reduce((a, b) => a + b, 0)
    expect(drawn).toBe(2 * expected.counted)

    const fragments = curve(ran.outputs, 'pairsqc-fragments')
    expect(fragments.xTicks).toEqual(expected.fragments.binLabels)
    expect(Array.from(fragments.series[0].y)).toEqual(expected.fragments.counts)
    expect(fragments.label).toContain(
      `${expected.fragments.seen.toLocaleString('en-US')} / ${expected.fragments.total.toLocaleString('en-US')} fragments seen`,
    )
    expect(ran.notes.join(' ')).toMatch(/had an end on a sequence the reference has not got/)
  })

  it('sets coverage against the sites on the map’s own grid', async () => {
    const { mc, held } = await imported()
    const restriction = await digest('DpnII', mc)
    const ran = await run(
      mc,
      { reference: 'ref.fa', enzyme: 'DpnII' },
      { ...held, mapSource: OWN, upstream: { restriction } },
    )
    const sites = curve(ran.outputs, 'pairsqc-sites')

    // The slow way: every pixel at both its ends, the diagonal once, and every
    // top-strand cut in the bin whose start it is at or past.
    const coverage = new Float64Array(mc.nBins)
    await mc.scanPixels({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          coverage[chunk.bin1[i]] += chunk.count[i]
          if (chunk.bin2[i] !== chunk.bin1[i]) coverage[chunk.bin2[i]] += chunk.count[i]
        }
      },
    })
    const cuts = cutsOfResult(restriction)!.get('chrI')!.top
    const [from, to] = mc.contigExtent('chrI')
    const count = new Float64Array(to - from)
    for (const cut of cuts) count[Math.floor(cut / BASE)]++
    const pairs: Array<[number, number]> = []
    for (let bin = from; bin < to; bin++) {
      if (coverage[bin] > 0 || count[bin - from] > 0) pairs.push([count[bin - from], coverage[bin]])
    }
    // Sorted by sites, each number's bins in the genome's order.
    const sorted = pairs
      .map((pair, at) => ({ pair, at }))
      .sort((a, b) => a.pair[0] - b.pair[0] || a.at - b.at)
      .map(({ pair }) => pair)
    expect(Array.from(sites.series[0].x)).toEqual(sorted.map(([x]) => x))
    expect(Array.from(sites.series[0].y)).toEqual(sorted.map(([, y]) => y))
    // chrII is not in the reference, so none of its bins is set against sites.
    expect(sites.series[0].x.length).toBeLessThanOrEqual(to - from)

    // The mean line over exactly those bins, and ρ over the same.
    const groups = new Map<number, number[]>()
    for (const [x, y] of sorted) groups.set(x, [...(groups.get(x) ?? []), y])
    // …and only where five bins share a number of sites: a thinner number
    // keeps its points, with no mean drawn through them.
    const means = sorted.map(([x]) => {
      const ys = groups.get(x)!
      return ys.length >= 5 ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.NaN
    })
    expect(Array.from(sites.series[1].y)).toEqual(means)
    expect(means.some((mean) => Number.isNaN(mean))).toBe(true)
    expect(means.some((mean) => !Number.isNaN(mean))).toBe(true)
    expect(ran.notes.join(' ')).toContain('The mean is drawn where at least five bins share a number of sites.')
    expect(sites.series[0].mark).toBe('points')
    const rho = spearman(sorted.map(([x]) => x), sorted.map(([, y]) => y))
    expect(sites.label).toContain(`ρ = ${rho.toFixed(3)}`)
    expect(ran.notes.join(' ')).toContain(`Spearman ρ = ${rho.toFixed(3)}`)
  })

  it('skips the digest without a reference, and says so for an enzyme chosen without one', async () => {
    const { mc, held } = await imported()
    const ran = await run(mc, { enzyme: 'DpnII' }, { ...held, mapSource: OWN })
    expect(ids(ran.outputs)).toEqual(PAIRTOOLS)
    expect(ran.opened).toEqual({ own: 0, named: 0 })
    expect(ran.notes.join(' ')).toMatch(/An enzyme was chosen with no reference/)
  })
})

describe('Pairs QC on a map opened as a matrix', () => {
  it('reads the .pairs the form was handed, and draws what the import would have', async () => {
    const { mc, held } = await imported()
    const fromImport = await run(mc, {}, { ...held, mapSource: OWN })
    // No records held: what an `.mcool` of the same library would hand the task.
    const fromFile = await run(mc, { pairs: 'library.pairs.gz' }, { sources: { pairs: DROPPED } })
    expect(fromFile.opened).toEqual({ own: 0, named: 1 })
    expect(ids(fromFile.outputs)).toEqual(PAIRTOOLS)
    for (const id of ['pairsqc-orientation', 'pairsqc-types', 'pairsqc-cis']) {
      expect(curve(fromFile.outputs, id).series.map((series) => Array.from(series.y)), id).toEqual(
        curve(fromImport.outputs, id).series.map((series) => Array.from(series.y)),
      )
    }
    expect(table(fromFile.outputs, 'pairsqc-stats').rows).toEqual(table(fromImport.outputs, 'pairsqc-stats').rows)
    expect(fromFile.notes.join(' ')).toMatch(/in one pass over library\.pairs\.gz/)
  })

  it('refuses with nothing named, and the run says why', async () => {
    const { mc } = await imported()
    const ran = await run(mc, {}, {})
    expect(ran.outputs).toEqual([])
    expect(ran.notes.join(' ')).toMatch(/opened as a matrix, which keeps no records/)
  })
})

describe('the Pairs QC descriptor', () => {
  const context = (over: Partial<AnalysisContext> = {}): AnalysisContext => ({
    uri: 'library.mcool',
    layout: 'cool',
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
    binsize: BASE,
    nBins: 90,
    hasMap: true,
    contigs: [],
    genomes: null,
    entries: [],
    framing: null,
    blockLoaded: false,
    blockBytes: 0,
    ...over,
  })
  const params = (over: Record<string, ParamValue> = {}): Params => ({ ...defaultParams(PAIRS_QC_TASK.params), ...over })

  it('hands the restriction step its reference and enzyme, or leaves it out', () => {
    expect(restrictionParams(params({ reference: 'a1', enzyme: 'Arima' }))).toEqual({
      sequence: 'a1',
      enzyme: 'Arima',
      sites: '',
    })
    expect(PAIRS_QC_TASK.upstreamParams?.('restriction', params({ reference: 'a1', enzyme: 'none' }))).toBeNull()
    expect(PAIRS_QC_TASK.upstreamParams?.('restriction', params({ reference: '', enzyme: 'DpnII' }))).toBeNull()
    expect(PAIRS_QC_TASK.upstreamParams?.('restriction', params({ reference: null, enzyme: 'DpnII' }))).toBeNull()
  })

  it('is waiting without a map, and ready on any map', () => {
    expect(PAIRS_QC_TASK.availability(context()).state).toBe('ready')
    expect(PAIRS_QC_TASK.availability(context({ hasMap: false })).state).toBe('waiting')
  })

  it('prices the import as free, a pass as a scan, and refuses a site it cannot read', () => {
    const binned = context({ binnedFrom: { name: 'lib.pairs.gz', orientation: true } })
    expect(PAIRS_QC_TASK.estimate(binned, params()).class).toBe('free')
    const digested = PAIRS_QC_TASK.estimate(binned, params({ reference: 'a1', enzyme: 'DpnII' }))
    expect(digested.class).toBe('scan')
    expect(digested.note).toBe(
      "The reference cut with DpnII, then one pass over lib.pairs.gz's records again and one over the pixel table.",
    )
    const typed = PAIRS_QC_TASK.estimate(binned, params({ reference: 'a1', enzyme: 'custom', sites: 'GATC' }))
    expect(typed.refusal).toMatch(/needs a \^ where the enzyme cuts/)
    const without = PAIRS_QC_TASK.estimate(binned, params({ reference: '', enzyme: 'DpnII' }))
    expect(without.refusal).toBeUndefined()
    expect(without.note).toMatch(/No reference is chosen, so there are no restriction statistics/)
    const named = PAIRS_QC_TASK.estimate(context(), params({ pairs: 'lib.pairs.gz', reference: 'a1', enzyme: 'Arima' }))
    expect(named.note).toBe('The reference cut with Arima, then one pass over the whole of lib.pairs.gz and one over the pixel table.')
  })
})
