/**
 * Resolutions the reader asks for and the file does not store (§3.4, §5.5).
 *
 * A `.mcool` carries the rungs whoever wrote it chose to write. `cooler zoomify`
 * defaults to doubling — 1, 2, 4, 8, 16 kb — and a great many published files
 * stop wherever the person running it stopped. So the reader who wants a 10 kb
 * picture of a file whose coarsest rung is 4 kb has, until now, had two options:
 * look at 4 kb and squint, or leave, run `cooler coarsen`, and come back. Both
 * are worse than the arithmetic, because the arithmetic is *free*: a 10 kb bin
 * is ten 1 kb bins added up, and this application has summed consecutive bins
 * into one cell since the whole-genome view was written (`pooling.ts`).
 *
 * ## What makes one doable
 *
 * **A whole number of some stored rung's bins, and nothing else.** A coarse bin
 * is a sum over fine ones; a fine bin either is inside it or is not. In a
 * `1 / 2 / 5 / 10 kb` ladder, 3 kb is three 1 kb bins — perfectly ordinary, and
 * *not* a rung anybody would have written, which is exactly why it is worth
 * offering. 2.5 kb is two and a half, and there is no such thing: half a bin's
 * contacts cannot be separated from the other half, because the file does not
 * record where inside a bin a contact landed. The refusal is not a limitation of
 * this implementation, and saying so is the difference between a control that
 * looks broken and one whose answer a reader can act on.
 *
 * Several rungs may divide a target — 20 kb is twenty 1 kb bins, ten 2 kb bins,
 * four 5 kb bins or two 10 kb bins — and the **coarsest** of them is taken. It
 * walks the fewest stored pixels for the same answer, which is `chooseRung`'s
 * argument in `ui/refine.ts` and the same one; and where the file was written
 * with `--balance`, its values were balanced at that rung rather than at the
 * finest, which is the better number to be summing. Ten thousand pixels or a
 * thousand, the picture is identical: that is what *exactly divides* means.
 *
 * ## What it is not
 *
 * It is not `cooler coarsen`, and the difference is one sentence long and worth
 * printing wherever this is offered. **Raw counts coarsen exactly**: the sum of
 * the counts in a block of fine bins *is* the count of the coarse bin, because a
 * contact is in exactly one fine bin and therefore in exactly one coarse one.
 * **Balanced values do not.** `cooler zoomify --balance` sums the raw counts and
 * then balances the coarse matrix, producing new weights fitted at that
 * resolution; summing balanced values instead applies the *fine* weights and
 * adds the results, which is a perfectly reasonable estimate of the same signal
 * and is what every aggregation in this field does — but it is an estimate, and
 * a reader comparing a derived 10 kb map against a colleague's `zoomify`d one
 * should know which of the two they are holding.
 *
 * That is also why a stored rung always wins: a derived rung that duplicates one
 * is refused rather than quietly shadowing it.
 */

/** One rung of a ladder: the entry's own name, and the bin size it means. */
export interface Rung {
  name: string
  binsize: number
}

/**
 * A resolution reached by summing whole bins of a rung the file does carry.
 *
 * `from` is the rung the read names and `factor` the bins per cell it asks for,
 * so `from.binsize * factor === binsize` by construction — the one invariant
 * everything downstream leans on, and the reason this is a type rather than a
 * pair of loose numbers passed about.
 */
export interface DerivedRung {
  /** The effective bin size, in base pairs. */
  binsize: number
  /** The stored rung its bins are summed from. */
  from: Rung
  /** How many of that rung's bins make one of these. Always `>= 2`. */
  factor: number
}

/**
 * The widest bin size worth offering, in base pairs.
 *
 * A hundred megabases is wider than any chromosome in common use, so a ladder
 * cannot reach it and a reader who typed it has slipped a decimal point. It is
 * a guard against a typo rather than a limit on the arithmetic — nothing breaks
 * at 200 Mb, there is simply no picture there.
 */
export const MAX_DERIVED_BP = 100_000_000

/**
 * How `target` would be reached, or `null` where it cannot be.
 *
 * Says nothing about whether it *should* be offered — a target that is already a
 * rung of the file has a perfectly good answer here and must still be refused.
 * {@link derivable} is the question a form asks; this is the arithmetic under it,
 * separated because the read side wants the arithmetic alone: a link arriving
 * with `coarsen=3000` needs to know which rung to open and by how much to pool,
 * not whether a dialog should have accepted it.
 */
