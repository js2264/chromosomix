/**
 * A remote open that does not wait for itself (§6.1, §12).
 *
 * Opening a map is a walk: every read names the place of the next, and each is
 * a synchronous request the next waits for. On the Human Hi-C example that was
 * thirty round trips in a row before the first picture, the line idle for
 * nearly all of it. Two things shorten it, and this pins both:
 *
 * - the probe asks for the file's **first chunk** and keeps it, so the first
 *   read — an HDF5 superblock, a `.hic` header — is not a second round trip;
 * - a **read plan** — the chunks a walk read, written down — is fetched side by
 *   side as the next open starts, and the walk then runs out of the cache.
 *
 * Both fetch through `fetch` and are checked against what they claim before a
 * byte of them is kept; the walk's own reads go through `syncFetch`, counted.
 */

import { describe, expect, it } from 'vitest'

import { RemoteRangeSource, type ReadPlan } from '@/sources/RemoteRangeSource'

const CHUNK = 256 * 1024
const URL = 'https://bucket.example/map.mcool'

/** A file of `chunks` chunks and a bit, every byte its own offset's low bits. */
function file(chunks: number): Uint8Array {
  const bytes = new Uint8Array(chunks * CHUNK + 1000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 9)) & 0xff
  return bytes
}

interface Host {
  /** Every `fetch`, as `METHOD range`. */
  asked: string[]
  /** Every synchronous read the walk made, as its range. */
  walked: string[]
  fetchImpl: typeof fetch
  syncFetch: (url: string, headers: Record<string, string>) => { status: number; body: Uint8Array; contentRange: string | null }
}

/**
 * A bucket like 4DN's: its `HEAD` exposes nothing, so the probe is the road,
 * and every range is answered exactly — unless `lie` says to answer one
 * differently.
 */
function host(bytes: Uint8Array, lie: { wholeFor?: string; hideRange?: boolean } = {}): Host {
  const asked: string[] = []
  const walked: string[] = []
  const answer = (range: string | undefined): Response => {
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '')
    if (match === null || range === lie.wholeFor) {
      const all = bytes.slice()
      return {
        ok: true,
        status: range === undefined ? 200 : 206,
        statusText: 'OK',
        headers: {
          get: (key: string) =>
            key.toLowerCase() === 'content-range' && range !== undefined ? `bytes 0-${bytes.length - 1}/${bytes.length}` : null,
        },
        arrayBuffer: async () => all.buffer,
      } as unknown as Response
    }
    const from = Number(match[1])
    const to = Math.min(Number(match[2]), bytes.length - 1)
    const slice = bytes.slice(from, to + 1)
    const said = new Map<string, string>([['content-length', String(slice.length)]])
    // 4DN's bucket exposes `ETag` alone to a page: `Content-Range` is sent and
    // the page cannot read it. `Content-Length` it always can.
    if (lie.hideRange !== true) said.set('content-range', `bytes ${from}-${to}/${bytes.length}`)
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: { get: (key: string) => said.get(key.toLowerCase()) ?? null },
      arrayBuffer: async () => slice.buffer,
    } as unknown as Response
  }
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    asked.push(`${init?.method ?? 'GET'} ${headers['Range'] ?? '-'}`)
    if (init?.method === 'HEAD') {
      // What a page reads off 4DN's `HEAD`: the length, and not `Accept-Ranges`.
      const length = lie.hideRange === true ? String(bytes.length) : null
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (key: string) => (key.toLowerCase() === 'content-length' ? length : null) },
      } as unknown as Response
    }
    return answer(headers['Range'])
  }) as unknown as typeof fetch
  const syncFetch = (_url: string, headers: Record<string, string>) => {
    walked.push(headers['Range'] ?? '-')
    const match = /bytes=(\d+)-(\d+)/.exec(headers['Range'] ?? '')
    const from = Number(match?.[1] ?? 0)
    const to = Math.min(Number(match?.[2] ?? bytes.length - 1), bytes.length - 1)
    return { status: 206, body: bytes.slice(from, to + 1), contentRange: `bytes ${from}-${to}/${bytes.length}` }
  }
  return { asked, walked, fetchImpl, syncFetch }
}

