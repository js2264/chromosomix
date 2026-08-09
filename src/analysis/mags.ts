/**
 * What a metagenome's contacts say about its binning.
 *
 * The tasks nothing else offers, and the reason §18.8 says the Analysis panel is
 * not nearly empty on this app's primary format. Every one of them answers a
 * question about the *bins* rather than about the biology inside them:
 *
 * - **Does this MAG keep to itself?** A genome whose contacts mostly leave it is
 *   a genome that is probably several things, or that is mostly noise.
 * - **Does this contig belong where it was put?** A contig whose contacts point
 *   overwhelmingly at another MAG is a contamination call, and it is a call the
 *   contact data can make and no composition-based binner can.
 * - **Is this MAG one organism?** A contig-level matrix that falls into two
 *   blocks with little between them is a chimera.
 *
 * All three come from the same walk over the pixel table, which is why the
 * accumulators are here together rather than in three modules: a reader who
 * wants two of them should pay for one scan.
 *
 * `__unbinned__` never appears as a genome in any of this (§7.4), and it is kept
 * out by the caller's display list rather than by matching the reserved name a
 * second time.
 */

/** Per-genome contact totals. */
export class GenomeContactAccumulator {
  /** `intra[g]` — contacts with both ends in genome `g`. */
  readonly intra: Float64Array
  /** `inter[g]` — contacts with exactly one end in genome `g`. */
  readonly inter: Float64Array
  /**
   * Genome-by-genome totals, for the network.
   *
   * `nGenomes²` doubles, which is the one thing here that does not scale
   * indefinitely: a 4,395-MAG file is 19 million cells and 154 MB. Allocated
   * only when the caller asks for it, so the QC pass that does not need a
   * network does not pay for one.
   */
  readonly pairs: Float64Array | null

  constructor(
    readonly nGenomes: number,
    options: { pairs?: boolean } = {},
  ) {
    this.intra = new Float64Array(nGenomes)
    this.inter = new Float64Array(nGenomes)
    this.pairs = options.pairs === true ? new Float64Array(nGenomes * nGenomes) : null
  }

  /**
   * Add one stored pixel, by the genomes of its two ends.
   *
   * A genome of `-1` is a bin no displayable genome claims — `__unbinned__`'s
   * contigs, or a bin outside every contig — and its contacts are dropped
   * entirely rather than counted as inter. Counting them would make every real
   * MAG look leakier in proportion to how badly the *rest* of the file was
   * binned, which is the opposite of a per-MAG diagnostic.
   */
  add(genome1: number, genome2: number, value: number): void {
    if (!Number.isFinite(value)) return
    if (genome1 < 0 || genome2 < 0) return
    if (genome1 === genome2) {
      this.intra[genome1] += value
    } else {
      this.inter[genome1] += value
      this.inter[genome2] += value
    }
    if (this.pairs === null) return
    this.pairs[genome1 * this.nGenomes + genome2] += value
    if (genome1 !== genome2) this.pairs[genome2 * this.nGenomes + genome1] += value
  }
}

/**
 * Per-contig purity, and which MAG a stray contig is straying towards.
 *
 * `own` and `other` are two numbers per contig and cost nothing. The *partner*
 * breakdown is a map per contig, and it is the one unbounded thing in this
 * module — a contig that touches four hundred MAGs has four hundred entries. So
 * it is capped, and the cap is reported rather than silently applied: a contig
 * that hit the cap has its top partner computed from the partners it saw first,
 * which is a real limitation and not one a reader should have to guess at.
 */
export class ContigPurityAccumulator {
  readonly own: Float64Array
  readonly other: Float64Array
  private readonly partners: Array<Map<number, number> | null>
  private capped = 0

  constructor(
    readonly nContigs: number,
    private readonly genomeOfContig: Int32Array,
    private readonly maxPartners = 32,
  ) {
    this.own = new Float64Array(nContigs)
    this.other = new Float64Array(nContigs)
    this.partners = new Array<Map<number, number> | null>(nContigs).fill(null)
  }

  add(contig1: number, contig2: number, value: number): void {
    if (!Number.isFinite(value)) return
    if (contig1 < 0 || contig2 < 0 || contig1 >= this.nContigs || contig2 >= this.nContigs) return
    const g1 = this.genomeOfContig[contig1]
    const g2 = this.genomeOfContig[contig2]
    if (g1 < 0 || g2 < 0) return
    if (g1 === g2) {
      this.own[contig1] += value
      if (contig1 !== contig2) this.own[contig2] += value
      return
    }
    this.other[contig1] += value
    this.other[contig2] += value
    this.note(contig1, g2, value)
    this.note(contig2, g1, value)
  }

  private note(contig: number, genome: number, value: number): void {
    let held = this.partners[contig]
    if (held === null) {
      held = new Map()
      this.partners[contig] = held
    }
    const current = held.get(genome)
    if (current !== undefined) {
      held.set(genome, current + value)
      return
    }
    if (held.size >= this.maxPartners) {
      this.capped++
      return
    }
    held.set(genome, value)
  }

  /** The MAG a contig sends most of its outside contacts to, and how much. */
  topPartner(contig: number): { genome: number; value: number } | null {
    const held = this.partners[contig]
    if (held === null) return null
    let best = -1
    let value = 0
    for (const [genome, total] of held) {
      if (total > value) {
        best = genome
        value = total
      }
    }
    return best < 0 ? null : { genome: best, value }
  }

  /** How many partner observations were dropped for want of room. */
  get droppedPartners(): number {
    return this.capped
  }
}

/**
 * Which genome each bin belongs to, or `-1`.
 *
 * The same trade `analysis/coverage.ts` makes for contigs and for the same
 * reason: a whole-file scan asks this once per stored pixel, of which there are
 * tens of millions, and a binary search per question is the difference between
 * seconds and minutes.
 */
export function binGenomeMap(
  contigs: ReadonlyArray<{ startBin: number; bins: number; genome: number }>,
  nBins: number,
  allowed: ReadonlySet<number> | null,
): Int32Array {
  const out = new Int32Array(nBins).fill(-1)
  for (const contig of contigs) {
    if (contig.genome < 0) continue
    if (allowed !== null && !allowed.has(contig.genome)) continue
    const to = Math.min(nBins, contig.startBin + contig.bins)
    for (let bin = contig.startBin; bin < to; bin++) out[bin] = contig.genome
  }
  return out
}

/** Which contig each bin belongs to, or `-1`. */
export function binContigIndex(
  contigs: ReadonlyArray<{ startBin: number; bins: number }>,
  nBins: number,
): Int32Array {
  const out = new Int32Array(nBins).fill(-1)
  for (let id = 0; id < contigs.length; id++) {
    const to = Math.min(nBins, contigs[id].startBin + contigs[id].bins)
    for (let bin = contigs[id].startBin; bin < to; bin++) out[bin] = id
  }
  return out
}
