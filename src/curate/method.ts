/**
 * The method behind the curation's suggestions (SPECS §33.5): the contig
 * network, the one number every suggestion is weighed by — **affinity** — and
 * the confidence of each kind of suggestion.
 *
 * **Affinity** is how densely a set of contigs `X` meets a genome `g` against
 * how densely `g`'s own contigs meet each other:
 *
 *     A(X, g) = (O_Xg / E_Xg) / D_g,   E_Xg = t_X · t_g / T,   D_g = 2 · O_gg · T / t_g²
 *
 * — the contacts observed over the contacts random ligation expects, over the
 * same ratio for the genome with itself, so the library's depth, the genome's
 * abundance and the contig's own visibility all cancel: `O_Xg · t_g / (2 · t_X ·
 * O_gg)`. **1 is as densely as the genome's own contigs**, the spurious
 * ligation's level a few hundredths. `t_c` is a contig's visibility — its
 * contacts with every other contig — and `O_gg` the contacts within a genome,
 * each two of its contigs once. A genome that holds no contact between two of
 * its contigs (one contig, or none in contact) has no density of its own and
 * takes the median of the genomes that have one.
 *
 * Two guards make it safe on a few contacts: its **lower bound**, scaled by the
 * one-sided 90% Poisson bound of the contacts it rests on, and a **background**,
 * the rate of spurious ligation measured from the file's own binning, which a
 * suggestion's contacts must stand out of.
 *
 * Validated on the mock community MM133 against its truth (§33.11,
 * `docs/genome-curation.md` §7). Pure functions over typed arrays: the reader's
 * worker runs them, and the stage's thread never sees the network.
 */

import { poissonSf } from '../analysis/poisson'

/** Every two contigs in contact, once (§33.5). */
export interface ContigNetwork {
  /** The file's contigs, in its order. */
  contigs: number
  /** Each pair `first[k] < second[k]`, sorted by `first` then `second`. */
  first: Int32Array
  second: Int32Array
  /** The sum of the raw counts of the stored pixels between the two contigs' bins. */
  contacts: Float64Array
  /** The contacts within each contig: pixels both of whose bins are its. */
  within: Float64Array
}

/** A binning as the method reads it: genome indices and kinds. */
export interface MethodBinning {
  /** Each contig's genome, an index into `kinds`; `-1` for the pool. */
  genomeOf: Int32Array
  /** Each genome's kind: `0` a MAG, `1` a mobile element. */
  kinds: Uint8Array
}

export const MAG = 0
export const ELEMENT = 1

/** Each contig's visibility: its contacts with every other contig. */
export function visibility(network: ContigNetwork): Float64Array {
  const t = new Float64Array(network.contigs)
  for (let k = 0; k < network.first.length; k++) {
    t[network.first[k]] += network.contacts[k]
    t[network.second[k]] += network.contacts[k]
  }
  return t
}

/** The contacts between and within genomes, and their visibilities. */
export interface GenomeTally {
  genomes: number
  /** Each genome's visibility: the sum of its contigs'. */
  visibility: Float64Array
  /** The contacts within each genome, between two of its contigs, each pair once. */
  within: Float64Array
  /** The contacts between two genomes `a < b`, keyed `a · genomes + b`. */
  between: Map<number, number>
  /** `T`: every contig's visibility, summed — twice the contacts between contigs. */
  total: number
  /** Each genome's contigs. */
  size: Int32Array
}

