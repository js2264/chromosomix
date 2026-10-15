/**
 * Bytes that lie, and the instruments for watching a reader meet them (§10, §12).
 *
 * A reader handed a malformed file has three ways to fail that are worse than
 * an error, and none of them is visible to an assertion on its answer: it
 * reads far more of the file than there is to read, it allocates on the
 * strength of a count nobody checked, or it never returns. So a test of one
 * needs a source that counts what it is asked for and refuses past a budget, a
 * spy on what is allocated, and a clock — and the corruption has to be
 * deterministic, or a failure found once is a failure nobody can find again.
 * The three live here so the regression tests and the fuzz share them.
 */

import { makeRandom, randomInt } from '@/analysis/random'
import type { ByteSource, SourceStats } from '@/types'

/** Thrown by a counting source once a reader has asked for more than its budget. */
export class ReadBudgetExceeded extends Error {
  constructor(readonly asked: number, readonly budget: number) {
    super(`a reader asked for ${asked} bytes against a budget of ${budget}`)
    this.name = 'ReadBudgetExceeded'
  }
}

/**
 * A file in memory as a {@link ByteSource}, counting every byte asked for.
 *
 * The count is of bytes *asked for*, clipped to the file as a real source
 * clips them, because that is the cost a remote reader pays: a read of two
 * gigabytes at an offset near the end is answered with what is there, and is
 * a request for the rest of the file all the same. Past `budget` it throws
 * {@link ReadBudgetExceeded}, which no reader catches as anything of its own.
 *
 * `readExact` is offered too, so a `.hic` walk takes the road a remote walk
 * takes and is counted on it.
 */
export class CountingSource implements ByteSource {
  readonly id = 'hostile.bin'
  readonly isRemote = false
  readonly size: number
  requests = 0
  bytes = 0

  constructor(
    private readonly data: Uint8Array,
    private readonly budget = Number.POSITIVE_INFINITY,
    /** The size the source claims, where a test needs a file larger than its bytes. */
    size = data.byteLength,
  ) {
    this.size = size
  }

  async mount(): Promise<string> {
    return this.id
  }

  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    this.requests += 1
    this.bytes += n
    if (this.bytes > this.budget) throw new ReadBudgetExceeded(this.bytes, this.budget)
    const out = new Uint8Array(n)
    // Bytes past the data and inside the claimed size read as zeros.
    if (position < this.data.byteLength) {
      out.set(this.data.subarray(position, Math.min(this.data.byteLength, position + n)))
    }
    return out
  }

  async readExact(position: number, length: number): Promise<Uint8Array> {
    return this.readBytes(position, length)
  }

  stats(): SourceStats {
    return { requests: this.requests, bytes: this.bytes }
  }

  close(): void {}
}

/**
 * The `(length, position)` read the `.2bit` and g3d readers take, counted and
 * budgeted as {@link CountingSource} is.
 */
