/**
 * A local file as a {@link ByteSource} — the private path (spec §11).
 *
 * Nothing here leaves the machine. A file dropped on the page is mounted into
 * the Emscripten FS and opened from there; nothing is uploaded, which is what
 * makes "no accounts, no storage, no GDPR review" a property of the code rather
 * than a promise in the UI.
 *
 * Three inputs are supported because the same class has to serve a browser and
 * the Node test suite:
 *
 * | input | mount |
 * |---|---|
 * | `File` / `Blob` in a worker | **lazy** FS node, slices read on demand |
 * | `Uint8Array` / `ArrayBuffer` | bytes copied into the FS |
 * | filesystem path (Node only) | used as-is |
 *
 * The path case costs nothing: `h5wasm/node` is built with NODERAWFS, so its
 * `FS` *is* the real filesystem and HDF5 reads the file in place. That is why
 * the 26 MB reference file can be opened in a unit test without a 26 MB copy.
 *
 * The `Blob` case now costs nothing either, and for the same reason: a
 * `FileReaderSync` over `blob.slice()` behind a bounded LRU is exactly what
 * `RemoteRangeSource` does with range requests, so a dropped file is read a
 * slice at a time instead of entirely, twice, before the first byte is parsed.
 * The fallback below it is for a runtime with no `FileReaderSync` — the main
 * thread, and the Node tests, neither of which is where the app does I/O.
 */

import type { ByteSource, SourceStats } from '../types'
import { ViewerError } from '../errors'
import type { H5FSNode, H5Module } from '../h5/bootstrap'
import { getH5, isNodeRuntime } from '../h5/bootstrap'

/** Bytes per cached slice. Matches the remote source's, for the same reasons. */
const LOCAL_CHUNK_SIZE = 1 << 20

/** Upper bound on retained slice bytes; least-recently-used are dropped. */
const LOCAL_CACHE_BYTES = 64 << 20

/** Anything {@link LocalFileSource} knows how to mount. */
export type LocalFileInput = Blob | Uint8Array | ArrayBuffer | ArrayBufferView | string

/**
 * A file already on disk, with its size resolved. Produced by
 * {@link LocalFileSource.fromPath}; the constructor accepts it so that the
 * path case shares one code path with the in-memory cases, without forcing
 * every caller through an async factory.
 */
export interface LocalPathRef {
  readonly path: string
  readonly size: number
}

export interface LocalFileOptions {
  /** Overrides the name used for the mount point and for `id`. */
  name?: string
  /**
   * Directory the temporary copy is written to when the input is in-memory and
   * we are running under Node. Defaults to `$TMPDIR` (then `/tmp`). Ignored in
   * the browser, where MEMFS has no such notion.
   */
  tempDir?: string
}

let counter = 0

export class LocalFileSource implements ByteSource {
  readonly id: string
  readonly size: number

  private readonly bytes: Uint8Array | null
  private readonly blob: Blob | null
  private readonly existingPath: string | null
  private readonly tempDir: string | undefined
  private mountPath: string | null = null
  private ownsMount = false
  private requests = 0
  private bytesRead = 0
  /** Slice cache for the lazy mount; insertion-ordered, so first key is LRU. */
  private readonly cache = new Map<number, Uint8Array>()
  private cachedBytes = 0
  private syncReader: FileReaderSync | null = null
  /** Resolved at mount, so {@link readBytes} has an FS to read a path through. */
  private module: H5Module | null = null

  /**
   * Wrap a `File`, a `Blob`, raw bytes, or a {@link LocalPathRef}.
   *
   * Synchronous, because `size` is knowable without I/O for every one of those
   * — and a `ByteSource` must report its size before `mount()`. Bytes are not
   * touched here: a `Blob` is only read when {@link mount} is called, so
   * constructing one is free.
   *
   * A bare filesystem path is *not* accepted, because its size cannot be
   * learnt synchronously; use {@link LocalFileSource.fromPath}.
   */
  constructor(
    input: Blob | Uint8Array | ArrayBuffer | ArrayBufferView | LocalPathRef,
    options: LocalFileOptions = {},
  ) {
    this.tempDir = options.tempDir
    this.bytes = null
    this.blob = null
    this.existingPath = null

    if (isBlob(input)) {
      const named = typeof File !== 'undefined' && input instanceof File ? input.name : null
      this.blob = input
      this.size = input.size
      this.id = options.name ?? named ?? `blob-${nextId()}`
      return
    }
    if (isPathRef(input)) {
      this.existingPath = input.path
      this.size = input.size
      this.id = options.name ?? input.path
      return
    }
    const bytes = asUint8Array(input)
    this.bytes = bytes
    this.size = bytes.byteLength
    this.id = options.name ?? `bytes-${nextId()}`
  }

