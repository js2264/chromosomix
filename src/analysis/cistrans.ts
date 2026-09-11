/**
 * What each sequence's contacts do: stay at home, or go somewhere else.
 *
 * The same accumulation `analysis/mags.ts` performs over genomes, performed over
 * **sequences** — and it is a separate module rather than a parameter on that
 * one because the two are offered on different files and answer different
 * questions. A MAG's intra fraction is a statement about a binning. A
 * chromosome's is a statement about the library and about the karyotype: the
 * cis/trans ratio is the first number anybody quotes of a Hi-C experiment, and
 * the off-diagonal block that stands far above the rest is where a translocation,
 * a fusion, or a centromere cluster lives.
 *
 * ## Why the pairs are sparse and the marginals are not
 *
 * `nContigs²` is 400 cells on a yeast genome and 19 million on a metagenome with
 * four thousand contigs, so the dense array `GenomeContactAccumulator` can
 * afford is one this cannot. What makes a map a contact map, though, is that
 * almost none of those pairs have any contact at all — so the pairs are held in
 * a `Map` keyed by the two ends, which costs what the data costs rather than
 * what the assembly's square does, and is capped so that a pathological file
 * degrades into *the marginals, and a sentence saying the pairs were dropped*
 * rather than into an out-of-memory tab.
 *
 * The marginals stay dense: they are `nContigs` long, which is small in every
 * case this application opens at all.
 */

/**
 * How many distinct sequence pairs are worth holding.
 *
 * Eight million entries is a few hundred megabytes of `Map` overhead, which is
 * past what a tab should spend on a diagnostic — and a file that reaches it has
 * a sequence pair count the ranked table below could not be read from anyway.
 * The marginals do not stop when this is hit; only the pairs do, and the run
 * says so.
 */
export const MAX_SEQUENCE_PAIRS = 8_000_000

/** Per-sequence contact totals, and the pairs between them. */
export class SequenceContactAccumulator {
  /** `cis[c]` — contacts with both ends on sequence `c`. */
  readonly cis: Float64Array
  /** `trans[c]` — contacts with exactly one end on sequence `c`. */
  readonly trans: Float64Array
  /** Trans contacts, counted once each rather than once per end. */
  transTotal = 0
  /** Contacts dropped for having an end outside every sequence. */
  dropped = 0
  /** `true` once {@link MAX_SEQUENCE_PAIRS} was reached and pairs stopped. */
  pairsOverflowed = false

  /** `a * nContigs + b` with `a < b`, to the contacts between them. */
  private readonly between = new Map<number, number>()

  constructor(readonly nContigs: number) {
    this.cis = new Float64Array(nContigs)
    this.trans = new Float64Array(nContigs)
  }

  /**
   * Add one stored pixel, by the sequences of its two ends.
   *
   * A sequence of `-1` is a bin outside every contig, which a well-formed file
   * does not have; it is counted rather than ignored so that a file which does
   * says so in a note instead of quietly reporting marginals that do not sum to
   * the map.
   */
  add(contig1: number, contig2: number, value: number): void {
    if (!Number.isFinite(value)) return
    if (contig1 < 0 || contig2 < 0) {
      this.dropped += value
      return
    }
    if (contig1 === contig2) {
      this.cis[contig1] += value
      return
    }
    // Once per **end** on the marginals and once per **contact** on the total,
    // and the difference is the whole of the arithmetic below: a trans contact
    // is one contact and two sequences' worth of trans coverage, so `Σ trans` is
    // twice `transTotal` by construction and the expectation divides by two to
    // get back to contacts.
    this.trans[contig1] += value
    this.trans[contig2] += value
    this.transTotal += value

    const a = contig1 < contig2 ? contig1 : contig2
    const b = contig1 < contig2 ? contig2 : contig1
    const key = a * this.nContigs + b
    const held = this.between.get(key)
    if (held !== undefined) {
      this.between.set(key, held + value)
    } else if (this.between.size < MAX_SEQUENCE_PAIRS) {
      this.between.set(key, value)
    } else {
      this.pairsOverflowed = true
    }
  }

  /** Contacts between two sequences, in either order. */
  pair(contig1: number, contig2: number): number {
    if (contig1 === contig2) return this.cis[contig1]
    const a = contig1 < contig2 ? contig1 : contig2
    const b = contig1 < contig2 ? contig2 : contig1
    return this.between.get(a * this.nContigs + b) ?? 0
  }

  /** Every pair that has any contact, as `[a, b, contacts]` with `a < b`. */
  *pairs(): Generator<[number, number, number]> {
    for (const [key, value] of this.between) {
      const a = Math.floor(key / this.nContigs)
      yield [a, key - a * this.nContigs, value]
    }
  }
}

/**
 * What two sequences would contact each other if contact were indifferent to
 * which sequences they were.
 *
 * `T_a · T_b / (2 · T)`, where `T_x` is the sequence's own trans coverage and
 * `T` the number of trans contacts. It is the independence model — the same one
 * a χ² table is read against, and the same shape as the trans expectation
 * §18.8's compartment chain divides a trans cell by — and the factor of two is
 * there because `Σ T_x = 2T`: each trans contact is counted at both of its ends.
 * Getting that two wrong is the easiest mistake here and the least visible:
 * every enrichment comes out at half, uniformly, which reads as a property of
 * the library rather than as arithmetic.
 *
 * **It is a function of the accumulator rather than of three numbers**, because
 * of the one correction the raw formula needs. Summed over every pair, the raw
 * expectation comes to `T − Σ T_x² / (4T)` rather than to `T`: the model assigns
 * a share of the mass to a sequence contacting *itself*, which is not a trans
 * contact and is not in the table. Left uncorrected, every enrichment on the map
 * is scaled by the same factor above one — 10 % on a three-sequence file, a
 * fraction of a per cent on a real assembly — and a picture centred on 1 would
 * be centred on nothing in particular. So the scale is worked out once, from the
 * marginals, and the expectation sums to the contacts there actually are.
 */
export function transExpectation(
  trans: Float64Array,
  transTotal: number,
): (a: number, b: number) => number {
  if (!(transTotal > 0)) return () => Number.NaN
  let squares = 0
  for (let i = 0; i < trans.length; i++) squares += trans[i] * trans[i]
  // `Σ_{a<b} T_a T_b / (2T)` is `((ΣT)² − ΣT²) / (4T)`, which is `T − ΣT²/(4T)`
  // — so the scale that makes it sum to `T` is this, in closed form and without
  // walking the `n²` pairs the sum is over.
  const denominator = 4 * transTotal * transTotal - squares
  const scale = denominator > 0 ? (4 * transTotal * transTotal) / denominator : 1
  return (a, b) => (scale * trans[a] * trans[b]) / (2 * transTotal)
}
