/**
 * A FASTA opened by its index (§8.8).
 *
 * Driven through the worker's front door, like `bam-lane.test.ts`, with a
 * `fetch` that serves a small FASTA and its `.fai` and *lies about the size*:
 * the whole-or-by-range decision is made on the size the server reports, so a
 * few hundred bytes can stand in for a genome. What is pinned is the promise
 * the index makes — the assembly is answered without reading a residue, every
 * window read by range equals the file read whole, and the two roads that
 * need the whole sequence decline in words — and the fallbacks around it: a
 * small file is held whole with or without an index, an index that is not
 * there is not an error, and a large file with none is refused by name.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { TrackSampleSet } from '@/annotations/types'
import type { BaseResult } from '@/annotations/worker/protocol'
import { parseFasta } from '@/annotations/fasta'

const posted: AnnotationResponse[] = []
let deliver: (request: AnnotationRequest) => void

beforeAll(async () => {
  ;(globalThis as unknown as { self: unknown }).self = globalThis
  ;(globalThis as unknown as { postMessage: unknown }).postMessage = (message: AnnotationResponse) => {
    posted.push(message)
  }
  await import('@/annotations/worker/annotations.worker')
  const handler = (globalThis as unknown as { onmessage: (event: { data: AnnotationRequest }) => void })
    .onmessage
  deliver = (request) => handler({ data: request })
})

let nextId = 1
type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never

/** The answer to a request — the result or the error, never a progress report on the way. */
function settled(id: number): AnnotationResponse | undefined {
  return posted.find(
    (message) => 'id' in message && message.id === id && message.type !== 'progress',
  )
}

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  await vi.waitFor(() => {
    expect(settled(id)).toBeDefined()
  })
  return settled(id) as AnnotationResponse
}

/** A FASTA of two sequences, long enough that a window spans several lines. */
function fastaText(): string {
  const bases = 'ACGT'
  let chrI = ''
  for (let i = 0; i < 700; i++) chrI += bases[(i * 7 + (i >> 3)) % 4]
  let chrII = ''
  for (let i = 0; i < 130; i++) chrII += 'GC'[(i * 3) % 2]
  // Long enough to reach past the worker's first cached chunk (256 KiB), so a
  // window on it is a ranged read of the file rather than a cache hit: the
  // two tests below that count requests read here.
  const parts: string[] = []
  for (let i = 0; i < 900_000; i++) parts.push(bases[(i * 11 + (i >> 5)) % 4])
  const chrIII = parts.join('')
  const wrap = (seq: string, width: number): string => seq.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\n') ?? ''
  return `>chrI the first\n${wrap(chrI, 60)}\n>chrII\n${wrap(chrII, 50)}\n>chrIII\n${wrap(chrIII, 60)}\n`
}

/** `samtools faidx`, for a file whose records are wrapped uniformly. */
function faiOf(text: string): string {
  const out: string[] = []
  let at = 0
  let name = ''
  let offset = 0
  let length = 0
  let lineBases = 0
  let lineWidth = 0
  for (const line of text.split(/(?<=\n)/)) {
    if (line.startsWith('>')) {
      if (name !== '') out.push(`${name}\t${length}\t${offset}\t${lineBases}\t${lineWidth}`)
      name = line.slice(1).trim().split(/\s+/)[0]
      offset = at + line.length
      length = 0
      lineBases = 0
      lineWidth = 0
    } else if (name !== '') {
      const residues = line.replace(/\n$/, '').length
      if (lineBases === 0) {
        lineBases = residues
        lineWidth = line.length
      }
      length += residues
    }
    at += line.length
  }
  if (name !== '') out.push(`${name}\t${length}\t${offset}\t${lineBases}\t${lineWidth}`)
  return out.join('\n') + '\n'
}

const TEXT = fastaText()
const BYTES = new TextEncoder().encode(TEXT)
const WHOLE = parseFasta(BYTES)

interface Served {
  /** The size the server claims for the FASTA — the whole-or-by-range decision is made on it. */
  size: number
  /** Whether the `.fai` is there. */
  index: boolean
}

/** Every request the stub answered, as `METHOD url range`. */
let log: string[] = []

function serve(served: Served): void {
  log = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const range = /bytes=(\d+)-(\d*)/.exec(String(headers['range'] ?? headers['Range'] ?? ''))
    log.push(`${init?.method ?? 'GET'} ${url} ${range === null ? '' : range[0]}`)
    if (url.endsWith('.fai')) {
      if (!served.index) return new Response(null, { status: 404, statusText: 'Not Found' })
      const body = new TextEncoder().encode(faiOf(TEXT))
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      })
    }
    if (range === null) {
      return new Response(BYTES as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': String(BYTES.length) },
      })
    }
    const from = Number(range[1])
    const to = range[2] === '' ? BYTES.length - 1 : Math.min(Number(range[2]), BYTES.length - 1)
    const slice = BYTES.slice(from, to + 1)
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        'content-length': String(slice.length),
        'content-range': `bytes ${from}-${from + slice.length - 1}/${served.size}`,
      },
    })
  }) as typeof fetch
}

