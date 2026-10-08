/**
 * The motif runner, against a fake context — which is where the *task's* half of
 * the feature lives.
 *
 * `motif.test.ts` owns the matcher and `motif-worker.test.ts` drives the whole
 * thing through the worker's front door. What is asserted here is the part in
 * between: the five decisions the runner makes on its own, each of which would
 * be invisible if it were wrong.
 *
 * - **A refusal is a note, not a throw.** `compileMotif` answers a pattern it
 *   cannot read with a sentence about what was typed, and §18.3 reserves a
 *   thrown error for something having gone wrong. A reader who typed `ACGX` must
 *   read *why*, under the run, rather than be shown a red card.
 * - **An empty bin of the density lane is a zero.** `NaN` in a `ProfileOutput`
 *   means *nothing is known here* and draws as a hole; a stretch of genome with
 *   no site in it is the most informative thing a restriction map has to say, and
 *   drawing it as missing data would hide exactly that.
 * - **The density is on the framing's bin grid**, because
 *   `AnalysisWorkspace.register` pairs this output's `binsize` with the session's
 *   own contig grid — so a vector on any other grid is drawn in the wrong places
 *   rather than not drawn at all. With no grid at all (a 1D browser session,
 *   where the framing's bin size is `0`) there is no density lane and the run
 *   says so.
 * - **A reference `N` does not satisfy a pattern naming a base.** That decision
 *   is `annotations/motif.ts`', and it is re-asserted through the runner because
 *   it is the one that decides whether a draft assembly reads as a genome or as a
 *   solid bar of fictional hits.
 * - **A sentence about the limit names the limit the scan used.** The cap is
 *   `MOTIF_SITE_LIMIT` whatever the parameter says, and a note quoting the
 *   parameter instead told a reader to raise a control that could not help them.
 *
 * The last section is the odd one out: it drives the real `AnalysisRunner`
 * rather than `runMotif`, because the thing being asserted is what a **Stop**
 * means for a task in this venue — a question about the runner that only a task
 * routed to the annotations worker can ask.
 */

import { describe, expect, it } from 'vitest'

import { runMotif, scanMotif } from '@/analysis/run/motif'
import { compileMotif, isMotifRefusal, type Motif } from '@/annotations/motif'
import type { SequenceReader, TrackJobContext } from '@/analysis/job'
import { AnalysisRunner, type RunnerHost, type RunTarget } from '@/analysis/runner'
import { MOTIF_SITE_LIMIT, MOTIF_TASK } from '@/analysis/tasks/motif'
import type {
  AnalysisContext,
  AnalysisFraming,
  IntervalsOutput,
  Params,
  ProfileOutput,
  TaskOutput,
  TaskResult,
} from '@/analysis/types'
import type { AnalysisClient } from '@/analysis/worker/client'
import type { AnnotationClient } from '@/annotations/worker/client'
import type { FeatureSet } from '@/annotations/types'

/**
 * Three sequences, in an order no alphabet would produce.
 *
 * `chrB` before `chrA` on purpose: "in the reference's own order" is a claim
 * that fails silently against a reference that is already sorted, and the grid
 * the density is laid out on is cumulative, so an order swapped anywhere puts
 * every later sequence's sites at the wrong absolute bin.
 */
const REFERENCE: Array<[string, string]> = [
  ['chrB', 'AAGATCAAAAGATCAA'], // GATC at 2 and 10
  ['chrA', 'TTGGATCTTTTTTTTT'], // GGATC at 2, so GATC at 3
  ['chrGap', 'NNNNNNNNAAAAAAAA'], // eight unknown bases, then eight known ones
]

const LENGTHS: Record<string, number> = Object.fromEntries(
  REFERENCE.map(([name, bases]) => [name, bases.length]),
)

function reader(): SequenceReader {
  const bases = new Map(
    REFERENCE.map(([name, text]) => [
      name,
      Uint8Array.from(text, (letter) => letter.charCodeAt(0)),
    ]),
  )
  return {
    contigs: REFERENCE.map(([name, text]) => ({ name, length: text.length })),
    bases: (contig) => bases.get(contig),
  }
}

/** `binsize: 8` gives each of the three sequences exactly two bins. */
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
}

