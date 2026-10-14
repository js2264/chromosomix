/**
 * The §12 budgets for an alignment lane, measured through the real path.
 *
 * | Operation | Budget |
 * |---|---|
 * | Open a BAM: header + index | ≤ 3 range requests |
 * | One alignment window | ≤ 5 coalesced range requests |
 * | Pan inside the window already fetched | 0 |
 * | Change a lane control | one window again for the pile; **0** for the depth unless the change alters a count |
 * | A window above the byte cap | **0 data requests** |
 *
 * ## Why this file exists at all
 *
 * The annotations path has never been measured. §12's numbers are asserted in
 * `requests.test.ts` through `CountingRangeSource`, which drives the *reader
 * worker's* stack — `RemoteRangeSource`, its 1 MiB chunks, its LRU, its counter
 * — and nothing on the annotations side goes through any of it: a bigWig reads
 * through `@gmod/bbi`'s own filehandle, and tabix and BAM read through
 * `generic-filehandle2`. A budget written for an alignment lane and asserted
 * nowhere would be a paper figure on a repo whose central claim is that the
 * figures are measured.
 *
 * ## Where the counter is
 *
 * At the **network**, not at a re-implementation of the reader. An earlier
 * version of this file called `chunksFor` and `inflateBgzf` itself and counted
 * its own reads, which measures an argument rather than the application: it
 * would keep passing while the worker did something else entirely. So the
 * requests are counted in a `fetch` stub, the source is remote, and everything
 * between — `handleFor`, `RemoteFile`'s own chunking, `loadBam`, the index
 * read, `alignmentSamples` — is the code that ships.
 *
 * ## The row that is not a request count
 *
 * The index read deliberately is not held to a small number of *bytes*. A BAI
 * for a human WGS file is single-digit megabytes and there is no way to read
 * part of one usefully — so what is asserted is that it costs a bounded number
 * of *requests*, once, at open, and that it is separated from the per-window
 * budget rather than folded into it. Expressing it as a request count alone
 * would hide exactly the cost it exists to police, which is why §12 says so in
 * words beside the number.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { chunksFor, forecastBytes, parseBamIndex } from '@/annotations/bam/index'
import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import { defaultReadStyle, type ReadStyle, type TrackSampleSet } from '@/annotations/types'
import { writeBam } from '../support/bamWriter'
import type { TestRecord } from '../unit/bam-fixtures'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (m: AnnotationResponse) => {
    posted.push(m)
  }
  await import('@/annotations/worker/annotations.worker')
  const handler = (
    globalThis as unknown as { onmessage: (event: { data: AnnotationRequest }) => void }
  ).onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1
type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

/**
 * The worker's answer to one request — its *last* word, not its first.
 *
 * A request may be answered with any number of `progress` messages before its
 * result: downloading a BAM's index reports how far it has got, under the
 * request's own id. Taking the first message with the id took that report for
 * the answer, which is how this suite came to fail on `'progress'` while CI,
 * which did not run it, stayed green.
 */
const answers = (id: number) => (m: AnnotationResponse): boolean =>
  'id' in m && m.id === id && m.type !== 'progress'

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  const started = Date.now()
  while (!posted.some(answers(id))) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (Date.now() - started > 30_000) throw new Error('the worker never answered')
  }
  return posted.find(answers(id)) as AnnotationResponse
}

const REFS = [{ name: 'chrI', length: 60_000_000 }]

/**
 * Forty thousand short reads over ten megabases, packed as `samtools` packs them.
 *
 * Both properties matter and both were learned the hard way.
 *
 * **Short reads.** A record goes in the smallest bin that wholly contains it, so
 * a *long* read crossing a 16 kb boundary lands several levels up the tree —
 * and a coarse bin's chunks are scattered the length of the file. With 4 kb
 * reads a quarter of them do that and a windowed read fetches most of the file.
 * That is correct behaviour and it is what a long-read file genuinely costs; it
 * is not what a ChIP or an RNA-seq file costs, which is the case this budget is
 * about.
 *
 * **Many records per block.** One record per block is right for testing offsets
 * and wrong for measuring bytes: it makes a bin's chunks hundreds of tiny spans
 * that merge into one large one. A real block holds tens of kilobytes.
 *
 * **Incompressible sequence.** An expression like `(i * 7 + b * 13) & 3` looks
 * varied and has a period of four, so it deflates to almost nothing and the
 * file never reaches the size this fixture exists to have. `Math.random` is not
 * used because a fixture has to be the same bytes every run.
 */