/** The genome-level contacts of a binning. */
export function tally(network: ContigNetwork, t: Float64Array, binning: MethodBinning): GenomeTally {
  const genomes = binning.kinds.length
  const out: GenomeTally = {
    genomes,
    visibility: new Float64Array(genomes),
    within: new Float64Array(genomes),
    between: new Map(),
    total: 0,
    size: new Int32Array(genomes),
  }
  for (let c = 0; c < network.contigs; c++) {
    out.total += t[c]
    const g = binning.genomeOf[c]
    if (g >= 0) {
      out.visibility[g] += t[c]
      out.size[g]++
    }
  }
  for (let k = 0; k < network.first.length; k++) {
    const a = binning.genomeOf[network.first[k]]
    const b = binning.genomeOf[network.second[k]]
    if (a < 0 || b < 0) continue
    const n = network.contacts[k]
    if (a === b) out.within[a] += n
    else {
      const key = a < b ? a * genomes + b : b * genomes + a
      out.between.set(key, (out.between.get(key) ?? 0) + n)
    }
  }
  return out
}

/** The contacts between two genomes of a tally. */
export function contactsBetween(tallied: GenomeTally, a: number, b: number): number {
  if (a === b) return tallied.within[a]
  return tallied.between.get(a < b ? a * tallied.genomes + b : b * tallied.genomes + a) ?? 0
}

/** How the background was measured, as the stage says it. */
export type BackgroundHow = 'median' | 'total' | 'floor'

/** The rate of spurious ligation, and how it was measured. */
export interface Background {
  rho: number
  how: BackgroundHow
  /** The pairs of MAGs it was measured over. */
  pairs: number
}

/**
 * The background (§33.5): the median, over every two MAGs whose expectation is
 * a contact or more, of their contacts observed over expected — two MAGs that
 * share nothing counted as nought, as they are. Most pairs of genomes of a
 * community are strangers, so their median is the spurious ligation's rate; the
 * few that are one organism's fragments, or a host and its plasmid's, do not
 * move it. Where more than half the pairs share nothing — a shallow library —
 * the median is nought, and the total of every pair's contacts over the total
 * expected is taken instead, which a fragment pair raises: a stricter
 * background, said as such. A map with no two MAGs in contact takes one
 * contact over everything.
 */
export function background(tallied: GenomeTally, kinds: Uint8Array): Background {
  const T = tallied.total
  const mags: number[] = []
  for (let g = 0; g < tallied.genomes; g++) if (kinds[g] === MAG && tallied.visibility[g] > 0) mags.push(g)
  if (!(T > 0) || mags.length < 2) return { rho: T > 0 ? 1 / T : 1, how: 'floor', pairs: 0 }
  // Pairs whose expectation reaches a contact: t_a · t_b ≥ T. Counted with the
  // visibilities sorted, two pointers, rather than every pair.
  const sorted = mags.map((g) => tallied.visibility[g]).sort((x, y) => x - y)
  let eligible = 0
  for (let i = 0, j = sorted.length - 1; i < j; ) {
    if (sorted[i] * sorted[j] >= T) {
      eligible += j - i
      j--
    } else i++
  }
  const isMag = new Uint8Array(tallied.genomes)
  for (const g of mags) isMag[g] = 1
  const ratios: number[] = []
  let observed = 0
  let expected = 0
  for (const [key, n] of tallied.between) {
    const a = Math.floor(key / tallied.genomes)
    const b = key - a * tallied.genomes
    if (isMag[a] !== 1 || isMag[b] !== 1) continue
    const e = (tallied.visibility[a] * tallied.visibility[b]) / T
    observed += n
    if (e >= 1) ratios.push(n / e)
  }
  for (let x = 0; x < mags.length; x++) for (let y = x + 1; y < mags.length; y++) expected += (tallied.visibility[mags[x]] * tallied.visibility[mags[y]]) / T
  ratios.sort((x, y) => x - y)
  const zeros = eligible - ratios.length
  const nth = (k: number): number => (k < zeros ? 0 : ratios[k - zeros])
  // numpy's median: the middle one, or the mean of the two middle ones.
  const median = eligible === 0 ? 0 : eligible % 2 === 1 ? nth((eligible - 1) / 2) : (nth(eligible / 2 - 1) + nth(eligible / 2)) / 2
  if (median > 0) return { rho: median, how: 'median', pairs: eligible }
  if (observed > 0 && expected > 0) return { rho: observed / expected, how: 'total', pairs: eligible }
  return { rho: 1 / T, how: 'floor', pairs: eligible }
}

