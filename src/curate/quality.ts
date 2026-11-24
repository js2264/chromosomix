/**
 * A genome's completeness and redundancy, recomputed from the marker genes of
 * its contigs (SPECS §33.5): miComplete's four numbers, for any set of contigs.
 *
 * `metator markers` stores, for every contig of a map, the marker genes
 * miComplete finds in it — `/contigs/markers_Bact105` and `markers_Arch131`,
 * each `NAME,NAME*COUNT,…` — and, in the map's metadata, both marker sets in
 * their HMM files' order with miComplete's weights. miComplete's numbers for a
 * bin are sums over the bin's genes, so for a set of contigs they are sums over
 * its contigs' markers, and the arithmetic below is miComplete's own
 * (`completeness.py`, `micomplete.py`, 1.1.1), rounding included:
 *
 * - **Completeness**: the markers present over the markers of the set.
 * - **Redundancy**: every accepted hit over the markers present.
 * - **Weighted completeness**: the weights of the markers miComplete **sees** —
 *   present, or seen and dropped by its suspicion check (`NAME*0` in the
 *   column: its `seen_hmms` is filled before the check, its present markers
 *   after); `0.0001` where that rounds to nothing.
 * - **Weighted redundancy**: the weights of the markers present twice or more —
 *   each once, whatever its copies — plus the seen weights, over the seen
 *   weights, unrounded.
 *
 * Every number is Python's `round(x, 4)`: half to even, on the binary value the
 * division made — which `toFixed` is not (`1.03125` is `1.0312` in Python and
 * `"1.0313"` in JavaScript). Of the two sets, the one with the higher weighted
 * completeness, bacteria on a tie, as metaTOR chooses (`merge_micomplete`).
 */

/** One marker set as the map's metadata gives it. */
export interface MarkerSet {
  /** `Bact105`, `Arch131`: the set's name, as the column `markers_<name>` carries it. */
  name: string
  /** Every marker of the set, in the HMM file's order. */
  markers: readonly string[]
  /** miComplete's weight of each, in the same order. */
  weights: readonly number[]
}

/** miComplete's four numbers for a set of contigs, under one marker set. */
export interface Quality {
  set: string
  /** Markers present, and markers in the set. */
  present: number
  markers: number
  /** Every accepted hit, a marker present twice counted twice. */
  hits: number
  completeness: number
  redundancy: number
  weightedCompleteness: number
  weightedRedundancy: number
  /** The markers present twice or more: what a redundancy above 1 is made of. */
  duplicated: string[]
}

/**
 * The markers of a contig, from its column's text: `Ribosomal_L22,SecY*2` is one
 * `Ribosomal_L22` and two `SecY`, and `CoaE*0` a marker miComplete saw and
 * dropped. An empty text is none. A term this build cannot read is skipped,
 * never guessed: a count that is not a whole number, or below nought.
 */
export function parseMarkers(text: string): Map<string, number> {
  const out = new Map<string, number>()
  if (text === '') return out
  for (const term of text.split(',')) {
    const trimmed = term.trim()
    if (trimmed === '') continue
    const star = trimmed.lastIndexOf('*')
    const name = star === -1 ? trimmed : trimmed.slice(0, star)
    const count = star === -1 ? 1 : Number(trimmed.slice(star + 1))
    if (name === '' || !Number.isInteger(count) || count < 0) continue
    out.set(name, (out.get(name) ?? 0) + count)
  }
  return out
}

/**
 * Every contig's markers under one set, as counts per marker index of the set:
 * read once per map, so a genome's numbers are a sum of small integer vectors.
 *
 * @param texts The column `markers_<set>`, one text per contig in the map's order.
 */
export function markerTable(set: MarkerSet, texts: readonly string[]): ContigMarkers {
  const index = new Map(set.markers.map((name, k) => [name, k]))
  const offsets = new Int32Array(texts.length + 1)
  const ids: number[] = []
  const counts: number[] = []
  for (let c = 0; c < texts.length; c++) {
    for (const [name, count] of parseMarkers(texts[c] ?? '')) {
      const k = index.get(name)
      // A marker the set does not list is not one of its markers: miComplete
      // counts only the set's own HMMs.
      if (k === undefined) continue
      ids.push(k)
      counts.push(count)
    }
    offsets[c + 1] = ids.length
  }
  return { set, offsets, ids: Int32Array.from(ids), counts: Int32Array.from(counts) }
}

/** One set's markers of every contig, CSR by contig. */
export interface ContigMarkers {
  set: MarkerSet
  /** Contig `c`'s markers are `ids[offsets[c]]…ids[offsets[c + 1] - 1]`. */
  offsets: Int32Array
  /** Marker indices into `set.markers`. */
  ids: Int32Array
  counts: Int32Array
}

