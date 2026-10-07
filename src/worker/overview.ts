/**
 * How the whole-file overview's axes are chosen (spec §7.3).
 *
 * The scan itself is one pass over every non-zero pixel and there is no index
 * that shortcuts it. What *is* a choice is what the axes are when there are
 * more units than a picture can hold, and the choice used to be **truncation**:
 * keep the 2,048 densest units and drop the rest. On the reference file that is
 * 53% of genomes or 98.7% of contigs discarded, and the ones kept were not the
 * densest either — see {@link poolUnits} and §4.3 of `docs/performance-review.md`.
 *
 * The replacement is **aggregation**. Every unit contributes; where there are
 * more than the budget allows, consecutive units share a slot. That is a
 * coarser picture of the whole file rather than a sharp picture of a fraction of
 * it, and it is what the renderer does one step later anyway — a raster is
 * pooled to `RASTER_MAX_DIM` per axis whatever it is handed.
 *
 * Slot boundaries are snapped to *group* boundaries where the budget allows, so
 * a slot never mixes two genomes and the dividers the contig-level view exists
 * to show stay exact.
 */

/**
 * The most units either axis of the overview may have, whatever the budget.
 *
 * `POOLED_CELL_CAP`, the bound every whole-file read keeps. It used to be
 * `RASTER_MAX_DIM`, on the argument that anything wider is pooled a second time
 * on the way to the screen — flat, with no idea where the genome boundaries are.
 * That still holds, but the raster is now 16,384 wide so that a single
 * chromosome can be read bin for bin, and an overview that followed it would be
 * a 2 GB accumulator: memory is the binding constraint again, as it was when
 * this was last 16,384, and the whole-file picture keeps the 4,096 it has.
 */
import { POOLED_CELL_CAP } from '../metacooler/pooling'

export const OVERVIEW_HARD_CAP = POOLED_CELL_CAP

/**
 * Bytes one unit of the accumulator costs, per unit of the other axis.
 *
 * The upper triangle is `8 B` per cell over `M(M+1)/2` cells, and the `Float32`
 * result handed to the renderer is `4 B` over `M²` — so `4 + 4` per `M²`,
 * near enough, and the arithmetic below is deliberately the pessimistic side of
 * "near enough".
 */
const BYTES_PER_UNIT_PAIR = 8

/**
 * What the *render* side costs, whatever the unit count.
 *
 * Bounded by {@link OVERVIEW_HARD_CAP}: pooled values, RGBA and canvas backing
 * store, 4 B each over at most that many units a side (`estimateBlockBytes`).
 */
const RENDER_CEILING_BYTES = 12 * OVERVIEW_HARD_CAP * OVERVIEW_HARD_CAP

/**
 * The most units this machine will draw an overview of.
 *
 * Derived from the same budget the dense guard uses rather than from a constant,
 * because it is the same question: the old fixed 2,048 was about eight times
 * tighter than a laptop needs, and on a machine that cannot afford even that it
 * was eight times too loose.
 */
export function overviewUnitCap(budgetBytes: number): number {
  const forAccumulator = Math.max(0, budgetBytes - RENDER_CEILING_BYTES)
  const cap = Math.floor(Math.sqrt(forAccumulator / BYTES_PER_UNIT_PAIR))
  // Never fewer than a few hundred: a machine too small for that is too small
  // for the scan, and an axis of 12 units is not a picture of anything.
  return Math.max(256, Math.min(OVERVIEW_HARD_CAP, cap))
}

/** One axis of the overview: which slot each displayed unit falls into. */
export interface UnitPooling {
  /** Slot of `displayed[i]`, non-decreasing, `0 … slots - 1`. */
  slotOf: Int32Array
  /** Number of slots — the axis length of the picture. */
  slots: number
  /** `true` when more than one unit shares a slot anywhere. */
  pooled: boolean
}

/**
 * Assign `displayed.length` units to at most `cap` slots.
 *
 * Below the cap this is the identity and nothing is pooled. Above it, units are
 * distributed as evenly as they can be while keeping every run of `groupOf`
 * inside its own slots — so a slot spans several contigs of one genome, never
 * the end of one genome and the start of the next.
 *
 * Group snapping needs at least one slot per run. Where there are more runs than
 * slots the groups are themselves too many to draw, and the fallback is a flat
 * proportional split, which is the same coarsening applied one level up.
 *
 * @param groupOf Group of the unit at each *position* in `displayed`; omit when
 *   the units have no coarser structure (a genome axis).
 */
