/**
 * `pairtools stats`, counted in the import's own pass (§3.7).
 *
 * A `.pairs` file is the end of a pipeline, and the first thing anybody asks of
 * one is the table `pairtools stats` writes: how many records, how many mapped
 * on both sides, on one, on neither; how many were duplicates; of the rest how
 * many are cis and how many trans, and how many cis pairs reach past 1, 2, 4,
 * 10, 20 and 40 kb; every pair type; the four orientations' decays and where they
 * converge; and the library's size by the Lander–Waterman estimate. It is what
 * MultiQC reads, what a methods section quotes, and what decides whether a
 * library was worth binning at all — and every number in it is about the
 * *records*, so none of it can be had from a matrix afterwards. The import is
 * already reading every record; this is a few more fields off each.
 *
 * ## A port, held to its reference
 *
 * `PairCounter.add_pairs_from_dataframe` and `calculate_summaries` of pairtools
 * 1.1.2, which is what `pairtools stats` runs, translated rather than
 * paraphrased (§18.9's rule for a port): the same classification of a record, the
 * same separation bins — `round(10 ** arange(0, 9.001, 1/8))` with `0` in front
 * and the repeats taken out — found the same way (`searchsorted(…, 'right') - 1`),
 * the same convergence rule with the same five per cent, and the same library
 * estimate through the principal branch of Lambert's W. Its golden is pairtools'
 * own output over a fixture with every pair type in it
 * (`test/unit/pairs-stats.test.ts`), and `notebooks/validation.qmd` holds it to
 * the same on a published file.
 *
 * Where pairtools has a choice in it that looks like an oversight, it is kept:
 * a record is *unmapped* when both chromosomes are `!` and *mapped* when neither
 * is, whatever its pair type says, so a walk (`WW`), which pairtools also writes
 * with `!`, counts as unmapped; only a mapped record can be a duplicate, and only
 * by `DD`; and the convergence distance is the edge *after* the furthest bin at
 * which any orientation strays five per cent from the four's mean, so a sparse
 * tail of chance strays reaches it.
 *
 * Two things pairtools would do that this does not, both on files pairtools
 * itself would not have written: a strand that is neither `+` nor `-`, and a
 * position that is not a number, end pairtools' run with an error, and here the
 * record is counted everywhere but the separation table. And a `duplicate`
 * column, which `add_pairs_from_dataframe` reads in place of `DD` where a file
 * has one, is not read: `pairtools dedup` marks a duplicate by its pair type.
 *
 * ## Nothing is decided from it
 *
 * The pair type is read here and nowhere else, as the strands are read for the
 * orientation curves: no record is kept or dropped for it, no count reaches a
 * bin, and the matrix is the same matrix whether the column is there or not
 * (`test/unit/pairs-bin.test.ts`). A duplicate is *counted* as one and still
 * binned — the importer bins the records the file holds, and a reader who wants
 * them gone runs `pairtools dedup` or `select`.
 */

import type { PairsContig } from './format'

/** The four orientations in pairtools' own order — the order its file writes them in. */
export const STATS_STRANDS = ['+-', '-+', '--', '++'] as const
export type StatsStrands = (typeof STATS_STRANDS)[number]

/** The separations `cis_*kb+` counts past, in kilobases. */
export const CIS_THRESHOLDS_KB = [1, 2, 4, 10, 20, 40] as const

/** `PairCounter.DIST_FREQ_REL_DIFF_THRESHOLD`. */
export const CONVERGENCE_THRESHOLD = 0.05

/** `PairCounter.N_DIST_BINS_DECADE_DEFAULT`. */
export const DIST_BINS_PER_DECADE = 8

/**
 * The left edges of the separation bins, as `PairCounter.__init__` lays them:
 * `np.unique(np.r_[0, np.round(10 ** np.arange(0, 9.001, 1 / n)).astype(int)])`.
 * `arange`'s values are `i / n` exactly for a power-of-two `n`, and no power of
 * ten at an eighth of a decade lies near a half, so the rounding cannot differ.
 */
export function distEdges(perDecade = DIST_BINS_PER_DECADE): number[] {
  const step = 1 / perDecade
  const count = Math.ceil(9.001 / step)
  const edges = new Set<number>([0])
  for (let i = 0; i < count; i++) edges.add(Math.round(10 ** (i * step)))
  return [...edges].sort((a, b) => a - b)
}