/**
 * The per-marker hits of a set of contigs: `-1` for a marker none of them shows,
 * `0` for one seen and dropped, else the accepted hits.
 */
export function markerCounts(table: ContigMarkers, contigs: Iterable<number>): Int32Array {
  const out = new Int32Array(table.set.markers.length).fill(-1)
  for (const c of contigs) {
    for (let k = table.offsets[c]; k < table.offsets[c + 1]; k++) {
      const m = table.ids[k]
      out[m] = out[m] < 0 ? table.counts[k] : out[m] + table.counts[k]
    }
  }
  return out
}

/** Two sets' per-marker hits together, `-1` where neither shows the marker. */
export function addCounts(a: ArrayLike<number>, b: ArrayLike<number>): Int32Array {
  const out = new Int32Array(a.length)
  for (let k = 0; k < a.length; k++) out[k] = a[k] < 0 && b[k] < 0 ? -1 : Math.max(a[k], 0) + Math.max(b[k], 0)
  return out
}

/**
 * miComplete's four numbers from a set's per-marker hits (see
 * {@link markerCounts}: `-1` unseen, `0` seen and dropped).
 */
export function qualityOf(set: MarkerSet, counts: ArrayLike<number>): Quality {
  let present = 0
  let hits = 0
  let weighted = 0
  let duplicated = 0
  const twice: string[] = []
  for (let k = 0; k < set.markers.length; k++) {
    const n = counts[k] ?? -1
    if (n < 0) continue
    const w = set.weights[k] ?? 0
    // Seen, whether its hits passed the suspicion check or not.
    weighted += w
    if (n === 0) continue
    present++
    hits += n
    // A marker present twice or more weighs once in the redundancy, whatever
    // its copies (`attribute_weights`).
    if (n > 1) {
      duplicated += w
      twice.push(set.markers[k])
    }
  }
  const markers = set.markers.length
  if (present === 0) {
    // miComplete divides by the markers present for the redundancy and catches
    // the division by nought, and writes 0 for both weighted numbers.
    return { set: set.name, present, markers, hits, completeness: 0, redundancy: 0, weightedCompleteness: 0, weightedRedundancy: 0, duplicated: twice }
  }
  // The weighted redundancy is over the weighted completeness before it is
  // rounded, as miComplete computes it.
  const weightedRedundancy = pyRound((duplicated + weighted) / weighted, 4)
  let weightedCompleteness = pyRound(weighted, 4)
  if (weightedCompleteness === 0) weightedCompleteness = 0.0001
  return {
    set: set.name,
    present,
    markers,
    hits,
    completeness: markers === 0 ? 0 : pyRound(present / markers, 4),
    redundancy: pyRound(hits / present, 4),
    weightedCompleteness,
    weightedRedundancy,
    duplicated: twice,
  }
}

/**
 * The numbers metaTOR keeps for a set of contigs: of every set's, the one with
 * the higher weighted completeness — the first set listed on a tie, which is
 * bacteria in the order metaTOR stores them.
 */
export function bestQuality(tables: readonly ContigMarkers[], contigs: readonly number[]): Quality | null {
  let best: Quality | null = null
  for (const table of tables) {
    const quality = qualityOf(table.set, markerCounts(table, contigs))
    if (best === null || quality.weightedCompleteness > best.weightedCompleteness) best = quality
  }
  return best
}

/**
 * Python's `round(x, digits)` for a float: the decimal nearest the **exact**
 * binary value of `x`, half to even, as a float again. Computed exactly, with
 * the mantissa and exponent as integers, since `x * 10 ** digits` would round
 * before the rounding is decided.
 */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x
  const negative = x < 0
  const { mantissa, exponent } = decompose(Math.abs(x))
  const scale = 10n ** BigInt(digits)
  let rounded: bigint
  if (exponent >= 0) {
    // An integer already: nothing past the point to round.
    return x
  } else {
    const denominator = 1n << BigInt(-exponent)
    const numerator = mantissa * scale
    const quotient = numerator / denominator
    const twice = (numerator - quotient * denominator) * 2n
    rounded = twice < denominator ? quotient : twice > denominator ? quotient + 1n : quotient % 2n === 0n ? quotient : quotient + 1n
  }
  // One correctly rounded division gives the float nearest the decimal, which
  // is the float Python's `round` returns.
  const value = Number(rounded) / Number(scale)
  return negative ? -value : value
}

/** A positive finite float as `mantissa · 2^exponent`, both exact. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const biased = (high >>> 20) & 0x7ff
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
  if (biased === 0) return { mantissa: fraction, exponent: -1074 }
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 }
}