export function countingRange(
  data: Uint8Array,
  budget = Number.POSITIVE_INFINITY,
): { read: (length: number, position: number) => Promise<Uint8Array>; stats: SourceStats } {
  const stats: SourceStats = { requests: 0, bytes: 0 }
  const read = async (length: number, position: number): Promise<Uint8Array> => {
    const n = Math.max(0, Math.min(data.byteLength - position, length))
    stats.requests += 1
    stats.bytes += n
    if (stats.bytes > budget) throw new ReadBudgetExceeded(stats.bytes, budget)
    return data.slice(position, position + n)
  }
  return { read, stats }
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

const TYPED_ARRAYS = [
  'Int8Array',
  'Uint8Array',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
] as const

/**
 * Watch every typed array made by length until the returned function is called,
 * recording the largest in bytes into `seen.largest`.
 *
 * A proxy over each global constructor, because a reader names them as globals
 * and that is the one place a length read from a file becomes memory. Only
 * `new X(n)` is counted — a view over an existing buffer allocates nothing —
 * and the platform's own buffers (a `DecompressionStream`'s chunks) are not
 * seen; the inflate is capped separately and its concatenation is a `new`.
 */
export function watchAllocations(seen: { largest: number }): () => void {
  const globals = globalThis as unknown as Record<string, unknown>
  const originals = new Map<string, unknown>()
  for (const name of TYPED_ARRAYS) {
    const original = globals[name] as { BYTES_PER_ELEMENT: number } & (new (...args: unknown[]) => object)
    originals.set(name, original)
    globals[name] = new Proxy(original, {
      construct(target, args: unknown[], newTarget) {
        if (typeof args[0] === 'number') {
          seen.largest = Math.max(seen.largest, args[0] * target.BYTES_PER_ELEMENT)
        }
        return Reflect.construct(target, args, newTarget)
      },
    })
  }
  return () => {
    for (const [name, original] of originals) globals[name] = original
  }
}

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

/** What one mutation did, for the failure message that has to reproduce it. */
export interface Mutation {
  bytes: Uint8Array
  how: string
}

/** 32-bit values a count field is most likely to be wrong with. */
export const EXTREME_32 = [0xffffffff, 0x7fffffff, 0x80000000, 0x00000000, 0x00ffffff, 0xfffffffe] as const

/** The same, for a 64-bit offset or count. */
export const EXTREME_64 = [
  0xffffffffffffffffn,
  0x7fffffffffffffffn,
  0x8000000000000000n,
  0x0020000000000001n,
  0x00000000ffffffffn,
] as const

/**
 * Offsets in `bytes` holding a little-endian `uint32` that looks like a count,
 * an offset or a length — positive and under 2^24 — which is where an extreme
 * value does its damage. A deflate stream is noise and mostly misses the test;
 * the structure around it mostly passes it.
 */
export function lengthLikeOffsets(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  for (let at = 0; at + 4 <= bytes.byteLength; at++) {
    const value = view.getUint32(at, true)
    if (value > 0 && value < 1 << 24) out.push(at)
  }
  return out
}

/**
 * One deterministic corruption of `original`, chosen by `rng`.
 *
 * Five kinds, because files go wrong in more than one way: bits flipped, as
 * storage and transfer do it; bytes overwritten; a length-like field set to an
 * extreme 32-bit value, or to an extreme 64-bit one where the field is wide
 * enough to be an offset; and the file cut short, as an interrupted download
 * leaves it.
 */
export function mutate(
  original: Uint8Array,
  rng: () => number,
  lengthLike: readonly number[],
  /** Where a flipped bit or a written byte may land; anywhere in the file by default. */
  pick: (rng: () => number) => number = (r) => randomInt(r, 0, original.length),
): Mutation {
  const bytes = original.slice()
  const view = new DataView(bytes.buffer)
  const kind = randomInt(rng, 0, 5)
  if (kind === 0) {
    const flips = randomInt(rng, 1, 9)
    const at: string[] = []
    for (let i = 0; i < flips; i++) {
      const byte = pick(rng)
      const bit = randomInt(rng, 0, 8)
      bytes[byte] ^= 1 << bit
      at.push(`${byte}.${bit}`)
    }
    return { bytes, how: `bits flipped at ${at.join(', ')}` }
  }
  if (kind === 1) {
    const writes = randomInt(rng, 1, 5)
    const at: string[] = []
    for (let i = 0; i < writes; i++) {
      const byte = pick(rng)
      bytes[byte] = randomInt(rng, 0, 256)
      at.push(`${byte}=${bytes[byte]}`)
    }
    return { bytes, how: `bytes overwritten at ${at.join(', ')}` }
  }
  if (kind === 2 || kind === 3) {
    const at = lengthLike.length > 0 ? lengthLike[randomInt(rng, 0, lengthLike.length)] : Math.min(pick(rng), bytes.length - 4)
    if (kind === 3 && at + 8 <= bytes.length) {
      const value = EXTREME_64[randomInt(rng, 0, EXTREME_64.length)]
      view.setBigUint64(at, value, true)
      return { bytes, how: `int64 at ${at} set to 0x${value.toString(16)}` }
    }
    const value = EXTREME_32[randomInt(rng, 0, EXTREME_32.length)]
    view.setUint32(at, value, true)
    return { bytes, how: `int32 at ${at} set to 0x${value.toString(16)}` }
  }
  const length = randomInt(rng, 0, bytes.length)
  return { bytes: bytes.slice(0, length), how: `cut to ${length} bytes` }
}

/** A generator for case `n` of a suite, so any one case can be rerun alone. */
export function caseRandom(seed: number, n: number): () => number {
  return makeRandom(seed * 1_000_003 + n)
}
