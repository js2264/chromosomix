/**
 * A BAM through the annotations worker: what opens, what is refused, what draws.
 *
 * The unit tests prove the decoders read bytes correctly and the oracle proves
 * they read them the way everybody else does. Neither says anything about the
 * thing a reader actually meets — a file handed to the worker, and a lane's
 * worth of depth coming back — and the pieces in between are where the two
 * refusals live, which are the price of §8.13's carve-out from §13 and are the
 * most likely thing to be quietly wrong.
 *
 * Driven through `self.onmessage`, which is the worker's real front door, so
 * the dispatch, the store and the transfer list are all in the path.
 */

// Deliberately **not** jsdom. The worker touches no DOM — it wants `self`,
// `File`, `Blob` and the compression streams, and Node has all of them while
// jsdom's `Blob` has no `.stream()`, so the fixtures cannot even be built
// there. `self` is the one global Node lacks, and it is what the module wires
// its front door onto.

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { TrackSampleSet } from '@/annotations/types'
import { writeBam } from '../support/bamWriter'
import type { TestRecord } from './bam-fixtures'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  // Both before the import, because the module wires `self.onmessage` and
  // starts a busy probe the moment it is evaluated.
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (
    message: AnnotationResponse,
  ) => {
    posted.push(message)
  }
  await import('@/annotations/worker/annotations.worker')
  const handler = (globalThis as unknown as { onmessage: (event: { data: AnnotationRequest }) => void })
    .onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1

/**
 * A request with its id left off.
 *
 * Distributive on purpose. A plain `Omit<AnnotationRequest, 'id'>` collapses the
 * union to the fields every member shares — which is `kind` alone — so `entry`
 * stops existing and the calls below fail to compile while running perfectly.
 */
type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

/** Send one request and wait for the response that answers it. */
async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  await vi.waitFor(() => {
    expect(posted.some((message) => 'id' in message && message.id === id)).toBe(true)
  })
  return posted.find((message) => 'id' in message && message.id === id) as AnnotationResponse
}

const REFS = [
  { name: 'chrI', length: 230_218 },
  { name: 'chrII', length: 813_184 },
]

function reads(): TestRecord[] {
  const out: TestRecord[] = []
  // Twenty reads of 100 bp stacked over 1000–1100, then a sparser run after it,
  // so depth is a number this test can state rather than merely compare.
  for (let i = 0; i < 20; i++) {
    out.push({ refId: 0, pos: 1000, cigar: '100M', name: `deep${i}`, seq: 'A'.repeat(100) })
  }
  for (let i = 0; i < 5; i++) {
    out.push({ refId: 0, pos: 2000 + i * 100, cigar: '100M', name: `flat${i}`, seq: 'C'.repeat(100) })
  }
  return out
}

/**
 * Enough incompressible sequence that a whole-chromosome window is over the cap.
 *
 * Long reads with random bases, packed a hundred to a block: the packed
 * sequence is four bits a base and does not deflate, which is what makes the
 * file large, and few large blocks rather than many small ones is what keeps
 * building it to a couple of seconds.
 */
function deepReads(): TestRecord[] {
  const bases = 'ACGT'
  // xorshift32, not a linear congruential generator: an LCG's low and middle
  // bits are strongly periodic, so `(seed >>> 16) & 3` produces a sequence that
  // deflates to a fraction of its size — which is the opposite of what a
  // fixture sized in megabytes needs.
  let seed = 0x51f3a7
  const next = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed & 3
  }
  const out: TestRecord[] = []
  // Eight thousand, not four. A base packs into four bits but only four of the
  // sixteen codes are ACGT, so the packed sequence still carries two bits of
  // entropy per nibble and deflate halves it — a file sized from the raw base
  // count comes out at half what was intended.
  for (let i = 0; i < 8000; i++) {
    const seq = new Array<string>(4000)
    for (let b = 0; b < 4000; b++) seq[b] = bases[next()]
    out.push({ refId: 0, pos: i * 4000, cigar: '4000M', name: `d${i}`, seq: seq.join('') })
  }
  return out
}

