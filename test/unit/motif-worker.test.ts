/**
 * The motif search, through the door it actually arrives at: the task.
 *
 * `motif.test.ts` covers the matcher, which is arithmetic over one array and can
 * be checked on its own, and `analysis-motif-run.test.ts` covers the runner
 * against a fake context. What neither can check is everything between a
 * reader's pattern and a lane: that the FASTA is found under the entry id the
 * *parameters* name, that the runner reaches the residues at all — which it can
 * only do through a capability this worker is the sole provider of
 * (`TrackJobContext.residues`) — that the scan walks the reference's own
 * sequences in the reference's own order, that a contig with no hit contributes
 * nothing rather than three empty arrays, and that a pattern nobody could
 * compile comes back as a *sentence* rather than as a failed request.
 *
 * That last one is the reason this file exists rather than a couple of extra
 * cases beside the matcher. "`X` is not a IUPAC base" is a fact about what the
 * reader typed and belongs in front of them as a note; a throw is the shape
 * reserved for something having gone wrong, and the difference is invisible from
 * inside the worker.
 *
 * It was written against a `motif` **request**, which the bespoke card sent.
 * There is no such request any more — the search is a registered task, and the
 * only thing the main thread sends is the `run` every other task in this venue
 * arrives by — so the same properties are asserted through that instead.
 */

// Not jsdom: importing the worker module wants `self`, and the front door it
// installs is the one a search really arrives through.

import { beforeAll, describe, expect, it } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { AnalysisFraming, IntervalsOutput, Params, TaskResult } from '@/analysis/types'
import type { FeatureSet } from '@/annotations/types'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (m: AnnotationResponse) => {
    posted.push(m)
  }
  await import('@/annotations/worker/annotations.worker')
  const handler = (globalThis as unknown as { onmessage: (e: { data: AnnotationRequest }) => void })
    .onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1

type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  for (let turn = 0; turn < 4000; turn++) {
    // `result` or `error` only. A task reports progress on the same id, and a
    // finder that took the first message carrying it would answer with the bar
    // rather than with the answer.
    const found = posted.find(
      (m) => (m.type === 'result' || m.type === 'error') && m.id === id,
    )
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`no answer for request ${id}`)
}

/**
 * A four-sequence reference, loaded once for every case below.
 *
 * `chrII` deliberately has no site of the motif the first cases look for, so
 * "a contig with no hits is omitted" is asserted against a real absence rather
 * than against an empty file. `chrIV` carries `GATCC` and nothing else does, so
 * the reverse-strand case has somewhere to find a hit that the forward search
 * provably cannot — otherwise it would pass against a reversed motif that was
 * never actually searched for.
 */
const FASTA =
  '>chrI\n' +
  'AAGATCAAAAGATCAA\n' + // GATC at 2 and 10
  '>chrII\n' +
  'AAAAAAAAAAAA\n' + // no site of anything looked for below
  '>chrIII\n' +
  'TTGGATCTTTTTTTTT\n' + // GGATC at 2, so GATC at 3
  '>chrIV\n' +
  'TTGATCCTTTTTTTTT\n' // GATCC at 2, which is GGATC read backwards
const ENTRY = 'seq-1'

/** The lengths of the four above, which is the assembly the task is handed. */
const LENGTHS: Record<string, number> = { chrI: 16, chrII: 12, chrIII: 16, chrIV: 16 }

/**
 * A framing with a bin grid, so both outputs are exercised.
 *
 * `binsize: 8` splits each of these toy sequences into two bins, which is enough
 * for the density half to be wrong in a visible way if it is wrong at all.
 */
const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'the four toy sequences',
  binsize: 8,
  binsPerCell: 1,
  rows: [0, 8],
  cols: [0, 8],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

async function run(params: Params): Promise<TaskResult> {
  const response = await ask({
    kind: 'run',
    task: 'motif',
    params: { sequence: ENTRY, bothStrands: false, ...params },
    framing: FRAMING,
    inputs: { contigLengths: LENGTHS },
  })
  expect(response.type, JSON.stringify(response)).toBe('result')
  return (response as { payload: TaskResult }).payload
}

/** The sites lane of a finished run, or `undefined` where it produced none. */
function intervals(result: TaskResult): FeatureSet | undefined {
  const output = result.outputs.find((one): one is IntervalsOutput => one.kind === 'intervals')
  return output?.payload.kind === 'features' ? output.payload.data : undefined
}

/** `{contig: [[start, end, strand], …]}`, which is what the assertions are about. */
function sites(result: TaskResult): Record<string, Array<[number, number, number]>> {
  const set = intervals(result)
  const out: Record<string, Array<[number, number, number]>> = {}
  if (set === undefined) return out
  for (let i = 0; i < set.length; i++) {
    const contig = set.contigs[set.contig[i]]
    ;(out[contig] ??= []).push([set.start[i], set.end[i], set.strand[i]])
  }
  return out
}

