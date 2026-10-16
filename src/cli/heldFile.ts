/**
 * A file on disk, read by range through a descriptor held open — the command
 * line's handle for a bigWig and a `.2bit`.
 *
 * generic-filehandle2's `LocalFile` is what `@gmod/bbi` would be given
 * otherwise, and it opens the file, reads, and closes it again **on every
 * read**: three trips through libuv's thread pool, and an `open` and a `close`
 * of the file's path each time. A metaplot over the RefSeq TSS reads a bigWig
 * sixteen thousand times, a block or two a read, so that was half of the time
 * it spent sampling (§18.10's timings): measured on the validation's ATAC-seq
 * track, the same 16,489 reads took 10.9 s through `LocalFile` and 5.4 s
 * through one descriptor, and on a cold disk every one of those opens was a
 * wait as well.
 *
 * So the descriptor is opened once and kept, and each read is one synchronous
 * `pread` into the buffer handed back. Synchronous because nothing else in a
 * command-line run is waiting on the event loop while a track is sampled — the
 * run is the only thing it is doing — and an asynchronous read here only paid
 * for the round trip. The bytes are the bytes `LocalFile` returns: a fresh
 * array of the length asked for, or of what was left before the end.
 *
 * **Reads that walk forward are read ahead**, the way the kernel reads ahead of
 * a file read in order, and for the same reason. A metaplot's reads arrive in
 * file order, a few kilobytes each with tens of kilobytes between them, across
 * most of the file: on a disk that has not cached the file every one is a seek,
 * and a first run of the validation's metaplot on a cold disk waited a minute
 * for twelve seconds of work. So while each read lands just past the one before
 * it (within {@link REACH}), the next read that misses fetches more than it was
 * asked for — {@link FIRST_AHEAD}, doubling to {@link MOST_AHEAD} — and the
 * reads after it are answered from those bytes: that metaplot's 16,489 reads
 * become 922 reads of the disk, in order, of 759 MB rather than 214. A jump
 * anywhere else resets the window to nothing, so reads scattered at random are
 * read as asked and no byte more.
 *
 * **At most {@link MOST_HELD} descriptors at once**, the least recently read
 * closed first and reopened when it is read again. A run over two hundred
 * bigWigs holds two hundred tracks, and macOS's default limit is 256 open
 * files for the whole process.
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import type {
  BufferEncoding,
  FilehandleOptions,
  GenericFilehandle,
  Stats,
} from 'generic-filehandle2'

/** Descriptors held open across every {@link HeldFile} of the process. */
export const MOST_HELD = 64

/** The open ones, least recently read first: a `Map` keeps insertion order. */
const held = new Map<HeldFile, number>()

/** The first read-ahead of a forward run, in bytes. */
export const FIRST_AHEAD = 64 << 10

/** The most a read-ahead fetches, in bytes: one buffer a file. */
export const MOST_AHEAD = 1 << 20

/** How far past the last read the next may start and still count as walking forward. */
export const REACH = 256 << 10

export class HeldFile implements GenericFilehandle {
  /** Bytes read ahead: the file's `[bufferAt, bufferAt + buffer.length)`, a view of {@link space}. */
  private buffer: Uint8Array | null = null
  /** Where every read-ahead of this file lands, {@link MOST_AHEAD} bytes once one is made. */
  private space: Uint8Array | null = null
  private bufferAt = 0
  /** The read-ahead the next miss fetches; `0` until reads walk forward. */
  private ahead = 0
  /** Where the last read asked for ended, or `-1` before the first. */
  private lastEnd = -1

  constructor(readonly path: string) {}

  /** The descriptor, opened if it is not, and marked as the most recently read. */
  private descriptor(): number {
    const open = held.get(this)
    if (open !== undefined) {
      held.delete(this)
      held.set(this, open)
      return open
    }
    while (held.size >= MOST_HELD) {
      const [oldest, fd] = held.entries().next().value as [HeldFile, number]
      held.delete(oldest)
      closeSync(fd)
    }
    const fd = openSync(this.path, 'r')
    held.set(this, fd)
    return fd
  }

  async read(length: number, position = 0): Promise<Uint8Array<ArrayBuffer>> {
    if (length === 0) return new Uint8Array(0)
    const end = position + length
    const buffer = this.buffer
    const bufferEnd = buffer === null ? -1 : this.bufferAt + buffer.length
    if (buffer !== null && position >= this.bufferAt && end <= bufferEnd) {
      this.lastEnd = end
      // A copy, as every read hands back an array of its own.
      return buffer.slice(position - this.bufferAt, end - this.bufferAt)
    }
    const forward =
      this.lastEnd >= 0 && position >= this.lastEnd && position <= Math.max(this.lastEnd, bufferEnd) + REACH
    this.ahead = forward ? Math.min(MOST_AHEAD, Math.max(FIRST_AHEAD, this.ahead * 2)) : 0
    this.lastEnd = end
    if (this.ahead <= length) return this.pread(length, position)
    // Into the same megabyte every time. Every read hands back a copy of its
    // bytes, so nothing holds a view of what this overwrites — and a fresh
    // buffer at each fetch was a megabyte of new pages to fault in and zero,
    // nine hundred times over a metaplot, only for the kernel to copy over them.
    const space = (this.space ??= new Uint8Array(MOST_AHEAD))
    const got = this.preadInto(space, this.ahead, position)
    this.buffer = space.subarray(0, got)
    this.bufferAt = position
    return space.slice(0, Math.min(length, got))
  }

  /** `length` bytes at `position`, or what is left of the file before them. */
  private pread(length: number, position: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(length)
    const got = this.preadInto(out, length, position)
    return got === length ? out : out.subarray(0, got)
  }

  /** Up to `length` bytes at `position` into the start of `into`: how many the file had. */
  private preadInto(into: Uint8Array, length: number, position: number): number {
    const fd = this.descriptor()
    let got = 0
    while (got < length) {
      const n = readSync(fd, into, got, length - got, position + got)
      if (n === 0) break
      got += n
    }
    return got
  }

  readFile(options?: Omit<FilehandleOptions, 'encoding'>): Promise<Uint8Array<ArrayBuffer>>
  readFile(
    options: BufferEncoding | (Omit<FilehandleOptions, 'encoding'> & { encoding: BufferEncoding }),
  ): Promise<string>
  readFile(
    options?: BufferEncoding | FilehandleOptions,
  ): Promise<Uint8Array<ArrayBuffer> | string> {
    // As `LocalFile` does it: the whole file, by path, in whatever encoding is asked.
    return readFile(this.path, options as Parameters<typeof readFile>[1]) as Promise<
      Uint8Array<ArrayBuffer> | string
    >
  }

  async stat(): Promise<Stats> {
    return stat(this.path)
  }

  async close(): Promise<void> {
    const fd = held.get(this)
    if (fd === undefined) return
    held.delete(this)
    closeSync(fd)
  }
}
