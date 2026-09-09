/**
 * The motif search, through the door it actually arrives at.
 *
 * `motif.test.ts` covers the matcher, which is arithmetic over one array and can
 * be checked on its own. What it cannot check is everything between a reader's
 * pattern and a list of coordinates: that the FASTA is loaded under the entry id
 * the request names, that the scan walks the reference's own sequences in the
 * reference's own order, that a contig with no hit does not become three empty
 * arrays on the wire, and that a pattern nobody could compile comes back as a
 * *sentence* rather than as a failed request.
 *
 * That last one is the reason this file exists rather than a couple of extra
 * cases beside the matcher. "`X` is not a IUPAC base" is a fact about what the
 * reader typed and belongs under the box they typed it into; an exception would
 * reach the main thread as the shape reserved for something having gone wrong,
 * and the difference is invisible from inside the worker.
 */

// Not jsdom: importing the worker module wants `self`, and the front door it
// installs is the one a search really arrives through.

import { beforeAll, describe, expect, it } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { MotifScanResult } from '@/annotations/worker/protocol'

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
    const found = posted.find((m) => 'id' in m && m.id === id)
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

async function search(
  pattern: string,
  options: { bothStrands?: boolean; limit?: number } = {},
): Promise<MotifScanResult> {
  const response = await ask({
    kind: 'motif',
    entry: ENTRY,
    pattern,
    bothStrands: options.bothStrands ?? false,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })
  expect(response.type, JSON.stringify(response)).toBe('result')
  return (response as { payload: MotifScanResult }).payload
}

/** `{contig: [[start, end, strand], …]}`, which is what the assertions are about. */
function sites(result: MotifScanResult): Record<string, Array<[number, number, number]>> {
  const out: Record<string, Array<[number, number, number]>> = {}
  for (const hit of result.hits) {
    out[hit.contig] = Array.from(hit.starts, (start, at) => [
      start,
      hit.ends[at],
      hit.strands[at],
    ])
  }
  return out
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
    const found = await search('GATC')
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
    expect(found.total).toBe(4)
    expect(found.truncated).toBe(false)
    expect(found.refusal).toBeNull()
  })

  it('omits a sequence with no site rather than carrying empty arrays', async () => {
    const found = await search('GATC')
    expect(found.hits.map((hit) => hit.contig)).toEqual(['chrI', 'chrIII', 'chrIV'])
  })

  it('marks a palindrome as both strands when both were asked for', async () => {
    const found = await search('GATC', { bothStrands: true })
    // Still four sites, not eight: the reverse search would land on exactly the
    // same coordinates, and a reader counting a lane would get twice the answer.
    expect(found.total).toBe(4)
    expect(sites(found).chrI).toEqual([
      [2, 6, 0],
      [10, 14, 0],
    ])
  })

  it('finds the reverse strand of a motif that has one', async () => {
    // GGATC reverse-complements to GATCC, which chrIV carries at 2.
    const found = await search('GGATC', { bothStrands: true })
    expect(sites(found)).toEqual({
      chrIII: [[2, 7, 1]],
      chrIV: [[2, 7, -1]],
    })
  })

  it('answers a degenerate pattern', async () => {
    // GRTC is GATC or GGTC; only GATC is here.
    expect((await search('GRTC')).total).toBe(4)
    expect((await search('GYTC')).total).toBe(0)
  })

  it('comes back with no sites rather than an error when there are none', async () => {
    const found = await search('CCCCCCCC')
    expect(found).toEqual({ hits: [], total: 0, truncated: false, refusal: null })
  })
})

describe('what it refuses and what it caps', () => {
  it('returns the refusal as a sentence, not as a failed request', async () => {
    const found = await search('ACGX')
    expect(found.refusal).toContain('X')
    expect(found.hits).toEqual([])
    expect(found.total).toBe(0)
  })

  it('stops at the limit and says that it did', async () => {
    const found = await search('A', { limit: 2 })
    expect(found.total).toBe(2)
    expect(found.truncated).toBe(true)
  })

  it('does not claim truncation when the limit was merely reached exactly', async () => {
    const all = await search('GATC')
    const exact = await search('GATC', { limit: all.total })
    expect(exact.total).toBe(all.total)
    expect(exact.truncated).toBe(false)
  })
})

describe('an entry that is not a loaded sequence', () => {
  it('fails the request, because that is a bug rather than a reader’s typo', async () => {
    const response = await ask({
      kind: 'motif',
      entry: 'no-such-entry',
      pattern: 'ACGT',
      bothStrands: false,
    })
    expect(response.type).toBe('error')
  })
})