/** Everything `pairtools stats` counts, as plain data that crosses a worker. */
export interface PairStats {
  total: number
  totalUnmapped: number
  totalSingleSidedMapped: number
  totalMapped: number
  totalDups: number
  totalNodups: number
  cis: number
  trans: number
  /** Every pair type and its count, the most common first. Empty where the file has no `pair_type` column. */
  pairTypes: Array<[string, number]>
  /** Cis pairs at least this far apart, for each of {@link CIS_THRESHOLDS_KB}. */
  cisAtLeast: Array<[number, number]>
  /** Unique mapped pairs per ordered pair of chromosomes, the most common first. */
  chromFreq: Array<[string, string, number]>
  /** {@link distEdges}: the left edge of every separation bin. */
  distEdges: number[]
  /** Cis pairs per separation bin, per orientation. */
  distFreq: Record<StatsStrands, number[]>
  /** The header's sequences and lengths, which pairtools writes at the end. */
  chromsizes: Array<[string, number]>
  /** Whether the file has a `pair_type` column; without one no record is a duplicate. */
  pairTypeColumn: boolean
  /**
   * Whether the counts are of part of the file — an import scoped through a
   * `.px2` to some pairs of chromosomes (§3.7) — rather than of all of it.
   */
  scoped: boolean
}

const BANG = 0x21
const PLUS = 0x2b
const MINUS = 0x2d

/** Which of {@link STATS_STRANDS} a pair of strand bytes is, or `-1`. */
function strandsOf(s1: number, s2: number): number {
  if (s1 === PLUS) return s2 === MINUS ? 0 : s2 === PLUS ? 3 : -1
  if (s1 === MINUS) return s2 === PLUS ? 1 : s2 === MINUS ? 2 : -1
  return -1
}

/**
 * Below this many declared sequences, the chromosome-pair counts are a square
 * array rather than a map: a thousand sequences is eight megabytes, and a lookup
 * per record into a `Map` is the one cost here that would show on a
 * hundred-million-record file.
 */
const DENSE_CHROM_PAIRS = 1024

/**
 * The counter. One per import; {@link add} per record, {@link result} once.
 *
 * Fed by the importer's own scan (`pairs/bin.ts`), which has already found each
 * field: the header indices of the two chromosomes — `-1` for a name the header
 * does not declare, which is decoded only then — and the spans of the two names
 * and of the pair type, so no string is built for a record the header knows.
 */
export class PairStatsCounter {
  private total = 0
  private totalUnmapped = 0
  private totalMapped = 0
  private totalDups = 0
  private cis = 0
  private trans = 0
  private readonly cisAtLeast = new Float64Array(CIS_THRESHOLDS_KB.length)
  private readonly edges: number[]
  private readonly distFreq: Float64Array[]
  /** Two-byte pair types by their two bytes — every one pairtools writes. */
  private readonly shortTypes = new Float64Array(1 << 16)
  private readonly typeOrder: string[] = []
  private readonly longTypes = new Map<string, number>()
  private readonly nContigs: number
  private readonly densePairs: Float64Array | null
  private readonly sparsePairs = new Map<number, number>()
  /** Pairs with a sequence the header does not declare, by `name1\tname2`. */
  private readonly namedPairs = new Map<string, number>()
  /** First appearance of each chromosome pair, so ties keep the file's order. */
  private readonly pairSeen = new Map<string, number>()
  private readonly decoder = new TextDecoder()
  private pairTypeSeen = false

  constructor(
    private readonly contigs: readonly PairsContig[],
    private readonly pairTypeColumn: boolean,
  ) {
    this.edges = distEdges()
    this.distFreq = STATS_STRANDS.map(() => new Float64Array(this.edges.length))
    this.nContigs = contigs.length
    this.densePairs =
      contigs.length <= DENSE_CHROM_PAIRS ? new Float64Array(contigs.length * contigs.length) : null
  }