describe('the probe', () => {
  it('asks for the first chunk and keeps it, so the first read is not a second round trip', async () => {
    const bytes = file(8)
    const at = host(bytes)
    const source = await RemoteRangeSource.open(URL, { fetchImpl: at.fetchImpl, syncFetch: at.syncFetch })
    expect(at.asked).toEqual(['HEAD -', `GET bytes=0-${CHUNK - 1}`])
    expect(source.readBytes(100, 64)).toEqual(bytes.slice(100, 164))
    expect(at.walked).toEqual([])
    // The chunk after it is read as it always was.
    expect(source.readBytes(CHUNK + 5, 10)).toEqual(bytes.slice(CHUNK + 5, CHUNK + 15))
    expect(at.walked).toEqual([`bytes=${CHUNK}-${2 * CHUNK - 1}`])
  })

  it('keeps nothing from a host that answers with the whole object', async () => {
    const bytes = file(4)
    const at = host(bytes, { wholeFor: `bytes=0-${CHUNK - 1}` })
    const source = await RemoteRangeSource.open(URL, { fetchImpl: at.fetchImpl, syncFetch: at.syncFetch })
    // The size is still the file's, from the `Content-Range` it did send…
    expect(source.size).toBe(bytes.length)
    // …and the first read is fetched, not taken from a body that was never read.
    expect(source.readBytes(0, 16)).toEqual(bytes.slice(0, 16))
    expect(at.walked).toHaveLength(1)
  })
})

