/**
 * A request-counting {@link ByteSource} for the §12 budget tests.
 *
 * ## The substitution, stated plainly
 *
 * The budgets in spec §12 are about a *remote* file read over HTTP range
 * requests, and there is no bucket yet (that is M5). This source is the stand-in:
 * it serves the bytes from a local file but drives them through the **real**
 * {@link RemoteRangeSource} — its 1 MiB chunk cache, its coalescing of adjacent
 * missing chunks, its LRU eviction and its request counter — so the number this
 * asserts against is the number the production remote path would issue for the
 * same access pattern. Only the transport is faked, and it is faked at the very
 * bottom: a synchronous `XMLHttpRequest` stub that answers a `Range` header out
 * of a `Uint8Array`, which is exactly what `fetchRange` calls.
 *
 * ## Why the bytes are intercepted at `FS.read`
 *
 * `RemoteRangeSource.mount()` builds a lazy Emscripten FS node whose
 * `stream_ops.read` pulls chunks on demand. That works in a browser worker over
 * MEMFS, and **not** under Node: `h5wasm/node` is compiled with NODERAWFS, whose
 * `FS` is the real filesystem — `FS.createFile('/', …)` fails with `EACCES` and
 * custom `stream_ops` are never consulted, because the syscall layer goes
 * straight to `node:fs`. So the node is not used here. Instead `FS.read` is
 * wrapped, and every read HDF5 issues against the file under test is answered
 * from `RemoteRangeSource.readBytes`. HDF5 sees identical bytes; the chunk cache
 * sees the identical access pattern; the counter counts the identical requests.
 *
 * The one thing this cannot reproduce is a browser's HTTP stack — connection
 * reuse, redirects, preflights. Those change latency, not request count.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { getH5 } from '@/h5/bootstrap'
import { RemoteRangeSource } from '@/sources/RemoteRangeSource'
import type { ByteSource, SourceStats } from '@/types'

/** Bytes served per fake URL, consulted by the `XMLHttpRequest` stub. */
const served = new Map<string, Uint8Array>()

/** Serves one intercepted `FS.read`, returning the number of bytes written. */
type ReadHandler = (buffer: Uint8Array, offset: number, length: number, position: number) => number

/** Active interceptors, keyed by the absolute path h5wasm reports for a read. */
const intercepted = new Map<string, ReadHandler>()

let xhrInstalled = false
let readPatched = false

/**
 * A synchronous `XMLHttpRequest` that answers range requests from memory.
 *
 * Deliberately minimal and deliberately strict: it *requires* a `Range` header
 * and returns 206, because a stub that quietly returned the whole object on a
 * missing header would hide the very bug (an un-ranged read) the budgets exist
 * to catch.
 */
class MemoryXhr {
  status = 0
  response: ArrayBuffer | null = null
  responseType = ''
  private url = ''
  private range: [number, number] | null = null
  private served: [number, number, number] = [0, 0, 0]

  open(_method: string, url: string, _async: boolean): void {
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    if (name.toLowerCase() !== 'range') return
    const match = /^bytes=(\d+)-(\d+)$/.exec(value)
    if (match === null) throw new Error(`unsupported Range header: ${value}`)
    this.range = [Number(match[1]), Number(match[2])]
  }

  send(_body: unknown): void {
    const bytes = served.get(this.url)
    if (bytes === undefined) {
      this.status = 404
      return
    }
    if (this.range === null) {
      throw new Error(`${this.url}: a range request must carry a Range header`)
    }
    const [from, to] = this.range
    const end = Math.min(to, bytes.byteLength - 1)
    const slice = bytes.subarray(from, end + 1)
    this.served = [from, end, bytes.byteLength]
    this.status = 206
    this.response = slice.slice().buffer
  }

  /**
   * `Content-Range`, which the reader believes over everything else.
   *
   * Not optional furniture: `RemoteRangeSource.windowOf` uses this header to
   * find where the body it got actually starts, because a host may answer 206
   * and send the whole object anyway. A stub without it makes every read look
   * like an offset-less one.
   */
  getResponseHeader(header: string): string | null {
    if (header.toLowerCase() !== 'content-range') return null
    const [from, to, total] = this.served
    return `bytes ${from}-${to}/${total}`
  }
}

/** Install the transport and read shims once per process. */
async function installShims(): Promise<void> {
  if (!xhrInstalled) {
    ;(globalThis as Record<string, unknown>).XMLHttpRequest = MemoryXhr
    xhrInstalled = true
  }
  if (readPatched) return
  const h5 = await getH5()
  const fs = h5.FS as unknown as {
    read(
      stream: { path?: string },
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number
  }
  const original = fs.read.bind(h5.FS)
  fs.read = function patched(stream, buffer, offset, length, position) {
    const handler = stream?.path === undefined ? undefined : intercepted.get(stream.path)
    if (handler === undefined) return original(stream, buffer, offset, length, position)
    return handler(buffer, offset, length, position)
  }
  readPatched = true
}

export interface CountingOptions {
  /** Bytes per cached chunk. Defaults to the production 1 MiB. */
  chunkSize?: number
  /** Retained chunk bytes before LRU eviction. Defaults to the production 64 MiB. */
  maxCacheBytes?: number
}

export class CountingRangeSource implements ByteSource {
  readonly id: string
  readonly size: number
  /** Reads HDF5 issued against this file — the un-coalesced lower bound. */
  rawReads = 0

  private readonly path: string
  private readonly url: string
  private readonly remote: RemoteRangeSource
  private mounted = false

  private constructor(path: string, url: string, remote: RemoteRangeSource) {
    this.path = path
    this.url = url
    this.remote = remote
    this.id = url
    this.size = remote.size
  }

  /**
   * Wrap a local file. The `HEAD` probe is answered from the file's own size
   * and **is counted**, exactly as it would be against a real bucket.
   */
  static async open(path: string, options: CountingOptions = {}): Promise<CountingRangeSource> {
    await installShims()
    const absolute = resolve(path)
    const bytes = new Uint8Array(readFileSync(absolute))
    const url = `https://fixtures.invalid/${encodeURIComponent(absolute)}`
    served.set(url, bytes)

    const remote = await RemoteRangeSource.open(url, {
      ...options,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input) !== url || init?.method !== 'HEAD') {
          throw new Error(`unexpected probe: ${init?.method} ${String(input)}`)
        }
        return new Response(null, {
          status: 200,
          headers: {
            'content-length': String(bytes.byteLength),
            'accept-ranges': 'bytes',
          },
        })
      },
    })
    return new CountingRangeSource(absolute, url, remote)
  }

  async mount(): Promise<string> {
    if (!this.mounted) {
      intercepted.set(this.path, (buffer, offset, length, position) => {
        this.rawReads += 1
        const slice = this.remote.readBytes(position, length)
        buffer.set(slice, offset)
        return slice.byteLength
      })
      this.mounted = true
    }
    // NODERAWFS opens the real file; every byte it then reads is answered by
    // the interceptor above, so the file on disk is never actually read.
    return this.path
  }

  close(): void {
    intercepted.delete(this.path)
    served.delete(this.url)
    this.mounted = false
    this.remote.close()
  }

  /** Range requests issued and bytes transferred, probe included. */
  stats(): SourceStats {
    return this.remote.stats()
  }

  /** Zero the counters so one operation can be measured on its own. */
  resetStats(): void {
    this.remote.resetStats()
    this.rawReads = 0
  }

  /** Chunks currently retained by the production LRU cache. */
  cachedChunkCount(): number {
    return this.remote.cachedChunkCount()
  }
}