function total(result: TaskResult): number {
  return intervals(result)?.length ?? 0
}

beforeAll(async () => {
  const response = await ask({
    kind: 'load',
    entry: ENTRY,
    source: { kind: 'local', file: new File([FASTA], 'ref.fa'), name: 'ref.fa' },
    mapContigs: [],
  })
  expect(response.type, JSON.stringify(response)).toBe('result')
})

describe('searching a loaded reference', () => {
  it('finds every site, in the reference’s own order', async () => {
    const found = await run({ pattern: 'GATC' })
    expect(sites(found)).toEqual({
      chrI: [
        [2, 6, 1],
        [10, 14, 1],
      ],
      // GATC is a palindrome, but only one strand was asked for, so these are
      // forward-strand hits. chrIII carries GGATC, whose GATC starts at 3.
      chrIII: [[3, 7, 1]],
      chrIV: [[2, 6, 1]],
    })
    expect(total(found)).toBe(4)
    // The order is the reference's, not the order a `Map` of hits happened to be
    // built in — the contigs table of the set is what a lane is drawn through.
    expect(intervals(found)?.contigs).toEqual(['chrI', 'chrIII', 'chrIV'])
  })

  it('omits a sequence with no site rather than carrying an empty row', async () => {
    expect(intervals(await run({ pattern: 'GATC' }))?.contigs).not.toContain('chrII')
  })

  it('marks a palindrome as both strands when both were asked for', async () => {
    const found = await run({ pattern: 'GATC', bothStrands: true })
    // Still four sites, not eight: the reverse search would land on exactly the
    // same coordinates, and a reader counting a lane would get twice the answer.
    expect(total(found)).toBe(4)
    expect(sites(found).chrI).toEqual([
      [2, 6, 0],
      [10, 14, 0],
    ])
  })

  it('finds the reverse strand of a motif that has one', async () => {
    // GGATC reverse-complements to GATCC, which chrIV carries at 2.
    const found = await run({ pattern: 'GGATC', bothStrands: true })
    expect(sites(found)).toEqual({
      chrIII: [[2, 7, 1]],
      chrIV: [[2, 7, -1]],
    })
  })

  it('answers a degenerate pattern', async () => {
    // GRTC is GATC or GGTC; only GATC is here.
    expect(total(await run({ pattern: 'GRTC' }))).toBe(4)
    expect(total(await run({ pattern: 'GYTC' }))).toBe(0)
  })

  it('says so in a note rather than failing when there is nothing to find', async () => {
    const found = await run({ pattern: 'CCCCCCCC' })
    expect(found.outputs).toEqual([])
    expect(found.notes.join(' ')).toMatch(/No match/i)
  })

  it('produces the density lane beside the sites, on the framing’s own bins', async () => {
    const found = await run({ pattern: 'GATC' })
    const profile = found.outputs.find((one) => one.kind === 'profile')
    expect(profile?.kind).toBe('profile')
    if (profile?.kind !== 'profile') return
    expect(profile.binsize).toBe(FRAMING.binsize)
    // Two bins per sequence, in the order the assembly was handed over, and the
    // sites summed into the bin each one starts in: chrI has one in each of its
    // two, chrII has none at all, chrIII and chrIV one each in their first.
    expect(Array.from(profile.values)).toEqual([1, 1, 0, 0, 1, 0, 1, 0])
    expect(profile.extent).toEqual([0, 8])
  })
})

describe('what it refuses and what it caps', () => {
  it('returns the refusal as a note, not as a failed request', async () => {
    const found = await run({ pattern: 'ACGX' })
    expect(found.notes.join(' ')).toContain('X')
    expect(found.outputs).toEqual([])
  })

  it('stops at the limit and says that it did', async () => {
    const found = await run({ pattern: 'A', limit: 2 })
    expect(total(found)).toBe(2)
    expect(found.notes.join(' ')).toMatch(/stopped at the limit/i)
  })

  it('does not claim truncation when the limit was merely reached exactly', async () => {
    const all = await run({ pattern: 'GATC' })
    const exact = await run({ pattern: 'GATC', limit: total(all) })
    expect(total(exact)).toBe(total(all))
    expect(exact.notes.join(' ')).not.toMatch(/stopped at the limit/i)
  })
})

describe('a parameter that names no loaded sequence', () => {
  it('is a sentence about the form rather than a failed run', async () => {
    // The row was dropped between the form being filled in and Run being
    // pressed. A task that threw here would show a red card for something the
    // reader can fix in one click.
    const response = await ask({
      kind: 'run',
      task: 'motif',
      params: { sequence: 'no-such-entry', pattern: 'ACGT', bothStrands: false },
      framing: FRAMING,
      inputs: { contigLengths: LENGTHS },
    })
    expect(response.type).toBe('result')
    const result = (response as { payload: TaskResult }).payload
    expect(result.outputs).toEqual([])
    expect(result.notes.join(' ')).toMatch(/no longer loaded/i)
  })
})
