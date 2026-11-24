/**
 * The curation's suggestions (SPECS §33.5): every merge, recruit, move, link and
 * unlink the contacts and the markers support, with its confidence, its
 * evidence and the step it would make — counted again after every step, on the
 * curated binning as it then is.
 *
 * - **merge**: two MAGs whose contacts with each other stand out against their
 *   contacts within themselves, the larger keeping its name; marker genes the
 *   two share count against it.
 * - **recruit**: an unbinned contig into the MAG it meets most densely, past its
 *   next best. The ones at {@link SURE} or more into one MAG are one suggestion,
 *   so a genome's contigs are taken in one answer; the rest one by one.
 * - **move**: a contig of a MAG into another it meets more densely than its own.
 * - **link** an element to a MAG it meets densely, past the background, on a
 *   share of its contacts with MAGs; **unlink** a link the binning no longer
 *   supports.
 *
 * Elements are gathered and merged by the hand alone: their contacts cannot
 * tell two plasmids of one host apart (`docs/genome-curation.md` §5.3).
 */

import { fmt } from '../units'
import type { CuratedBinning, CurationStep } from '../genome/curation'
import {
  affinity,
  affinityBetween,
  confidenceOf,
  contigFeatures,
  densities,
  densityOf,
  ELEMENT,
  INITIAL_WEIGHTS,
  LIKELY,
  linkFeatures,
  lowerAffinity,
  MAG,
  mergeFeatures,
  OFFER_FLOOR,
  significance,
  tally,
  type Background,
  type ContigNetwork,
  type Densities,
  type GenomeTally,
  type MethodBinning,
  type SuggestionKind,
  type Weights,
} from './method'
import { addCounts, markerCounts, qualityOf, type ContigMarkers, type Quality } from './quality'

/** Recruits at this confidence or more into one MAG are offered as one suggestion. */
export const SURE = 0.8

/** What the method reads, kept by the reader's worker while the stage is open. */
export interface CurationEvidence {
  network: ContigNetwork
  /** Each contig's visibility: its contacts with every other contig. */
  visibility: Float64Array
  /** Each contig's neighbours, CSR: `neighbours[offsets[c]] … neighbours[offsets[c + 1] - 1]`. */
  offsets: Int32Array
  neighbours: Int32Array
  counts: Float64Array
  /** The marker sets of the map, one table each; none where the map holds no markers. */
  markers: readonly ContigMarkers[]
  /** The rate of spurious ligation, measured from the file's own binning. */
  background: Background
  /** Every contig's name and length, in the file's order. */
  names: readonly string[]
  lengths: readonly number[]
}

/** The network's neighbour lists, built once. */
export function neighbourLists(network: ContigNetwork): Pick<CurationEvidence, 'offsets' | 'neighbours' | 'counts'> {
  const n = network.contigs
  const degree = new Int32Array(n + 1)
  for (let k = 0; k < network.first.length; k++) {
    degree[network.first[k] + 1]++
    degree[network.second[k] + 1]++
  }
  for (let c = 0; c < n; c++) degree[c + 1] += degree[c]
  const offsets = Int32Array.from(degree)
  const fill = Int32Array.from(degree.subarray(0, n))
  const neighbours = new Int32Array(2 * network.first.length)
  const counts = new Float64Array(2 * network.first.length)
  for (let k = 0; k < network.first.length; k++) {
    const a = network.first[k]
    const b = network.second[k]
    neighbours[fill[a]] = b
    counts[fill[a]++] = network.contacts[k]
    neighbours[fill[b]] = a
    counts[fill[b]++] = network.contacts[k]
  }
  return { offsets, neighbours, counts }
}

/** A step the app proposes. */
export interface Suggestion {
  /** Stable across steps that do not concern it, so an answer to it is kept. */
  key: string
  kind: SuggestionKind
  step: CurationStep
  words: string
  confidence: number
  features: number[]
  /** What it rests on, a chip each. */
  evidence: string[]
  /** The genomes it concerns, as indices of the curated binning's. */
  genomes: number[]
  /** The contigs it concerns, as indices of the file's. */
  contigs: number[]
  affinity: number
  contacts: number
}

