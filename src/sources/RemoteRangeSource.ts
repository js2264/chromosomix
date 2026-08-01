/**
 * A remote file as a {@link ByteSource}, read over HTTP range requests
 * (spec §11, M5).
 *
 * The shape is Emscripten's `FS.createLazyFile` — an FS node whose contents are
 * fetched on demand — but the built-in is not reused, for three reasons that
 * are all requirements rather than preferences:
 *
 * 1. **It probes with a synchronous `HEAD` of its own.** We must probe
 *    asynchronously first anyway, to tell "this host does not serve ranges"
 *    apart from "the browser refused the request" (spec §10); doing it twice
 *    wastes a request out of a budget of twenty.
 * 2. **Its cache is unbounded.** Every chunk ever touched is retained, so a
 *    long session over a large file ends up holding the file. h5wasm's own
 *    `lazyFileLRU` demo exists to fix exactly this, and this is that fix.
 * 3. **It counts nothing.** The §12 budgets are assertions on request and byte
 *    counts, so the source has to be the thing that counts them.
 *
 * Reads must be synchronous because Emscripten's stream `read` is synchronous,
 * so this only works where synchronous `XMLHttpRequest` is allowed: **inside a
 * worker**. That is where all I/O lives anyway.
 */

import type { ByteSource, SourceStats } from '../types'
import { ViewerError } from '../errors'
import type { H5FSNode } from '../h5/bootstrap'
import { getH5 } from '../h5/bootstrap'

/** 1 MiB. Large enough that HDF5's metadata walk lands repeatedly in one chunk. */
const DEFAULT_CHUNK_SIZE = 1 << 20

/** 64 MiB of chunks retained. Well above one MAG's matrix, far below a file. */
const DEFAULT_CACHE_BYTES = 64 << 20

