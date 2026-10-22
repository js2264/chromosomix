/**
 * A file whose bytes are fetched as HDF5 asks for them, mounted under either
 * build of h5wasm.
 *
 * The browser build's filesystem is MEMFS, and a lazy file there is an FS node
 * with a `read` stream op of our own — Emscripten's `createLazyFile` shape,
 * which `RemoteRangeSource` and `LocalFileSource` have always built. The Node
 * build is NODERAWFS: its `FS` *is* the real filesystem, `createFile` would
 * write an empty file at the root of the disk, and there is no node to hang a
 * stream op on. So the command line, which reads an address by range as the app
 * does (§23.1), needs a second road to the same shape.
 *
 * It finds one in how NODERAWFS reads. Every stream op it overrides — `read`,
 * `llseek`, `mmap` — hands a stream that carries `stream_ops` of its own back to
 * the in-memory layer underneath, which is how it serves `/dev/stdin`. So a path
 * registered here is opened as such a stream, and every read HDF5 makes of it is
 * a call into the source's own `read`; `fstat` and `stat` answer its size, which
 * is what HDF5's `sec2` driver takes the end of the file from. No file is
 * written, nothing touches the disk, and a path that is not registered is
 * opened exactly as before.
 */

import type { H5FSNode, H5Module } from './bootstrap'
import { isNodeRuntime } from './bootstrap'

/** Copy `length` bytes of the file at `position` into `buffer` at `offset`. */
export type LazyRead = (buffer: Uint8Array, offset: number, position: number, length: number) => void

/** The stream ops a lazy file answers with: a read that never returns more than the file has. */
interface LazyOps {
  read(stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number): number
  llseek(stream: { position: number }, offset: number, whence: number): number
  mmap(stream: unknown, length: number, position: number): { ptr: number; allocated: boolean }
}

interface Registered {
  size: number
  ino: number
  ops: LazyOps
}

/** Where NODERAWFS lazy files live: a directory that does not exist on disk, and need not. */
const NODE_ROOT = '/chromosomix-lazy'

/** Lazy files under NODERAWFS, by path. */
const registered = new Map<string, Registered>()

/** The FS objects already taught about {@link registered}: one per h5wasm instance. */
const patched = new WeakSet<object>()

let serial = 0

/** The ops every lazy file shares, closed over its size and its reader. */
function opsFor(h5: H5Module, size: number, read: LazyRead): LazyOps {
  return {
    read: (_stream, buffer, offset, length, position) => {
      if (position >= size) return 0
      const n = Math.min(size - position, length)
      read(buffer, offset, position, n)
      return n
    },
    llseek: (stream, offset, whence) => {
      // SEEK_SET, SEEK_CUR, SEEK_END, as MEMFS answers them.
      const position = whence === 1 ? stream.position + offset : whence === 2 ? size + offset : offset
      if (position < 0) throw new Error('a lazy file cannot be sought before its start')
      return position
    },
    mmap: (_stream, length, position) => {
      const ptr = h5.Module._malloc(length)
      if (ptr === 0) throw new Error('mmap allocation failed')
      const n = Math.max(0, Math.min(size - position, length))
      if (n > 0) read(h5.Module.HEAPU8, ptr, position, n)
      return { ptr, allocated: true }
    },
  }
}

/**
 * Mount a file of `size` bytes read through `read`, and return the path HDF5
 * opens it by.
 *
 * `leaf` names it: the whole path under MEMFS, as the browser has always named
 * one, and a part of it under NODERAWFS, where a serial follows so that two
 * mounts of one address — a map run against itself — are two files.
 */
export function mountLazyFile(h5: H5Module, leaf: string, size: number, read: LazyRead): string {
  const ops = opsFor(h5, size, read)
  if (isNodeRuntime()) {
    teach(h5)
    serial += 1
    const path = `${NODE_ROOT}/${leaf}-${serial}`
    registered.set(path, { size, ino: 0x4c00000 + serial, ops })
    return path
  }
  const node: H5FSNode = h5.FS.createFile('/', leaf, {}, true, false)
  const contents = { length: size }
  node.contents = contents
  // A getter over `contents.length`, or MEMFS's `getattr` reports a
  // zero-length file and HDF5 refuses to open it.
  Object.defineProperty(node, 'usedBytes', { get: () => contents.length })
  // Copied: MEMFS shares one stream_ops object across every file it created.
  node.stream_ops = { ...node.stream_ops, read: ops.read, mmap: ops.mmap }
  return `/${leaf}`
}

/** Let go of a path {@link mountLazyFile} returned. Safe to call twice. */
export function unmountLazyFile(h5: H5Module, path: string): void {
  if (registered.delete(path)) return
  try {
    h5.FS.unlink(path)
  } catch {
    // Already gone, or the FS went with the worker.
  }
}

/** How many lazy files are mounted under NODERAWFS — a leak assertion for tests. */
export function lazyFilesMounted(): number {
  return registered.size
}

/** The shape of the NODERAWFS members this module wraps. */
interface RawFS {
  open(path: unknown, flags: unknown, mode?: unknown): { stream_ops?: unknown; path?: string }
  fstat(fd: number): unknown
  stat(path: unknown, dontFollow?: boolean): unknown
  getStream(fd: number): { path?: string; stream_ops?: unknown } | null | undefined
  createStream(stream: Record<string, unknown>, fd?: number): { stream_ops?: unknown; path?: string }
}

/** `struct stat` for a lazy file: a regular file, read-only, of its size. */
function statOf(entry: Registered): Record<string, unknown> {
  const epoch = new Date(0)
  return {
    dev: 0x4c,
    ino: entry.ino,
    mode: 0o100444,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: entry.size,
    blksize: 4096,
    blocks: Math.ceil(entry.size / 512),
    atime: epoch,
    mtime: epoch,
    ctime: epoch,
  }
}

/**
 * Wrap `open`, `fstat` and `stat` on this instance's FS, once, so a registered
 * path is a lazy stream and every other path is what NODERAWFS made of it.
 *
 * Patching the object rather than holding a copy: the syscalls look these up
 * on `FS` at every call, so a wrapper installed here is what `openat`, `fstat`
 * and `stat` reach.
 */
function teach(h5: H5Module): void {
  const fs = h5.FS as unknown as RawFS
  if (patched.has(fs)) return
  patched.add(fs)
  const open = fs.open.bind(fs)
  const fstat = fs.fstat.bind(fs)
  const stat = fs.stat.bind(fs)
  fs.open = (path, flags, mode) => {
    const entry = typeof path === 'string' ? registered.get(path) : undefined
    if (entry === undefined) return open(path, flags, mode)
    const node = { id: entry.ino, mode: 0o100444, node_ops: {}, path, usedBytes: entry.size }
    // O_RDONLY whatever was asked: a lazy file has nothing to write to, and
    // HDF5 opens read-only for a file it was told to read.
    return fs.createStream({ path, flags: 0, node, stream_ops: entry.ops, seekable: true, position: 0 })
  }
  fs.fstat = (fd) => {
    const stream = fs.getStream(fd)
    const entry = stream?.path === undefined ? undefined : registered.get(stream.path)
    return entry !== undefined && stream?.stream_ops === entry.ops ? statOf(entry) : fstat(fd)
  }
  fs.stat = (path, dontFollow) => {
    const entry = typeof path === 'string' ? registered.get(path) : undefined
    return entry === undefined ? stat(path, dontFollow) : statOf(entry)
  }
}