/** The weights each kind is counted with: the initial ones, or what the review taught. */
export type KindWeights = Partial<Record<Exclude<SuggestionKind, 'unlink'>, Weights>>

/** The binning as the method reads it: genome indices and kinds. */
export function methodBinning(binning: CuratedBinning): MethodBinning {
  return { genomeOf: binning.genomeOf, kinds: Uint8Array.from(binning.genomes.map((genome) => (genome.kind === 'mag' ? MAG : ELEMENT))) }
}

/** Every genome's per-marker hits, one array per set: the merges' and recruits' witnesses. */
function genomeMarkers(evidence: CurationEvidence, binning: CuratedBinning): Int32Array[][] {
  return evidence.markers.map((table) => binning.genomes.map((genome) => markerCounts(table, genome.contigs)))
}

/** The set metaTOR judges a set of counts by: the higher weighted completeness. */
function bestSet(evidence: CurationEvidence, perSet: ArrayLike<number>[]): number {
  let best = -1
  let bestWeight = -1
  evidence.markers.forEach((table, s) => {
    const q = qualityOf(table.set, perSet[s])
    if (q.weightedCompleteness > bestWeight) {
      best = s
      bestWeight = q.weightedCompleteness
    }
  })
  return best
}

/** What the stage draws and weighs after every step. */
export interface CurationState {
  tally: GenomeTally
  densities: Densities
  /** Each genome's quality, where the map holds markers. */
  quality: Array<Quality | null>
  suggestions: Suggestion[]
  /** Every two genomes in contact: the contact map's cells. */
  pairs: GenomePairs
  /** Every element and MAG in contact: the host map's links, linked or not. */
  hosts: HostPair[]
  /** Each contig's place: the MAG it meets most densely but its own, and how densely it meets each. */
  contigs: ContigPlaces
}

/** Every two genomes in contact, `a < b`, with their contacts and their affinity. */
export interface GenomePairs {
  a: Int32Array
  b: Int32Array
  contacts: Float64Array
  affinity: Float32Array
}

/** An element and a MAG in contact. */
export interface HostPair {
  element: number
  mag: number
  contacts: number
  affinity: number
  /** The share of the element's contacts with MAGs that go to this one. */
  share: number
  confidence: number
  linked: boolean
}

/** Per contig, as indices of the file's contigs. */
export interface ContigPlaces {
  /** The MAG other than its own it meets most densely, `-1` for none. */
  best: Int32Array
  bestAffinity: Float32Array
  /** Its affinity with its own genome, the genome taken without it; `NaN` in the pool or alone in its genome. */
  ownAffinity: Float32Array
  /** Its contacts with every contig, its own counted twice as a pair with both reads in it is: Hi-C's hits. */
  hits: Float64Array
}

/** Everything the stage needs from the method, for the binning as it stands. */
export function curationState(evidence: CurationEvidence, binning: CuratedBinning, weights: KindWeights = {}, declined: readonly string[] = []): CurationState {
  const method = methodBinning(binning)
  const tallied = tally(evidence.network, evidence.visibility, method)
  const d = densities(tallied)
  const perGenome = genomeMarkers(evidence, binning)
  const quality = binning.genomes.map((_, g) => {
    if (evidence.markers.length === 0) return null
    const s = bestSet(evidence, perGenome.map((sets) => sets[g]))
    return s < 0 ? null : qualityOf(evidence.markers[s].set, perGenome[s][g])
  })
  // The contigs first: a contig binned in the wrong MAG carries every contact
  // between its MAG and the one it belongs to, and every contact of that one's
  // elements with it — a merge or a link it alone explains is not offered until
  // its move is answered: taken, the contig is moved; turned down, the reader
  // has said it is where it is, and its contacts count where it is.
  const n = evidence.network.contigs
  const places: ContigPlaces = {
    best: new Int32Array(n).fill(-1),
    bestAffinity: new Float32Array(n),
    ownAffinity: new Float32Array(n).fill(Number.NaN),
    hits: new Float64Array(n),
  }
  for (let c = 0; c < n; c++) places.hits[c] = evidence.visibility[c] + 2 * evidence.network.within[c]
  const contigs = contigSuggestions(evidence, binning, method, tallied, d, perGenome, weights, places)
  const explained = explainedContacts(evidence, method, contigs, new Set(declined))
  const hosts: HostPair[] = []
  const suggestions = [
    ...merges(evidence, binning, tallied, d, perGenome, weights, explained, quality),
    ...contigs,
    ...links(evidence, binning, tallied, d, weights, explained, hosts),
  ].sort((x, y) => y.confidence - x.confidence || x.key.localeCompare(y.key))
  return { tally: tallied, densities: d, quality, suggestions, pairs: genomePairs(tallied, d), hosts, contigs: places }
}

