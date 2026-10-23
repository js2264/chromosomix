/**
 * The restriction task, run against a fake context, and its descriptor.
 *
 * `restriction.test.ts` owns the arithmetic and `restriction-golden.test.ts`
 * holds it to bioframe and pairtools. What is asserted here is what the task
 * adds on top: the two outputs and their ids, which Pairs QC and a shell's
 * output folder both depend on; the cuts read back out of a run with both
 * strands; a reference read by range cut site for site as one held whole;
 * every refusal a sentence rather than a throw; and the form's checks.
 */

import { describe, expect, it } from 'vitest'

import { runRestriction, scanCuts } from '@/analysis/run/restriction'
import { ENZYME_PARAM, RESTRICTION_TASK, SITES_PARAM } from '@/analysis/tasks/restriction'
import type { SequenceReader, TrackJobContext } from '@/analysis/job'
import type {
  AnalysisContext,
  AnalysisFraming,
  IntervalsOutput,
  Params,
  ProfileOutput,
  TaskOutput,
  TaskResult,
} from '@/analysis/types'
import { defaultParams } from '@/analysis/types'
import type { AnnotationEntry, FeatureSet } from '@/annotations/types'
import { cutsOfResult, enzymesFor, type Enzyme } from '@/genome/restriction'

/**
 * Three sequences, in an order no alphabet would produce, as the motif run's
 * test has them: `chrB` before `chrA`, so an order lost anywhere shows.
 */
const REFERENCE: Array<[string, string]> = [
  ['chrB', 'AAGATCAAAAGAATCA'], // DpnII at 2, HinfI's GAATC at 10
  ['chrA', 'TTGGATCTTTTTTTTT'], // DpnII at 3
  ['chrGap', 'NNNNNNNNAAAAAAAA'], // no site at all
]

const LENGTHS: Record<string, number> = Object.fromEntries(REFERENCE.map(([name, bases]) => [name, bases.length]))

function reader(): SequenceReader {
  const bases = new Map(REFERENCE.map(([name, text]) => [name, Uint8Array.from(text, (c) => c.charCodeAt(0))]))
  return {
    contigs: REFERENCE.map(([name, text]) => ({ name, length: text.length })),
    bases: (contig) => bases.get(contig),
  }
}

/** The same reference as the worker hands out a FASTA opened by its `.fai`, logging each read. */
function ranged(log: Array<[string, number, number]> = []): SequenceReader {
  const source = reader()
  return {
    contigs: source.contigs,
    bases: () => undefined,
    refusal: 'This FASTA is read by range from its index rather than held.',
    read: async (contig, start, end) => {
      log.push([contig, start, end])
      return source.bases(contig)?.slice(start, end)
    },
  }
}

function framing(binsize: number): AnalysisFraming {
  return {
    uri: 'test.cool',
    label: 'three toy sequences',
    binsize,
    binsPerCell: 1,
    rows: [0, 6],
    cols: [0, 6],
    balance: false,
    value: '',
    normalise: null,
    level: 'bin',
  }
}

interface Ran {
  outputs: TaskOutput[]
  notes: string[]
  progress: number[]
}

async function run(
  params: Params,
  options: { binsize?: number; reference?: SequenceReader; cancelAfter?: number } = {},
): Promise<Ran> {
  const notes: string[] = []
  const progress: number[] = []
  let checks = 0
  const residues = options.reference ?? reader()
  const job: TrackJobContext = {
    params: { sequence: 'seq1', enzyme: 'DpnII', ...params },
    framing: framing(options.binsize ?? 8),
    inputs: { contigLengths: LENGTHS },
    cancelled: () => false,
    throwIfCancelled: () => {
      if (options.cancelAfter !== undefined && ++checks > options.cancelAfter) throw new Error('cancelled')
    },
    progress: (done, total) => progress.push(done / total),
    note: (text) => notes.push(text),
    sample: () => Promise.reject(new Error('a digest reads no tracks')),
    lengthOf: (contig) => LENGTHS[contig],
    residues: (entry) => (entry === 'seq1' ? residues : undefined),
  }
  return { outputs: await runRestriction(job), notes, progress }
}

function sitesOf(outputs: TaskOutput[]): IntervalsOutput | undefined {
  return outputs.find((one): one is IntervalsOutput => one.kind === 'intervals')
}

function setOf(outputs: TaskOutput[]): FeatureSet | undefined {
  const output = sitesOf(outputs)
  return output?.payload.kind === 'features' ? output.payload.data : undefined
}