export function poolUnits(
  count: number,
  cap: number,
  groupOf?: (position: number) => number,
): UnitPooling {
  const slotOf = new Int32Array(count)
  if (count <= cap) {
    for (let i = 0; i < count; i++) slotOf[i] = i
    return { slotOf, slots: count, pooled: false }
  }

  const runs = groupOf === undefined ? null : runLengths(count, groupOf)
  if (runs === null || runs.length > cap) {
    // Flat: unit i goes to slot floor(i * cap / count), which is monotone and
    // fills every slot.
    for (let i = 0; i < count; i++) slotOf[i] = Math.floor((i * cap) / count)
    return { slotOf, slots: cap, pooled: true }
  }

  const perRun = apportion(runs, cap)
  let unit = 0
  let slot = 0
  for (let r = 0; r < runs.length; r++) {
    const length = runs[r]
    const share = perRun[r]
    for (let k = 0; k < length; k++, unit++) {
      // Within a run, spread its units over the slots it was given.
      slotOf[unit] = slot + Math.min(share - 1, Math.floor((k * share) / length))
    }
    slot += share
  }
  return { slotOf, slots: slot, pooled: true }
}

/** Lengths of the maximal runs of equal `groupOf`, in order. */
function runLengths(count: number, groupOf: (position: number) => number): number[] {
  const out: number[] = []
  let start = 0
  for (let i = 1; i <= count; i++) {
    if (i < count && groupOf(i) === groupOf(start)) continue
    out.push(i - start)
    start = i
  }
  return out
}

/**
 * Split `total` slots between runs in proportion to their size, giving every
 * run at least one — the largest-remainder method, so the shares sum to `total`
 * exactly rather than to whatever the rounding happened to produce.
 */
export function apportion(sizes: readonly number[], total: number): Int32Array {
  const n = sizes.length
  const share = new Int32Array(n)
  if (n === 0) return share
  const sum = sizes.reduce((a, b) => a + b, 0)
  // One each first; the rest are shared out by exact quota.
  const spare = total - n
  const remainders: Array<{ index: number; fraction: number }> = []
  let handed = 0
  for (let i = 0; i < n; i++) {
    const quota = sum === 0 ? 0 : (sizes[i] * spare) / sum
    const whole = Math.floor(quota)
    share[i] = 1 + whole
    handed += whole
    remainders.push({ index: i, fraction: quota - whole })
  }
  remainders.sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let k = 0; handed < spare; k++, handed++) {
    share[remainders[k % n].index] += 1
  }
  return share
}

/**
 * A symmetric `M × M` accumulator holding only its upper triangle.
 *
 * Two reasons, and the second is the larger. It halves the memory, which is what
 * sets the unit cap. And it removes the mirror write from the scan's inner loop
 * — `acc[b * n + a] += value`, a strided store into an array far larger than any
 * cache, which measured 3.9 ns/pixel at 256 units and 524 ns/pixel at 16,384.
 * The mirroring happens once, at the end, in a pass that is sequential.
 */
export class TriangleAccumulator {
  readonly n: number
  private readonly values: Float64Array

  constructor(n: number) {
    this.n = n
    this.values = new Float64Array((n * (n + 1)) / 2)
  }

  /** Add `value` to the cell `(a, b)`, in either order. */
  add(a: number, b: number, value: number): void {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    this.values[lo * this.n - (lo * (lo - 1)) / 2 + (hi - lo)] += value
  }

  /** Read back a cell, in either order. */
  get(a: number, b: number): number {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    return this.values[lo * this.n - (lo * (lo - 1)) / 2 + (hi - lo)]
  }

  /** The full square, mirrored, narrowed for the wire. */
  toSquare(): Float32Array {
    const { n, values } = this
    const out = new Float32Array(n * n)
    let at = 0
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++, at++) {
        const v = values[at]
        out[a * n + b] = v
        out[b * n + a] = v
      }
    }
    return out
  }
}