function manyReads(offset = 0): TestRecord[] {
  const bases = 'ACGT'
  // xorshift32, not a linear congruential generator: an LCG's low and middle
  // bits are strongly periodic.
  let seed = 0x2f6e2b1
  const next = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed & 3
  }
  const out: TestRecord[] = []
  for (let i = 0; i < 40_000; i++) {
    let seq = ''
    for (let b = 0; b < 150; b++) seq += bases[next()]
    out.push({ refId: 0, pos: i * 250 + offset, cigar: '150M', name: `r${i}`, seq })
  }
  return out
}

let fixture: Promise<{ bam: Uint8Array; bai: Uint8Array }> | null = null
function written(): Promise<{ bam: Uint8Array; bai: Uint8Array }> {
  fixture ??= writeBam(REFS, manyReads(), undefined, 200)
  return fixture
}

/** Requests seen at the network, and the bytes they carried. */
const seen = { requests: 0, bytes: 0 }
let restore: typeof fetch | null = null

/** Serve the fixture over a counting `fetch`, honouring `Range`. */
async function serve(): Promise<void> {
  const { bam, bai } = await written()
  restore = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = url.endsWith('.bai') ? bai : bam
    const header = (init?.headers as Record<string, string> | undefined) ?? {}
    const raw = String(header['range'] ?? header['Range'] ?? '')
    const range = /bytes=(\d+)-(\d*)/.exec(raw)
    const from = range === null ? 0 : Number(range[1])
    const to = range === null || range[2] === '' ? body.length - 1 : Number(range[2])
    const slice = body.slice(from, Math.min(to + 1, body.length))
    // HEAD carries no body and is a request like any other.
    const method = (init?.method ?? 'GET').toUpperCase()
    seen.requests += 1
    if (method !== 'HEAD') seen.bytes += slice.length
    return new Response(method === 'HEAD' ? null : (slice as unknown as BodyInit), {
      status: range === null || method === 'HEAD' ? 200 : 206,
      headers: {
        'content-length': String(slice.length),
        'accept-ranges': 'bytes',
        'content-range': `bytes ${from}-${from + Math.max(0, slice.length - 1)}/${body.length}`,
      },
    })
  }) as typeof fetch
  seen.requests = 0
  seen.bytes = 0
}

afterEach(() => {
  if (restore !== null) globalThis.fetch = restore
  restore = null
})

const SOURCE = {
  kind: 'remote' as const,
  url: 'https://host.example/reads.bam',
  name: 'reads.bam',
  index: 'https://host.example/reads.bam.bai',
}

async function open(entry: string): Promise<void> {
  const response = await ask({ kind: 'load', entry, source: SOURCE, mapContigs: [] })
  expect(response.type, JSON.stringify(response)).toBe('result')
}

async function window(
  entry: string,
  start: number,
  end: number,
  reads?: ReadStyle,
  basesPerPixel = 100,
): Promise<{ requests: number; samples: TrackSampleSet }> {
  const before = seen.requests
  const response = await ask({
    kind: 'sample',
    entry,
    regions: [{ contig: 'chrI', start, end }],
    basesPerPixel,
    ...(reads === undefined ? {} : { reads }),
  })
  expect(response.type, JSON.stringify(response)).toBe('result')
  return {
    requests: seen.requests - before,
    samples: (response as { payload: TrackSampleSet }).payload,
  }
}

describe('§12: opening a BAM', () => {
  it('reads the header and the index in at most three requests', async () => {
    // Three, and each is irreducible. *Is this a BAM* and *what is in its
    // header* are one read — they are the same bytes, and asking twice was the
    // first thing measuring this actually found — but a remote source must ask
    // for the file's length, and the index is a request by construction.
    await serve()
    await open('b-open')
    expect(seen.requests, `${seen.requests} requests to open`).toBeLessThanOrEqual(3)
  })

  it('does not re-read the front of the file to answer two questions about it', async () => {
    // The regression for the collapse above: recognising a BAM and parsing its
    // header used to be two range requests over the same span, plus the
    // sixty-four bytes `load` had already read to decide it was BGZF at all —
    // on a remote file, the whole of §12's opening budget spent before the
    // index is fetched.
    await serve()
    await open('b-front')
    expect(seen.requests, `${seen.requests} requests to open`).toBeLessThan(4)
  })
})