async function run(
  params: Params,
  // `reference` for the one case that cannot use the toy sequences above: the
  // site ceiling needs half a million hits, and no other case should carry half
  // a megabyte of residues to get them.
  options: { binsize?: number; reference?: SequenceReader } = {},
): Promise<Ran> {
  const notes: string[] = []
  const residues = options.reference ?? reader()
  const lengths: Record<string, number> =
    options.reference === undefined
      ? LENGTHS
      : Object.fromEntries(options.reference.contigs.map((one) => [one.name, one.length]))
  const job: TrackJobContext = {
    params: { sequence: 'seq1', bothStrands: false, ...params },
    framing: framing(options.binsize ?? 8),
    inputs: { contigLengths: lengths },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text) => notes.push(text),
    sample: () => Promise.reject(new Error('a motif search reads no tracks')),
    lengthOf: (contig) => lengths[contig],
    // Keyed on the parameter's value, exactly as the worker's is on its store:
    // a runner that reached for "the reference" rather than for the one the
    // reader chose would pass every other case in this file.
    residues: (entry) => (entry === 'seq1' ? residues : undefined),
  }
  return { outputs: await runMotif(job), notes }
}

function features(outputs: TaskOutput[]): FeatureSet | undefined {
  const output = outputs.find((one): one is IntervalsOutput => one.kind === 'intervals')
  return output?.payload.kind === 'features' ? output.payload.data : undefined
}

function profile(outputs: TaskOutput[]): ProfileOutput | undefined {
  return outputs.find((one): one is ProfileOutput => one.kind === 'profile')
}

/** `[contig, start, end, strand]` per site, in the order the lane holds them. */
function sites(outputs: TaskOutput[]): Array<[string, number, number, number]> {
  const set = features(outputs)
  if (set === undefined) return []
  const out: Array<[string, number, number, number]> = []
  for (let i = 0; i < set.length; i++) {
    out.push([set.contigs[set.contig[i]], set.start[i], set.end[i], set.strand[i]])
  }
  return out
}

describe('the sites a run finds', () => {
  it('are in the reference’s own order, with the coordinates and the strand', async () => {
    const { outputs } = await run({ pattern: 'GATC' })
    expect(sites(outputs)).toEqual([
      ['chrB', 2, 6, 1],
      ['chrB', 10, 14, 1],
      ['chrA', 3, 7, 1],
    ])
  })

  it('carry the pattern as a name, so the search box can find one', async () => {
    const set = features((await run({ pattern: 'gatc' })).outputs)
    expect(set?.name[0]).toContain('GATC')
  })

  it('are named and labelled with the strand the search asked about', async () => {
    const one = await run({ pattern: 'GATC' })
    const both = await run({ pattern: 'GATC', bothStrands: true })
    const label = (outputs: TaskOutput[]): string =>
      outputs.find((output) => output.kind === 'intervals')?.label ?? ''
    expect(label(one.outputs)).toBe('GATC')
    expect(label(both.outputs)).toBe('GATC (both strands)')
    // Two different answers to two different questions, so two different rows:
    // one id for both would let the second silently replace the first.
    const id = (outputs: TaskOutput[]): string =>
      outputs.find((output) => output.kind === 'intervals')?.id ?? ''
    expect(id(one.outputs)).not.toBe(id(both.outputs))
  })
})

describe('one strand or both', () => {
  it('reports a palindrome once when both were asked for, not twice', async () => {
    // GATC is its own reverse complement, so a both-strand search lands on the
    // same coordinates twice — and a reader counting the lane would get double.
    const both = await run({ pattern: 'GATC', bothStrands: true })
    expect(sites(both.outputs).map((site) => site[3])).toEqual([0, 0, 0])
    expect(sites(both.outputs).length).toBe(sites((await run({ pattern: 'GATC' })).outputs).length)
  })

  it('finds a reverse-strand hit only when both strands were asked for', async () => {
    // GGATC occurs on chrA forwards. Its reverse complement, GATCC, occurs
    // nowhere, so the one-strand and both-strand answers differ by nothing here
    // — while AAAAAAAA’s complement TTTTTTTT is on chrA and chrGap has both.
    const one = await run({ pattern: 'TTTTTTTT' })
    const both = await run({ pattern: 'TTTTTTTT', bothStrands: true })
    expect(sites(one.outputs).every((site) => site[3] === 1)).toBe(true)
    expect(sites(both.outputs).some((site) => site[3] === -1)).toBe(true)
    expect(sites(both.outputs).length).toBeGreaterThan(sites(one.outputs).length)
  })
})