  /**
   * One record.
   *
   * `c1`, `c2` are header indices or `-1`; `[c1From, c1To)` and `[c2From, c2To)`
   * where the names lie in `line`; `p1`, `p2` the positions, `-1` where not a
   * number; `s1`, `s2` the strands' first bytes, `-1` where absent; and
   * `[tFrom, tTo)` the pair type, `tFrom < 0` where the record has none.
   */
  add(
    line: Uint8Array,
    c1: number,
    c1From: number,
    c1To: number,
    c2: number,
    c2From: number,
    c2To: number,
    p1: number,
    p2: number,
    s1: number,
    s2: number,
    tFrom: number,
    tTo: number,
  ): void {
    this.total++
    let duplicate = false
    if (tFrom >= 0 && tTo > tFrom) {
      this.pairTypeSeen = true
      if (tTo - tFrom === 2) {
        const key = (line[tFrom] << 8) | line[tFrom + 1]
        if (this.shortTypes[key] === 0) this.typeOrder.push(String.fromCharCode(line[tFrom], line[tFrom + 1]))
        this.shortTypes[key]++
        duplicate = key === 0x4444 // 'DD'
      } else {
        const name = this.decoder.decode(line.subarray(tFrom, tTo))
        if (!this.longTypes.has(name)) this.typeOrder.push(name)
        this.longTypes.set(name, (this.longTypes.get(name) ?? 0) + 1)
      }
    }

    const unmapped1 = c1To - c1From === 1 && line[c1From] === BANG
    const unmapped2 = c2To - c2From === 1 && line[c2From] === BANG
    if (unmapped1 && unmapped2) {
      this.totalUnmapped++
      return
    }
    if (unmapped1 || unmapped2) return
    this.totalMapped++
    if (duplicate) {
      this.totalDups++
      return
    }

    let sameChrom: boolean
    if (c1 >= 0 && c2 >= 0) {
      sameChrom = c1 === c2
      const at = c1 * this.nContigs + c2
      if (this.densePairs !== null) {
        if (this.densePairs[at] === 0) this.notePair(this.contigs[c1].name, this.contigs[c2].name)
        this.densePairs[at]++
      } else {
        const had = this.sparsePairs.get(at)
        if (had === undefined) this.notePair(this.contigs[c1].name, this.contigs[c2].name)
        this.sparsePairs.set(at, (had ?? 0) + 1)
      }
    } else {
      // A name the header does not declare: rare, and the one road that builds strings.
      const name1 = c1 >= 0 ? this.contigs[c1].name : this.decoder.decode(line.subarray(c1From, c1To))
      const name2 = c2 >= 0 ? this.contigs[c2].name : this.decoder.decode(line.subarray(c2From, c2To))
      sameChrom = name1 === name2
      const key = `${name1}\t${name2}`
      if (!this.namedPairs.has(key)) this.notePair(name1, name2)
      this.namedPairs.set(key, (this.namedPairs.get(key) ?? 0) + 1)
    }
    if (!sameChrom) {
      this.trans++
      return
    }
    this.cis++
    if (p1 < 0 || p2 < 0) return
    const dist = Math.abs(p2 - p1)
    const which = strandsOf(s1, s2)
    if (which >= 0) {
      // `searchsorted(edges, dist, 'right') - 1`: the last edge at or below.
      const edges = this.edges
      let lo = 0
      let hi = edges.length
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (edges[mid] <= dist) lo = mid
        else hi = mid
      }
      this.distFreq[which][lo]++
    }
    for (let i = 0; i < CIS_THRESHOLDS_KB.length; i++) {
      if (dist >= CIS_THRESHOLDS_KB[i] * 1000) this.cisAtLeast[i]++
    }
  }

  private notePair(name1: string, name2: string): void {
    const key = `${name1}\t${name2}`
    if (!this.pairSeen.has(key)) this.pairSeen.set(key, this.pairSeen.size)
  }

  /** Everything counted, as plain data. `scoped` where only part of the file was read. */
  result(scoped: boolean): PairStats {
    const typeCount = (name: string): number =>
      name.length === 2 && this.longTypes.get(name) === undefined
        ? this.shortTypes[(name.charCodeAt(0) << 8) | name.charCodeAt(1)]
        : (this.longTypes.get(name) ?? 0)
    const pairTypes = this.typeOrder
      .map((name, order) => ({ name, count: typeCount(name), order }))
      .sort((a, b) => b.count - a.count || a.order - b.order)
      .map(({ name, count }): [string, number] => [name, count])

    const pairs: Array<{ name1: string; name2: string; count: number }> = []
    const n = this.nContigs
    if (this.densePairs !== null) {
      for (let at = 0; at < this.densePairs.length; at++) {
        const count = this.densePairs[at]
        if (count > 0) pairs.push({ name1: this.contigs[Math.floor(at / n)].name, name2: this.contigs[at % n].name, count })
      }
    } else {
      for (const [at, count] of this.sparsePairs) {
        pairs.push({ name1: this.contigs[Math.floor(at / n)].name, name2: this.contigs[at % n].name, count })
      }
    }
    for (const [key, count] of this.namedPairs) {
      const [name1, name2] = key.split('\t')
      pairs.push({ name1, name2, count })
    }
    const seen = (pair: { name1: string; name2: string }): number => this.pairSeen.get(`${pair.name1}\t${pair.name2}`) ?? 0
    pairs.sort((a, b) => b.count - a.count || seen(a) - seen(b))

    const distFreq = {} as Record<StatsStrands, number[]>
    STATS_STRANDS.forEach((strands, i) => {
      distFreq[strands] = Array.from(this.distFreq[i])
    })
    return {
      total: this.total,
      totalUnmapped: this.totalUnmapped,
      totalSingleSidedMapped: this.total - this.totalMapped - this.totalUnmapped,
      totalMapped: this.totalMapped,
      totalDups: this.totalDups,
      totalNodups: this.totalMapped - this.totalDups,
      cis: this.cis,
      trans: this.trans,
      pairTypes,
      cisAtLeast: CIS_THRESHOLDS_KB.map((kb, i): [number, number] => [kb, this.cisAtLeast[i]]),
      chromFreq: pairs.map(({ name1, name2, count }): [string, string, number] => [name1, name2, count]),
      distEdges: [...this.edges],
      distFreq,
      chromsizes: this.contigs.map((contig): [string, number] => [contig.name, contig.length]),
      pairTypeColumn: this.pairTypeColumn && this.pairTypeSeen,
      scoped,
    }
  }
}