/** The contact map's cells: every two genomes in contact, and how densely they meet. */
function genomePairs(tallied: GenomeTally, d: Densities): GenomePairs {
  const n = tallied.between.size
  const out: GenomePairs = { a: new Int32Array(n), b: new Int32Array(n), contacts: new Float64Array(n), affinity: new Float32Array(n) }
  let k = 0
  for (const [key, o] of [...tallied.between].sort((x, y) => x[0] - y[0])) {
    const a = Math.floor(key / tallied.genomes)
    const b = key - a * tallied.genomes
    out.a[k] = a
    out.b[k] = b
    out.contacts[k] = o
    out.affinity[k] = affinityBetween(o, tallied.visibility[a], tallied.visibility[b], densityOf(d, a), densityOf(d, b), tallied.total)
    k++
  }
  return out
}

/**
 * The contacts between two genomes that a likely move explains: for every
 * contig whose move away from its MAG is offered at {@link LIKELY} or more, and
 * not turned down (`declined`), its contacts with every other genome, keyed as
 * the tally keys a pair.
 */
function explainedContacts(evidence: CurationEvidence, method: MethodBinning, contigs: readonly Suggestion[], declined: ReadonlySet<string>): Map<number, number> {
  const genomes = method.kinds.length
  const out = new Map<number, number>()
  for (const s of contigs) {
    if (s.kind !== 'move' || s.confidence < LIKELY || declined.has(s.key)) continue
    const c = s.contigs[0]
    const own = method.genomeOf[c]
    for (let k = evidence.offsets[c]; k < evidence.offsets[c + 1]; k++) {
      const g = method.genomeOf[evidence.neighbours[k]]
      if (g < 0 || g === own) continue
      const key = own < g ? own * genomes + g : g * genomes + own
      out.set(key, (out.get(key) ?? 0) + evidence.counts[k])
    }
  }
  return out
}

