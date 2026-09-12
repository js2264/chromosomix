/**
 * What a kernel that walks the diagonal is allowed to ask for.
 *
 * Three of the tasks in this subtree — the directionality index, the scalogram
 * and the HiC score — are the same shape of arithmetic: at every bin of one
 * sequence, look a bounded distance up the diagonal and a bounded distance down
 * it, and reduce what is there to one number. None of them needs the square, all
 * of them need the band, and `analysis/run/blocks.ts` already reads a band
 * without the square around it.
 *
 * What was missing was a **word for the thing being read**, and the reason it
 * matters is circularity. A circular sequence has no first bin and no last one:
 * the bin after the end is the beginning, the separation between two bins is the
 * shorter of the two ways round, and a kernel that knows this has to say so in
 * every index it computes. Three kernels each doing their own modular arithmetic
 * is three places for the wrap to be off by one, in a picture where an off-by-one
 * at the junction looks exactly like a real feature at the junction.
 *
 * So the wrap lives here, in one accessor, and the kernels are written as though
 * every sequence were linear:
 *
 * ```ts
 * for (let d = 1; d <= window; d++) downstream += band.forward(bin, d)
 * for (let d = 1; d <= window; d++) upstream += band.forward(bin - d, d)
 * ```
 *
 * On a linear sequence `forward` answers `NaN` for a row off either end, which
 * is what every kernel here already does with a missing cell. On a circular one
 * it answers the cell that is genuinely there, because on a circle there is no
 * off-the-end to be. Neither loop changes.
 *
 * Nothing in this module reads a file, and nothing in it names `MetaCooler`: it
 * is the vocabulary, and `analysis/run/blocks.ts` is what fills one in.
 */

/**
 * One sequence's near-diagonal contacts, as the kernels see them.
 *
 * **Separation-addressed, not coordinate-addressed**, which is the whole of why
 * this interface exists rather than a `(row, col)` one. A kernel asking for
 * `(row, col)` on a circular sequence has to decide for itself which of the two
 * arcs between them it meant, and has to put `col` back inside `[0, n)` before
 * asking — two decisions, at every call site, that are the wrap. Asking for *the
 * bin `offset` downstream of `row`* has one answer on both kinds of sequence.
 */
export interface SeparationBand {
  /** Bins in the sequence. */
  readonly n: number
  /** Largest separation this band can answer for. */
  readonly hi: number
  /** Whether the sequence joins its own end to its own beginning. */
  readonly circular: boolean
  /**
   * Contact between `row` and the bin `offset` further along, or `NaN`.
   *
   * `NaN` for three different things, and they are deliberately not told apart:
   * a row off the end of a linear sequence, a separation this band was not read
   * wide enough to hold, and a cell the balancer dropped. Every kernel here
   * treats all three the same way — it does not count — and a kernel that
   * treated one of them as a zero would draw a trough wherever the data merely
   * stopped.
   *
   * `offset` may be negative, and means what it says: `forward(i, -d)` is the
   * cell `d` bins *before* `i`, which is `forward(i - d, d)` written the way the
   * caller was thinking about it.
   */
  forward(row: number, offset: number): number
}

/**
 * The separation between two bins of a sequence of `n`, the short way round.
 *
 * `min(|i − j|, n − |i − j|)` on a circle and `|i − j|` on a line — the one
 * piece of arithmetic that makes a circular P(s) a decay rather than a decay
 * with a mirror image of itself stuck on the end. Exported because every
 * runner that bins by separation needs exactly this and none of them should
 * write it again.
 */
export function separation(i: number, j: number, n: number, circular: boolean): number {
  const d = Math.abs(i - j)
  return circular ? Math.min(d, n - d) : d
}

/**
 * The widest separation a sequence of `n` bins can have.
 *
 * Half the sequence when it is circular, because past that the short way round
 * is the other way and the distance starts falling again — so a band read wider
 * than this holds each cell twice and a curve plotted past it folds back on
 * itself. One bin less than the sequence when it is linear, which is the
 * distance between its two ends.
 */
export function maxSeparation(n: number, circular: boolean): number {
  return circular ? Math.floor(n / 2) : Math.max(0, n - 1)
}

/**
 * A dense square read as a band.
 *
 * For the tests and for the kernels' goldens: a square is what a reader can
 * check an answer against by hand, and every one of these kernels has to agree
 * cell for cell with the same arithmetic done over a whole matrix. It is also
 * what `analysis/run/blocks.ts` falls back to when the block on screen already
 * covers the sequence, so it is not test-only scaffolding.
 *
 * `values` is row-major and symmetric — which a block read out of this app
 * always is, because the reader mirrors the upper triangle it stores (§5.3).
 */
export function squareBand(
  values: ArrayLike<number>,
  n: number,
  options: { circular?: boolean; hi?: number } = {},
): SeparationBand {
  const circular = options.circular === true
  const hi = Math.max(
    0,
    Math.min(options.hi ?? maxSeparation(n, circular), maxSeparation(n, circular)),
  )
  // A plain function rather than a method, so a band whose `forward` has been
  // pulled out of it — which is what an inner loop does with one — still knows
  // how to answer a negative offset.
  const forward = (row: number, offset: number): number => {
    if (offset < 0) return forward(row + offset, -offset)
    if (offset > hi) return Number.NaN
    let r = row
    if (circular) {
      r = ((row % n) + n) % n
    } else if (r < 0 || r + offset >= n) {
      return Number.NaN
    }
    const c = circular ? (r + offset) % n : r + offset
    return values[r * n + c]
  }
  return { n, hi, circular, forward }
}