/**
 * Each genome's own density `D_g = 2 · O_gg · T / t_g²`, and the median of those
 * that have one, which a genome with no contact between two of its contigs
 * takes instead.
 */
export interface Densities {
  own: Float64Array
  /** The median density of the genomes that have one; `NaN` where none has. */
  typical: number
}

export function densities(tallied: GenomeTally): Densities {
  const own = new Float64Array(tallied.genomes)
  const measured: number[] = []
  for (let g = 0; g < tallied.genomes; g++) {
    const t = tallied.visibility[g]
    const within = tallied.within[g]
    if (within > 0 && t > 0 && tallied.size[g] >= 2) {
      own[g] = (2 * within * tallied.total) / (t * t)
      measured.push(own[g])
    } else own[g] = Number.NaN
  }
  measured.sort((x, y) => x - y)
  const n = measured.length
  const typical = n === 0 ? Number.NaN : n % 2 === 1 ? measured[(n - 1) / 2] : (measured[n / 2 - 1] + measured[n / 2]) / 2
  return { own, typical }
}

/** A genome's density, or the typical one where it has none of its own. */
export function densityOf(d: Densities, g: number): number {
  const own = d.own[g]
  return Number.isFinite(own) ? own : d.typical
}

/**
 * The affinity of contacts `o` between a set of visibility `tX` and a genome of
 * visibility `tG` and density `density`, in a library of total `T`: observed over
 * expected, over the genome's own. `0` where nothing could be expected.
 */
export function affinity(o: number, tX: number, tG: number, density: number, T: number): number {
  if (!(tX > 0) || !(tG > 0) || !(density > 0) || !(T > 0)) return 0
  return (o * T) / (tX * tG) / density
}

/**
 * The affinity between two genomes, symmetric: the geometric mean of the two
 * directions, `O_ab / (2 √(O_aa · O_bb))` where both have a density — about 1
 * for two halves of one genome.
 */
export function affinityBetween(o: number, ta: number, tb: number, da: number, db: number, T: number): number {
  if (!(ta > 0) || !(tb > 0) || !(da > 0) || !(db > 0) || !(T > 0)) return 0
  return (o * T) / (ta * tb) / Math.sqrt(da * db)
}

const lowerCache = new Map<number, number>()

/**
 * The one-sided 90% lower bound of a Poisson mean that gave `o` contacts: the λ
 * at which `o` or more would be drawn one time in ten, `χ²(0.1; 2o) / 2`. Nought
 * for nought. Solved by Newton's method on SciPy's own tail (`poissonSf`), from
 * the Wilson–Hilferty guess, and kept: contacts are whole and a recount asks the
 * same few hundred of them again.
 */
export function poissonLower(o: number): number {
  if (!(o > 0)) return 0
  const cached = lowerCache.get(o)
  if (cached !== undefined) return cached
  // Wilson–Hilferty for χ² with 2o degrees of freedom at its 10th centile.
  const nu = 2 * o
  const z = -1.2815515655446004
  const wh = (nu * (1 - 2 / (9 * nu) + z * Math.sqrt(2 / (9 * nu))) ** 3) / 2
  let lambda = Number.isFinite(wh) && wh > 0 ? wh : o / 10
  let lo = 0
  let hi = o + 10 * Math.sqrt(o) + 10
  for (let i = 0; i < 100; i++) {
    // P(N ≥ o | λ) − 0.1, increasing in λ; its derivative is the mass at o − 1.
    const f = poissonSf(o - 1, lambda) - 0.1
    if (f > 0) hi = lambda
    else lo = lambda
    const pmf = Math.exp((o - 1) * Math.log(lambda) - lambda - lnFactorial(o - 1))
    let next = pmf > 0 ? lambda - f / pmf : Number.NaN
    if (!(next > lo && next < hi)) next = (lo + hi) / 2
    if (Math.abs(next - lambda) <= 1e-14 * Math.max(1, lambda)) {
      lambda = next
      break
    }
    lambda = next
  }
  lowerCache.set(o, lambda)
  return lambda
}