describe('an ambiguous base in the reference', () => {
  it('does not satisfy a pattern that names one, so a gap is not a run of hits', async () => {
    // chrGap is eight `N`s and then eight `A`s. A pattern of `AAAA` matches four
    // windows in the second half and none at all in the first, which is the
    // whole of the decision: an assembly gap is a base nobody knows.
    const { outputs } = await run({ pattern: 'AAAA' })
    const gap = sites(outputs).filter((site) => site[0] === 'chrGap')
    expect(gap.length).toBe(5)
    expect(gap.every((site) => site[1] >= 8)).toBe(true)
  })

  it('matches N against N, which is the only way an N ever matches', async () => {
    const { outputs } = await run({ pattern: 'NNNN' })
    expect(sites(outputs).some((site) => site[0] === 'chrGap' && site[1] === 0)).toBe(true)
  })
})

describe('the density lane', () => {
  it('counts an empty bin as zero rather than as a gap', async () => {
    const { outputs } = await run({ pattern: 'GATC' })
    const values = Array.from(profile(outputs)?.values ?? [])
    // Two bins per sequence, in the assembly's order: chrB has a site in each of
    // its two, chrA one in its first, chrGap none at all. Every other bin is a
    // measured zero — `NaN` would draw those as holes and claim the search never
    // looked there.
    expect(values).toEqual([1, 1, 1, 0, 0, 0])
    expect(values.some((value) => Number.isNaN(value))).toBe(false)
  })

  it('is on the framing’s bin size, not one of its own choosing', async () => {
    const fine = profile((await run({ pattern: 'GATC' }, { binsize: 8 })).outputs)
    const coarse = profile((await run({ pattern: 'GATC' }, { binsize: 16 })).outputs)
    expect(fine?.binsize).toBe(8)
    expect(fine?.extent).toEqual([0, 6])
    // One bin per sequence at 16 bp, and both of chrB's sites land in it.
    expect(coarse?.binsize).toBe(16)
    expect(Array.from(coarse?.values ?? [])).toEqual([2, 1, 0])
  })

  it('sums to the number of sites, which is what makes the lane readable', async () => {
    const { outputs } = await run({ pattern: 'GATC' })
    const values = Array.from(profile(outputs)?.values ?? [])
    expect(values.reduce((sum, value) => sum + value, 0)).toBe(sites(outputs).length)
  })

  it('is absent — and said to be — where the session has no bin grid', async () => {
    // A 1D browser session: tracks and a reference, no contact map, so the
    // framing's bin size is 0 and there is nothing for a density to be *per*.
    // The sites lane still arrives, because it carries its own coordinates.
    const { outputs, notes } = await run({ pattern: 'GATC' }, { binsize: 0 })
    expect(profile(outputs)).toBeUndefined()
    expect(features(outputs)?.length).toBe(3)
    expect(notes.join(' ')).toMatch(/density/i)
  })
})

describe('a pattern that will not compile', () => {
  it('is a note saying why, rather than a thrown error', async () => {
    const { outputs, notes } = await run({ pattern: 'ACGX' })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toContain('X')
    expect(notes.join(' ')).toMatch(/IUPAC/)
  })

  it('is the same for an empty box, which is a form to finish', async () => {
    const { outputs, notes } = await run({ pattern: '   ' })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toMatch(/type a sequence/i)
  })
})

describe('a reference that is not there', () => {
  it('names the problem rather than reporting an empty search', async () => {
    const { outputs, notes } = await run({ sequence: 'gone', pattern: 'GATC' })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toMatch(/no longer loaded/i)
  })

  it('says something different again when nothing was chosen at all', async () => {
    const { outputs, notes } = await run({ sequence: '', pattern: 'GATC' })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toMatch(/No reference was chosen/i)
  })
})

/**
 * One sequence of nothing but `A`, a base longer than a search for `A` may
 * report — so the ceiling, and not the reference, is what ends the scan.
 *
 * Sized from {@link MOTIF_SITE_LIMIT} rather than from a literal, so raising the
 * ceiling moves the reference with it instead of quietly turning this into a
 * case that never reaches the cap at all.
 */
function crowded(): SequenceReader {
  const bases = new Uint8Array(MOTIF_SITE_LIMIT + 1).fill('A'.charCodeAt(0))
  return {
    contigs: [{ name: 'chrCrowd', length: bases.length }],
    bases: (contig) => (contig === 'chrCrowd' ? bases : undefined),
  }
}