function densityOf(outputs: TaskOutput[]): ProfileOutput | undefined {
  return outputs.find((one): one is ProfileOutput => one.kind === 'profile')
}

/** `[contig, start, end, name]` per cut, in the order the lane holds them. */
function cuts(outputs: TaskOutput[]): Array<[string, number, number, string]> {
  const set = setOf(outputs)
  if (set === undefined) return []
  return Array.from({ length: set.length }, (_, i) => [set.contigs[set.contig[i]], set.start[i], set.end[i], set.name[i]])
}

function result(outputs: TaskOutput[]): TaskResult {
  return {
    outputs,
    provenance: {
      task: 'restriction',
      taskVersion: 1,
      params: {},
      framing: framing(8),
      app: 'test',
      createdAt: '',
    },
    notes: [],
    ms: 0,
  }
}

describe('the sites a run finds', () => {
  it('are one base at each top-strand cut, in the reference’s order, named by the enzyme', async () => {
    const { outputs } = await run({})
    expect(cuts(outputs)).toEqual([
      ['chrB', 2, 3, 'DpnII'],
      ['chrA', 3, 4, 'DpnII'],
    ])
    const set = setOf(outputs)
    // Every sequence the run cut is in the set, the one with no cut included.
    expect(set?.contigs).toEqual(['chrB', 'chrA', 'chrGap'])
    expect(Array.from(set?.contigAt ?? [])).toEqual([0, 1, 2, 2])
    expect(set?.detail[0]).toBe('DpnII cuts ^GATC')
  })

  it('are a lane of points, with the id and the label a shell writes them under', async () => {
    const { outputs } = await run({})
    expect(outputs.map((one) => one.kind)).toEqual(['intervals', 'profile'])
    const sites = sitesOf(outputs)
    expect(sites).toMatchObject({
      id: 'restriction-DpnII',
      label: 'DpnII sites',
      display: 'lane',
      look: 'point',
      noun: { one: 'site', many: 'sites' },
    })
    expect(densityOf(outputs)?.id).toBe('restriction-DpnII-density')
  })

  it('name a kit by itself and each cut by the enzyme that made it', async () => {
    const { outputs } = await run({ enzyme: 'Arima' })
    expect(cuts(outputs)).toEqual([
      ['chrB', 2, 3, 'DpnII'],
      ['chrB', 11, 12, 'HinfI'],
      ['chrA', 3, 4, 'DpnII'],
    ])
    expect(sitesOf(outputs)).toMatchObject({ id: 'restriction-Arima', label: 'Arima (DpnII+HinfI) sites' })
  })

  it('name typed sites by the sites, a ^ written so that a file can be named after it', async () => {
    const { outputs } = await run({ enzyme: 'custom', sites: 'G^ANTC, MboI' })
    expect(sitesOf(outputs)?.id).toBe('restriction-G_ANTC-DpnII')
    expect(sitesOf(outputs)?.label).toBe('G^ANTC+DpnII sites')
    expect(cuts(outputs).map((cut) => cut[3])).toEqual(['DpnII', 'G^ANTC', 'DpnII'])
  })

  it('say how many there are and how long the fragments are', async () => {
    const { notes } = await run({})
    expect(notes.join(' ')).toMatch(/2 DpnII cuts on 3 sequences: 5 fragments, 10 bp long on average/)
  })
})

describe('the cuts, read back', () => {
  it('are both strands of every cut, for each sequence the run read', async () => {
    const { outputs } = await run({ enzyme: 'Arima' })
    const back = cutsOfResult(result(outputs))
    expect([...(back?.keys() ?? [])]).toEqual(['chrB', 'chrA', 'chrGap'])
    // DpnII's bottom strand four bases after the top, HinfI's three.
    expect(Array.from(back?.get('chrB')?.top ?? [])).toEqual([2, 11])
    expect(Array.from(back?.get('chrB')?.bottom ?? [])).toEqual([6, 14])
    expect(back?.get('chrGap')?.top.length).toBe(0)
  })

  it('agree with a scan of the reference itself', async () => {
    const enzymes = enzymesFor('Arima', '') as Enzyme[]
    const scanned = await scanCuts(reader(), enzymes)
    const back = cutsOfResult(result((await run({ enzyme: 'Arima' })).outputs))
    for (const one of scanned) {
      expect(Array.from(back?.get(one.contig)?.top ?? []), one.contig).toEqual(Array.from(one.cuts.top))
      expect(Array.from(back?.get(one.contig)?.bottom ?? []), one.contig).toEqual(Array.from(one.cuts.bottom))
    }
  })
})