function lnFactorial(n: number): number {
  let s = 0
  for (let k = 2; k <= n && k <= 256; k++) s += Math.log(k)
  if (n <= 256) return s
  // Stirling with its first corrections, exact to double precision past 256.
  return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n) - 1 / (360 * n ** 3)
}

/**
 * An affinity as the stage prints it, in every part — a chip, a card, a
 * picture's readout: two decimals from 1 (`1.16`), two significant figures
 * below (`0.084`, `0.00036`), and under a ten-thousandth `< 0.0001`, never an
 * exponent in prose, which breaks across lines at its hyphen; a dash where
 * there is none. The one rule: the selection card, the chips, the pictures.
 */
export function affinityText(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value <= 0) return '0'
  if (value >= 1) return value.toFixed(2)
  // Its space unbreakable: no number is cut across two lines.
  if (value < 1e-4) return '<\u00a00.0001'
  const text = value.toPrecision(2)
  // 0.999 rounds up to the next decade: printed as 1 is, from 1.
  return text === '1.0' ? '1.00' : text
}

/** An affinity scaled to the lower bound of the contacts it rests on. */
export function lowerAffinity(a: number, o: number): number {
  return o > 0 ? (a * poissonLower(o)) / o : 0
}

/**
 * The chance that spurious ligation alone gives `o` contacts or more between
 * sets of visibilities `tX` and `tG`: `P(Poisson(ρ · tX · tG / T) ≥ o)`.
 */
export function significance(o: number, tX: number, tG: number, rho: number, T: number): number {
  if (!(o > 0)) return 1
  if (!(T > 0)) return 1
  return poissonSf(o - 1, (rho * tX * tG) / T)
}

/** A suggestion's contacts must stand out of the background at least this much. */
export const LEAST_SIGNIFICANCE = 1e-3

// ---------------------------------------------------------------------------
// Confidence: one logistic per kind, its weights stated with their reasons.
// ---------------------------------------------------------------------------

export type SuggestionKind = 'merge' | 'recruit' | 'move' | 'link' | 'unlink'

/** An intercept, then one weight per feature. */
export type Weights = readonly number[]

/**
 * The initial weights of each kind (§33.5), each with its reason.
 *
 * **merge** — features `log₂(A_lo / 0.1)`, `log₁₀(1 + o) − 2`, the markers the
 * smaller genome shares with the other times how many it has (to ten), and
 * whether the contacts fail the background:
 * - **0**, the intercept: two genomes that meet a tenth as densely as their own
 *   contigs, on a hundred contacts, are an even bet — on MM133 every true
 *   fragment pair stands at 0.1 or more, and every pair of strangers under 0.07.
 * - **2** a doubling of affinity: it is the evidence.
 * - **0.5** a decade of contacts: more of them make the same affinity surer.
 * - **−6** on the shared markers: two fragments of one organism are
 *   complementary, two organisms are not — a merge that would duplicate every
 *   marker the smaller has is refused by the markers whatever the contacts say,
 *   and a fragment with one marker neither helps nor harms.
 * - **−3** on contacts the background could have given.
 *
 * **recruit** — features `log₂(A_lo / 0.5)` between −4 and 2, how many doublings
 * it stands above the contig's next best genome between 0 and 3, its markers the
 * genome already has (to two), and the background:
 * - **0**: a contig whose lower bound meets a genome half as densely as its own
 *   contigs is an even bet.
 * - **2** a doubling of its lower bound, capped at four times: past that a contig
 *   is the genome's, and the cap keeps a contig's few contacts with a
 *   three-contig genome from counting as certainty.
 * - **1** a doubling above the next best: a contig has one genome.
 * - **−3** a marker the genome has: it would be counted twice.
 * - **−3** the background.
 *
 * **move** — a recruit's features, the next best being the contig's own genome,
 * and **−2** more on the intercept: the binning put it there.
 *
 * **link** — features `log₂(A_lo / 0.2)` between −4 and 2, `log₂(s / 0.1)`
 * between −3 and 2 (`s` the share of the element's contacts with MAGs that go to
 * this one), and the background:
 * - **0**: an element whose lower bound meets a MAG a fifth as densely as the
 *   MAG's own contigs, on a tenth of its contacts with MAGs, is an even bet — a
 *   plasmid's copies spread through the cell, and meet its chromosome less
 *   densely than the chromosome meets itself.
 * - **2** each, a doubling of each.
 * - **−3** the background.
 *
 * **unlink** is a link's own confidence, the other way round.
 */
