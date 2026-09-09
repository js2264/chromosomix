/**
 * The motif runner, against a fake context — which is where the *task's* half of
 * the feature lives.
 *
 * `motif.test.ts` owns the matcher and `motif-worker.test.ts` drives the whole
 * thing through the worker's front door. What is asserted here is the part in
 * between: the four decisions the runner makes on its own, each of which would
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
 */

import { describe, expect, it } from 'vitest'

import { runMotif } from '@/analysis/run/motif'
import type { SequenceReader, TrackJobContext } from '@/analysis/job'
import type {
  AnalysisFraming,
  IntervalsOutput,
  Params,
  ProfileOutput,
  TaskOutput,
} from '@/analysis/types'
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

async function run(params: Params, options: { binsize?: number } = {}): Promise<Ran> {
  const notes: string[] = []
  const job: TrackJobContext = {
    params: { sequence: 'seq1', bothStrands: false, ...params },
    framing: framing(options.binsize ?? 8),
    inputs: { contigLengths: LENGTHS },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text) => notes.push(text),
    sample: () => Promise.reject(new Error('a motif search reads no tracks')),
    lengthOf: (contig) => LENGTHS[contig],
    // Keyed on the parameter's value, exactly as the worker's is on its store:
    // a runner that reached for "the reference" rather than for the one the
    // reader chose would pass every other case in this file.
    residues: (entry) => (entry === 'seq1' ? reader() : undefined),
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