// ---------------------------------------------------------------------------
// The summaries
// ---------------------------------------------------------------------------

/**
 * A number as pairtools writes it: an integer as an integer, a float as Python
 * prints one, or a word. Kept apart because `0` and `0.0` are different lines in
 * a `.stats` file, and the file is meant to be read by what reads pairtools'.
 */
export type StatValue = { int: number } | { float: number } | { text: string }

/** The convergence of the four orientations, as `find_dist_freq_convergence_distance` finds it. */
export interface Convergence {
  /** The separation above which every orientation is within the threshold, or `null` where none strayed. */
  distance: number | null
  /** The orientation that strayed furthest out, or `null`. */
  strands: StatsStrands | null
  /** Cis pairs below it, per orientation. */
  below: Record<StatsStrands, number>
  belowAll: number
  aboveAll: number
}

/** The four orientations in the order `find_dist_freq_convergence_distance` walks them. */
const CONVERGENCE_ORDER: StatsStrands[] = ['++', '--', '-+', '+-']

/** {@link Convergence}, with pairtools' index of the bin it is reached in. */
export function convergenceOf(stats: PairStats, threshold = CONVERGENCE_THRESHOLD): Convergence & { binIndex: number } {
  const freq = (strands: StatsStrands): number[] => stats.distFreq[strands]
  const nBins = stats.distEdges.length
  const mean = new Float64Array(nBins)
  for (let i = 0; i < nBins; i++) {
    let sum = 0
    for (const strands of CONVERGENCE_ORDER) sum += freq(strands)[i]
    mean[i] = sum / CONVERGENCE_ORDER.length
  }
  let binIndex = 0
  let strandsOut: StatsStrands | null = null
  for (const strands of CONVERGENCE_ORDER) {
    let furthest = 0
    for (let i = 0; i < nBins; i++) {
      // `np.nan_to_num(|f - mean| / mean)`: an empty bin, `0 / 0`, is no stray.
      const deviation = mean[i] === 0 ? 0 : Math.abs(freq(strands)[i] - mean[i]) / mean[i]
      if (deviation > threshold) furthest = i
    }
    if (furthest > binIndex) {
      binIndex = furthest
      strandsOut = strands
    }
  }
  const below = {} as Record<StatsStrands, number>
  let belowAll = 0
  let aboveAll = 0
  for (const strands of CONVERGENCE_ORDER) {
    let under = 0
    let over = 0
    freq(strands).forEach((count, i) => {
      if (i <= binIndex) under += count
      else over += count
    })
    below[strands] = under
    belowAll += under
    aboveAll += over
  }
  return {
    distance: strandsOut === null ? null : (stats.distEdges[binIndex + 1] ?? Number.MAX_SAFE_INTEGER),
    strands: strandsOut,
    below,
    belowAll,
    aboveAll,
    binIndex,
  }
}