export const INITIAL_WEIGHTS: Record<Exclude<SuggestionKind, 'unlink'>, Weights> = {
  merge: [0, 2, 0.5, -6, -3],
  recruit: [0, 2, 1, -3, -3],
  move: [-2, 2, 1, -3, -3],
  link: [0, 2, 2, -3],
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/** The confidence of features under weights. */
export function confidenceOf(features: readonly number[], weights: Weights): number {
  let z = weights[0] ?? 0
  for (let k = 0; k < features.length; k++) z += (weights[k + 1] ?? 0) * features[k]
  return sigmoid(z)
}

/** A merge's features (see {@link INITIAL_WEIGHTS}). */
export function mergeFeatures(lower: number, o: number, sharedMarkers: number, fewerMarkers: number, p: number): number[] {
  const overlap = fewerMarkers > 0 ? sharedMarkers / fewerMarkers : 0
  return [
    Math.log2(Math.max(lower, 1e-9) / 0.1),
    Math.log10(1 + o) - 2,
    overlap * Math.min(1, fewerMarkers / 10),
    p > LEAST_SIGNIFICANCE ? 1 : 0,
  ]
}

/** A recruit's or a move's features (see {@link INITIAL_WEIGHTS}). */
export function contigFeatures(lower: number, next: number, duplicated: number, p: number): number[] {
  return [
    clamp(Math.log2(Math.max(lower, 1e-9) / 0.5), -4, 2),
    next > 0 ? clamp(Math.log2(Math.max(lower, 1e-9) / next), 0, 3) : 3,
    Math.min(duplicated, 2),
    p > LEAST_SIGNIFICANCE ? 1 : 0,
  ]
}

/** A link's features (see {@link INITIAL_WEIGHTS}). */
export function linkFeatures(lower: number, share: number, p: number): number[] {
  return [
    clamp(Math.log2(Math.max(lower, 1e-9) / 0.2), -4, 2),
    clamp(Math.log2(Math.max(share, 1e-9) / 0.1), -3, 2),
    p > LEAST_SIGNIFICANCE ? 1 : 0,
  ]
}

/**
 * One answer, learned (as §27.6's): a step of logistic regression towards it,
 * pulled back towards the initial weights so three answers cannot overturn the
 * contacts and thirty can teach the stage what this file's evidence means.
 */
export function learn(kind: Exclude<SuggestionKind, 'unlink'>, weights: Weights, features: readonly number[], accepted: boolean): number[] {
  const rate = 0.1
  const prior = 0.15
  const initial = INITIAL_WEIGHTS[kind]
  const error = (accepted ? 1 : 0) - confidenceOf(features, weights)
  const x = [1, ...features]
  return weights.map((w, k) => w + rate * (error * (x[k] ?? 0) - prior * (w - (initial[k] ?? 0))))
}

/** The confidence a suggestion is offered from, put first in review from, and taken by auto mode from. */
export const OFFER_FLOOR = 0.15
export const LIKELY = 0.5
export const AUTO_THRESHOLD = 0.8
