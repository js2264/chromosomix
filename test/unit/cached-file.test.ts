/**
 * The chunk-caching remote handle (`annotations/worker/cachedFile.ts`).
 *
 * What is asserted is the count: a parser's small reads are one request, the
 * same file opened again reads nothing, two readers after one chunk make one
 * request between them, and a read that runs off the end learns the size
 * rather than asking for it. The host is a fake `fetch` that answers ranges
 * over a buffer and counts what it was asked for.
 */

import { describe, expect, it } from 'vitest'

import { CachedRemoteFile } from '@/annotations/worker/cachedFile'

const SIZE = 1_000_000

function bytesOf(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 7 + (i >> 8)) & 0xff
  return out
}

const FILE = bytesOf(SIZE)

/** A range-answering host over `FILE`, logging each request's range. */
function host(): { fetch: typeof fetch; ranges: string[] } {
  const ranges: string[] = []
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const range = /bytes=(\d+)-(\d*)/.exec(String(headers['range'] ?? headers['Range'] ?? ''))
    if (range === null) {
      ranges.push('whole')
      return new Response(FILE as unknown as BodyInit, { status: 200, headers: { 'content-length': String(SIZE) } })
    }
    const from = Number(range[1])
    const to = range[2] === '' ? SIZE - 1 : Math.min(Number(range[2]), SIZE - 1)
    ranges.push(`${from}-${to}`)
    if (from >= SIZE) return new Response(null, { status: 416 })
    const slice = FILE.slice(from, to + 1)
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: { 'content-length': String(slice.length), 'content-range': `bytes ${from}-${to}/${SIZE}` },
    })
  }) as typeof fetch
  return { fetch: impl, ranges }
}

function opened(chunk = 1 << 18, budget = 64 << 20): { file: CachedRemoteFile; ranges: string[] } {
  const { fetch, ranges } = host()
  return { file: new CachedRemoteFile('https://h.example/a.bw', { fetch }, chunk, budget), ranges }
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

describe('a chunk-caching handle', () => {
  it('answers a parser’s small reads out of one request, and answers them again for nothing', async () => {
    const { file, ranges } = opened()
    expect(same(await file.read(64, 0), FILE.subarray(0, 64))).toBe(true)
    expect(same(await file.read(2000, 0), FILE.subarray(0, 2000))).toBe(true)
    expect(same(await file.read(32, 344), FILE.subarray(344, 376))).toBe(true)
    expect(same(await file.read(292, 376), FILE.subarray(376, 668))).toBe(true)
    expect(ranges).toEqual(['0-262143'])
    expect(file.requests).toBe(1)
    // The second open of the same file, which is what a track's load is after
    // the assembly question.
    await file.read(2000, 0)
    expect(file.requests).toBe(1)
  })

  it('reads a span across chunks in one request, and only the chunks it lacks', async () => {
    const { file, ranges } = opened(1000)
    await file.read(10, 1500) // chunk 1
    expect(ranges).toEqual(['1000-1999'])
    const out = await file.read(3500, 500) // chunks 0..3, of which 1 is held
    expect(same(out, FILE.subarray(500, 4000))).toBe(true)
    expect(ranges).toEqual(['1000-1999', '0-999', '2000-3999'])
  })

  it('makes one request for two readers after the same chunk at the same moment', async () => {
    const { file, ranges } = opened()
    const [a, b] = await Promise.all([file.read(100, 10), file.read(100, 200)])
    expect(same(a, FILE.subarray(10, 110))).toBe(true)
    expect(same(b, FILE.subarray(200, 300))).toBe(true)
    expect(ranges).toEqual(['0-262143'])
  })

  it('learns the size from a read that runs off the end, and asks for nothing past it', async () => {
    const { file, ranges } = opened(1 << 18)
    const tail = await file.read(5000, SIZE - 1000)
    expect(same(tail, FILE.subarray(SIZE - 1000))).toBe(true)
    expect(ranges).toHaveLength(1)
    // Past the end: no request, nothing back.
    expect((await file.read(100, SIZE + 10)).length).toBe(0)
    expect(ranges).toHaveLength(1)
    // Straddling it: the bytes there are, and nothing invented.
    const edge = await file.read(50, SIZE - 20)
    expect(same(edge, FILE.subarray(SIZE - 20))).toBe(true)
  })

  it('lets the oldest chunks go when its budget is spent', async () => {
    const { file, ranges } = opened(1000, 3000)
    for (let i = 0; i < 5; i++) await file.read(10, i * 1000)
    expect(ranges).toHaveLength(5)
    // The first chunk was the first to go: reading it again is a request.
    await file.read(10, 0)
    expect(ranges).toHaveLength(6)
    // The last one read is still here.
    await file.read(10, 4000)
    expect(ranges).toHaveLength(6)
  })
})