/**
 * The library's size, `estimate_library_complexity(total_mapped, total_dups)`:
 * the Lander–Waterman estimate Picard makes, solved in closed form through the
 * principal branch of Lambert's W. `NaN` for a library with no duplicates, as
 * pairtools writes it — see {@link lambertW0} — and `0` for an empty or wholly
 * duplicated one.
 */
export function libraryComplexity(mapped: number, duplicates: number): number {
  if (mapped === 0) return 0
  const unique = (mapped - duplicates) / mapped
  if (unique === 0) return 0
  return mapped / (lambertW0(-Math.exp(-1 / unique) / unique) + 1 / unique)
}

/**
 * The principal branch of Lambert's W on `(-1/e, 0]`, where the estimate needs
 * it: Halley's iteration from the branch-point series near `-1/e` and from
 * `z` near zero, to the last bit — scipy's `lambertw` is what it is compared to.
 *
 * And `NaN` at `-exp(-1)` itself, as scipy answers there: the double nearest
 * `1/e` is a hair above it, so `-exp(-1)` lies just outside the branch. It is
 * exactly the argument a library with no duplicates hands the estimate, which is
 * why pairtools writes `nan` for one — measured on a deduplicated yeast library
 * of 17.6 million pairs — and why this does.
 */
export function lambertW0(z: number): number {
  if (z === 0) return 0
  const branch = -Math.exp(-1)
  if (z <= branch) return Number.NaN
  const p = Math.sqrt(2 * (Math.E * z + 1))
  let w = z < -0.25 ? -1 + p - (p * p) / 3 + (11 / 72) * p * p * p : z
  for (let i = 0; i < 64; i++) {
    const ew = Math.exp(w)
    const f = w * ew - z
    const wp1 = w + 1
    if (wp1 === 0) break
    const step = f / (ew * wp1 - ((w + 2) * f) / (2 * wp1))
    const next = w - step
    if (!Number.isFinite(next)) break
    if (Math.abs(next - w) <= 1e-16 * Math.max(1, Math.abs(next))) return next
    w = next
  }
  return w
}

