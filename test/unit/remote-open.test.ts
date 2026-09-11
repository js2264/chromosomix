/**
 * The remote path, end to end, without a browser.
 *
 * `RemoteRangeSource` is the one source that cannot be exercised by the rest of
 * the suite: it needs `fetch` for the probe and a *synchronous* `XMLHttpRequest`
 * for the reads Emscripten's stream ops make, and it mounts through the browser
 * h5wasm build rather than the NODERAWFS one. So this file supplies both over a
 * local file and forces the browser branch of `isNodeRuntime()`.
 *
 * That is worth doing rather than mocking `mount()` away, because everything
 * interesting lives exactly there: the lazy FS node, `usedBytes`, the copied
 * `stream_ops`, and whether HDF5 can read a file it is never handed whole.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSync, readSync, statSync, closeSync } from 'node:fs'
import { requireGenomes } from './_golden'

const FILE = new URL('../../demo/metagenomics/mock-community/Mock_microbial_community.metacool', import.meta.url).pathname
const URL_FOR = (path: string): string => `https://example.test/${path.replace(/^\//, '')}`

let fd: number
let size: number
const saved: Record<string, unknown> = {}

/** A synchronous XHR that serves byte ranges out of the local file. */
class FakeXHR {
  status = 0
  response: ArrayBuffer | null = null
  responseType = ''
  private range: [number, number] | null = null
  private served: [number, number] = [0, 0]

  /** Only `content-range` is consulted, and it is what tells the two cases apart. */
  getResponseHeader(header: string): string | null {
    if (header.toLowerCase() !== 'content-range') return null
    return `bytes ${this.served[0]}-${this.served[1]}/${size}`
  }

  open(_method: string, _url: string, _async: boolean): void {}

  /** Every header the last ranged read set, in the order it set them. */
  static lastHeaders: Array<[string, string]> = []

  setRequestHeader(header: string, value: string): void {
    FakeXHR.lastHeaders.push([header, value])
    if (header.toLowerCase() !== 'range') return
    const match = /bytes=(\d+)-(\d+)/.exec(value)
    if (match) this.range = [Number(match[1]), Number(match[2])]
  }

  /** Set by a test to mimic a host that answers 206 and ignores the range. */
  static ignoreRanges = false

  send(): void {
    if (FakeXHR.ignoreRanges) {
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, 0)
      this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      this.served = [0, size - 1]
      this.status = 206
      return
    }
    const [from, to] = this.range ?? [0, size - 1]
    const end = Math.min(to, size - 1)
    const length = Math.max(0, end - from + 1)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, from)
    this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    this.served = [from, end]
    this.status = 206
  }
}

/** `fetch` for the HEAD probe: range support, declared length, nothing else. */
const fakeFetch = async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
  const headers = new Map([
    ['content-length', String(size)],
    ['accept-ranges', 'bytes'],
  ])
  if (init?.method === 'HEAD') {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    } as unknown as Response
  }
  throw new Error(`unexpected ${init?.method ?? 'GET'} in the probe`)
}

beforeAll(() => {
  fd = openSync(FILE, 'r')
  size = statSync(FILE).size
  const g = globalThis as Record<string, unknown>
  for (const key of ['window', 'XMLHttpRequest', 'fetch']) saved[key] = g[key]
  // `isNodeRuntime()` returns false as soon as `window` exists, which is what
  // selects the MEMFS browser build this path is written against.
  g['window'] = globalThis
  g['XMLHttpRequest'] = FakeXHR
  g['fetch'] = fakeFetch
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key]
    else g[key] = value
  }
  if (fd !== undefined) closeSync(fd)
})

describe('opening a file over ranged HTTP', () => {
  it('mounts and reads without ever holding the whole file', async () => {
    const { RemoteRangeSource } = await import('@/sources/RemoteRangeSource')
    const { MetaCooler } = await import('@/metacooler/MetaCooler')

    const url = URL_FOR(FILE)
    const source = await RemoteRangeSource.open(url, { fetchImpl: fakeFetch as typeof fetch })
    expect(source.size).toBe(size)

    const mc = await MetaCooler.open(url, source)
    expect(mc.nGenomes).toBe(49)
    expect(mc.nContigs).toBe(20566)
    expect(mc.binsize).toBe(1000)

    // The point of the exercise: a 14 MB file opened out of a fraction of itself.
    expect(source.stats().bytes).toBeLessThan(size / 2)
    mc.close()
    source.close()
  })

  it('survives a host that answers 206 and sends the whole object anyway', async () => {
    const { RemoteRangeSource } = await import('@/sources/RemoteRangeSource')
    const { MetaCooler } = await import('@/metacooler/MetaCooler')

    FakeXHR.ignoreRanges = true
    try {
      const source = await RemoteRangeSource.open(URL_FOR(FILE), {
        fetchImpl: fakeFetch as typeof fetch,
      })
      const mc = await MetaCooler.open(URL_FOR(FILE), source)
      expect(mc.nGenomes).toBe(49)
      expect(requireGenomes(mc).columns).toContain('name')
      mc.close()
      source.close()
    } finally {
      FakeXHR.ignoreRanges = false
    }
  })
})