  /**
   * Wrap a file already on disk. Node only.
   *
   * Async because the size is read through h5wasm's `FS.stat` rather than
   * `node:fs` — that keeps this module free of Node built-in imports, which is
   * what lets it be bundled for the browser unchanged.
   */
  static async fromPath(path: string, options: LocalFileOptions = {}): Promise<LocalFileSource> {
    if (!isNodeRuntime()) {
      throw new ViewerError(
        'bad-uri',
        `cannot open the filesystem path ${path} in a browser; pass the File object instead`,
        { path },
      )
    }
    const h5 = await getH5()
    let size: number
    try {
      size = h5.FS.stat(path).size
    } catch (cause) {
      throw new ViewerError(
        'not-hdf5',
        `cannot stat ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { path },
      )
    }
    return new LocalFileSource({ path, size }, { name: options.name ?? path, ...options })
  }

  /** Dispatch on whatever the caller has. */
  static async open(
    input: LocalFileInput,
    options: LocalFileOptions = {},
  ): Promise<LocalFileSource> {
    if (typeof input === 'string') return LocalFileSource.fromPath(input, options)
    return new LocalFileSource(input, options)
  }

  async mount(): Promise<string> {
    if (this.mountPath !== null) return this.mountPath
    const h5 = await getH5()
    this.module = h5

    if (this.existingPath !== null) {
      // NODERAWFS: the file is already visible to HDF5 where it lies. No copy,
      // no request, nothing to clean up.
      this.mountPath = this.existingPath
      this.ownsMount = false
      return this.mountPath
    }

    // A `Blob` in a worker is read *lazily*, a slice at a time.
    //
    // Reading it whole put the file in memory twice — once as the ArrayBuffer
    // and once as the MEMFS copy — before a single byte of HDF5 was parsed, so
    // opening a 5 GB file to look at one 2 Mb region cost 5 GB of reading and up
    // to 10 GB of heap, and a large enough file could not be opened at all. The
    // remote path has never done that: it mounts an FS node whose `read` fetches
    // on demand behind an LRU. `FileReaderSync` is the same shape for a local
    // file — synchronous, worker-only, which is where all I/O already lives — so
    // the two sources differ in their byte accessor and in nothing else, and a
    // local file is now bounded by its *reads* rather than by its size.
    if (this.blob !== null && typeof FileReaderSync !== 'undefined') {
      this.mountPath = this.mountLazy(h5, this.blob)
      this.ownsMount = true
      return this.mountPath
    }

    const bytes = this.bytes ?? new Uint8Array(await (this.blob as Blob).arrayBuffer())
    const target = this.mountTarget()
    h5.FS.writeFile(target, bytes)
    this.mountPath = target
    this.ownsMount = true
    this.requests += 1
    this.bytesRead += bytes.byteLength
    return target
  }

  /**
   * Create the lazy FS node, mirroring `RemoteRangeSource.mount`.
   *
   * `usedBytes` has to be a getter over `contents.length` or MEMFS's `getattr`
   * reports a zero-length file and HDF5 refuses to open it; `stream_ops` is
   * copied rather than mutated because MEMFS shares one object across every file
   * it created.
   */
  private mountLazy(h5: H5Module, blob: Blob): string {
    const leaf = this.mountTarget().replace(/^\//, '')
    const node: H5FSNode = h5.FS.createFile('/', leaf, {}, true, false)
    const contents = { length: this.size }
    node.contents = contents
    Object.defineProperty(node, 'usedBytes', { get: () => contents.length })
    node.stream_ops = {
      ...node.stream_ops,
      read: (
        _stream: unknown,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): number => {
        if (position >= this.size) return 0
        const n = Math.min(this.size - position, length)
        this.copyInto(blob, buffer, offset, position, n)
        return n
      },
      mmap: (_stream: unknown, length: number, position: number): { ptr: number; allocated: boolean } => {
        const ptr = h5.Module._malloc(length)
        if (ptr === 0) throw new Error('mmap allocation failed')
        const n = Math.max(0, Math.min(this.size - position, length))
        if (n > 0) this.copyInto(blob, h5.Module.HEAPU8, ptr, position, n)
        return { ptr, allocated: true }
      },
    }
    return `/${leaf}`
  }

  /**
   * Read `[position, position + length)`, whatever this source is backed by.
   *
   * The three cases are the three constructor inputs, and each takes the
   * cheapest route it has: in-memory bytes are a `subarray` copy, a `Blob` goes
   * through the same slice cache the lazy mount uses — so a `.hic`'s block
   * index and the blocks beside it are paid for once — and a path is read
   * through the Emscripten FS, which under NODERAWFS is a real bounded read.
   *
   * The path case needs {@link mount} to have been called, because that is
   * where the module is resolved and there is nowhere in a synchronous method
   * to await it. Every caller mounts first; the throw is for the one that
   * forgets, and says so rather than returning zeroes.
   */
  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    if (n <= 0) return new Uint8Array(0)
    if (this.bytes !== null) {
      return this.bytes.subarray(position, position + n).slice()
    }
    if (this.blob !== null) {
      const out = new Uint8Array(n)
      this.copyInto(this.blob, out, 0, position, n)
      return out
    }
    const h5 = this.module
    if (this.existingPath === null || h5 === null) {
      throw new ViewerError(
        'unsupported',
        `${this.id} cannot be read directly before it has been mounted.`,
        { id: this.id },
      )
    }
    const out = new Uint8Array(n)
    const stream = h5.FS.open(this.existingPath, 'r')
    try {
      let done = 0
      while (done < n) {
        const got = h5.FS.read(stream, out, done, n - done, position + done)
        if (got <= 0) break
        done += got
      }
      this.requests += 1
      this.bytesRead += done
      return done === n ? out : out.subarray(0, done)
    } finally {
      h5.FS.close(stream)
    }
  }

  /**
   * Copy `length` bytes at `position` out of the blob, through a chunk cache.
   *
   * The same bounded LRU the remote source uses, for the same reason: HDF5's
   * metadata walk reads a few dozen bytes at a time from a handful of places,
   * and a `FileReaderSync` call per read would be thousands of them.
   */
  private copyInto(
    blob: Blob,
    buffer: Uint8Array,
    offset: number,
    position: number,
    length: number,
  ): void {
    let done = 0
    while (done < length) {
      const at = position + done
      const index = Math.floor(at / LOCAL_CHUNK_SIZE)
      let chunk = this.cache.get(index)
      if (chunk === undefined) {
        const from = index * LOCAL_CHUNK_SIZE
        const to = Math.min(from + LOCAL_CHUNK_SIZE, this.size)
        chunk = new Uint8Array(this.reader().readAsArrayBuffer(blob.slice(from, to)))
        this.store(index, chunk)
        this.requests += 1
        this.bytesRead += chunk.byteLength
      } else {
        // Reinsert at the back: `Map` keeps insertion order, so the first key
        // is the least recently used.
        this.cache.delete(index)
        this.cache.set(index, chunk)
      }
      const start = at - index * LOCAL_CHUNK_SIZE
      const n = Math.min(chunk.length - start, length - done)
      if (n <= 0) throw new Error(`short read of ${this.id} at ${at}`)
      buffer.set(chunk.subarray(start, start + n), offset + done)
      done += n
    }
  }

  private store(index: number, chunk: Uint8Array): void {
    this.cache.set(index, chunk)
    this.cachedBytes += chunk.byteLength
    for (const key of this.cache.keys()) {
      if (this.cachedBytes <= LOCAL_CACHE_BYTES) break
      if (key === index) continue
      const evicted = this.cache.get(key)
      if (evicted) this.cachedBytes -= evicted.byteLength
      this.cache.delete(key)
    }
  }

  private reader(): FileReaderSync {
    this.syncReader ??= new FileReaderSync()
    return this.syncReader
  }

  close(): void {
    this.cache.clear()
    this.cachedBytes = 0
    if (this.mountPath === null) return
    const path = this.mountPath
    this.mountPath = null
    if (!this.ownsMount) return
    this.ownsMount = false
    void getH5().then(
      (h5) => {
        try {
          h5.FS.unlink(path)
        } catch {
          // Already gone, or the FS was torn down with the worker. Either way
          // there is nothing a viewer can do about it and nothing to report.
        }
      },
      () => undefined,
    )
  }

  /**
   * Bytes materialised and copies made.
   *
   * There is no network here, so `requests` counts FS materialisations: `0` for
   * a path mount, `1` once an in-memory source has been written. The §12
   * budget tests read this to prove that opening a local file costs no
   * requests at all.
   */
  stats(): SourceStats {
    return { requests: this.requests, bytes: this.bytesRead }
  }

  /** Slices currently retained — a cache-behaviour assertion for tests. */
  cachedChunkCount(): number {
    return this.cache.size
  }

  /** Zero the counters, so a budget test can measure one operation. */
  resetStats(): void {
    this.requests = 0
    this.bytesRead = 0
  }

  private mountTarget(): string {
    const safe = this.id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-100)
    const leaf = `metacooler-viewer-${nextId()}-${safe}`
    if (!isNodeRuntime()) return `/${leaf}`
    // Under NODERAWFS a "mount" is a real file, so it needs a real writable
    // directory; MEMFS's root does not exist on the host filesystem.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env
    const dir = this.tempDir ?? env?.TMPDIR ?? env?.TMP ?? env?.TEMP ?? '/tmp'
    return `${dir.replace(/\/+$/, '')}/${leaf}`
  }
}

function nextId(): string {
  counter += 1
  return `${Date.now().toString(36)}${counter.toString(36)}`
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function isPathRef(value: unknown): value is LocalPathRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LocalPathRef).path === 'string' &&
    typeof (value as LocalPathRef).size === 'number'
  )
}

function asUint8Array(data: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
