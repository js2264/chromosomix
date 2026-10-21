/**
 * yapc's scan of one sequence through its WebAssembly kernel (`wasm/yapc.c`),
 * where this engine has SIMD.
 *
 * What `run/peaks.ts` does to a window between reading it and the next — the
 * intervals into pieces, the tracks' mean, its smoothed second derivative and
 * flat mask, where that is concave, each track's own second derivative there,
 * and the concave regions — done in one call into the kernel, with the same
 * numbers as the TypeScript bit for bit (`test/unit/yapc-kernel.test.ts` holds
 * the two to that). It is three times the speed of the same loops in
 * JavaScript, and those loops were nine-tenths of a genome-wide call (§18.8).
 *
 * **A memory per sequence, and none kept.** The scan's state is the kernel's own,
 * so each sequence is an instance of its own over a memory of its own, let go
 * when the sequence is done: two calls running at once in one worker never share
 * one, and the values a centromere's megabases of flat signal make it hold are
 * not held after it.
 *
 * Where the kernel cannot run — no WebAssembly, or none with SIMD, which
 * `WebAssembly.validate` says — {@link KernelScan.open} returns `null` and the
 * TypeScript runs instead. Where its memory cannot grow mid-sequence, the scan
 * throws {@link KernelMemoryError} and the caller scans that sequence again in
 * TypeScript, which needs none of it.
 */

import type { TrackSamples } from '../annotations/types'
import { YAPC_WASM_BASE64 } from './wasm/yapc.generated'
import { convolutionCentre, type ConcaveRegions, type YapcKernel } from './yapc'

/**
 * The kernel's exports (`wasm/yapc.c`). An address comes back as a signed 32-bit
 * integer, so each is read `>>> 0`, as the unsigned offset it is.
 */
interface Exports {
  scan_open(tracks: number, taps: number, centre: number, length: number, window: number): number
  scan_kernel(): number
  scan_input(track: number, count: number): number
  scan_window(from: number, to: number, lo: number, hi: number, absent: number): number
  scan_finish(): number
  scan_rose(): number
  scan_regions(): number
  scan_region_starts(): number
  scan_region_ends(): number
  scan_region_modes(): number
  scan_region_flats(): number
  scan_region_capacity(): number
  scan_pooled(): number
  scan_flat(): number
  scan_own(track: number): number
}

/** The tracks one kernel scans together at most (`MAX_TRACKS`). */
const MOST_TRACKS = 8

/** What the kernel's statuses below zero mean. */
const NO_MEMORY = -1
const OUT_OF_ORDER = -2

/** The module, compiled once per thread; `null` where this engine cannot run it. */
let compiled: WebAssembly.Module | null | undefined

function yapcModule(): WebAssembly.Module | null {
  if (compiled !== undefined) return compiled
  compiled = null
  try {
    if (typeof WebAssembly === 'undefined') return null
    const text = atob(YAPC_WASM_BASE64)
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    // `validate` is false on an engine without SIMD, which is the one way the
    // module can fail to load where WebAssembly exists.
    if (WebAssembly.validate(bytes)) compiled = new WebAssembly.Module(bytes)
  } catch {
    compiled = null
  }
  return compiled
}

/** Whether the kernel runs here — for the tests. */
export function yapcKernelAvailable(): boolean {
  return yapcModule() !== null
}

/** The kernel's memory could not grow: the sequence is scanned again in TypeScript. */
export class KernelMemoryError extends Error {
  constructor() {
    super('The peak-calling kernel ran out of memory.')
    this.name = 'KernelMemoryError'
  }
}

/** Regions as they are closed, kept until the sequence is done. */
class Collected {
  size = 0
  starts = new Int32Array(1024)
  ends = new Int32Array(1024)
  modes = new Int32Array(1024)
  flats = new Uint8Array(1024)
  scores: Float64Array[]

  constructor(tracks: number) {
    this.scores = Array.from({ length: tracks }, () => new Float64Array(1024))
  }

  /** `count` more, from the kernel's region buffers. */
  take(memory: WebAssembly.Memory, exports: Exports, count: number): void {
    if (count === 0) return
    while (this.size + count > this.starts.length) this.grow()
    const buffer = memory.buffer
    const cap = exports.scan_region_capacity()
    this.starts.set(new Int32Array(buffer, exports.scan_region_starts() >>> 0, count), this.size)
    this.ends.set(new Int32Array(buffer, exports.scan_region_ends() >>> 0, count), this.size)
    this.modes.set(new Int32Array(buffer, exports.scan_region_modes() >>> 0, count), this.size)
    this.flats.set(new Uint8Array(buffer, exports.scan_region_flats() >>> 0, count), this.size)
    const scores = exports.scan_regions() >>> 0
    this.scores.forEach((column, t) => column.set(new Float64Array(buffer, scores + t * cap * 8, count), this.size))
    this.size += count
  }

