/**
 * Which key a chosen input is filed under, and read back out from.
 *
 * `AnalysisRunner` gathers the sets a form chose and files each one under the
 * **parameter key** that chose it — `a`, `b`, `features`, `pairs` — because a
 * task with two feature-set parameters has to be able to tell them apart, and
 * because the entry id is a runtime accident that a runner cannot name at the
 * point it wants the set. That is what `TaskInputs` says it means.
 *
 * Five of the six runners read the record back by the **entry id** instead, and
 * every one of them was wrong in the same invisible way: the lookup type-checks,
 * it reads as though it must be right, and it returns `undefined` for a set the
 * reader had plainly chosen — whereupon the task reports *no set was chosen*,
 * over a dropdown with the set's own name in it. Two of them were reported from
 * the field before anyone found the third.
 *
 * So this file asserts the *joint* fact rather than either half. A runner is
 * driven with the two halves deliberately different — the id is `ann7`, the key
 * is `a` — because that is the only arrangement in which the mistake shows: key
 * the record by id in a fixture, and a runner that indexes by id passes.
 */

import { describe, expect, it } from 'vitest'

import { chosenInput, missingInput } from '@/analysis/job'
import type { AnalysisFraming } from '@/analysis/types'
import type { TrackJobContext } from '@/analysis/job'
import { runOverlap } from '@/analysis/run/overlap'
import type { FeatureSet } from '@/annotations/types'

/** A feature set of `n` intervals, `[start, end)` each, on one sequence. */
function features(spans: Array<[number, number]>): FeatureSet {
  const n = spans.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(spans.map(([from]) => from)),
    end: Int32Array.from(spans.map(([, to]) => to)),
    strand: new Int8Array(n),
    score: Float32Array.from(new Array<number>(n).fill(Number.NaN)),
    name: spans.map((_, i) => `f${i}`),
    detail: spans.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(new Array<number>(n).fill(-1)),
    cdsEnd: Int32Array.from(new Array<number>(n).fill(-1)),
    // One contig, so its run is the whole set.
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([Math.max(0, ...spans.map(([from, to]) => to - from))]),
  }
}

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'I',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 100],
  cols: [0, 100],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/** Everything a track-venue runner is handed, plus the notes it wrote. */
function job(
  params: Record<string, unknown>,
  inputs: TrackJobContext['inputs'],
): { context: TrackJobContext; notes: string[] } {
  const notes: string[] = []
  const context: TrackJobContext = {
    params: params as TrackJobContext['params'],
    framing: FRAMING,
    inputs,
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text) => notes.push(text),
    sample: () => Promise.reject(new Error('no sampling in this test')),
    lengthOf: () => 100_000,
  }
  return { context, notes }
}

describe('a runner finds the set the form chose', () => {
  /**
   * The reported failure, end to end: two peak sets picked, and *neither has
   * been chosen* comes back.
   */
  it('reads interval overlap’s two sets by parameter key, not by entry id', async () => {
    const { context, notes } = job(
      // What the form stores: the *entry ids*.
      { a: 'ann7', b: 'ann9' },
      // What the runner files: the same two sets, under the *parameter keys*.
      { features: { a: features([[0, 100]]), b: features([[50, 150]]) } },
    )
    const out = await runOverlap(context)
    expect(notes).toEqual([])
    expect(out).toHaveLength(1)
    const table = out[0]
    expect(table.kind).toBe('table')
    // Half of each set is in the other, so a fiftieth of nothing is not the
    // answer: 50 shared over 150 in either.
    const jaccard = table.kind === 'table' ? table.rows[0]['value'] : null
    expect(jaccard).toBeCloseTo(50 / 150, 10)
  })

  it('still says so when a box really is empty', async () => {
    const { context, notes } = job({ a: 'ann7' }, { features: { a: features([[0, 100]]) } })
    const out = await runOverlap(context)
    expect(out).toEqual([])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/has not been chosen/)
  })

  /**
   * Chosen and gone is a different sentence, and the distinction is the reason
   * the bug was so hard to see from the outside: "nothing was chosen" was being
   * said about both, so the one message covered a form the reader had filled in
   * correctly *and* a form they had not.
   */
  it('tells a set nobody picked from one that was dropped after picking', async () => {
    const { context, notes } = job({ a: 'ann7', b: 'ann9' }, { features: { a: features([[0, 1]]) } })
    expect(await runOverlap(context)).toEqual([])
    expect(notes[0]).toMatch(/no longer loaded/)
  })
})

describe('chosenInput', () => {
  it('takes the key and ignores the id stored under it', () => {
    const set = features([[0, 10]])
    const found = chosenInput({ features: set }, { features: 'ann7' }, 'features')
    expect(found.value).toBe(set)
    expect(found.chosen).toBe(true)
  })

  it('reports a choice whose set is absent as chosen, not as empty', () => {
    const found = chosenInput<FeatureSet>({}, { features: 'ann7' }, 'features')
    expect(found.value).toBeUndefined()
    expect(found.chosen).toBe(true)
  })

  it('reports an untouched control as unchosen', () => {
    const found = chosenInput<FeatureSet>({}, {}, 'features')
    expect(found.chosen).toBe(false)
  })
})

describe('missingInput', () => {
  const words = { unchosen: 'pick one', gone: 'it went away' }

  it('is silent when the input is there', () => {
    expect(missingInput({ value: 1, chosen: true }, words)).toBeNull()
  })

  it('asks for a choice, or explains the one that was made', () => {
    expect(missingInput({ value: undefined, chosen: false }, words)).toBe('pick one')
    expect(missingInput({ value: undefined, chosen: true }, words)).toBe('it went away')
  })
})