describe('the density lane', () => {
  it('counts the cuts per bin of the session’s grid, an empty bin a zero', async () => {
    const { outputs } = await run({ enzyme: 'Arima' })
    const density = densityOf(outputs)
    expect(density?.binsize).toBe(8)
    expect(density?.extent).toEqual([0, 6])
    expect(Array.from(density?.values ?? [])).toEqual([1, 1, 1, 0, 0, 0])
    expect(density?.unit).toBe('sites')
  })

  it('is absent, and said to be, where the session has no bin grid', async () => {
    const { outputs, notes } = await run({}, { binsize: 0 })
    expect(densityOf(outputs)).toBeUndefined()
    expect(setOf(outputs)?.length).toBe(2)
    expect(notes.join(' ')).toMatch(/density/i)
  })
})

describe('a reference read by range', () => {
  it('is cut through its windows, cut for cut as one held whole', async () => {
    const held = await run({ enzyme: 'Arima' })
    const read = await run({ enzyme: 'Arima' }, { reference: ranged() })
    expect(cuts(read.outputs)).toEqual(cuts(held.outputs))
    expect(Array.from(densityOf(read.outputs)?.values ?? [])).toEqual(Array.from(densityOf(held.outputs)?.values ?? []))
    expect(read.notes.join(' ')).not.toContain('rather than held')
  })

  it('finds a site across a seam once, wherever the seam falls', async () => {
    const enzymes = enzymesFor('Arima', '') as Enzyme[]
    const whole = await scanCuts(reader(), enzymes)
    for (let piece = 1; piece <= 17; piece++) {
      const log: Array<[string, number, number]> = []
      const read = await scanCuts(ranged(log), enzymes, { piece })
      const held = await scanCuts(reader(), enzymes, { piece })
      for (const pieced of [read, held]) {
        expect(pieced.map((one) => Array.from(one.cuts.top)), `pieces of ${piece}`).toEqual(
          whole.map((one) => Array.from(one.cuts.top)),
        )
        expect(pieced.map((one) => Array.from(one.cuts.bottom)), `pieces of ${piece}`).toEqual(
          whole.map((one) => Array.from(one.cuts.bottom)),
        )
      }
      // No window longer than a piece and the overlap, one base short of GAATC.
      for (const [, start, end] of log) expect(end - start).toBeLessThanOrEqual(piece + 4)
    }
  })

  it('reports as it goes, and sees a Stop between two pieces', async () => {
    const enzymes = enzymesFor('DpnII', '') as Enzyme[]
    const seen: number[] = []
    await scanCuts(ranged(), enzymes, { piece: 4, progress: (done, total) => seen.push(done / total) })
    expect(seen.at(-1)).toBe(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)

    let checks = 0
    const log: Array<[string, number, number]> = []
    const stopped = scanCuts(ranged(log), enzymes, {
      piece: 4,
      throwIfCancelled: () => {
        if (++checks === 3) throw new Error('cancelled')
      },
    })
    await expect(stopped).rejects.toThrow('cancelled')
    expect(log).toHaveLength(2)
  })
})

describe('the sequences ticked', () => {
  it('narrow the digest to themselves, and the lane and its id say which', async () => {
    const log: Array<[string, number, number]> = []
    const { outputs } = await run({ sequences: ['chrA'] }, { reference: ranged(log) })
    expect(cuts(outputs)).toEqual([['chrA', 3, 4, 'DpnII']])
    expect(new Set(log.map(([name]) => name))).toEqual(new Set(['chrA']))
    expect(sitesOf(outputs)).toMatchObject({ id: 'restriction-DpnII-on-chrA', label: 'DpnII on chrA sites' })
    // Only chrA is the reference now, so only chrA comes back.
    expect([...(cutsOfResult(result(outputs))?.keys() ?? [])]).toEqual(['chrA'])
  })

  it('are nothing when none is ticked, and the run says so before reading', async () => {
    const log: Array<[string, number, number]> = []
    const { outputs, notes } = await run({ sequences: [] }, { reference: ranged(log) })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toMatch(/No sequence is ticked/)
    expect(log).toEqual([])
  })
})

describe('a run that cannot cut', () => {
  it('says so in a note rather than throwing, for each reason', async () => {
    const said = async (params: Params): Promise<string> => {
      const { outputs, notes } = await run(params)
      expect(outputs).toEqual([])
      return notes.join(' ')
    }
    expect(await said({ enzyme: 'none' })).toMatch(/No enzyme was chosen/)
    expect(await said({ enzyme: 'custom', sites: 'GATC' })).toMatch(/needs a \^/)
    expect(await said({ sequence: '' })).toMatch(/No reference was chosen/)
    expect(await said({ sequence: 'gone' })).toMatch(/no longer loaded/)
    expect(await said({ sequences: ['chrZ'] })).toMatch(/None of the ticked sequences is in this reference/)
  })
})

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