async function bamFile(
  options: { sort?: string; records?: TestRecord[] } = {},
): Promise<{ bam: File; bai: File }> {
  const written = await writeBam(
    REFS,
    options.records ?? reads(),
    `@HD\tVN:1.6\tSO:${options.sort ?? 'coordinate'}\n`,
  )
  return {
    bam: new File([written.bam as BlobPart], 'reads.bam'),
    bai: new File([written.bai as BlobPart], 'reads.bam.bai'),
  }
}

describe('opening a BAM', () => {
  it('reads its reference table and says which index it found', async () => {
    const { bam, bai } = await bamFile()
    const response = await ask({
      kind: 'load',
      entry: 'e-open',
      source: { kind: 'local', file: bam, name: 'reads.bam', index: bai },
      mapContigs: REFS.map((ref) => ({ name: ref.name, length: ref.length })),
    })

    expect(response.type, JSON.stringify(response)).toBe('result')
    const payload = (response as { payload: { format: string; contigs: string[]; summary: string } })
      .payload
    expect(payload.format).toBe('bam')
    expect(payload.contigs).toEqual(['chrI', 'chrII'])
    expect(payload.summary).toContain('BAI')
    expect(payload.summary).toContain('2 references')
  })

  it('answers what genome it is on, without needing an index at all', async () => {
    // A header needs no index to read, so a dropped `.bam` can start a browser
    // session even where `load` would go on to refuse it.
    const { bam } = await bamFile()
    const response = await ask({
      kind: 'assembly',
      source: { kind: 'local', file: bam, name: 'reads.bam' },
    })
    expect(response.type).toBe('result')
    const payload = (response as { payload: { format: string; contigs: unknown[]; exact: boolean } })
      .payload
    expect(payload.format).toBe('bam')
    expect(payload.exact).toBe(true)
    expect(payload.contigs).toEqual([
      { name: 'chrI', length: 230_218 },
      { name: 'chrII', length: 813_184 },
    ])
  })
})

describe('the two refusals', () => {
  it('refuses a BAM with no index, and names the command', async () => {
    const { bam } = await bamFile()
    const response = await ask({
      kind: 'load',
      entry: 'e-noindex',
      source: { kind: 'local', file: bam, name: 'reads.bam' },
      mapContigs: [],
    })
    expect(response.type).toBe('error')
    const message = (response as { message: string }).message
    expect(message).toContain('samtools index reads.bam')
    // And says *why* there is no fallback, since every other format here has one.
    expect(message).toContain('no whole-file fallback')
  })

  it('refuses a name-sorted BAM, and names a different command', async () => {
    // Not a technicality: the index describes a coordinate-sorted file, so a
    // region query on this one answers with whatever was in those blocks.
    const { bam, bai } = await bamFile({ sort: 'queryname' })
    const response = await ask({
      kind: 'load',
      entry: 'e-qname',
      source: { kind: 'local', file: bam, name: 'reads.bam', index: bai },
      mapContigs: [],
    })
    expect(response.type).toBe('error')
    const message = (response as { message: string }).message
    expect(message).toContain('read name')
    expect(message).toContain('samtools sort')
  })

  it('tells a remote miss apart from a broken local index', async () => {
    // A remote sidecar URL is *guessed* — `<url>.bai`, never probed — so the
    // commonest remote failure is no index at that address rather than a
    // corrupt one. Saying "could not be read" would send a reader looking for
    // a broken file that does not exist.
    //
    // Served here rather than pointed at a dead host, because a host that does
    // not resolve fails at the *file* read and never reaches the branch this
    // test is named after.
    const { bam } = await bamFile()
    const bytes = new Uint8Array(await bam.arrayBuffer())
    const previous = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('.bai') || url.endsWith('.csi')) {
        return new Response(null, { status: 404, statusText: 'Not Found' })
      }
      const range = /bytes=(\d+)-(\d*)/.exec(
        String((init?.headers as Record<string, string> | undefined)?.['range'] ?? ''),
      )
      const from = range === null ? 0 : Number(range[1])
      const to = range === null || range[2] === '' ? bytes.length - 1 : Number(range[2])
      const slice = bytes.slice(from, Math.min(to + 1, bytes.length))
      return new Response(slice as unknown as BodyInit, {
        status: range === null ? 200 : 206,
        headers: {
          'content-length': String(slice.length),
          'content-range': `bytes ${from}-${from + slice.length - 1}/${bytes.length}`,
        },
      })
    }) as typeof fetch

    try {
      const response = await ask({
        kind: 'load',
        entry: 'e-remote',
        source: {
          kind: 'remote',
          url: 'https://host.example/reads.bam',
          name: 'reads.bam',
          index: 'https://host.example/reads.bam.bai',
        },
        mapContigs: [],
      })
      expect(response.type).toBe('error')
      const message = (response as { message: string }).message
      // The branch the test is named after: the file read fine, the index did
      // not exist at the guessed address, and the way out is the one convention
      // there is for saying where it really is.
      expect(message).toContain('No index could be read')
      expect(message).toContain('#index=')
      expect(message).not.toContain('samtools index')
    } finally {
      globalThis.fetch = previous
    }
  })

  it('tells a broken index apart from an absent one', async () => {
    // Different fixes, so they must not share a message.
    const { bam } = await bamFile()
    const response = await ask({
      kind: 'load',
      entry: 'e-badindex',
      source: {
        kind: 'local',
        file: bam,
        name: 'reads.bam',
        index: new File(['not an index'], 'reads.bam.bai'),
      },
      mapContigs: [],
    })
    expect(response.type).toBe('error')
    const message = (response as { message: string }).message
    expect(message).toContain('could not be read')
    expect(message).not.toContain('no whole-file fallback')
  })
})