function lengthOf(evidence: CurationEvidence, contigs: readonly number[]): number {
  let total = 0
  for (const c of contigs) total += evidence.lengths[c]
  return total
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`
}

function grouped(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function affinityText(a: number): string {
  return `affinity ${a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)}`
}

function merges(
  evidence: CurationEvidence,
  binning: CuratedBinning,
  tallied: GenomeTally,
  d: Densities,
  perGenome: Int32Array[][],
  weights: KindWeights,
  explained: ReadonlyMap<number, number>,
  quality: ReadonlyArray<Quality | null>,
): Suggestion[] {
  const out: Suggestion[] = []
  const T = tallied.total
  const { rho } = evidence.background
  for (const [key, all] of tallied.between) {
    const a = Math.floor(key / tallied.genomes)
    const b = key - a * tallied.genomes
    const A = binning.genomes[a]
    const B = binning.genomes[b]
    if (A.kind !== 'mag' || B.kind !== 'mag') continue
    const o = all - (explained.get(key) ?? 0)
    if (!(o > 0)) continue
    const ta = tallied.visibility[a]
    const tb = tallied.visibility[b]
    const aff = affinityBetween(o, ta, tb, densityOf(d, a), densityOf(d, b), T)
    if (!(aff > 0)) continue
    const lower = lowerAffinity(aff, o)
    const p = significance(o, ta, tb, rho, T)
    // The markers of the two under the set the merged genome would be judged by.
    let shared = 0
    let fewer = 0
    let before = ''
    let after = ''
    if (perGenome.length > 0) {
      const union = perGenome.map((sets) => addCounts(sets[a], sets[b]))
      const s = bestSet(evidence, union)
      if (s >= 0) {
        const ca = perGenome[s][a]
        const cb = perGenome[s][b]
        let pa = 0
        let pb = 0
        for (let k = 0; k < ca.length; k++) {
          if (ca[k] > 0) pa++
          if (cb[k] > 0) pb++
          if (ca[k] > 0 && cb[k] > 0) shared++
        }
        fewer = Math.min(pa, pb)
        const set = evidence.markers[s].set
        const qa = qualityOf(set, ca)
        const qb = qualityOf(set, cb)
        const qm = qualityOf(set, union[s])
        before = `completeness ${percent(qa.completeness)} + ${percent(qb.completeness)} → ${percent(qm.completeness)}`
        after = `redundancy ${Math.max(qa.redundancy, qb.redundancy).toFixed(2)} → ${qm.redundancy.toFixed(2)}`
      }
    }
    const features = mergeFeatures(lower, o, shared, fewer, p)
    const confidence = confidenceOf(features, weights.merge ?? INITIAL_WEIGHTS.merge)
    if (confidence < OFFER_FLOOR) continue
    // The more complete keeps its name, the longer on a tie — as a question of
    // several merges keeps its most complete member's (`questions.ts`).
    const ca = quality[a]?.weightedCompleteness ?? -1
    const cb = quality[b]?.weightedCompleteness ?? -1
    const [keep, fold] = ca > cb || (ca === cb && lengthOf(evidence, A.contigs) >= lengthOf(evidence, B.contigs)) ? [A, B] : [B, A]
    const evidenceChips = [affinityText(aff), `${grouped(o)} contacts`]
    if (before !== '') {
      evidenceChips.push(before, after)
      if (fewer > 0) evidenceChips.push(shared === 0 ? 'markers complementary' : `${shared} of ${fewer} markers shared`)
    }
    if (p > 1e-3) evidenceChips.push('within the background')
    out.push({
      key: `merge:${[A.id, B.id].sort().join('+')}`,
      kind: 'merge',
      step: { op: 'merge', into: keep.id, genomes: [fold.id] },
      words: `merge ${fold.name} into ${keep.name}`,
      confidence,
      features,
      evidence: evidenceChips,
      genomes: keep === A ? [a, b] : [b, a],
      contigs: [],
      affinity: aff,
      contacts: o,
    })
  }
  return out
}

function contigSuggestions(
  evidence: CurationEvidence,
  binning: CuratedBinning,
  method: MethodBinning,
  tallied: GenomeTally,
  d: Densities,
  perGenome: Int32Array[][],
  weights: KindWeights,
  places: ContigPlaces,
): Suggestion[] {
  const out: Suggestion[] = []
  const T = tallied.total
  const { rho } = evidence.background
  const t = evidence.visibility
  const sure = new Map<number, Suggestion[]>()
  const toGenome = new Map<number, number>()
  for (let c = 0; c < evidence.network.contigs; c++) {
    const own = method.genomeOf[c]
    // Elements' contigs are the hand's to move: a plasmid meets its host densely.
    if (own >= 0 && method.kinds[own] !== MAG) continue
    if (own >= 0 && tallied.size[own] < 2) continue
    if (!(t[c] > 0)) continue
    toGenome.clear()
    for (let k = evidence.offsets[c]; k < evidence.offsets[c + 1]; k++) {
      const g = method.genomeOf[evidence.neighbours[k]]
      if (g < 0 || method.kinds[g] !== MAG) continue
      toGenome.set(g, (toGenome.get(g) ?? 0) + evidence.counts[k])
    }
    if (toGenome.size === 0) continue
    // Its affinity with its own genome, the genome taken without it.
    let ownAffinity = 0
    if (own >= 0) {
      const o = toGenome.get(own) ?? 0
      const tRest = tallied.visibility[own] - t[c]
      const withinRest = tallied.within[own] - o
      const density = withinRest > 0 && tRest > 0 && tallied.size[own] >= 3 ? (2 * withinRest * T) / (tRest * tRest) : d.typical
      ownAffinity = affinity(o, t[c], tRest, density, T)
      places.ownAffinity[c] = ownAffinity
    }
    let best = -1
    let bestAffinity = 0
    let next = 0
    for (const [g, o] of toGenome) {
      if (g === own) continue
      const a = affinity(o, t[c], tallied.visibility[g], densityOf(d, g), T)
      if (a > bestAffinity) {
        next = bestAffinity
        bestAffinity = a
        best = g
      } else if (a > next) next = a
    }
    if (best < 0) continue
    places.best[c] = best
    places.bestAffinity[c] = bestAffinity
    const o = toGenome.get(best) ?? 0
    const lower = lowerAffinity(bestAffinity, o)
    const kind: 'recruit' | 'move' = own < 0 ? 'recruit' : 'move'
    if (kind === 'move' && !(lower > ownAffinity)) continue
    const p = significance(o, t[c], tallied.visibility[best], rho, T)
    // Its markers the genome already has, under the set the genome is judged by.
    let duplicated = 0
    if (perGenome.length > 0) {
      const s = bestSet(evidence, perGenome.map((sets) => sets[best]))
      if (s >= 0) {
        const table = evidence.markers[s]
        const have = perGenome[s][best]
        for (let k = table.offsets[c]; k < table.offsets[c + 1]; k++) if (table.counts[k] > 0 && have[table.ids[k]] > 0) duplicated++
      }
    }
    const features = contigFeatures(lower, kind === 'move' ? ownAffinity : next, duplicated, p)
    const confidence = confidenceOf(features, weights[kind] ?? INITIAL_WEIGHTS[kind])
    if (confidence < OFFER_FLOOR) continue
    const target = binning.genomes[best]
    const name = evidence.names[c]
    const chips = [affinityText(bestAffinity), `${grouped(o)} contacts`]
    if (kind === 'move') chips.push(`its own ${affinityText(ownAffinity).slice(9)}`)
    else if (next > 0) chips.push(`next best ${affinityText(next).slice(9)}`)
    if (duplicated > 0) chips.push(`${duplicated} marker${duplicated === 1 ? '' : 's'} it has already`)
    if (p > 1e-3) chips.push('within the background')
    const suggestion: Suggestion = {
      key: `${kind}:${name}>${target.id}`,
      kind,
      step: { op: 'move', contigs: [name], to: target.id },
      words: kind === 'recruit' ? `recruit ${name} into ${target.name}` : `move ${name} from ${binning.genomes[own].name} to ${target.name}`,
      confidence,
      features,
      evidence: chips,
      genomes: kind === 'move' ? [best, own] : [best],
      contigs: [c],
      affinity: bestAffinity,
      contacts: o,
    }
    if (kind === 'recruit' && confidence >= SURE) {
      const list = sure.get(best) ?? []
      list.push(suggestion)
      sure.set(best, list)
    } else out.push(suggestion)
  }
  // The sure recruits into one MAG, one answer: the least sure of them is the group's confidence.
  for (const [g, list] of sure) {
    if (list.length === 1) {
      out.push(list[0])
      continue
    }
    list.sort((x, y) => y.confidence - x.confidence || x.key.localeCompare(y.key))
    const target = binning.genomes[g]
    const contigs = list.map((s) => s.contigs[0])
    const length = lengthOf(evidence, contigs)
    out.push({
      key: `recruit:${target.id}:${list.map((s) => evidence.names[s.contigs[0]]).sort().join(',')}`,
      kind: 'recruit',
      step: { op: 'move', contigs: contigs.map((c) => evidence.names[c]), to: target.id },
      words: `recruit ${list.length.toLocaleString('en-US')} contigs into ${target.name}`,
      confidence: Math.min(...list.map((s) => s.confidence)),
      features: list[list.length - 1].features,
      evidence: [fmt.bp(length), `each at ${percent(SURE)} or more`, `${grouped(list.reduce((sum, s) => sum + s.contacts, 0))} contacts`],
      genomes: [g],
      contigs,
      affinity: Math.min(...list.map((s) => s.affinity)),
      contacts: list.reduce((sum, s) => sum + s.contacts, 0),
    })
  }
  return out
}

function links(
  evidence: CurationEvidence,
  binning: CuratedBinning,
  tallied: GenomeTally,
  d: Densities,
  weights: KindWeights,
  explained: ReadonlyMap<number, number>,
  hosts: HostPair[],
): Suggestion[] {
  const out: Suggestion[] = []
  const T = tallied.total
  const { rho } = evidence.background
  const linked = new Set(binning.links.map((link) => `${link.element}\t${link.mag}`))
  const withMags = new Float64Array(tallied.genomes)
  const pairs: Array<[number, number, number]> = []
  for (const [key, all] of tallied.between) {
    const a = Math.floor(key / tallied.genomes)
    const b = key - a * tallied.genomes
    const ka = binning.genomes[a].kind
    const kb = binning.genomes[b].kind
    if (ka === kb) continue
    const [e, m] = ka === 'element' ? [a, b] : [b, a]
    // What a MAG's likely misplaced contigs bring is theirs, not the MAG's.
    const o = all - (explained.get(key) ?? 0)
    withMags[e] += o
    if (o > 0) pairs.push([e, m, o])
  }
  const seen = new Set<string>()
  for (const [e, m, o] of pairs) {
    const element = binning.genomes[e]
    const mag = binning.genomes[m]
    const aff = affinity(o, tallied.visibility[e], tallied.visibility[m], densityOf(d, m), T)
    const lower = lowerAffinity(aff, o)
    const share = withMags[e] > 0 ? o / withMags[e] : 0
    const p = significance(o, tallied.visibility[e], tallied.visibility[m], rho, T)
    const features = linkFeatures(lower, share, p)
    const confidence = confidenceOf(features, weights.link ?? INITIAL_WEIGHTS.link)
    const pair = `${element.id}\t${mag.id}`
    seen.add(pair)
    hosts.push({ element: e, mag: m, contacts: o, affinity: aff, share, confidence, linked: linked.has(pair) })
    const chips = [affinityText(aff), `${percent(share)} of its contacts with MAGs`, `${grouped(o)} contacts`]
    if (p > 1e-3) chips.push('within the background')
    if (linked.has(pair)) {
      if (confidence >= OFFER_FLOOR) continue
      out.push({
        key: `unlink:${element.id}>${mag.id}`,
        kind: 'unlink',
        step: { op: 'unlink', element: element.id, mag: mag.id },
        words: `unlink ${element.name} from ${mag.name}`,
        confidence: 1 - confidence,
        features,
        evidence: chips,
        genomes: [e, m],
        contigs: [],
        affinity: aff,
        contacts: o,
      })
    } else if (confidence >= OFFER_FLOOR) {
      out.push({
        key: `link:${element.id}>${mag.id}`,
        kind: 'link',
        step: { op: 'link', element: element.id, mag: mag.id },
        words: `link ${element.name} to ${mag.name}`,
        confidence,
        features,
        evidence: chips,
        genomes: [e, m],
        contigs: [],
        affinity: aff,
        contacts: o,
      })
    }
  }
  // A link between two genomes in no contact at all: nothing supports it.
  for (const link of binning.links) {
    if (seen.has(`${link.element}\t${link.mag}`)) continue
    const e = binning.indexOfId(link.element)
    const m = binning.indexOfId(link.mag)
    if (e === undefined || m === undefined) continue
    out.push({
      key: `unlink:${link.element}>${link.mag}`,
      kind: 'unlink',
      step: { op: 'unlink', element: link.element, mag: link.mag },
      words: `unlink ${binning.genomes[e].name} from ${binning.genomes[m].name}`,
      confidence: 1 - confidenceOf(linkFeatures(0, 0, 1), weights.link ?? INITIAL_WEIGHTS.link),
      features: linkFeatures(0, 0, 1),
      evidence: ['no contact between them'],
      genomes: [e, m],
      contigs: [],
      affinity: 0,
      contacts: 0,
    })
  }
  return out
}