describe('a read plan', () => {
  const plan = (bytes: Uint8Array, ranges: Array<[number, number]>): ReadPlan => ({ size: bytes.length, ranges })

  it('is fetched beside the open, side by side, and the walk then reads none of it', async () => {
    const bytes = file(64)
    const at = host(bytes)
    const ranges: Array<[number, number]> = [
      [0, CHUNK],
      [10 * CHUNK, 12 * CHUNK],
      [40 * CHUNK, 41 * CHUNK],
    ]
    const source = await RemoteRangeSource.open(URL, {
      fetchImpl: at.fetchImpl,
      syncFetch: at.syncFetch,
      plan: plan(bytes, ranges),
    })
    // The HEAD first, then every range of the plan, all before the probe's
    // answer was waited for — not one after another behind the walk.
    expect(at.asked.slice(0, 4)).toEqual([
      'HEAD -',
      `GET bytes=0-${CHUNK - 1}`,
      `GET bytes=${10 * CHUNK}-${12 * CHUNK - 1}`,
      `GET bytes=${40 * CHUNK}-${41 * CHUNK - 1}`,
    ])
    expect(source.readBytes(11 * CHUNK - 20, 40)).toEqual(bytes.slice(11 * CHUNK - 20, 11 * CHUNK + 20))
    expect(source.readBytes(40 * CHUNK + 3, 9)).toEqual(bytes.slice(40 * CHUNK + 3, 40 * CHUNK + 12))
    expect(at.walked).toEqual([])
    expect(source.stats().requests).toBe(at.asked.length)
  })

  it('is kept from a bucket that hides Content-Range, on the length it can read', async () => {
    // 4DN's: `Access-Control-Expose-Headers: ETag`. A plan held to the range it
    // could not see was fetched and thrown away, and the walk read it again.
    const bytes = file(32)
    const at = host(bytes, { hideRange: true })
    const source = await RemoteRangeSource.open(URL, {
      fetchImpl: at.fetchImpl,
      syncFetch: at.syncFetch,
      plan: plan(bytes, [[0, CHUNK], [9 * CHUNK, 11 * CHUNK]]),
    })
    expect(source.size).toBe(bytes.length)
    expect(source.readBytes(5, 5)).toEqual(bytes.slice(5, 10))
    expect(source.readBytes(10 * CHUNK - 3, 6)).toEqual(bytes.slice(10 * CHUNK - 3, 10 * CHUNK + 3))
    expect(at.walked).toEqual([])
  })

  it('is not used for a file of another size, which is another file', async () => {
    const bytes = file(16)
    const at = host(bytes)
    const source = await RemoteRangeSource.open(URL, {
      fetchImpl: at.fetchImpl,
      syncFetch: at.syncFetch,
      plan: { size: bytes.length + 1, ranges: [[5 * CHUNK, 6 * CHUNK]] },
    })
    source.readBytes(5 * CHUNK, 10)
    expect(at.walked).toEqual([`bytes=${5 * CHUNK}-${6 * CHUNK - 1}`])
  })

  it('keeps no range answered with anything but itself', async () => {
    const bytes = file(16)
    const lied = `bytes=${5 * CHUNK}-${6 * CHUNK - 1}`
    const at = host(bytes, { wholeFor: lied })
    const source = await RemoteRangeSource.open(URL, {
      fetchImpl: at.fetchImpl,
      syncFetch: at.syncFetch,
      plan: plan(bytes, [[5 * CHUNK, 6 * CHUNK]]),
    })
    expect(source.readBytes(5 * CHUNK + 1, 4)).toEqual(bytes.slice(5 * CHUNK + 1, 5 * CHUNK + 5))
    expect(at.walked).toEqual([lied])
  })

  it('is what a walk writes down: the chunks it touched, a one-chunk gap bridged', async () => {
    const bytes = file(64)
    const at = host(bytes)
    const source = await RemoteRangeSource.open(URL, { fetchImpl: at.fetchImpl, syncFetch: at.syncFetch, readAhead: false })
    source.beginRecording()
    source.readBytes(10, 10)
    source.readBytes(20 * CHUNK + 10, 10)
    source.readBytes(22 * CHUNK + 10, CHUNK) // two chunks, one apart from the last
    source.readBytes(50 * CHUNK, 10)
    expect(source.recorded()).toEqual({
      size: bytes.length,
      ranges: [
        [0, CHUNK],
        [20 * CHUNK, 24 * CHUNK],
        [50 * CHUNK, 51 * CHUNK],
      ],
    })
    source.stopRecording()
    expect(source.recorded()).toBeNull()

    // …and played back on a second open, the same walk asks for nothing.
    const again = host(bytes)
    const replayed = await RemoteRangeSource.open(URL, {
      fetchImpl: again.fetchImpl,
      syncFetch: again.syncFetch,
      plan: { size: bytes.length, ranges: [[0, CHUNK], [20 * CHUNK, 24 * CHUNK], [50 * CHUNK, 51 * CHUNK]] },
    })
    replayed.readBytes(10, 10)
    replayed.readBytes(20 * CHUNK + 10, 10)
    replayed.readBytes(22 * CHUNK + 10, CHUNK)
    replayed.readBytes(50 * CHUNK, 10)
    expect(again.walked).toEqual([])
  })

  it('fetches only what a source does not already hold, once it is open', async () => {
    const bytes = file(32)
    const at = host(bytes)
    const source = await RemoteRangeSource.open(URL, { fetchImpl: at.fetchImpl, syncFetch: at.syncFetch, readAhead: false })
    source.readBytes(9 * CHUNK, 10)
    at.asked.length = 0
    await source.prefetch({ size: bytes.length, ranges: [[8 * CHUNK, 11 * CHUNK]] })
    // Chunk 9 is held, so the run is cut around it.
    expect(at.asked).toEqual([`GET bytes=${8 * CHUNK}-${9 * CHUNK - 1}`, `GET bytes=${10 * CHUNK}-${11 * CHUNK - 1}`])
    at.walked.length = 0
    source.readBytes(8 * CHUNK, 3 * CHUNK)
    expect(at.walked).toEqual([])
  })
})
