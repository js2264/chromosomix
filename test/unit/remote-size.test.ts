/**
 * A remote file whose host will not say how long it is.
 *
 * 4DN's open-data bucket answers a ranged read with a `Content-Range` the
 * browser is not allowed to see — its CORS policy exposes `ETag` and nothing
 * else — so the file handle reports a size of nought. Taken at its word that
 * was a header read of nought bytes, "not a BAM", and the whole alignment
 * file fetched to find out what its first block said. Two things are pinned:
 * the size is asked for again with a `HEAD`, whose `Content-Length` every
 * page may read, and a host that answers neither still gets a bounded header
 * read rather than a download.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import { writeBam } from '../support/bamWriter'

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

function settled(id: number): AnnotationResponse | undefined {
  return posted.find((message) => 'id' in message && message.id === id && message.type !== 'progress')
}

async function ask(request: Unsent<AnnotationRequest>): Promise<AnnotationResponse> {
  const id = nextId++
  deliver({ ...request, id } as AnnotationRequest)
  await vi.waitFor(() => {
    expect(settled(id)).toBeDefined()
  })
  return settled(id) as AnnotationResponse
}

const REFS = [
  { name: 'chrI', length: 230_218 },
  { name: 'chrII', length: 813_184 },
]

let log: string[] = []

/** Serve a BAM the way 4DN does: ranges honoured, `Content-Range` invisible, `HEAD` as asked. */
async function serve(options: { head: 'ok' | 'refused' }): Promise<void> {
  const written = await writeBam(REFS, [], '@HD\tVN:1.6\tSO:coordinate\n')
  const bytes = new Uint8Array(await new Blob([written.bam as BlobPart]).arrayBuffer())
  log = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const method = init?.method ?? 'GET'
    const range = /bytes=(\d+)-(\d*)/.exec(String(headers['range'] ?? headers['Range'] ?? ''))
    log.push(`${method} ${url.split('/').pop()} ${range === null ? 'whole' : range[0]}`)
    if (method === 'HEAD') {
      return options.head === 'ok'
        ? new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } })
        : new Response(null, { status: 405, statusText: 'Method Not Allowed' })
    }
    if (url.endsWith('.bai')) return new Response(null, { status: 404, statusText: 'Not Found' })
    if (range === null) {
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': String(bytes.length) },
      })
    }
    const from = Number(range[1])
    const to = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1)
    const slice = bytes.slice(from, to + 1)
    // No `content-range`: the browser would not be allowed to read it here.
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: { 'content-length': String(slice.length) },
    })
  }) as typeof fetch
}

const SOURCE = { kind: 'remote', url: 'https://h.example/reads.bam', name: 'reads.bam' } as const

describe('a BAM on a host that hides Content-Range', () => {
  it('learns the size from a HEAD and answers the assembly from the header, never reading the file whole', async () => {
    await serve({ head: 'ok' })
    const response = await ask({ kind: 'assembly', source: SOURCE })
    expect(response.type, JSON.stringify(response)).toBe('result')
    const payload = (response as { payload: { format: string; contigs: unknown[] } }).payload
    expect(payload.format).toBe('bam')
    expect(payload.contigs).toEqual(REFS)
    expect(log.some((line) => line.startsWith('HEAD reads.bam'))).toBe(true)
    expect(log.filter((line) => line.startsWith('GET reads.bam whole'))).toEqual([])
  })

  it('still answers from a bounded header read when even the HEAD is refused', async () => {
    await serve({ head: 'refused' })
    const response = await ask({ kind: 'assembly', source: SOURCE })
    expect(response.type, JSON.stringify(response)).toBe('result')
    expect((response as { payload: { format: string } }).payload.format).toBe('bam')
    expect(log.filter((line) => line.startsWith('GET reads.bam whole'))).toEqual([])
    // …and a load, which needs the size, says what the host would not, rather
    // than fetching gigabytes to find out.
    const loaded = await ask({ kind: 'load', entry: 'e-unsized', source: SOURCE, mapContigs: [] })
    expect(loaded.type).toBe('error')
    expect((loaded as { message: string }).message).toContain('cannot be measured')
    expect(log.filter((line) => line.startsWith('GET reads.bam whole'))).toEqual([])
  })
})