function entry(byRange?: { bases: number; bytesPerBase: number }): AnnotationEntry {
  return {
    id: 'seq1',
    card: 'linear',
    kind: 'sequence',
    label: 'yeast.fa',
    source: { kind: 'remote', url: 'https://example.invalid/yeast.fa', name: 'yeast.fa' },
    status: 'ready',
    visible: true,
    placement: { top: false, right: false, bottom: true, left: false },
    ...(byRange === undefined ? {} : { byRange }),
  } as AnnotationEntry
}

function context(entries: AnnotationEntry[]): AnalysisContext {
  return {
    entries,
    contigs: REFERENCE.map(([name, bases], at) => ({ name, length: bases.length, startBin: at * 2, bins: 2 })),
  } as unknown as AnalysisContext
}

describe('the descriptor', () => {
  const params = (over: Params): Params => ({ ...defaultParams(RESTRICTION_TASK.params), sequence: 'seq1', ...over })

  it('runs beside the residues, makes the sites then the density, and waits for a FASTA', () => {
    expect(RESTRICTION_TASK).toMatchObject({ id: 'restriction', title: 'Restriction sites', venue: 'annotations', group: '1d' })
    expect(RESTRICTION_TASK.outputs).toEqual(['intervals', 'profile'])
    expect(RESTRICTION_TASK.availability(context([])).state).toBe('waiting')
    expect(RESTRICTION_TASK.availability(context([entry()])).state).toBe('ready')
  })

  it('offers none, every preset, the kit and custom, and asks for sites only under custom', () => {
    expect(ENZYME_PARAM.default).toBe('none')
    expect(ENZYME_PARAM.options.map((option) => option.value)).toEqual([
      'none',
      'DpnII',
      'HindIII',
      'NcoI',
      'EcoRI',
      'BglII',
      'HinfI',
      'DdeI',
      'MseI',
      'NlaIII',
      'CviQI',
      'AluI',
      'Arima',
      'custom',
    ])
    expect(SITES_PARAM.when?.({ enzyme: 'custom' })).toBe(true)
    expect(SITES_PARAM.when?.({ enzyme: 'DpnII' })).toBe(false)
  })

  it('keeps every hint to one sentence, in prose', () => {
    // The registry's rule (`analysis-registry.test.ts`), held here too so the
    // two controls Pairs QC borrows are checked wherever they are used.
    for (const spec of RESTRICTION_TASK.params) {
      if (spec.hint === undefined) continue
      expect(spec.hint.split(/[.!?] +(?=[A-Z0-9])/).length, spec.key).toBe(1)
      expect(spec.hint, spec.key).not.toMatch(/[`*_]|§/)
      expect(spec.hint, spec.key).toMatch(/[.!?]$/)
    }
  })

  it('refuses before a run what the run would refuse, in the library’s words', () => {
    const ctx = context([entry()])
    expect(RESTRICTION_TASK.estimate(ctx, params({ sequence: '' })).refusal).toMatch(/Choose a reference/)
    expect(RESTRICTION_TASK.estimate(ctx, params({})).refusal).toMatch(/Choose an enzyme/)
    expect(RESTRICTION_TASK.estimate(ctx, params({ enzyme: 'custom', sites: 'GATC' })).refusal).toMatch(
      /needs a \^ where the enzyme cuts/,
    )
    expect(RESTRICTION_TASK.estimate(ctx, params({ enzyme: 'DpnII', sequences: [] })).refusal).toBe(
      'Tick at least one sequence.',
    )
  })

  it('prices a reference held whole as free and one read by range as a scan', () => {
    const held = RESTRICTION_TASK.estimate(context([entry()]), params({ enzyme: 'Arima' }))
    expect(held).toMatchObject({ class: 'free', requests: 0, bytes: 0 })
    expect(held.refusal).toBeUndefined()
    expect(held.note).toMatch(/2 passes over yeast\.fa/)
    const read = RESTRICTION_TASK.estimate(context([entry({ bases: 48, bytesPerBase: 1.02 })]), params({ enzyme: 'DpnII' }))
    expect(read).toMatchObject({ class: 'scan', requests: 3, bytes: 49 })
  })
})