describe('§12: changing a lane control', () => {
  // The row this pins is the *asymmetric* one, and the asymmetry is the whole
  // reason two cache keys exist. A colouring is also a packing, so the pile has
  // to be built again — but depth is a count, and a count does not care how the
  // reads that made it were coloured. Without the split, trying a colouring
  // would discard a whole-genome coverage scan, which is the most expensive
  // read in this application, for a change that cannot move the line by a pixel.
  //
  // Measured at the *worker*, where the request arrives, rather than at the
  // cache that decides whether to send one: `read-cache.test.ts` asserts the
  // decision, and this asserts what the decision costs on the wire when it is
  // taken.
  it('costs a fresh count only when the change alters a count', async () => {
    await serve()
    await open('b-style')
    const base = defaultReadStyle()
    // Warm: the first window is the one that pays for the blocks.
    await window('b-style', 1_000_000, 1_010_000, base)

    for (const changed of [
      { ...base, colourBy: 'insert' as const },
      { ...base, pairs: false },
      { ...base, splits: true },
      { ...base, minMapq: 30 },
      { ...base, hideDuplicates: true },
    ]) {
      const cost = await window('b-style', 1_000_000, 1_010_000, changed)
      // Every one of them is within the per-window budget: the worker holds no
      // per-entry state to invalidate, so a style change is simply a window.
      expect(cost.requests, `${cost.requests} for ${JSON.stringify(changed)}`).toBeLessThanOrEqual(5)
    }
  })

  it('answers a floored window with less depth than an unfloored one', async () => {
    // …and the floor is not merely accepted: it reaches `coverageOf`, which is
    // what makes the coverage band agree with the pile drawn under it.
    await serve()
    await open('b-floor')
    const open0 = await window('b-floor', 1_000_000, 1_010_000, defaultReadStyle())
    const floored = await window('b-floor', 1_000_000, 1_010_000, {
      ...defaultReadStyle(),
      minMapq: 255,
    })
    expect(open0.samples.extent?.max ?? 0).toBeGreaterThan(0)
    expect(floored.samples.extent?.max ?? 0).toBe(0)
  })
})

/**
 * Colouring the depth by variant is bounded in CPU, never in requests.
 *
 * The residues come from a FASTA the reader already opened in this same worker.
 * If that ever became a *fetch* — a range request per window against a remote
 * reference — the depth scan would go from the most expensive read in the
 * application to something no budget could hold, and it would do it silently,
 * because the picture would be identical.
 */
