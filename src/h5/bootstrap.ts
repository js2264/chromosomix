/**
 * h5wasm initialisation — the single place the WebAssembly runtime is loaded.
 *
 * Two things make this file more than a one-liner:
 *
 * 1. **Two entry points.** `h5wasm/node` is compiled with NODERAWFS (its
 *    `FS` is the real filesystem, so `new File('/abs/path','r')` just works),
 *    while `h5wasm` is the browser build over MEMFS. They are not
 *    interchangeable, so the runtime is *detected*, never assumed.
 * 2. **One instance per process/worker.** The module keeps `Module`/`FS` in
 *    module-level `var`s that are assigned when its own `ready` promise
 *    settles, so importing it twice is fine but awaiting it once and caching
 *    the result is what keeps `mount()` cheap.
 *
 * The `.wasm` needs no asset URL: h5wasm 0.10.x ships a single-file Emscripten
 * build with the binary inlined in `hdf5_util.js` (`findWasmBinary()` decodes a
 * string literal — there is no `.wasm` file in the package at all). Nothing here
 * has to locate, copy or configure one, in either environment.
 */

import type {
  Dataset as H5wasmDataset,
  Entity as H5wasmEntity,
  File as H5wasmFile,
  Group as H5wasmGroup,
  Metadata,
} from 'h5wasm'

import { ViewerError } from '../errors'

export type { H5wasmDataset, H5wasmEntity, H5wasmFile, H5wasmGroup, Metadata }

/**
 * The Emscripten runtime members this repo reaches for directly.
 *
 * h5wasm's own high-level `Dataset.slice()` is not always usable: it decodes
 * fixed-length string data with `TextDecoder('ascii')` whenever the datatype
 * carries the ASCII character set, which is exactly what h5py writes for a
 * numpy `S<n>` column. metacooler stores UTF-8 *bytes* in those columns
 * (`_str_to_hdf5` sizes them by encoded byte length), so a name like `café`
 * comes back as `cafÃ©`. Reading the raw bytes through `get_dataset_data` and
 * decoding them here is the only correct path (spec §6.2).
 *
 * Declared structurally rather than imported: h5wasm does not re-export its
 * `H5Module` type, and pinning ourselves to only the members we use makes an
 * upstream signature change a compile error in one file.
 */
export interface H5Runtime {
  _malloc(size: number): number
  _free(ptr: number): void
  readonly HEAPU8: Uint8Array
  readonly HEAP8: Int8Array
  readonly MAXIMUM_MEMORY: number
  UTF8ToString(ptr: number): string
  readonly H5T_class_t: {
    readonly H5T_INTEGER: { value: number }
    readonly H5T_FLOAT: { value: number }
    readonly H5T_STRING: { value: number }
    readonly H5T_ENUM: { value: number }
  }
  get_dataset_data(
    file_id: bigint,
    path: string,
    count: bigint[] | null,
    offset: bigint[] | null,
    strides: bigint[] | null,
    rdata_ptr: bigint,
  ): number
  get_attribute_metadata(loc_id: bigint, obj_name: string, attr_name: string): Metadata
  get_attribute_data(file_id: bigint, obj_name: string, attr_name: string, ptr: bigint): number
  reclaim_vlen_memory_count(
    file_id: bigint,
    obj_name: string,
    attr_name: string,
    ptr: bigint,
    count: bigint[],
  ): number
}

/** An Emscripten FS node, as far as the lazy remote file needs to see one. */
export interface H5FSNode {
  contents: unknown
  stream_ops: Record<string, unknown>
  url?: string
}

/**
 * The Emscripten filesystem members used to mount a byte source.
 *
 * Under `h5wasm/node` these are NODERAWFS shims over the real filesystem, so
 * `writeFile` creates a real file and `unlink` removes it; under the browser
 * build they operate on MEMFS. Both {@link ByteSource} implementations are
 * written against this one shape.
 */