/** What `pairtools stats` writes, in its order, as key and value. */
export function pairtoolsStatsEntries(stats: PairStats): Array<[string, StatValue]> {
  const int = (value: number): StatValue => ({ int: value })
  // Python's `a / b` on two ints is a float; pairtools writes `0`, an int, where
  // it guards a zero denominator itself, and numpy's `nan` or `inf` where it does not.
  const ratio = (num: number, den: number): StatValue => (den > 0 ? { float: num / den } : int(0))
  const npRatio = (num: number, den: number): StatValue => ({ float: num / den })
  const out: Array<[string, StatValue]> = [
    ['total', int(stats.total)],
    ['total_unmapped', int(stats.totalUnmapped)],
    ['total_single_sided_mapped', int(stats.totalSingleSidedMapped)],
    ['total_mapped', int(stats.totalMapped)],
    ['total_dups', int(stats.totalDups)],
    ['total_nodups', int(stats.totalNodups)],
    ['cis', int(stats.cis)],
    ['trans', int(stats.trans)],
  ]
  for (const [type, count] of stats.pairTypes) out.push([`pair_types/${type}`, int(count)])
  for (const [kb, count] of stats.cisAtLeast) out.push([`cis_${kb}kb+`, int(count)])

  out.push(['summary/frac_cis', ratio(stats.cis, stats.totalNodups)])
  for (const [kb, count] of stats.cisAtLeast) out.push([`summary/frac_cis_${kb}kb+`, ratio(count, stats.totalNodups)])
  out.push(['summary/frac_dups', ratio(stats.totalDups, stats.totalMapped)])
  const complexity = libraryComplexity(stats.totalMapped, stats.totalDups)
  // pairtools' own `0` where it returns early, an int; otherwise a float, `nan` included.
  out.push(['summary/complexity_naive', stats.totalMapped === 0 || complexity === 0 ? int(0) : { float: complexity }])

  const c = convergenceOf(stats)
  const at = 'summary/dist_freq_convergence'
  out.push([`${at}/convergence_dist`, c.distance === null ? { text: '0' } : int(c.distance)])
  out.push([`${at}/strands_w_max_convergence_dist`, { text: c.strands ?? '??' }])
  out.push([`${at}/convergence_rel_diff_threshold`, { float: CONVERGENCE_THRESHOLD }])
  for (const strands of CONVERGENCE_ORDER) out.push([`${at}/n_cis_pairs_below_convergence_dist/${strands}`, int(c.below[strands])])
  out.push([`${at}/n_cis_pairs_below_convergence_dist_all_strands`, int(c.belowAll)])
  out.push([`${at}/n_cis_pairs_above_convergence_dist_all_strands`, int(c.aboveAll)])
  const norms: Array<[string, number]> = [
    ['cis', stats.cis],
    ['total_mapped', stats.totalMapped],
    ['total_nodups', stats.totalNodups],
  ]
  for (const [key, norm] of norms) {
    // Summed as Python's `sum()` sums the list: from zero, left to right.
    let all = 0
    for (const strands of CONVERGENCE_ORDER) {
      const value = c.below[strands] / norm
      all += value
      out.push([`${at}/frac_${key}_in_cis_below_convergence_dist/${strands}`, npRatio(c.below[strands], norm)])
    }
    out.push([`${at}/frac_${key}_in_cis_below_convergence_dist_all_strands`, { float: all }])
    out.push([`${at}/frac_${key}_in_cis_above_convergence_dist_all_strands`, npRatio(c.aboveAll, norm)])
  }

  for (const [name1, name2, count] of stats.chromFreq) out.push([`chrom_freq/${name1}/${name2}`, int(count)])
  const edges = stats.distEdges
  for (let i = 0; i < edges.length; i++) {
    const range = i < edges.length - 1 ? `${edges[i]}-${edges[i + 1]}` : `${edges[i]}+`
    for (const strands of STATS_STRANDS) out.push([`dist_freq/${range}/${strands}`, int(stats.distFreq[strands][i])])
  }
  for (const [name, length] of stats.chromsizes) out.push([`chromsizes/${name}`, int(length)])
  return out
}

/**
 * The text of a `pairtools stats` file: one `key<TAB>value` a line, in
 * pairtools' order, its numbers spelled as pairtools spells them — so MultiQC,
 * `pairtools stats --merge` and anything else that reads one reads this.
 */
export function writePairtoolsStats(stats: PairStats): string {
  return pairtoolsStatsEntries(stats)
    .map(([key, value]) => `${key}\t${statText(value)}`)
    .join('\n')
    .concat('\n')
}

/** A {@link StatValue} as pairtools prints it. */
export function statText(value: StatValue): string {
  if ('text' in value) return value.text
  if ('int' in value) return String(value.int)
  return pythonFloat(value.float)
}

/**
 * A float as Python's `str` prints it: the shortest digits that read back to
 * the same number — which is what JavaScript prints too — in fixed notation
 * from 1e-4 up to 1e16 and in Python's exponent form outside it, with `.0` on a
 * whole number; and `nan` and `inf` as numpy spells them.
 */
export function pythonFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (value === Infinity) return 'inf'
  if (value === -Infinity) return '-inf'
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  const [mantissa, exponentText] = value.toExponential().split('e')
  const exponent = Number(exponentText)
  const negative = mantissa.startsWith('-')
  const digits = mantissa.replace('-', '').replace('.', '')
  const sign = negative ? '-' : ''
  if (exponent < -4 || exponent >= 16) {
    const lead = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    const magnitude = Math.abs(exponent)
    return `${sign}${lead}e${exponent < 0 ? '-' : '+'}${magnitude < 10 ? `0${magnitude}` : magnitude}`
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0')
  const fraction = digits.slice(exponent + 1)
  return `${sign}${whole}.${fraction === '' ? '0' : fraction}`
}