export interface RemoteRangeOptions {
  /** Bytes per cached chunk. */
  chunkSize?: number
  /** Upper bound on retained chunk bytes; least-recently-used are dropped. */
  maxCacheBytes?: number
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export class RemoteRangeSource implements ByteSource {
  readonly id: string
  readonly size: number
  readonly url: string

  private readonly chunkSize: number
  private readonly maxCacheBytes: number
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly cache = new Map<number, Uint8Array>()
  private cachedBytes = 0
  private requests: number
  private bytesRead: number
  private mountPath: string | null = null

  private constructor(
    url: string,
    size: number,
    options: RemoteRangeOptions,
    probeCost: SourceStats,
  ) {
    this.url = url
    this.id = url
    this.size = size
    this.chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? DEFAULT_CHUNK_SIZE))
    const requested = Math.trunc(options.maxCacheBytes ?? DEFAULT_CACHE_BYTES)
    this.maxCacheBytes = Math.max(this.chunkSize, requested)
    this.requests = probeCost.requests
    this.bytesRead = probeCost.bytes
  }

  /**
   * Probe the URL, then return a source ready to mount.
   *
   * The probe is what produces the two distinct refusals spec §10 demands. A
   * cross-origin failure surfaces in the browser as an opaque `TypeError` on
   * `fetch` with no status and no headers — indistinguishable, on its face,
   * from the host being down. It is told apart by *shape*: a second request in
   * `no-cors` mode does not require CORS headers, so if that one succeeds while
   * the plain request failed, the host is reachable and the response was
   * blocked by the browser's CORS check.
   */
  static async open(url: string, options: RemoteRangeOptions = {}): Promise<RemoteRangeSource> {
    const doFetch = options.fetchImpl ?? globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw new ViewerError('remote-cors', 'this runtime has no fetch(); remote files need one', {
        url,
      })
    }
    const host = hostOf(url)
    const cost: SourceStats = { requests: 0, bytes: 0 }

    let head: Response | null = null
    try {
      cost.requests += 1
      head = await doFetch(url, { method: 'HEAD' })
    } catch (cause) {
      await failCrossOrigin(url, host, cause, doFetch, cost)
    }
    if (head && !head.ok) {
      // An HTTP error status is neither of spec §10's two remote refusals: the
      // request was allowed through and answered, it just did not name a
      // readable object. `bad-uri` is the honest code for that.
      throw new ViewerError(
        'bad-uri',
        `${host} answered ${head.status} ${head.statusText} to a HEAD of ${url}; ` +
          'the viewer needs a publicly readable object. A presigned URL will not work — ' +
          'it is signed for a single method, so the HEAD probe fails even when the GET ' +
          'would have succeeded.',
        { url, host, status: head.status },
      )
    }

    const declaredLength = numberHeader(head, 'content-length')
    const acceptsRanges = (head?.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes')

    if (acceptsRanges && declaredLength !== null) {
      return new RemoteRangeSource(url, declaredLength, options, cost)
    }

    // Either the host says nothing about ranges, or CORS hid the headers from
    // us. One byte settles both questions and yields the size along the way.
    let probe: Response
    try {
      cost.requests += 1
      probe = await doFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
    } catch (cause) {
      await failCrossOrigin(url, host, cause, doFetch, cost)
      throw new Error('unreachable')
    }
    cost.bytes += numberHeader(probe, 'content-length') ?? 1

    if (probe.status !== 206) {
      throw new ViewerError(
        'remote-no-ranges',
        `${host} does not serve HTTP range requests: a \`Range: bytes=0-0\` request for ` +
          `${url} returned ${probe.status}, not 206 Partial Content. The viewer reads ` +
          'remote files a slice at a time and cannot download a whole file to open it. ' +
          'Host the file on storage that advertises `Accept-Ranges: bytes` (S3, R2 and ' +
          'GCS all do); GEO and SRA download endpoints do not.',
        { url, host, status: probe.status },
      )
    }

    const total = totalFromContentRange(probe.headers.get('content-range')) ?? declaredLength
    if (total === null) {
      throw new ViewerError(
        'remote-cors',
        `${host} serves ranges for ${url} but does not expose its size to this page: ` +
          'neither `Content-Length` nor `Content-Range` was readable. Add both to the ' +
          "bucket's CORS `Access-Control-Expose-Headers`.",
        { url, host },
      )
    }
    return new RemoteRangeSource(url, total, options, cost)
  }

  /**
   * Create the lazy FS node and return its path.
   *
   * The node carries a `contents` object with a `length` and our own `read`
   * stream op, mirroring what `FS.createLazyFile` builds; `usedBytes` has to be
   * a getter over `contents.length` or MEMFS's `getattr` reports a zero-length
   * file and HDF5 refuses to open it.
   */
  async mount(): Promise<string> {
    if (this.mountPath !== null) return this.mountPath
    if (typeof XMLHttpRequest === 'undefined') {
      throw new ViewerError(
        'remote-cors',
        'remote files are read with synchronous XMLHttpRequest, which exists only in a ' +
          'browser worker; this runtime has none.',
        { url: this.url },
      )
    }
    const h5 = await getH5()
    const leaf = `remote-${Math.abs(hash(this.url)).toString(36)}`
    const node: H5FSNode = h5.FS.createFile('/', leaf, {}, true, false)
    const contents = { length: this.size }
    node.contents = contents
    Object.defineProperty(node, 'usedBytes', { get: () => contents.length })

    const inherited = node.stream_ops
    // Copy: MEMFS shares one stream_ops object across every file it created.
    node.stream_ops = {
      ...inherited,
      read: (
        _stream: unknown,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): number => {
        if (position >= this.size) return 0
        const n = Math.min(this.size - position, length)
        this.copyInto(buffer, offset, position, n)
        return n
      },
      mmap: (
        _stream: unknown,
        length: number,
        position: number,
      ): { ptr: number; allocated: boolean } => {
        const ptr = h5.Module._malloc(length)
        if (ptr === 0) throw new Error('mmap allocation failed')
        const n = Math.max(0, Math.min(this.size - position, length))
        if (n > 0) this.copyInto(h5.Module.HEAPU8, ptr, position, n)
        return { ptr, allocated: true }
      },
    }
    this.mountPath = `/${leaf}`
    return this.mountPath
  }

  close(): void {
    this.cache.clear()
    this.cachedBytes = 0
    if (this.mountPath === null) return
    const path = this.mountPath
    this.mountPath = null
    void getH5().then(
      (h5) => {
        try {
          h5.FS.unlink(path)
        } catch {
          // Nothing to do: the FS may already be gone with the worker.
        }
      },
      () => undefined,
    )
  }

  /** Requests issued and bytes received, including the open-time probe. */
  stats(): SourceStats {
    return { requests: this.requests, bytes: this.bytesRead }
  }

  /** Zero the counters, so a budget test can measure one view change. */
  resetStats(): void {
    this.requests = 0
    this.bytesRead = 0
  }

  /** Chunks currently retained — a cache-behaviour assertion for tests. */
  cachedChunkCount(): number {
    return this.cache.size
  }

  /**
   * Read `[position, position + length)` of the remote file.
   *
   * This is the byte accessor {@link mount}'s stream op is built on, exposed
   * because the chunk cache is the part with the interesting behaviour —
   * coalescing and eviction — and it should be assertable without standing up
   * an Emscripten FS.
   */
  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    const out = new Uint8Array(n)
    if (n > 0) this.copyInto(out, 0, position, n)
    return out
  }

  /**
   * Copy `length` bytes starting at `position` into `buffer` at `offset`,
   * fetching whatever is missing.
   *
   * Contiguous missing chunks are fetched in **one** range request. That
   * coalescing is what keeps a bounded pixel slice inside the §12 budget of
   * five requests: without it, a 4 MB slice at 1 MiB chunks would be four.
   *
   * Bytes are copied straight out of the response and only *then* offered to
   * the cache. Doing it the other way round — fill the cache, read it back —
   * looks tidier and is wrong: a read spanning more chunks than the cache
   * holds evicts its own earlier chunks before it gets to them.
   */
  private copyInto(buffer: Uint8Array, offset: number, position: number, length: number): void {
    let done = 0
    while (done < length) {
      const at = position + done
      const index = Math.floor(at / this.chunkSize)
      const cached = this.cache.get(index)
      if (cached) {
        this.touch(index)
        done += blit(buffer, offset + done, cached, at - index * this.chunkSize, length - done)
        continue
      }

      const last = Math.floor((position + length - 1) / this.chunkSize)
      let end = index
      while (end + 1 <= last && !this.cache.has(end + 1)) end += 1
      const from = index * this.chunkSize
      const to = Math.min((end + 1) * this.chunkSize, this.size) - 1
      const fetched = this.fetchRange(from, to)

      done += blit(buffer, offset + done, fetched, at - from, length - done)
      for (let i = index; i <= end; i++) {
        const start = i * this.chunkSize - from
        if (start >= fetched.length) break
        this.store(i, fetched.subarray(start, Math.min(start + this.chunkSize, fetched.length)))
      }
    }
  }

  private fetchRange(from: number, to: number): Uint8Array {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', this.url, false)
    xhr.setRequestHeader('Range', `bytes=${from}-${to}`)
    // Allowed on a synchronous request only inside a worker; the guard in
    // mount() is what makes this reachable.
    xhr.responseType = 'arraybuffer'
    xhr.send(null)
    this.requests += 1
    if (xhr.status !== 206 && xhr.status !== 200) {
      throw new ViewerError(
        'remote-no-ranges',
        `${hostOf(this.url)} returned ${xhr.status} for bytes ${from}-${to} of ${this.url}`,
        { url: this.url, status: xhr.status, from, to },
      )
    }
    const body = new Uint8Array((xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0))
    this.bytesRead += body.byteLength
    return this.windowOf(body, from, to, xhr.getResponseHeader('content-range'))
  }

  /**
   * Reduce a response body to exactly the window that was asked for.
   *
   * A host can ignore `Range` in two ways. The obvious one is a 200 with the
   * whole object. The dangerous one is a **206** whose `Content-Range` covers
   * the whole object — vite's own dev server does this, as do several CDNs.
   * The status says "partial" and the first chunk is genuinely correct, so
   * nothing looks wrong until a later read returns bytes from the *start* of
   * the file while the caller believes they came from `from`. HDF5 then reads
   * structure out of noise and fails hundreds of lines away, as a missing
   * column or an unreadable attribute, with nothing pointing back here.
   *
   * `Content-Range` is believed when it is present, since it is the server's
   * own statement of what it sent. Without it, a body longer than the window
   * can only mean the whole object, which starts at zero.
   */
  private windowOf(
    body: Uint8Array,
    from: number,
    to: number,
    contentRange: string | null,
  ): Uint8Array {
    const wanted = to - from + 1
    const start = rangeStart(contentRange)
    const skip = start === null ? (body.byteLength > wanted ? from : 0) : from - start
    if (skip === 0 && body.byteLength <= wanted) return body
    if (skip < 0 || skip >= body.byteLength) {
      throw new ViewerError(
        'remote-no-ranges',
        `${hostOf(this.url)} answered a request for bytes ${from}-${to} of ${this.url} with ` +
          `${body.byteLength} bytes starting at ${start ?? 'an unstated offset'}, which does ` +
          'not contain what was asked for.',
        { url: this.url, from, to, start, length: body.byteLength },
      )
    }
    return body.subarray(skip, Math.min(skip + wanted, body.byteLength))
  }

  private store(index: number, chunk: Uint8Array): void {
    // Copy out of the response buffer so the (much larger) response can be
    // collected once its useful window has been cached.
    const owned = new Uint8Array(chunk)
    this.cache.set(index, owned)
    this.cachedBytes += owned.byteLength
    for (const key of this.cache.keys()) {
      if (this.cachedBytes <= this.maxCacheBytes) break
      if (key === index) continue // never evict what was just stored
      const evicted = this.cache.get(key)
      if (evicted) this.cachedBytes -= evicted.byteLength
      this.cache.delete(key)
    }
  }

  /** Mark a cached chunk most-recently-used, by reinserting it at the back. */
  private touch(index: number): void {
    const chunk = this.cache.get(index)
    if (!chunk) return
    this.cache.delete(index)
    this.cache.set(index, chunk)
  }
}