export interface H5FileSystem {
  writeFile(path: string, data: Uint8Array): void
  unlink(path: string): void
  stat(path: string): { size: number }
  analyzePath(path: string): { exists: boolean }
  mkdirTree(path: string): void
  createFile(
    parent: string,
    name: string,
    properties: Record<string, unknown>,
    canRead: boolean,
    canWrite: boolean,
  ): H5FSNode
  /**
   * The three stream ops, for reading a *bounded* slice of a mounted file.
   *
   * Present so `LocalFileSource.readBytes` can serve a path-backed source
   * without loading it: under NODERAWFS these are real `pread`s, so a `.hic`
   * on disk is read a block at a time by the CLI exactly as it is in a tab.
   * `readFile` would be the obvious call and is the wrong one — it returns the
   * whole file, which is precisely the cost the block index exists to avoid.
   */
  open(path: string, flags: string): H5FSStream
  read(
    stream: H5FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number
  close(stream: H5FSStream): void
}

/** An open Emscripten FS stream. Opaque; only {@link H5FileSystem} touches it. */
export interface H5FSStream {
  readonly fd?: number
}

/**
 * The h5wasm module namespace, narrowed to what this repo uses.
 *
 * `Group` and `Dataset` are carried so call sites can narrow an `Entity` with
 * `instanceof`: h5wasm's `OBJECT_TYPE` string enum is not exported, so
 * `entity.type === 'Group'` does not type-check.
 */
export interface H5Module {
  readonly File: typeof H5wasmFile
  readonly Group: typeof H5wasmGroup
  readonly Dataset: typeof H5wasmDataset
  readonly FS: H5FileSystem
  readonly Module: H5Runtime
}

/** Shape of the raw h5wasm namespace before it is narrowed to {@link H5Module}. */
interface RawH5wasmNamespace {
  ready: Promise<unknown>
  File: typeof H5wasmFile
  Group: typeof H5wasmGroup
  Dataset: typeof H5wasmDataset
  FS: unknown
  Module: unknown
}

let cached: Promise<H5Module> | null = null

/**
 * `true` when running under Node (including vitest), `false` in a browser or
 * worker.
 *
 * The `window` test comes second on purpose: an Electron renderer has both
 * `process` and `window` and must take the browser branch, because its DOM
 * globals — not its Node globals — are what h5wasm's browser build expects.
 */
export function isNodeRuntime(): boolean {
  const g = globalThis as { process?: { versions?: { node?: string } }; window?: unknown }
  if (typeof g.window !== 'undefined') return false
  return typeof g.process !== 'undefined' && g.process?.versions?.node != null
}

/**
 * Load and initialise h5wasm, once per process or worker.
 *
 * The Node specifier is held in a variable so a bundler cannot statically
 * follow it into a browser build (the Node build imports `fs` and `path`); the
 * browser specifier stays a literal so it *is* bundled. That asymmetry is
 * deliberate — swapping either form breaks one of the two targets.
 */
export function getH5(): Promise<H5Module> {
  if (cached) return cached
  cached = load().catch((cause: unknown) => {
    // Do not memoise a failure: a transient wasm-instantiation error should not
    // poison every later open for the lifetime of the worker.
    cached = null
    throw new ViewerError(
      'not-hdf5',
      `Could not initialise the HDF5 (h5wasm) runtime: ${describe(cause)}`,
      { runtime: isNodeRuntime() ? 'node' : 'browser' },
    )
  })
  return cached
}

async function load(): Promise<H5Module> {
  let ns: RawH5wasmNamespace
  if (isNodeRuntime()) {
    const nodeEntry = 'h5wasm/node'
    ns = (await import(/* @vite-ignore */ nodeEntry)) as unknown as RawH5wasmNamespace
  } else {
    ns = (await import('h5wasm')) as unknown as RawH5wasmNamespace
  }
  await ns.ready
  return {
    File: ns.File,
    Group: ns.Group,
    Dataset: ns.Dataset,
    FS: ns.FS as H5FileSystem,
    Module: ns.Module as H5Runtime,
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}

/**
 * Drop the memoised runtime. Only useful to tests that want to exercise the
 * initialisation path more than once; the wasm instance itself is not torn
 * down, so this is not a way to reclaim memory.
 */
export function resetH5(): void {
  cached = null
}
