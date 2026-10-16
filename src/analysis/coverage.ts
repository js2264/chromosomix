/**
 * How much contact each bin carries, split into cis and trans.
 *
 * The cheapest diagnostic there is and one of the most useful, which is why it
 * is a first-class task rather than something a reader is expected to infer from
 * the picture (§18.8). Three things it answers that a contact map does not:
 *
 * - **A domain that is really a coverage artefact.** A stretch of low marginal
 *   is pale on the map for the same reason a compartment is, and the only way to
 *   tell them apart is to have both tracks under the picture at once.
 * - **Whether balancing worked.** A balanced matrix should have a flat total
 *   marginal by construction, so a balanced track that is *not* flat is a file
 *   whose weights do not fit it.
 * - **The cis/trans ratio**, which on a metagenome is the per-contig version of
 *   the question the whole file is being read to answer: does this sequence keep
 *   to itself?
 *
 * A marginal is a sum over *every* pixel that touches a bin, so unlike almost
 * everything else in this subtree it cannot be read off one block unless that
 * block is the whole file. The accumulator here is therefore built to be fed
 * either way — a dense square, or a stream of pixels — and to give the same
 * answer from both.
 */

/** Which sequence each bin belongs to, so a pixel can be called cis or trans. */
export type BinContig = Int32Array

/**
 * Running marginals over every bin of a file.
 *
 * `Float64Array` throughout, and not because the totals are large: a marginal is
 * a sum over thousands of pixels, and float32 accumulation drifts by a few parts
 * in a thousand over that many additions — which is invisible on a track and
 * fatal to a cis/trans *ratio*, where the two sums are differenced against each
 * other.
 */
export class CoverageAccumulator {
  readonly cis: Float64Array
  readonly trans: Float64Array

  /**
   * @param covered Whether a bin was looked at at all. Everything by default.
   *
   * This is the distinction the two feeding paths would otherwise disagree
   * about, and it is subtler than it looks. A dense block writes an explicit
   * zero into every empty cell, so a bin with no contacts still *appears*; a
   * sparse scan never sees that bin at all, because cooler stores only the
   * non-zeros. Marking a bin as a gap because no pixel arrived would therefore
   * make the two paths give different answers for the same file — and it would
   * be the sparse one that was wrong, since an absent pixel in a cooler is a
   * measured zero rather than a missing measurement.
   *
   * A bin is a genuine gap for exactly one reason: it was excluded. That is a
   * `NaN` balancing weight (§6.4), which is a bin the balancer *dropped*, and
   * the caller is the only thing that knows about it.
   */
  constructor(
    readonly nBins: number,
    private readonly contigOf: BinContig,
    private readonly covered: ((bin: number) => boolean) | null = null,
  ) {
    this.cis = new Float64Array(nBins)
    this.trans = new Float64Array(nBins)
  }

  /**
   * Add one stored pixel, to both of the bins it touches.
   *
   * **Both**, and the diagonal exactly once. A marginal is a sum over the row
   * *and* the column — the pixel `(i, j)` is contact belonging to `i` and to `j`
   * alike — so an upper-triangular store has to be mirrored here or every bin
   * reports half its contacts. The diagonal is its own mirror, and adding it
   * twice is the classic way a coverage track comes out with a spike on every
   * bin that has a strong self-contact.
   */
  add(bin1: number, bin2: number, value: number): void {
    if (!Number.isFinite(value)) return
    if (bin1 < 0 || bin1 >= this.nBins || bin2 < 0 || bin2 >= this.nBins) return
    const target = this.contigOf[bin1] === this.contigOf[bin2] ? this.cis : this.trans
    target[bin1] += value
    if (bin1 === bin2) return
    target[bin2] += value
  }

  /**
   * A chunk of stored pixels, each exactly as {@link add} takes it — balanced
   * by `weights` where they are given, as `raw × w[i] × w[j]` in that order.
   *
   * One loop over the chunk's arrays rather than a call per pixel: a whole-file
   * scan feeds tens of millions of them, and the same tests in the same order
   * give the same sums to the last bit.
   */
  addPixels(
    bin1: Int32Array,
    bin2: Int32Array,
    count: Float64Array,
    length: number,
    weights: Float64Array | null,
  ): void {
    const { cis, trans, contigOf, nBins } = this
    for (let i = 0; i < length; i++) {
      const b1 = bin1[i]
      const b2 = bin2[i]
      const value = weights === null ? count[i] : count[i] * weights[b1] * weights[b2]
      if (!Number.isFinite(value)) continue
      if (b1 < 0 || b1 >= nBins || b2 < 0 || b2 >= nBins) continue
      const target = contigOf[b1] === contigOf[b2] ? cis : trans
      target[b1] += value
      if (b1 !== b2) target[b2] += value
    }
  }

