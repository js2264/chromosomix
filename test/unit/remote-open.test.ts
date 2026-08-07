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

const FILE = new URL('../../demo/mock-community/Mock_microbial_community.metacool', import.meta.url).pathname
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

  setRequestHeader(header: string, value: string): void {
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
