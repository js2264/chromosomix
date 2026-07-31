/**
 * A local file as a {@link ByteSource} — the private path (spec §11).
 *
 * Nothing here leaves the machine. A file dropped on the page is read into the
 * Emscripten MEMFS and opened from there; nothing is uploaded, which is what
 * makes "no accounts, no storage, no GDPR review" a property of the code rather
 * than a promise in the UI.
 *
 * Three inputs are supported because the same class has to serve a browser and
 * the Node test suite:
 *
 * | input | mount |
 * |---|---|
 * | `File` / `Blob` | bytes copied into the FS |
 * | `Uint8Array` / `ArrayBuffer` | bytes copied into the FS |
 * | filesystem path (Node only) | used as-is |
 *
 * The path case costs nothing: `h5wasm/node` is built with NODERAWFS, so its
 * `FS` *is* the real filesystem and HDF5 reads the file in place. That is why
 * the 26 MB reference file can be opened in a unit test without a 26 MB copy.
 */

import type { ByteSource, SourceStats } from '../types'
import { ViewerError } from '../errors'
import { getH5, isNodeRuntime } from '../h5/bootstrap'

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

    if (this.existingPath !== null) {
      // NODERAWFS: the file is already visible to HDF5 where it lies. No copy,
      // no request, nothing to clean up.
      this.mountPath = this.existingPath
      this.ownsMount = false
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

  close(): void {
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