const LARGE = 500_000_000

function source(name = 'genome.fa', index?: string): { kind: 'remote'; url: string; name: string; index?: string } {
  return { kind: 'remote', url: `https://h.example/${name}`, name, ...(index === undefined ? {} : { index }) }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('a large FASTA with its index', () => {
  it('answers the assembly from the index alone, without reading a residue', async () => {
    serve({ size: LARGE, index: true })
    const response = await ask({ kind: 'assembly', source: source('big.fa') })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const payload = (response as { payload: { format: string; contigs: unknown[]; exact: boolean } }).payload
    expect(payload.format).toBe('fasta')
    expect(payload.exact).toBe(true)
    expect(payload.contigs).toEqual([
      { name: 'chrI', length: 700 },
      { name: 'chrII', length: 130 },
      { name: 'chrIII', length: 900_000 },
    ])
    // The sniff, the size and the index — and not the file.
    expect(log.some((line) => line.includes('big.fa.fai'))).toBe(true)
    expect(log.filter((line) => line.startsWith('GET https://h.example/big.fa ') && !line.includes('bytes='))).toEqual([])
  })

  it('loads as a lane that says so, and reads every window by range exactly as the whole file reads', async () => {
    serve({ size: LARGE, index: true })
    const loaded = await ask({ kind: 'load', entry: 'e-idx', source: source('big.fa'), mapContigs: [] })
    expect(loaded.type, JSON.stringify(loaded)).toBe('result')
    const summary = (loaded as { payload: { format: string; summary: string } }).payload
    expect(summary.format).toBe('fasta')
    expect(summary.summary).toContain('3 sequences')
    expect(summary.summary).toContain('read by range from its index')

    for (const [contig, start, end] of [
      ['chrI', 0, 10],
      ['chrI', 55, 65],
      ['chrI', 119, 121],
      ['chrI', 690, 700],
      ['chrI', 695, 900],
      ['chrII', 49, 51],
      ['chrII', 0, 130],
    ] as const) {
      const response = await ask({ kind: 'bases', entry: 'e-idx', regions: [{ contig, start, end }] })
      expect(response.type, JSON.stringify(response)).toBe('result')
      const regions = (response as { payload: BaseResult }).payload.regions
      expect(regions, `${contig}:${start}-${end}`).toHaveLength(1)
      const expected = decode((WHOLE.bases.get(contig) as Uint8Array).subarray(start, Math.min(end, (WHOLE.bases.get(contig) as Uint8Array).length)))
      expect(decode(regions[0].bases), `${contig}:${start}-${end}`).toBe(expected)
      expect(regions[0].start).toBe(start)
    }
    // A name the file has not got is simply absent from the reply.
    const missing = await ask({ kind: 'bases', entry: 'e-idx', regions: [{ contig: 'chrX', start: 0, end: 10 }] })
    expect((missing as { payload: BaseResult }).payload.regions).toEqual([])
  })

  it('draws GC content over a window it can afford, and nothing over one it cannot', async () => {
    serve({ size: LARGE, index: true })
    await ask({ kind: 'load', entry: 'e-gc', source: source('big.fa'), mapContigs: [] })
    const response = await ask({
      kind: 'sample',
      entry: 'e-gc',
      regions: [{ contig: 'chrII', start: 0, end: 130 }],
      basesPerPixel: 10,
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const samples = (response as { payload: TrackSampleSet }).payload
    expect(samples.regions).toHaveLength(1)
    // chrII is G and C throughout, so every bin is 1 — and on the sequence's own coordinates.
    expect(samples.regions[0].starts[0]).toBe(0)
    expect(Array.from(samples.regions[0].values).every((value) => value === 1)).toBe(true)

    const wide = await ask({
      kind: 'sample',
      entry: 'e-gc',
      regions: [{ contig: 'chrI', start: 0, end: 5_000_000 }],
      basesPerPixel: 10_000,
    })
    const refused = (wide as { payload: TrackSampleSet }).payload
    expect(refused.regions).toEqual([])
    // …and says so under the lane's name, rather than sitting blank.
    expect(refused.note).toContain('zoom in')
    expect(refused.note).toContain('4 Mb')
  })

  it('judges the cap over the whole request, so a genome of small scaffolds is one refusal and not a read each', async () => {
    serve({ size: LARGE, index: true })
    await ask({ kind: 'load', entry: 'e-many', source: source('big.fa'), mapContigs: [] })
    const before = log.filter((line) => /big\.fa bytes=/.test(line)).length
    // Two regions each under the cap and together over it — the whole-genome
    // view of a cow, in miniature.
    const wide = await ask({
      kind: 'sample',
      entry: 'e-many',
      regions: [
        { contig: 'chrI', start: 0, end: 3_000_000 },
        { contig: 'chrII', start: 0, end: 3_000_000 },
      ],
      basesPerPixel: 10_000,
    })
    expect((wide as { payload: TrackSampleSet }).payload.regions).toEqual([])
    expect(log.filter((line) => /big\.fa bytes=/.test(line)).length).toBe(before)
  })

  it('reports how far a ranged read has got, under the request that asked', async () => {
    serve({ size: LARGE, index: true })
    // Its own address: the worker keeps one chunk-caching handle per file, and
    // a chunk an earlier test fetched would answer this window for nothing.
    await ask({ kind: 'load', entry: 'e-progress', source: source('progress.fa'), mapContigs: [] })
    const seen = posted.length
    const id = nextId
    await ask({ kind: 'bases', entry: 'e-progress', regions: [{ contig: 'chrIII', start: 280_000, end: 280_120 }] })
    const reports = posted
      .slice(seen)
      .filter((message) => message.type === 'progress' && 'id' in message && message.id === id)
    expect(reports.length).toBeGreaterThan(0)
    const last = reports[reports.length - 1] as { done: number; total: number }
    expect(last.done).toBeGreaterThan(0)
    expect(last.total).toBe(last.done)
  })

  it('reads a window once, and a pan that stays inside it not at all', async () => {
    serve({ size: LARGE, index: true })
    await ask({ kind: 'load', entry: 'e-cache', source: source('cached.fa'), mapContigs: [] })
    await ask({ kind: 'bases', entry: 'e-cache', regions: [{ contig: 'chrIII', start: 280_000, end: 280_200 }] })
    const reads = (): number => log.filter((line) => /cached\.fa bytes=/.test(line)).length
    const before = reads()
    expect(before).toBeGreaterThan(0)
    await ask({ kind: 'bases', entry: 'e-cache', regions: [{ contig: 'chrIII', start: 280_050, end: 280_150 }] })
    expect(reads()).toBe(before)
    // A window in a stretch nothing has fetched — past the handle's chunk as
    // well as past the sequence cache's window.
    await ask({ kind: 'bases', entry: 'e-cache', regions: [{ contig: 'chrIII', start: 600_000, end: 600_100 }] })
    expect(reads()).toBe(before + 1)
  })

  it('takes a named index over the guess', async () => {
    serve({ size: LARGE, index: true })
    // Its own file name: the worker answers the second question about one
    // file from the first, so `big.fa` above would come back from memory.
    const response = await ask({
      kind: 'assembly',
      source: source('named.fa', 'https://h.example/elsewhere/named.fai'),
    })
    expect(response.type, JSON.stringify(response)).toBe('result')
    expect(log.some((line) => line.includes('elsewhere/named.fai'))).toBe(true)
    expect(log.some((line) => line.includes('named.fa.fai'))).toBe(false)
  })
})

describe('the fallbacks', () => {
  it('holds a small FASTA whole, index or no index, so every zoom draws GC', async () => {
    serve({ size: BYTES.length, index: true })
    const loaded = await ask({ kind: 'load', entry: 'e-small', source: source('small.fa'), mapContigs: [] })
    const summary = (loaded as { payload: { summary: string } }).payload.summary
    expect(summary).toContain('3 sequences')
    expect(summary).not.toContain('read by range')
    expect(log.some((line) => line.includes('.fai'))).toBe(false)
  })

  it('reads a FASTA over the line whole when there is no index at all', async () => {
    // The server says "past the whole-read line, under the cap", nothing
    // answers for the index, and the read that always worked is what happens
    // — which here is the small body.
    serve({ size: 100_000_000, index: false })
    const loaded = await ask({ kind: 'load', entry: 'e-noindex', source: source('noindex.fa'), mapContigs: [] })
    expect(loaded.type, JSON.stringify(loaded)).toBe('result')
    expect((loaded as { payload: { summary: string } }).payload.summary).not.toContain('read by range')
    expect(log.some((line) => line.includes('noindex.fa.fai'))).toBe(true)
  })

  it('refuses a FASTA past the whole-read cap with no index, naming the command', async () => {
    serve({ size: 900_000_000, index: false })
    const response = await ask({ kind: 'assembly', source: source('huge.fa') })
    expect(response.type).toBe('error')
    const message = (response as { message: string }).message
    expect(message).toContain('samtools faidx huge.fa')
    expect(message).toContain('#index=')
    // …and before reading the file whole.
    expect(log.filter((line) => line.startsWith('GET https://h.example/huge.fa ') && !line.includes('bytes=')).length).toBe(0)
  })
})