describe('the coverage lane', () => {
  async function opened(entry: string): Promise<void> {
    const { bam, bai } = await bamFile()
    const response = await ask({
      kind: 'load',
      entry,
      source: { kind: 'local', file: bam, name: 'reads.bam', index: bai },
      mapContigs: REFS.map((ref) => ({ name: ref.name, length: ref.length })),
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
  }

  it('answers a window with depth', async () => {
    await opened('e-cov')
    const response = await ask({
      kind: 'sample',
      entry: 'e-cov',
      regions: [{ contig: 'chrI', start: 1000, end: 1100 }],
      basesPerPixel: 100,
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const samples = (response as { payload: TrackSampleSet }).payload
    expect(samples.regions).toHaveLength(1)
    // Twenty reads stacked over exactly this window.
    expect(samples.regions[0].values[0]).toBeCloseTo(20, 4)
  })

  it('floors its extent at zero, so uncovered ground reads as uncovered', async () => {
    // Autoscaling a depth lane from its own minimum would make a region with
    // three reads on it look as covered as one with forty.
    await opened('e-extent')
    const response = await ask({
      kind: 'sample',
      entry: 'e-extent',
      regions: [{ contig: 'chrI', start: 0, end: 3000 }],
      basesPerPixel: 100,
    })
    const samples = (response as { payload: TrackSampleSet }).payload
    expect(samples.extent?.min).toBe(0)
    expect(samples.extent?.max).toBeGreaterThan(0)
  })

  it('draws a contig with no reads on it as empty, rather than not at all', async () => {
    // The region is answered with zeros rather than omitted, because a flat
    // line on the baseline says "we looked and there is nothing here" and an
    // absent lane says nothing at all. But its extent is null, not `{0, 0}`:
    // a zero-height axis is not a range, and handing one to `resolveLimits` is
    // how a lane gets rescaled to nothing the moment a reader pans across an
    // empty contig.
    await opened('e-empty')
    const response = await ask({
      kind: 'sample',
      entry: 'e-empty',
      regions: [{ contig: 'chrII', start: 0, end: 1000 }],
      basesPerPixel: 100,
    })
    expect(response.type).toBe('result')
    const samples = (response as { payload: TrackSampleSet }).payload
    expect(samples.regions).toHaveLength(1)
    expect([...samples.regions[0].values].every((value) => value === 0)).toBe(true)
    expect(samples.extent).toBeNull()
    // And no note: nothing was refused, the answer is simply the answer.
    expect(samples.note).toBeUndefined()
  })

  it('draws nothing above what it can afford, and says why', async () => {
    // Decision 4 of §8.13, and the whole of what makes an alignment lane
    // bounded. The refusal is made from the *forecast* — the byte spans the
    // index resolves the window to — so it costs no data requests, and what the
    // reader gets is a lane that names the number rather than one that is
    // mysteriously blank.
    const big = await writeBam(
      [{ name: 'chrI', length: 40_000_000 }],
      deepReads(),
      undefined,
      100,
    )
    expect(big.bam.byteLength).toBeGreaterThan(8 << 20)

    const response = await ask({
      kind: 'load',
      entry: 'e-cap',
      source: {
        kind: 'local',
        file: new File([big.bam as BlobPart], 'deep.bam'),
        name: 'deep.bam',
        index: new File([big.bai as BlobPart], 'deep.bam.bai'),
      },
      mapContigs: [{ name: 'chrI', length: 40_000_000 }],
    })
    expect(response.type, JSON.stringify(response)).toBe('result')

    const wide = await ask({
      kind: 'sample',
      entry: 'e-cap',
      regions: [{ contig: 'chrI', start: 0, end: 40_000_000 }],
      basesPerPixel: 40_000,
    })
    const refused = (wide as { payload: TrackSampleSet }).payload
    expect(refused.regions).toHaveLength(0)
    // Short on purpose: it is drawn where the value range goes, in the name
    // column's gutter, so a sentence of advice there widens that column for
    // every lane in the stack.
    expect(refused.note).toContain('MB of reads')
    expect(refused.note).toContain('zoom in')
    expect(refused.note?.length ?? 0).toBeLessThan(40)

    // And the same file at a width it *can* afford still draws, so the cap is a
    // ceiling rather than a lane that never works.
    const narrow = await ask({
      kind: 'sample',
      entry: 'e-cap',
      regions: [{ contig: 'chrI', start: 100_000, end: 110_000 }],
      basesPerPixel: 100,
    })
    const drawn = (narrow as { payload: TrackSampleSet }).payload
    expect(drawn.note).toBeUndefined()
    expect(drawn.regions).toHaveLength(1)
    expect(drawn.extent?.max).toBeGreaterThan(0)
  })

  it('reads a file whose records straddle blocks, part-way through it', async () => {
    // The layout `bgzf_write` actually produces: blocks are cut when the buffer
    // fills, with no idea that records exist, so a record beginning near the
    // end of a block continues into the next one. A window whose byte span
    // starts at a later block therefore starts at the *tail* of a record, and
    // a walk beginning at the block boundary reads those bytes as a record
    // length — yielding nothing, silently.
    const many: TestRecord[] = []
    for (let i = 0; i < 900; i++) {
      many.push({
        refId: 0,
        pos: 1000 + i * 137,
        cigar: '100M',
        name: `s${i}`,
        seq: 'ACGT'.repeat(20 + (i % 17)),
      })
    }
    const written = await writeBam(REFS, many, undefined, 1, true)
    const response = await ask({
      kind: 'load',
      entry: 'e-straddle',
      source: {
        kind: 'local',
        file: new File([written.bam as BlobPart], 'straddle.bam'),
        name: 'straddle.bam',
        index: new File([written.bai as BlobPart], 'straddle.bam.bai'),
      },
      mapContigs: REFS.map((ref) => ({ name: ref.name, length: ref.length })),
    })
    expect(response.type, JSON.stringify(response)).toBe('result')

    const samples = await ask({
      kind: 'sample',
      entry: 'e-straddle',
      regions: [{ contig: 'chrI', start: 100_000, end: 120_000 }],
      basesPerPixel: 200,
    })
    const drawn = (samples as { payload: TrackSampleSet }).payload
    expect(drawn.regions).toHaveLength(1)
    // Reads every 137 bp of 100 bp each is depth well under one on average, but
    // firmly above nothing — which is what the bug produces.
    expect(drawn.extent?.max ?? 0).toBeGreaterThan(0.5)
  })

  it('forgets the file when the row is dropped', async () => {
    // A BAI is megabytes and the handle behind it is live; neither should
    // outlive the row that owns it.
    await opened('e-drop')
    await ask({ kind: 'drop', entry: 'e-drop' })
    const response = await ask({
      kind: 'sample',
      entry: 'e-drop',
      regions: [{ contig: 'chrI', start: 1000, end: 1100 }],
      basesPerPixel: 100,
    })
    expect(response.type).toBe('error')
    expect((response as { message: string }).message).toContain('no longer open')
  })
})
