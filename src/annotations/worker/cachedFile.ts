/**
 * A remote file handle that reads in chunks and keeps them.
 *
 * ## Why
 *
 * `generic-filehandle2`'s `RemoteFile` turns every `read` into one ranged
 * request, and the readers behind it read the way a library reads: a bigWig's
 * header is four requests of 64, 2,000, 32 and 292 bytes, and the file is
 * opened three times on the way to a browser — once to ask what genome it is
 * on, once to load it as a track, once per window after that. Over a bucket
 * next door that is a few tens of milliseconds a request and nobody notices;
 * over the Drive API, where a request is the better part of a second and is
 * metered, it is the difference between a file that opens and one a reader
 * gives up on (§24.9).
 *
 * So this handle reads whole chunks and keeps them, exactly as the main
 * thread's `RemoteRangeSource` does for a contact map and for the same reason:
 * the small reads a parser makes land in one chunk, and the second and third
 * open of the same file read nothing at all. One handle per address, held by
 * `annotations.worker.ts`, is what makes the three opens one.
 *
 * ## What it does not do
 *
 * `readFile` is left to the base class: a whole-file download is already one
 * request, and the bytes it hands back are the caller's to keep. And a read
 * past the end is not an error — the base class answers a short read for a
 * range that runs off the file, and that short answer is how the size is
 * learnt here without a `HEAD`.
 */

import { RemoteFile } from 'generic-filehandle2'

/** 256 KiB: a bigWig's header, chromosome tree and zoom headers in one, and still small on a slow link. */
export const CHUNK_BYTES = 1 << 18

/** Chunks kept per handle. 64 MiB, the bound `RemoteRangeSource` keeps too. */
const BUDGET_BYTES = 64 << 20

type Options = ConstructorParameters<typeof RemoteFile>[1]

export class CachedRemoteFile extends RemoteFile {
  /** Cached chunks by index, insertion-ordered so the oldest is first to go. */
  private readonly chunks = new Map<number, Uint8Array>()
  /** Fetches in flight, by every chunk index each covers, so a second reader joins rather than repeats. */
  private readonly inflight = new Map<number, Promise<void>>()
  private held = 0
  /** The file's length, once a read has run off its end. */
  private end: number | null = null

  constructor(
    url: string,
    options?: Options,
    private readonly chunkBytes = CHUNK_BYTES,
    private readonly budgetBytes = BUDGET_BYTES,
  ) {
    super(url, options)
  }

  /** Bytes read from the host so far, for a test to count. */
  fetched = 0
  /** Requests made to the host so far, for a test to count. */
  requests = 0

  override async read(length: number, position: number, opts?: Parameters<RemoteFile['read']>[2]): Promise<Uint8Array<ArrayBuffer>> {
    if (length <= 0 || (this.end !== null && position >= this.end)) return new Uint8Array(0)
    const first = Math.floor(position / this.chunkBytes)
    const last = Math.floor((position + length - 1) / this.chunkBytes)

    // Missing chunks, in runs, so a read spanning many is one request rather
    // than one per chunk — and chunks another read is already fetching are
    // waited for rather than fetched twice.
    const waits: Promise<void>[] = []
    let runFrom: number | null = null
    const runs: Array<[number, number]> = []
    for (let index = first; index <= last; index++) {
      const pending = this.inflight.get(index)
      if (this.chunks.has(index) || pending !== undefined) {
        if (pending !== undefined && !waits.includes(pending)) waits.push(pending)
        if (runFrom !== null) runs.push([runFrom, index - 1])
        runFrom = null
        continue
      }
      if (runFrom === null) runFrom = index
    }
    if (runFrom !== null) runs.push([runFrom, last])
    for (const [from, to] of runs) {
      const promise = this.fetchRun(from, to, opts)
      for (let index = from; index <= to; index++) this.inflight.set(index, promise)
      const done = (): void => {
        for (let index = from; index <= to; index++) {
          if (this.inflight.get(index) === promise) this.inflight.delete(index)
        }
      }
      promise.then(done, done)
      waits.push(promise)
    }
    await Promise.all(waits)

    const out = new Uint8Array(length)
    let filled = 0
    for (let index = first; index <= last; index++) {
      const chunk = this.chunks.get(index)
      if (chunk === undefined) break
      this.touch(index, chunk)
      const chunkStart = index * this.chunkBytes
      const from = Math.max(position, chunkStart) - chunkStart
      const to = Math.min(position + length, chunkStart + chunk.length) - chunkStart
      if (to <= from) break
      out.set(chunk.subarray(from, to), Math.max(position, chunkStart) - position)
      filled = Math.max(position, chunkStart) - position + (to - from)
      // A chunk shorter than the chunk size is the file's last, and the
      // caller's range ends with it.
      if (chunk.length < this.chunkBytes) break
    }
    return filled === length ? out : out.subarray(0, filled) as Uint8Array<ArrayBuffer>
  }

  private async fetchRun(from: number, to: number, opts?: Parameters<RemoteFile['read']>[2]): Promise<void> {
    const start = from * this.chunkBytes
    let want = (to - from + 1) * this.chunkBytes
    if (this.end !== null) want = Math.min(want, Math.max(0, this.end - start))
    if (want <= 0) return
    this.requests += 1
    const bytes = await super.read(want, start, opts)
    this.fetched += bytes.length
    if (bytes.length < want) this.end = start + bytes.length
    for (let index = from; index <= to; index++) {
      const at = (index - from) * this.chunkBytes
      if (at >= bytes.length) break
      // Copied, not sliced: `super.read` may hand back a view over a buffer it
      // reuses, and a kept chunk has to be its own bytes.
      this.store(index, bytes.slice(at, Math.min(at + this.chunkBytes, bytes.length)))
    }
  }

  private store(index: number, chunk: Uint8Array): void {
    const previous = this.chunks.get(index)
    if (previous !== undefined) this.held -= previous.length
    this.chunks.set(index, chunk)
    this.held += chunk.length
    while (this.held > this.budgetBytes && this.chunks.size > 1) {
      const oldest = this.chunks.keys().next().value as number
      const dropped = this.chunks.get(oldest) as Uint8Array
      this.chunks.delete(oldest)
      this.held -= dropped.length
    }
  }

  /** Mark a chunk most recently used, by reinserting it at the back. */
  private touch(index: number, chunk: Uint8Array): void {
    this.chunks.delete(index)
    this.chunks.set(index, chunk)
  }
}
