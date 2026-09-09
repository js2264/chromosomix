/**
 * The lengths a browser invents for a file that declares none.
 *
 * A GTF, a BED, a narrowPeak, a bedGraph and a bedpe carry features and nothing
 * about the sequences under them, so the only length available is "at least as
 * far as the last feature". `contigsOf` rounds that up a little, so a browser
 * opened on a peak set does not appear to end exactly on the last peak — and
 * *how much* it rounds up is the whole of what is tested here, because getting
 * it wrong is silent: every coordinate stays right, every gesture keeps working,
 * and the only symptom is a genome that is not the shape of the real one.
 *
 * It was wrong. The step was the coordinate's own order of magnitude — one
 * significant figure — so yeast VII (last feature 1,090,940) and IV (1,531,933)
 * were both handed exactly 2,000,000, the yeast genome came out 31% too long,
 * every sequence grew a blank pannable margin on its right, and the SEQUENCES
 * card, which draws each bar as `length / longest`, drew a different genome.
 * The numbers below are the real sacCer3 ones, so this is the case that shipped
 * rather than a case written to pass.
 */

// Not jsdom: importing the worker module wants `self`, and the front door it
// installs is the one the assembly question really arrives through.

import { beforeAll, describe, expect, it } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import { assemblyOf, lengthsAreExact } from '@/genome/assembly'

/** The last feature on each sequence of a real yeast annotation set. */
const ENDS: Record<string, number> = {
  I: 230_218,
  II: 813_184,
  IV: 1_531_933,
  V: 576_874,
  VII: 1_090_940,
  IX: 439_888,
  XII: 1_078_177,
  XV: 1_091_291,
}

let contigsOf: (ends: Map<string, number>) => Array<{ name: string; length: number }>
const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (m: AnnotationResponse) => {
    posted.push(m)
  }
  const worker = await import('@/annotations/worker/annotations.worker')
  contigsOf = worker.contigsOf
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
    const found = posted.find((m) => 'id' in m && m.id === id)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`no answer for request ${id}`)
}

function lengthsOf(ends: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const contig of contigsOf(new Map(Object.entries(ends)))) out[contig.name] = contig.length
  return out
}

describe('lengths inferred from features', () => {
  it('rounds up by about a thousandth, not by an order of magnitude', () => {
    // Three significant figures. The two that mattered are IV and VII: at one
    // figure they were the same number, and there is 441 kb between them.
    expect(lengthsOf(ENDS)).toEqual({
      I: 231_000,
      II: 814_000,
      IV: 1_540_000,
      V: 577_000,
      VII: 1_100_000,
      IX: 440_000,
      XII: 1_080_000,
      XV: 1_100_000,
    })
  })

  it('does not collapse two sequences onto the same length', () => {
    // The visible failure, named as its own case: IV's last feature is 40%
    // further along than VII's and the two came out identical, which is a
    // genome browser telling a reader two chromosomes are the same size.
    const lengths = lengthsOf(ENDS)
    expect(lengths.IV).not.toBe(lengths.VII)
    // The rule underneath it, over every pair: the rounding is monotone, and
    // two sequences more than one step apart cannot merge. VII and XV *may*
    // share a number — their last features are 351 bp apart — and that is the
    // rounding working rather than the bug, which is why the threshold is a
    // ratio rather than a demand that all eight differ.
    const order = Object.keys(ENDS).sort((a, b) => ENDS[a] - ENDS[b])
    for (let i = 1; i < order.length; i++) {
      const [under, over] = [order[i - 1], order[i]]
      expect(lengths[over], over).toBeGreaterThanOrEqual(lengths[under])
      if (ENDS[over] / ENDS[under] > 1.02) {
        expect(lengths[over], `${over} against ${under}`).toBeGreaterThan(lengths[under])
      }
    }
  })

  it('always ends past the last feature, and never by much', () => {
    for (const [name, end] of Object.entries(ENDS)) {
      const length = lengthsOf({ [name]: end })[name]
      // Strictly greater: the whole point of rounding at all is that the
      // sequence must not appear to stop on its last feature.
      expect(length, name).toBeGreaterThan(end)
      // …and a margin, not a second genome. One step is at most a hundredth of
      // the value, so nothing is ever inflated by more than 1%.
      expect(length / end, name).toBeLessThan(1.02)
    }
  })

  it('keeps the whole genome within a percent of what the file shows', () => {
    // The number a reader sees on the Genome card as `total`. It used to read
    // 31% high, which is a yeast genome with four extra chromosomes in it.
    const lengths = lengthsOf(ENDS)
    const seen = Object.values(ENDS).reduce((sum, end) => sum + end, 0)
    const inferred = Object.values(lengths).reduce((sum, length) => sum + length, 0)
    expect(inferred).toBeGreaterThan(seen)
    expect(inferred / seen).toBeLessThan(1.01)
  })

  it('is strictly greater even where the last feature is already round', () => {
    // `floor + 1` rather than `ceil`, and this is the case that tells them
    // apart. A peak set whose last peak ends at exactly 1,200,000 is not rare —
    // round numbers are what a binned or windowed file ends on — and under
    // `ceil` it would be handed 1,200,000 and end on its own last feature.
    expect(lengthsOf({ round: 1_200_000 }).round).toBe(1_210_000)
    expect(lengthsOf({ mega: 1_000_000 }).mega).toBe(1_010_000)
  })

  it('gives a positive length to a sequence with almost nothing on it', () => {
    // `assemblyOf` drops a contig of length 0, so a sequence whose only feature
    // ends at 0 would vanish from the axis entirely rather than be short.
    expect(lengthsOf({ tiny: 0 }).tiny).toBe(1)
    expect(lengthsOf({ one: 1 }).one).toBe(2)
    expect(lengthsOf({ short: 999 }).short).toBe(1000)
    expect(assemblyOf({
      uri: 'x',
      name: 'x',
      origin: 'features',
      contigs: contigsOf(new Map([['tiny', 0]])),
    }).contigs).toHaveLength(1)
  })
})

describe('a BED through the worker', () => {
  it('reports each sequence just past its last feature', async () => {
    // End to end through `self.onmessage`, the door a drop actually arrives at,
    // so the sniffing, the routing and the rounding are all in the path — the
    // same reason `vcf-lane.test.ts` drives the worker rather than the parser.
    const bed = Object.entries(ENDS)
      .map(([name, end]) => `${name}\t${end - 100}\t${end}\tfeature_${name}\t100\t+`)
      .join('\n')
    const response = await ask({
      kind: 'assembly',
      source: { kind: 'local', file: new File([bed + '\n'], 'peaks.bed'), name: 'peaks.bed' },
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const held = (response as {
      payload: { format: string; contigs: Array<{ name: string; length: number }>; origin: string }
    }).payload
    expect(held.format).toBe('bed')
    // Still a lower bound, and still said to be one: rounding up is a margin on
    // a guess, not a claim to know where the chromosome ends.
    expect(held.origin).toBe('features')
    expect(lengthsAreExact({ origin: 'features' })).toBe(false)
    expect(Object.fromEntries(held.contigs.map((c) => [c.name, c.length]))).toEqual({
      I: 231_000,
      II: 814_000,
      IV: 1_540_000,
      V: 577_000,
      VII: 1_100_000,
      IX: 440_000,
      XII: 1_080_000,
      XV: 1_100_000,
    })
  })
})