/**
 * A recording `fetch`, for the two questions the probe path answers.
 *
 * It keeps every call's method and headers, and it answers a `HEAD` the way a
 * bucket that exposes nothing does — no `Accept-Ranges`, no `Content-Length` —
 * so the probe falls through to the one-byte `GET` and both requests are on
 * record. That is not a contrivance: it is what `4dn-open-data-public` does to a
 * browser, which is why the probe path exists at all.
 */
function recordingFetch(): {
  calls: Array<{ method: string; headers: Record<string, string> }>
  impl: typeof fetch
} {
  const calls: Array<{ method: string; headers: Record<string, string> }> = []
  const impl = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const sent = { ...(init?.headers as Record<string, string>) }
    calls.push({ method, headers: sent })
    if (method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      } as unknown as Response
    }
    const body = new Map<string, string>([
      ['content-range', 'bytes 0-0/' + String(size)],
      ['content-length', '1'],
    ])
    return {
      ok: true,
      status: sent['Range'] === undefined ? 200 : 206,
      statusText: 'Partial Content',
      headers: { get: (key: string) => body.get(key.toLowerCase()) ?? null },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('a URL that carries its own signature', () => {
  /**
   * SPECS §23.6, and the whole of what it asks for: a presigned URL is signed
   * for one method, so the `HEAD` it used to be probed with came back 403 and
   * the open failed before it started — on a link whose `GET` would have been
   * served. The probe used instead is the one the source already had for a host
   * that says nothing about ranges; what changed is that this URL takes it first.
   */
  const PRESIGNED =
    URL_FOR(FILE) +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600' +
    '&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefdeadbeef'

  it('is opened without a HEAD, straight to the one-byte range probe', async () => {
    const { RemoteRangeSource } = await import('@/sources/RemoteRangeSource')
    const { calls, impl } = recordingFetch()

    const source = await RemoteRangeSource.open(PRESIGNED, { fetchImpl: impl })

    expect(calls.map((call) => call.method)).toEqual(['GET'])
    expect(calls[0].headers['Range']).toBe('bytes=0-0')
    // …and the size comes from the probe's `Content-Range`, which is the only
    // place it can come from once the `HEAD` is gone.
    expect(source.size).toBe(size)
    source.close()
  })

  it('still probes a URL whose query is not a signature', async () => {
    // The negative half: the rule is about a signature in the query, not about
    // there being a query. A versioned object URL carries one and is not signed.
    const { RemoteRangeSource } = await import('@/sources/RemoteRangeSource')
    const { calls, impl } = recordingFetch()

    const source = await RemoteRangeSource.open(URL_FOR(FILE) + '?versionId=abc', {
      fetchImpl: impl,
    })

    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET'])
    source.close()
  })
})

describe('the static header bag', () => {
  /**
   * SPECS §23.7: a Google API key and a bearer token are headers rather than
   * signatures, and they go on **every** request for the URL. Every request is
   * the point — a bag applied to the probe and not to the reads opens a file
   * that then fails on its first block, which reads as the file being corrupt.
   */
  const HEADERS = { 'x-goog-api-key': 'AIzaKEY', Authorization: 'Bearer ya29.TOKEN' }
  const GOOGLE = 'https://storage.googleapis.com/storage/v1/b/lab/o/mock.metacool?alt=media'

  it('is on the HEAD, on the probe and on every ranged read', async () => {
    const { RemoteRangeSource } = await import('@/sources/RemoteRangeSource')
    const { calls, impl } = recordingFetch()
    FakeXHR.lastHeaders = []

    const source = await RemoteRangeSource.open(GOOGLE, { fetchImpl: impl, headers: HEADERS })

    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET'])
    for (const call of calls) {
      expect(call.headers['x-goog-api-key']).toBe('AIzaKEY')
      expect(call.headers['Authorization']).toBe('Bearer ya29.TOKEN')
    }

    // And on the read itself, which goes through `XMLHttpRequest` rather than
    // `fetch` because Emscripten's stream `read` op is synchronous.
    source.readBytes(0, 16)
    const names = FakeXHR.lastHeaders.map(([name]) => name)
    expect(names).toContain('x-goog-api-key')
    expect(names).toContain('Authorization')
    // `Range` is set last, after everything that is signed over — the order
    // `fetchRange` has always kept, now with the static bag in front of it.
    expect(names[names.length - 1]).toBe('Range')
    source.close()
  })

  it('adds nothing when there is nothing to add, which is every public file', async () => {
    // A range read with no headers is a *simple* cross-origin request; a bag
    // put on unconditionally would cost a preflight per read of every demo.
    const { RemoteRangeSource } = await import('@/sources/RemoteRangeSource')
    const { calls, impl } = recordingFetch()
    FakeXHR.lastHeaders = []

    const source = await RemoteRangeSource.open(URL_FOR(FILE), { fetchImpl: impl })
    expect(calls[0].headers).toEqual({})
    source.readBytes(0, 16)
    expect(FakeXHR.lastHeaders.map(([name]) => name)).toEqual(['Range'])
    source.close()
  })
})