/**
 * The ceiling, and the sentence a reader gets when it bites.
 *
 * `scanMotif` has always capped at {@link MOTIF_SITE_LIMIT} whatever the
 * parameter asked for, and the note used to quote the *parameter*: a run asked
 * for two million sites stopped at five hundred thousand and reported "the
 * limit of 2,000,000 … Raise “Most sites”". Both halves were wrong in the same
 * way — a limit the scan never reached, and a remedy that is inert once the
 * number is already above the ceiling, so a reader who followed the instruction
 * got the identical answer with the identical note under it.
 */
describe('the site ceiling', () => {
  it('quotes the limit the scan stopped at rather than the one that was asked for', async () => {
    const asked = MOTIF_SITE_LIMIT * 4
    const { notes } = await run(
      { pattern: 'A', limit: asked },
      // No bin grid, so no density lane: this case is about the sentence, and
      // the second output is covered above.
      { binsize: 0, reference: crowded() },
    )
    const note = notes.find((text) => text.includes('stopped at the limit')) ?? ''
    expect(note).toContain(MOTIF_SITE_LIMIT.toLocaleString())
    expect(note).not.toContain(asked.toLocaleString())
    // And the remedy is the one that can work. There is nothing left to raise.
    expect(note).not.toMatch(/raise/i)
    expect(note).toMatch(/most one run reports/i)
  })

  it('still points at the control when the reader is the one who set the limit', async () => {
    // Below the ceiling the parameter is honoured, so "Raise “Most sites”" is
    // true and must survive the fix that removed it from the other branch.
    const { notes } = await run({ pattern: 'A', limit: 2 })
    const note = notes.find((text) => text.includes('stopped at the limit')) ?? ''
    expect(note).toContain('limit of 2')
    expect(note).toMatch(/raise/i)
  })
})

// ---------------------------------------------------------------------------
// A reference read by range (§8.8, §8.21)
// ---------------------------------------------------------------------------

/**
 * The toy reference as the worker hands out a FASTA opened by its `.fai`: no
 * `bases`, a refusal for the tasks that need a sequence whole, and `read` —
 * which logs every window it is asked for, so a case can see the pieces.
 */