export function coarsenTo(target: number, rungs: readonly Rung[]): DerivedRung | null {
  if (!Number.isFinite(target) || !Number.isInteger(target) || target <= 0) return null
  // Coarsest first, so the first that divides is the one that walks the fewest
  // stored pixels — and, on a `--balance`d file, the one whose values were
  // balanced closest to the resolution being asked for.
  const ordered = [...rungs].sort((a, b) => b.binsize - a.binsize)
  for (const from of ordered) {
    if (!Number.isInteger(from.binsize) || from.binsize <= 0) continue
    if (target <= from.binsize) continue
    if (target % from.binsize !== 0) continue
    return { binsize: target, from, factor: target / from.binsize }
  }
  return null
}

/** What a refusal is: the sentence, and the kind, for a test to name. */
export interface Refusal {
  kind: 'shape' | 'stored' | 'declared' | 'finer' | 'wide' | 'indivisible'
  why: string
}

/**
 * Whether the reader may add `target` to this ladder, and why not when not.
 *
 * Every refusal names what would have to change, because the alternative is a
 * dialog that greys its own button and leaves a reader guessing which of half a
 * dozen rules they broke. The indivisible case in particular: *2.5 kb is not a
 * whole number of 1 kb bins* is a fact somebody can act on — they type 2 kb or
 * 3 kb — while "invalid resolution" is not.
 *
 * @param declared Bin sizes the reader has already added, so the second attempt
 *   at the same number is told it is already there rather than silently doing
 *   nothing.
 */
export function derivable(
  target: number,
  rungs: readonly Rung[],
  declared: readonly number[] = [],
): DerivedRung | Refusal {
  if (!Number.isFinite(target) || target <= 0) {
    return { kind: 'shape', why: 'A resolution is a positive number of base pairs.' }
  }
  if (!Number.isInteger(target)) {
    // Before the divisibility test, and with its own sentence, because the two
    // failures look identical to a reader who typed `1.5` in the kilobase box
    // and cannot see that the app turned it into 1,500 bp — which is legal.
    return {
      kind: 'shape',
      why: `${target.toLocaleString('en-US')} bp is not a whole number of base pairs.`,
    }
  }
  if (target > MAX_DERIVED_BP) {
    return {
      kind: 'wide',
      why: `${(target / 1e6).toLocaleString('en-US')} Mb is wider than any chromosome — check the unit.`,
    }
  }
  const stored = rungs.find((rung) => rung.binsize === target)
  if (stored !== undefined) {
    return {
      kind: 'stored',
      why: 'This file already carries that resolution — it is on the ladder.',
    }
  }
  if (declared.includes(target)) {
    return { kind: 'declared', why: 'You have already added that resolution.' }
  }
  const finest = rungs.reduce(
    (least, rung) => Math.min(least, rung.binsize),
    Number.POSITIVE_INFINITY,
  )
  if (target < finest) {
    // The honest refusal, and the one worth being clear about: there is no
    // arithmetic that invents detail the file does not hold, so a finer
    // resolution is not a harder version of this feature — it is a different
    // file.
    return {
      kind: 'finer',
      why: `Finer than this file's own ${finest.toLocaleString('en-US')} bp bins. Bins can be added up, never split.`,
    }
  }
  const derived = coarsenTo(target, rungs)
  if (derived !== null) return derived
  return {
    kind: 'indivisible',
    why: `Not a whole number of bins of any resolution this file carries (${rungs
      .map((rung) => rung.binsize.toLocaleString('en-US'))
      .join(', ')} bp).`,
  }
}

/** Whether `derivable` said yes. */
export function isDerived(answer: DerivedRung | Refusal): answer is DerivedRung {
  return 'factor' in answer
}

/**
 * The stored rungs and the reader's own, as one ladder in bin-size order.
 *
 * One list, because the picker draws one row: a resolution the reader added sits
 * where its number says it sits — 3 kb before 5 kb — rather than in a second
 * group at the end, which would make the ladder's own order a lie about which
 * of two pictures is coarser. `derived` says which is which, and that is what
 * the `*` beside the label is drawn from.
 *
 * A declared size that is no longer derivable is dropped rather than shown
 * broken: the reader may have added 3 kb against one entry of an `.mmetacool`
 * and navigated to another whose ladder starts at 2 kb, and a stop that cannot
 * be read is worse than one that is not offered.
 */
export function ladderWith(
  rungs: readonly Rung[],
  declared: readonly number[],
): Array<Rung & { derived?: DerivedRung }> {
  const stored = new Set(rungs.map((rung) => rung.binsize))
  const out: Array<Rung & { derived?: DerivedRung }> = rungs.map((rung) => ({ ...rung }))
  for (const binsize of new Set(declared)) {
    if (stored.has(binsize)) continue
    const derived = coarsenTo(binsize, rungs)
    if (derived === null) continue
    out.push({ name: String(binsize), binsize, derived })
  }
  return out.sort((a, b) => a.binsize - b.binsize)
}