  private grow(): void {
    const twice = <T extends Int32Array | Uint8Array | Float64Array>(values: T): T => {
      const grown = new (values.constructor as new (n: number) => T)(values.length * 2)
      grown.set(values)
      return grown
    }
    this.starts = twice(this.starts)
    this.ends = twice(this.ends)
    this.modes = twice(this.modes)
    this.flats = twice(this.flats)
    this.scores = this.scores.map(twice)
  }
}

/**
 * One sequence's scan in the kernel: {@link window} for each window in order,
 * then {@link finish} — what `ConcaveScan` gives, from the tracks' own intervals.
 */
export class KernelScan {
  private readonly collected: Collected

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly exports: Exports,
    private readonly contig: string,
    private readonly tracks: number,
  ) {
    this.collected = new Collected(tracks)
  }

  /**
   * A scan of `contig`, `length` bases long, over `tracks` tracks in windows of
   * at most `window` bases; `null` where the kernel cannot run here.
   */
  static open(kernel: YapcKernel, contig: string, length: number, tracks: number, window: number): KernelScan | null {
    const module = yapcModule()
    if (module === null || tracks < 1 || tracks > MOST_TRACKS) return null
    try {
      const memory = new WebAssembly.Memory({ initial: 2 })
      const instance = new WebAssembly.Instance(module, { env: { memory } })
      const exports = instance.exports as unknown as Exports
      const taps = kernel.values.length
      if (exports.scan_open(tracks, taps, convolutionCentre(kernel, length), length, window) !== 0) return null
      const at = exports.scan_kernel() >>> 0
      new Float64Array(memory.buffer, at, taps).set(kernel.values)
      new Float64Array(memory.buffer, at + taps * 8, taps + 1).set(kernel.cumulative)
      return new KernelScan(memory, exports, contig, tracks)
    } catch {
      return null
    }
  }

  /**
   * Window `[from, to)`, read over `[lo, hi)`: each track's answer there, or
   * `null` for a track that does not have the sequence, which reads as zeros.
   */
  window(from: number, to: number, lo: number, hi: number, answers: ReadonlyArray<TrackSamples | null>): void {
    let absent = 0
    for (let t = 0; t < this.tracks; t++) {
      const answer = answers[t]
      if (answer === null) {
        absent |= 1 << t
        continue
      }
      const count = answer.starts.length
      const at = this.exports.scan_input(t, count) >>> 0
      if (at === 0) throw new KernelMemoryError()
      // Values as doubles, as `runsOver` reads them, then starts and ends.
      const buffer = this.memory.buffer
      new Float64Array(buffer, at, count).set(answer.values)
      new Int32Array(buffer, at + count * 8, count).set(answer.starts)
      new Int32Array(buffer, at + count * 12, count).set(answer.ends)
    }
    this.closed(this.exports.scan_window(from, to, lo, hi, absent), from)
  }

  /**
   * The last window's pooled second derivative and flat mask, and each track's
   * own second derivative (`NaN` where the pooled one is not concave), `length`
   * positions long — for the tests that hold them to `convolveSame`'s.
   */
  lastWindow(length: number): { pooled: Float64Array; flat: Uint8Array; own: Float64Array[] } {
    const buffer = this.memory.buffer
    return {
      pooled: new Float64Array(buffer, this.exports.scan_pooled() >>> 0, length).slice(),
      flat: new Uint8Array(buffer, this.exports.scan_flat() >>> 0, length).slice(),
      own: Array.from({ length: this.tracks }, (_, t) =>
        new Float64Array(buffer, this.exports.scan_own(t) >>> 0, length).slice(),
      ),
    }
  }

  /** The sequence's concave regions, as `ConcaveScan.finish` gives them. */
  finish(): ConcaveRegions {
    this.closed(this.exports.scan_finish(), -1)
    const { collected } = this
    // No rising edge, no regions: yapc's early return (`ConcaveScan`).
    const n = this.exports.scan_rose() === 1 ? collected.size : 0
    return {
      contig: this.contig,
      starts: collected.starts.slice(0, n),
      ends: collected.ends.slice(0, n),
      modes: collected.modes.slice(0, n),
      scores: collected.scores.map((column) => column.slice(0, n)),
      flat: collected.flats.slice(0, n),
    }
  }

  private closed(status: number, from: number): void {
    if (status === NO_MEMORY) throw new KernelMemoryError()
    if (status === OUT_OF_ORDER) throw new Error(`ConcaveScan: fed ${from} out of order`)
    if (status < 0) throw new Error(`pooledRuns: a track does not cover a window at ${from}`)
    this.collected.take(this.memory, this.exports, status)
  }
}