  /**
   * Add a dense block, which is only the whole answer for a whole-file block.
   *
   * A dense square that was mirrored out of an upper-triangular store holds each
   * off-diagonal pair twice, so this walks the cells as they are and lets
   * {@link add} see each *stored* pair once: the upper triangle plus the
   * diagonal. Walking all of it and calling `add` on every cell would double
   * every off-diagonal contribution, which is the same factor-of-two the
   * expected accumulator warns about and is *not* self-cancelling here, because
   * a marginal has no denominator.
   */
  addBlock(block: {
    nrows: number
    ncols: number
    values: Float32Array
    rowExtent: readonly [number, number]
    colExtent: readonly [number, number]
  }): void {
    const { nrows, ncols, values } = block
    for (let r = 0; r < nrows; r++) {
      const bin1 = block.rowExtent[0] + r
      const base = r * ncols
      for (let c = 0; c < ncols; c++) {
        const bin2 = block.colExtent[0] + c
        if (bin2 < bin1) continue
        this.add(bin1, bin2, values[base + c])
      }
    }
  }

  /**
   * The four tracks, as bin vectors with gaps where nothing landed.
   *
   * A bin that was *excluded* is `NaN` throughout; a bin that was looked at and
   * found empty is `0`. The two are genuinely different claims — *nothing was
   * measured here* against *nothing is here* — and both occur: the balancer
   * drops bins, and a metagenome is full of contigs that are in the assembly, in
   * the bin grid, and have no contacts at all. Which is which is
   * {@link covered}'s to say, for the reason its own comment gives.
   */
  finish(): {
    total: Float64Array
    cis: Float64Array
    trans: Float64Array
    cisFraction: Float64Array
  } {
    const total = new Float64Array(this.nBins)
    const cis = new Float64Array(this.nBins)
    const trans = new Float64Array(this.nBins)
    const cisFraction = new Float64Array(this.nBins)
    for (let bin = 0; bin < this.nBins; bin++) {
      if (this.covered !== null && !this.covered(bin)) {
        total[bin] = Number.NaN
        cis[bin] = Number.NaN
        trans[bin] = Number.NaN
        cisFraction[bin] = Number.NaN
        continue
      }
      const c = this.cis[bin]
      const t = this.trans[bin]
      total[bin] = c + t
      cis[bin] = c
      trans[bin] = t
      // A fraction and not a ratio, deliberately. `cis / trans` is unbounded and
      // is `Infinity` for every contig with no trans contact at all — which is
      // most of a well-binned metagenome, and which no bigWig can carry (§18.7).
      // `cis / (cis + trans)` says the same thing on `[0, 1]`.
      //
      // A bin with no contacts at all has no fraction: zero of zero is not zero,
      // and drawing it at the floor would put a bin that was never in contact
      // with anything in the same place as one that only ever reaches other
      // sequences. That one *is* a gap, even though its coverage is a real zero.
      cisFraction[bin] = c + t > 0 ? c / (c + t) : Number.NaN
    }
    return { total, cis, trans, cisFraction }
  }
}

/**
 * Which contig each bin belongs to, from the contig layout.
 *
 * One `Int32Array` over every bin rather than a search per pixel: a whole-file
 * scan asks this question once per stored pixel, of which there are tens of
 * millions, and a binary search per question is the difference between a scan
 * that takes seconds and one that takes minutes.
 */
export function binContigMap(
  contigs: ReadonlyArray<{ startBin: number; bins: number }>,
  nBins: number,
): BinContig {
  const out = new Int32Array(nBins).fill(-1)
  for (let id = 0; id < contigs.length; id++) {
    const contig = contigs[id]
    const to = Math.min(nBins, contig.startBin + contig.bins)
    for (let bin = contig.startBin; bin < to; bin++) out[bin] = id
  }
  return out
}