/**
 * Copy at most `limit` bytes of `source` from `at` into `target` at `into`,
 * returning how many were written.
 *
 * A short response would otherwise leave the caller's loop unable to advance,
 * so an empty copy is reported as a truncated read rather than spun on.
 */
function blit(
  target: Uint8Array,
  into: number,
  source: Uint8Array,
  at: number,
  limit: number,
): number {
  const n = Math.min(source.length - at, limit)
  if (n <= 0) {
    throw new ViewerError('remote-no-ranges', 'a range request returned a short response', {
      wanted: limit,
      available: source.length - at,
    })
  }
  target.set(source.subarray(at, at + n), into)
  return n
}

/**
 * Turn an opaque `fetch` rejection into a refusal that names the host and says
 * which of the two things went wrong.
 *
 * Both carry the code `remote-cors`, because that is the only code the shared
 * {@link ErrorCode} union has for a request that never produced a response;
 * `detail.reachable` is what a caller switches on to tell them apart without
 * matching on prose.
 */
async function failCrossOrigin(
  url: string,
  host: string,
  cause: unknown,
  doFetch: typeof fetch,
  cost: SourceStats,
): Promise<never> {
  let reachable = false
  try {
    cost.requests += 1
    await doFetch(url, { method: 'GET', mode: 'no-cors', headers: { Range: 'bytes=0-0' } })
    reachable = true
  } catch {
    reachable = false
  }
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  if (reachable) {
    throw new ViewerError(
      'remote-cors',
      `${host} is reachable but refused a cross-origin read of ${url} (${detail}). ` +
        'That is what a missing `Access-Control-Allow-Origin` looks like from a browser: ' +
        'the failure has no status and no headers. Configure the bucket to allow GET and ' +
        'HEAD and the `Range` request header, and to expose `Content-Length` and ' +
        '`Content-Range`.',
      { url, host, cause: detail, reachable: true },
    )
  }
  throw new ViewerError(
    'remote-cors',
    `${host} could not be reached for ${url} (${detail}). The request failed before any ` +
      'response arrived, so this is a DNS, TLS or connectivity problem rather than a ' +
      'CORS one.',
    { url, host, cause: detail, reachable: false },
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function numberHeader(response: Response | null, name: string): number | null {
  const raw = response?.headers.get(name)
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** `bytes 128-255/26520008` → `128`; `null` when the header is absent or odd. */
function rangeStart(header: string | null): number | null {
  if (!header) return null
  const match = /bytes\s+(\d+)-/.exec(header)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** `bytes 0-0/26520008` → `26520008`. */
function totalFromContentRange(header: string | null): number | null {
  if (!header) return null
  const match = /\/\s*(\d+)\s*$/.exec(header)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return h
}