/**
 * The grid of a derived rung over a map's own bins: each sequence's bins summed
 * `factor` at a time from its own first bin, its last cell holding whatever is
 * left — `contigStart + m·k`, the grid the map is drawn on (`snapToGrid`) and
 * the one `cooler coarsen` writes.
 *
 * What a task reading the map *at* a derived rung is framed by (§3.4, §18.4):
 * the offsets the coarser map's sequences start at, and the two directions of
 * the arithmetic — the fine bins a coarse extent holds, for the read, and the
 * fewest coarse bins holding a fine extent, for the window a view drew. Pure,
 * so the page that frames a task and the worker that runs it share one grid.
 */
export class CoarseGrid {
  private constructor(
    /** Fine bins to a coarse one. */
    readonly factor: number,
    /** The fine map's `chrom_offset`. */
    readonly fineOffset: Float64Array,
    /** The coarse map's `chrom_offset`: `ceil(n / factor)` bins for a sequence of `n`. */
    readonly chromOffset: Float64Array,
  ) {}

  /** The grid over a map whose sequences start at these bins. */
  static of(fineOffset: ArrayLike<number>, factor: number): CoarseGrid {
    const fine = Float64Array.from(fineOffset)
    const coarse = new Float64Array(fine.length)
    for (let c = 0; c + 1 < fine.length; c++) {
      coarse[c + 1] = coarse[c] + Math.ceil((fine[c + 1] - fine[c]) / factor)
    }
    return new CoarseGrid(factor, fine, coarse)
  }

  /** The coarse map's bins. */
  get nBins(): number {
    return this.chromOffset[this.chromOffset.length - 1] ?? 0
  }

  /** The fine map's bins. */
  get fineBins(): number {
    return this.fineOffset[this.fineOffset.length - 1] ?? 0
  }

  /** The coarse bin a fine bin is summed into; the coarse total past the last. */
  coarseBin(bin: number): number {
    if (bin >= this.fineBins) return this.nBins
    const c = sequenceAt(this.fineOffset, bin)
    return this.chromOffset[c] + Math.floor((bin - this.fineOffset[c]) / this.factor)
  }

  /** The first fine bin a coarse one sums; the fine total past the last. */
  fineBin(bin: number): number {
    if (bin >= this.nBins) return this.fineBins
    const c = sequenceAt(this.chromOffset, bin)
    return this.fineOffset[c] + (bin - this.chromOffset[c]) * this.factor
  }

  /** The fine bins a coarse extent sums. */
  toFine(extent: readonly [number, number]): [number, number] {
    return [this.fineBin(extent[0]), this.fineBin(extent[1])]
  }

  /** The fewest coarse bins holding every fine bin of an extent. */
  toCoarse(extent: readonly [number, number]): [number, number] {
    const lo = this.coarseBin(extent[0])
    return extent[1] <= extent[0] ? [lo, lo] : [lo, this.coarseBin(extent[1] - 1) + 1]
  }

  /** Every fine bin's coarse bin, for a pass over pixels. */
  coarseIndex(): Int32Array {
    const out = new Int32Array(this.fineBins)
    for (let c = 0; c + 1 < this.fineOffset.length; c++) {
      const base = this.chromOffset[c]
      const from = this.fineOffset[c]
      for (let bin = from; bin < this.fineOffset[c + 1]; bin++) {
        out[bin] = base + Math.floor((bin - from) / this.factor)
      }
    }
    return out
  }
}

/**
 * A derived rung with the grid its stored rung's bins are summed on: what a task
 * reading the map at it is framed by — the window a view drew, carried onto the
 * coarse bins, and the bin size its results are measured at (§18.4).
 */
export interface DerivedGrid {
  rung: DerivedRung
  grid: CoarseGrid
}

/**
 * The sequence a bin is in, by its offsets: the last whose first bin is at or
 * before it — past every sequence of no bins, which start where the next does.
 */
function sequenceAt(offsets: Float64Array, bin: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (offsets[mid] <= bin) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

/**
 * The bins of each sequence at `binsize`, as a cooler lays them out: one more
 * for whatever is left at the end. What a page that has a sequence table and no
 * offsets frames a coarse grid from.
 */
export function offsetsOf(lengths: ArrayLike<number>, binsize: number): Float64Array {
  const out = new Float64Array(lengths.length + 1)
  for (let c = 0; c < lengths.length; c++) out[c + 1] = out[c] + Math.ceil(Number(lengths[c]) / binsize)
  return out
}
