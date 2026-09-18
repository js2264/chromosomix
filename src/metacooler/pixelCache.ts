/**
 * The pixels, kept after they have been inflated.
 *
 * Every read in this application ends in the same place: `forEachPixelSpan`
 * turns a bin range into a **pixel index range** through `indexes/bin1_offset`,
 * and then pulls `pixels/bin1_id`, `pixels/bin2_id` and the count column over
 * that range a window at a time. Whatever the caller wanted — a dense block, a
 * pooled one, a roll-up, an analysis task — that is the read, and the cost of
 * it is almost entirely HDF5 turning compressed chunks back into numbers.
 *
 * Measured on `demo/yeast/Yeast_microC_G2M_1kb.cool` (12,118 bins, 13.7 M
 * stored pixels), a whole-genome pooled read costs 2,930 ms. A bare walk of the
 * same span with an **empty callback** costs 2,026 ms of it, and summing every
 * count in the callback adds 50 ms. The arithmetic is free; the inflation is
 * the read. And the identical read costs the identical 2 s every time it is
 * made — three consecutive reads of one window measured 854, 810 and 812 ms —
 * because nothing between h5wasm and the accumulator remembers anything.
 *
 * That is what made a zoom that changes resolution feel like a page load: each
 * rung of the ladder re-inflated bytes the rung before it had just inflated,
 * for a picture of the same place. The block cache in `ui/refine.ts` holds
 * three finished **pictures**; this holds the **numbers they were made from**,
 * which every grid can be made from and only the file can supply.
 *
 * **The cache key is a pixel index range, and that is the whole idea.** A
 * ladder reads nested row bands — the whole genome, then half of it, then a
 * quarter — and nested bands are nested pixel ranges, so the first read
 * populates every read after it. A window inside a run that is already held is
 * a `subarray`: no copy, no allocation, and the callback contract
 * (*"the buffers handed to `onChunk` are not retained between calls"*) is
 * exactly what makes that safe.
 *
 * **What it is not.** It is not a tile cache: nothing here is a picture,
 * nothing is composited, nothing is evicted mid-read. It is not an index — a
 * miss costs precisely what the read cost before this file existed. And it is
 * not a correctness surface: the file is immutable for as long as it is open,
 * the key is a byte range in it, and the only invalidation is closing the
 * handle.
 */

import type { Hdf5Handle } from '../h5/api'
import type { PixelChunk } from '../types'

/**
 * Bytes one cached pixel occupies: two `Int32Array` ids and a `Float64Array`
 * count, which is what the columns arrive as.
 *
 * `bin1` is stored rather than rebuilt from `indexes/bin1_offset`, which would
 * save a quarter of this. The offsets are a different dataset with a different
 * lifetime, and a cache that has to be handed a second array to answer with the
 * first one is a cache with a way to be wrong; four bytes a pixel is the
 * cheaper side of that trade. The count stays `Float64Array` for the reason the
 * reader reads it as one: a `/pixels` value column may be a float, and "safe
 * for the counts I happened to test" is not a property worth having.
 */
export const BYTES_PER_PIXEL = 4 + 4 + 8

/**
 * What the cache will hold, across every handle open in this thread.
 *
 * 13.7 M pixels — the whole yeast demo at 1 kb — is 220 MB, so this holds it
 * and about half as much again. It is a **new** allowance rather than one taken
 * out of `HELD_BYTES`: the block cache and this one answer different questions
 * and both are worth having, and the whole point of the number is that a
 * genome-scale cooler fits inside it whole.
 *
 * Scaled by what the machine admits to, because the alternative on a small
 * device is a killed tab. The share is smaller than `denseBudgetFor`'s, since
 * this is held for the life of the file rather than for the life of one block.
 */
export const PIXEL_CACHE_BYTES = 384 * 1024 * 1024

/** The share of a reported device memory this cache may take. */
const DEVICE_SHARE = 1 / 8

/** Gibibytes assumed where the browser will not say. */
const DEVICE_FALLBACK_GIB = 8

/**
 * What this machine will lend the pixel cache.
 *
 * `navigator.deviceMemory` is a coarse, capped hint rather than a measurement
 * — Chrome rounds it to a power of two and stops at 8 — so this is a ceiling
 * being lowered on small machines rather than raised on large ones.
 */
export function pixelCacheBudgetBytes(): number {
  const reported = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory
  const gib = typeof reported === 'number' && reported > 0 ? reported : DEVICE_FALLBACK_GIB
  return Math.min(PIXEL_CACHE_BYTES, Math.max(32 * 1024 * 1024, gib * 1024 ** 3 * DEVICE_SHARE))
}

/**
 * One contiguous run of inflated pixels, `[from, to)` in pixel indices, held as
 * **the windows it arrived in**.
 *
 * Not as one array per column, which is what this was first written as and what
 * measuring it immediately argued against: concatenating a whole-genome span
 * means allocating 220 MB and copying every pixel into it, which added 1.6 s to
 * the one read that was already the slowest in the application — a tax on the
 * first picture to make the second one cheap. The windows are exactly what
 * h5wasm handed back and nothing else refers to them, so keeping them **is**
 * the cache: no allocation, no copy, and the read path is untouched.
 */
interface Run {
  handle: Hdf5Handle
  /** Which `/pixels` column the values came from; a different column is different data. */
  column: string
  from: number
  to: number
  /** The windows, in order and abutting: `parts[i]` starts where `parts[i-1]` ended. */
  parts: PixelChunk[]
  /** Bumped on every hit, so the sweep drops the least recently wanted run. */
  used: number
}