function ranged(log: Array<[string, number, number]> = [], source = reader()): SequenceReader {
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

function compiled(pattern: string): Motif {
  const motif = compileMotif(pattern)
  if (isMotifRefusal(motif)) throw new Error(motif.reason)
  return motif
}

/** `[contig, start, strand]` per site, out of a scan rather than a run. */
function scanned(result: Awaited<ReturnType<typeof scanMotif>>): Array<[string, number, number]> {
  return result.hits.flatMap((hits) =>
    Array.from(hits.starts, (start, at): [string, number, number] => [hits.contig, start, hits.strands[at]]),
  )
}

describe('a reference read by range', () => {
  it('is searched through its windows, site for site as one held whole', async () => {
    const held = await run({ pattern: 'GATC', bothStrands: true })
    const read = await run({ pattern: 'GATC', bothStrands: true }, { reference: ranged() })
    expect(sites(read.outputs)).toEqual(sites(held.outputs))
    expect(Array.from(profile(read.outputs)?.values ?? [])).toEqual(
      Array.from(profile(held.outputs)?.values ?? []),
    )
    // Not refused for not being held: the refusal is for the tasks that need a
    // sequence whole, and a search does not.
    expect(read.notes.join(' ')).not.toContain('rather than held')
  })

  it('finds a site across a seam once, and only once, wherever the seam falls', async () => {
    // chrB's GATC at 2 straddles a seam at 3, its GATC at 10 one at 12 — and a
    // piece of one base puts a seam inside every site there is. Each piece
    // carries the next three residues, so a site lies whole in exactly one.
    const motif = compiled('GATC')
    const whole = await scanMotif(reader(), motif, { bothStrands: true, limit: 1000 })
    for (let piece = 1; piece <= 17; piece++) {
      const log: Array<[string, number, number]> = []
      const result = await scanMotif(ranged(log), motif, { bothStrands: true, limit: 1000, piece })
      expect(scanned(result), `pieces of ${piece}`).toEqual(scanned(whole))
      expect(result.total).toBe(whole.total)
      // No window longer than a piece and its overlap, and every residue read.
      for (const [, start, end] of log) expect(end - start).toBeLessThanOrEqual(piece + 3)
      expect(log.filter(([name]) => name === 'chrB').map(([, start]) => start)[1] ?? 16).toBe(
        Math.min(piece, 16),
      )
    }
  })

  it('stops at the cap across pieces, and says whether there were more', async () => {
    const motif = compiled('GATC')
    // Three forward sites on chrB and chrA: a cap of two is short of them, a
    // cap of three is exactly them, and only the first is a truncated answer.
    // (chrGap is left out because a cap reached with a sequence still unread
    // is a truncated answer whatever that sequence holds.)
    const contigs = reader().contigs.slice(0, 2)
    const short = await scanMotif(ranged(), motif, { bothStrands: false, limit: 2, piece: 3, contigs })
    expect(short.total).toBe(2)
    expect(short.truncated).toBe(true)
    const exact = await scanMotif(ranged(), motif, { bothStrands: false, limit: 3, piece: 3, contigs })
    expect(exact.total).toBe(3)
    expect(exact.truncated).toBe(false)
  })

  it('reports as it goes, and sees a Stop between two pieces', async () => {
    const motif = compiled('GATC')
    const seen: number[] = []
    await scanMotif(ranged(), motif, {
      bothStrands: false,
      limit: 1000,
      piece: 4,
      progress: (done, total) => seen.push(done / total),
    })
    expect(seen.at(-1)).toBe(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)

    let checks = 0
    const log: Array<[string, number, number]> = []
    const stopped = scanMotif(ranged(log), motif, {
      bothStrands: false,
      limit: 1000,
      piece: 4,
      throwIfCancelled: () => {
        if (++checks === 3) throw new Error('cancelled')
      },
    })
    await expect(stopped).rejects.toThrow('cancelled')
    // Two pieces read, and not one more after the Stop.
    expect(log).toHaveLength(2)
  })
})

describe('the sequences ticked', () => {
  it('narrow the search to themselves, and the lane says which', async () => {
    const log: Array<[string, number, number]> = []
    const { outputs } = await run({ pattern: 'GATC', sequences: ['chrA'] }, { reference: ranged(log) })
    expect(sites(outputs)).toEqual([['chrA', 3, 7, 1]])
    // Nothing of the others was read: a narrowed search over a genome read by
    // range is a narrowed download, which is the point of narrowing it.
    expect(new Set(log.map(([name]) => name))).toEqual(new Set(['chrA']))
    const lane = outputs.find((output) => output.kind === 'intervals')
    expect(lane?.label).toBe('GATC on chrA')
    // Its own rows: chr1 searched and then chr2 are two answers.
    expect(lane?.id).toBe('motif-GATC-on-chrA')
  })

  it('are the whole reference when every one of the session’s is ticked', async () => {
    const { outputs } = await run({ pattern: 'GATC', sequences: ['chrB', 'chrA', 'chrGap'] })
    expect(sites(outputs)).toHaveLength(3)
    const lane = outputs.find((output) => output.kind === 'intervals')
    expect(lane?.label).toBe('GATC')
    expect(lane?.id).toBe('motif-GATC')
  })

  it('are nothing when none is ticked, and the run says so before reading', async () => {
    const log: Array<[string, number, number]> = []
    const { outputs, notes } = await run({ pattern: 'GATC', sequences: [] }, { reference: ranged(log) })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toMatch(/No sequence is ticked/)
    expect(log).toEqual([])
  })

  it('reach the reference by the map’s spelling of them (§5.9)', async () => {
    const roman: SequenceReader = {
      contigs: [
        { name: 'chrIV', length: 8 },
        { name: 'chrV', length: 8 },
      ],
      bases: (contig) =>
        contig === 'chrIV' || contig === 'chrV'
          ? Uint8Array.from('AGATCAAA', (letter) => letter.charCodeAt(0))
          : undefined,
    }
    const { outputs } = await run({ pattern: 'GATC', sequences: ['IV'] }, { reference: roman })
    expect(sites(outputs)).toEqual([['chrIV', 1, 5, 1]])
  })

  it('say so when none of them is in the reference', async () => {
    const { outputs, notes } = await run({ pattern: 'GATC', sequences: ['chrZ'] })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toMatch(/None of the ticked sequences is in this reference/)
  })
})

// ---------------------------------------------------------------------------
// What Stop means for a task in this venue
// ---------------------------------------------------------------------------

/** A session with a reference and a bin grid; the shape `queueOne` reads. */
function sessionContext(): AnalysisContext {
  return {
    uri: 'test.cool',
    layout: 'cool',
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
    binsize: 8,
    nBins: 6,
    hasMap: true,
    contigs: REFERENCE.map(([name, text], at) => ({
      name,
      startBin: at * 2,
      bins: 2,
      length: text.length,
      genome: -1,
    })),
    genomes: null,
    entries: [],
    framing: framing(8),
    blockLoaded: false,
    blockBytes: 0,
  }
}

/**
 * What the annotations worker answers a finished `run` with.
 *
 * The outputs are left empty: what is asserted below is whether `finished` is
 * called at all, and the lanes it would adopt are `motifTrack.ts`' business and
 * are covered above.
 */
function trackResult(): TaskResult {
  return {
    outputs: [],
    provenance: {
      task: 'motif',
      taskVersion: 0,
      params: {},
      framing: framing(8),
      app: '0.0.0-test',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    notes: [],
    ms: 7,
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * **Stop must not end in `done`, whatever the worker goes on to answer.**
 *
 * A motif scan over a reference held whole is a synchronous pass inside the
 * annotations worker, which never returns to its event loop, so the `cancel` the
 * runner now sends there (`analysis/runner.ts`, the `annotations` branch of
 * `runStep`) cannot be read before the pass ends and the run finishes
 * regardless. That is a bounded wait and it is not what this asserts. What it
 * asserts is the half the runner owns: the reader pressed Stop, so the cancel is
 * sent and the answer is *refused*. Before this was checked, the runner's only cancellation test sat at
 * the top of the step loop — before the step, never after it — so a Stop pressed
 * while the step was in flight left the row saying `running` until the scan
 * returned, then set it to `done` and handed the result to `finished`, which put
 * a sites overlay and a density lane on the Annotations panel for a run the
 * reader had called off. The row is the only place a Stop is visible here, so a
 * Stop that lands as `done` is a button that lies.
 *
 * Its natural home is `test/unit/analysis-runner.test.ts` beside the venue's
 * other cases; it is here because motif is the task that makes the window wide
 * enough for a reader to hit.
 */
describe('a Stop pressed while a motif run is on the annotations worker', () => {
  function bench(): {
    runner: AnalysisRunner
    finish: (result: TaskResult) => void
    finished: string[]
    cancels: () => number
  } {
    const finished: string[] = []
    let release: ((result: TaskResult) => void) | null = null
    let cancels = 0
    // Through `cancellable`, which is how a run reaches the worker: the Stop has
    // a door to knock on even where, as here, the work cannot hear it.
    const tracks = {
      cancellable: () => ({
        promise: new Promise<TaskResult>((resolve) => {
          release = resolve
        }),
        cancel: () => {
          cancels++
        },
      }),
    }
    const host: RunnerHost = {
      context: () => sessionContext(),
      // No byte source: a track-only chain mounts nothing, which is also what
      // makes the analysis client below safe to leave unbuilt.
      source: () => null,
      block: () => null,
      payload: () => undefined,
      annotations: () => tracks as unknown as AnnotationClient,
      finished: (task: { id: string }, _result: TaskResult, _target: RunTarget) => {
        finished.push(task.id)
      },
    }
    const client = { terminate: () => {} } as unknown as AnalysisClient
    return {
      runner: new AnalysisRunner(host, () => client),
      finish: (result) => release?.(result),
      finished,
      cancels: () => cancels,
    }
  }

  it('leaves the row cancelled and adopts nothing when the scan answers anyway', async () => {
    const { runner, finish, finished, cancels } = bench()
    runner.run(MOTIF_TASK, { sequence: 'seq1', pattern: 'GATC', bothStrands: false })
    await settle()
    expect(runner.stateOf('motif').status).toBe('running')

    runner.cancel('motif')
    // Sent to the worker, where a task that yields reads it at its next check.
    expect(cancels()).toBe(1)
    // The scan was already past the point of stopping, so the worker answers.
    finish(trackResult())
    await settle()

    const state = runner.stateOf('motif')
    expect(state.status).toBe('cancelled')
    // No red card either: a cancellation is not a failure (§18.3).
    expect(state).not.toHaveProperty('message')
    expect(finished).toEqual([])
    expect(runner.resultOf('motif')).toBeNull()
    runner.destroy()
  })

  it('still reaches done and adopts the lanes when nobody pressed Stop', async () => {
    // The other half, so the guard above cannot pass by refusing everything.
    const { runner, finish, finished } = bench()
    runner.run(MOTIF_TASK, { sequence: 'seq1', pattern: 'GATC', bothStrands: false })
    await settle()
    finish(trackResult())
    await settle()

    expect(runner.stateOf('motif').status).toBe('done')
    expect(finished).toEqual(['motif'])
    runner.destroy()
  })
})