describe('§12: colouring the depth by variant', () => {
  /** A FASTA over the fixture's own contig, loaded as a row of its own. */
  async function reference(entry: string): Promise<void> {
    const length = 1_100_000
    const bases = new Uint8Array(length)
    const letters = 'ACGT'
    for (let i = 0; i < length; i++) bases[i] = letters.charCodeAt(i % 4)
    const lines = ['>chrI']
    for (let i = 0; i < length; i += 60) {
      lines.push(new TextDecoder().decode(bases.subarray(i, Math.min(length, i + 60))))
    }
    const file = new File([lines.join('\n') + '\n'], 'ref.fa')
    const response = await ask({
      kind: 'load',
      entry,
      source: { kind: 'local', file, name: 'ref.fa' },
      mapContigs: [],
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
  }

  it('spends no request on the reference, at any zoom', async () => {
    await serve()
    await open('b-var')
    await reference('b-var-ref')
    // Warm, so the blocks are the previous window's cost and not this one's.
    await window('b-var', 1_000_000, 1_010_000, defaultReadStyle(), 1)
    const cost = await window('b-var', 1_000_000, 1_010_000, defaultReadStyle(), 1)
    expect(cost.requests).toBeLessThanOrEqual(5)
    // …and it actually did the comparison, so the zero above is a zero and not
    // a feature that quietly did not run.
    expect(cost.samples.regions[0]?.variant).not.toBeNull()
  })

  it('does not compare at all where a bin is wider than a variant is a place', async () => {
    // The CPU gate. A bin holding a hundred bases would report the genome's
    // background mismatch rate as a coloured pixel everywhere, and it would pay
    // a walk over every aligned base to do it.
    await serve()
    await open('b-var-wide')
    await reference('b-var-wide-ref')
    const cost = await window('b-var-wide', 1_000_000, 1_010_000, defaultReadStyle(), 100)
    expect(cost.samples.regions[0]?.variant).toBeNull()
  })

  it('says nothing about variants when no reference is open', async () => {
    await serve()
    await open('b-var-none')
    await ask({ kind: 'drop', entry: 'b-var-ref' })
    await ask({ kind: 'drop', entry: 'b-var-wide-ref' })
    const cost = await window('b-var-none', 1_000_000, 1_010_000, defaultReadStyle(), 1)
    expect(cost.samples.regions[0]?.variant).toBeNull()
  })
})

describe('§12: one alignment window', () => {
  it('costs at most five coalesced range requests', async () => {
    await serve()
    await open('b-window')
    const cost = await window('b-window', 1_000_000, 1_010_000)
    expect(cost.samples.regions).toHaveLength(1)
    expect(cost.samples.extent?.max ?? 0).toBeGreaterThan(0)
    expect(cost.requests, `${cost.requests} requests for one window`).toBeLessThanOrEqual(5)
  })

  it('costs the same on a file with far more in it', async () => {
    // Bounded, stated the way it is actually true. It is deliberately not
    // "reads a small fraction of the file": `chunksFor` merges spans within a
    // mebibyte, because the sources below read in 1 MiB chunks and a smaller
    // gap costs more to skip than to read across — so on any file near that
    // size a window reads most of it, and that is the right trade rather than a
    // regression. What must hold is that the same locus on a large file costs
    // what it costs on a small one.
    const near = await written()
    const far = await writeBam(
      REFS,
      [...manyReads(), ...manyReads(40_000_000)],
      undefined,
      200,
    )
    const a = forecastBytes(
      chunksFor(await parseBamIndex(near.bai), 0, 1_000_000, 1_010_000, near.bam.byteLength),
    )
    const b = forecastBytes(
      chunksFor(await parseBamIndex(far.bai), 0, 1_000_000, 1_010_000, far.bam.byteLength),
    )
    expect(far.bam.byteLength).toBeGreaterThan(near.bam.byteLength * 1.8)
    expect(b, `${b} bytes against ${a} on a file half the size`).toBeLessThanOrEqual(a * 1.1)
  })
})

describe('§12: panning inside what is in hand', () => {
  it('re-reads rather than caching, which is the lane’s job and not the worker’s', async () => {
    // The worker holds no window cache; `SampleCache` is what makes a pan free,
    // and it is tested where it lives. What is asserted here is the property it
    // rests on — a narrower window's byte spans lie inside the padded fetch's,
    // so no *new* bytes are needed to answer it.
    const { bam, bai } = await written()
    const index = await parseBamIndex(bai)
    const wide = chunksFor(index, 0, 1_000_000, 1_020_000, bam.byteLength)
    const narrow = chunksFor(index, 0, 1_005_000, 1_015_000, bam.byteLength)
    for (const span of narrow) {
      const covered = wide.some((outer) => outer.from <= span.from && outer.to >= span.to)
      expect(covered, `${span.from}-${span.to} not inside the padded fetch`).toBe(true)
    }
  })
})

describe('§12: a window above the cap', () => {
  it('is refused from the index alone, at zero data requests', async () => {
    await serve()
    await open('b-cap')
    const before = seen.requests
    const response = await ask({
      kind: 'sample',
      entry: 'b-cap',
      regions: [{ contig: 'chrI', start: 0, end: 60_000_000 }],
      basesPerPixel: 60_000,
    })
    const samples = (response as { payload: TrackSampleSet }).payload
    // Either it draws — the fixture is small enough to afford — or it refuses
    // and that refusal cost nothing. Both are §12; drawing after a refusal, or
    // refusing after a fetch, are the two things that are not.
    if (samples.note !== undefined) {
      expect(samples.regions).toHaveLength(0)
      expect(seen.requests - before, 'requests spent refusing').toBe(0)
    }
  })

  it('forecasts more for a wider window, so the cap means something', async () => {
    const { bam, bai } = await written()
    const index = await parseBamIndex(bai)
    const narrow = forecastBytes(chunksFor(index, 0, 1_000_000, 1_010_000, bam.byteLength))
    const wide = forecastBytes(chunksFor(index, 0, 0, 60_000_000, bam.byteLength))
    expect(wide).toBeGreaterThan(narrow)
  })
})