/**
 * The runs, most recently used first.
 *
 * A list rather than a map because the lookup is *containment* rather than
 * equality — a read of half a genome wants the run that holds the whole one —
 * and because the population is small by construction: a run is at least a
 * window wide and the budget is a few hundred megabytes, so there are tens of
 * them, not thousands.
 */
let runs: Run[] = []
let clock = 0
let heldBytes = 0
/** Reads served without touching the file, and reads that had to; for the budget test. */
let hits = 0
let misses = 0

/** Bytes a run of `n` pixels occupies. */
function bytesOf(n: number): number {
  return n * BYTES_PER_PIXEL
}

/** The run that holds `[from, to)` whole, or `null`. */
function find(handle: Hdf5Handle, column: string, from: number, to: number): Run | null {
  for (const run of runs) {
    if (run.handle !== handle || run.column !== column) continue
    if (run.from <= from && run.to >= to) {
      run.used = ++clock
      return run
    }
  }
  return null
}

/** Drop the least recently used runs until the budget is met. */
function sweep(budget: number): void {
  if (heldBytes <= budget) return
  runs.sort((a, b) => b.used - a.used)
  while (runs.length > 0 && heldBytes > budget) {
    const dropped = runs.pop()
    if (dropped === undefined) break
    heldBytes -= bytesOf(dropped.to - dropped.from)
  }
}

/**
 * Keep an inflated span, replacing anything it contains.
 *
 * A run that a wider one now covers is dropped rather than kept beside it: the
 * ladder reads outward as well as inward, and two runs describing the same
 * pixels are the same bytes held twice. Containment is the only merge attempted
 * — two *adjacent* runs are left alone, because splicing them means copying
 * both, and the read that wants the union will arrive as one span and be stored
 * as one anyway.
 */
export function keepPixels(
  handle: Hdf5Handle,
  column: string,
  from: number,
  parts: readonly PixelChunk[],
  budget: number = pixelCacheBudgetBytes(),
): void {
  let n = 0
  for (const part of parts) n += part.length
  const to = from + n
  if (n <= 0) return
  const bytes = bytesOf(n)
  // A span that could not fit even in an empty cache is not worth evicting the
  // whole cache to fail to hold. It is read and forgotten, exactly as before.
  if (bytes > budget) return
  runs = runs.filter((run) => {
    const covered = run.handle === handle && run.column === column && run.from >= from && run.to <= to
    if (covered) heldBytes -= bytesOf(run.to - run.from)
    return !covered
  })
  runs.unshift({
    handle,
    column,
    from,
    to,
    parts: parts.map((part) => ({
      // Narrowed to the valid prefix, since a chunk's arrays may be over-allocated
      // and the cache's arithmetic is all in `length`.
      bin1: part.bin1.subarray(0, part.length),
      bin2: part.bin2.subarray(0, part.length),
      count: part.count.subarray(0, part.length),
      length: part.length,
    })),
    used: ++clock,
  })
  heldBytes += bytes
  sweep(budget)
}

/**
 * Hand `[from, to)` to `onChunk` in windows of `width`, out of a held run.
 *
 * @returns `false` when nothing holds it, and the caller must read.
 */
export function replayPixels(
  handle: Hdf5Handle,
  column: string,
  from: number,
  to: number,
  onChunk: (chunk: PixelChunk) => void,
  between?: () => boolean,
): boolean {
  const run = find(handle, column, from, to)
  if (run === null) {
    misses++
    return false
  }
  hits++
  // Walked part by part, clipped to the request at both ends. The windows a run
  // holds are the reader's own, so the sizes handed out here are the sizes a
  // caller would have seen from the file — which is what makes a replay
  // indistinguishable from a read to everything downstream.
  let at = run.from
  for (const part of run.parts) {
    const start = at
    at += part.length
    if (at <= from) continue
    if (start >= to) break
    if (between?.() === false) return true
    const lo = Math.max(0, from - start)
    const hi = Math.min(part.length, to - start)
    // `subarray`, not `slice`: the callback contract forbids retaining these,
    // which is exactly the licence to hand out a view of the cache itself.
    onChunk({
      bin1: part.bin1.subarray(lo, hi),
      bin2: part.bin2.subarray(lo, hi),
      count: part.count.subarray(lo, hi),
      length: hi - lo,
    })
  }
  return true
}

/**
 * Forget everything read through one handle.
 *
 * Called from `MetaCooler.close`, and it is the only invalidation there is: the
 * key is a byte range in a file that cannot change while it is open, so the
 * question a cache usually has to answer — *is this still true* — does not
 * arise. What does arise is the handle going away, and a run holding 200 MB for
 * a file nobody has open is the one way this could be a leak.
 */
export function releasePixels(handle: Hdf5Handle): void {
  runs = runs.filter((run) => {
    if (run.handle !== handle) return true
    heldBytes -= bytesOf(run.to - run.from)
    return false
  })
}

/** What the cache is holding, for the debug panel and the budget tests. */
export function pixelCacheStats(): {
  runs: number
  bytes: number
  hits: number
  misses: number
} {
  return { runs: runs.length, bytes: heldBytes, hits, misses }
}

/** Empty it, and reset the counters. Tests, and nothing else. */
export function resetPixelCache(): void {
  runs = []
  heldBytes = 0
  hits = 0
  misses = 0
  clock = 0
}
