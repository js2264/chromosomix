/**
 * The host map's arithmetic (SPECS §33.3), apart from its canvas: which MAG
 * each element is placed beside, the rows the two columns take, the links
 * drawn between them and what each rests on, the genomes shown around the
 * selection — around an element, the MAGs it meets that no link joins it to
 * and the elements it meets most —, a link's curve and how near a point is to
 * it, labels pushed apart where they crowd, and the words the readout prints.
 *
 * **Two columns that share their rows.** The MAGs on the left in the stage's
 * order, the elements on the right, each **beside the MAG it meets most** —
 * so a link mostly runs level, and a MAG that hosts many elements fans out to
 * them. Every MAG is a **band** of rows, one for each element placed beside
 * it, one at least, its node at the band's middle; an element is a row of the
 * band of its MAG. Elements that meet no MAG, and are linked to none, fold
 * into the foot. Where an element is placed is **kept across steps**, as the
 * stage's order is: set when the stage opens and on *tidy*, an element keeps
 * its MAG while that MAG lasts, a new one goes beside the genome its contigs
 * came from (else the MAG it meets most), and one gone leaves no hole.
 *
 * Pure: arrays in, arrays out, so the pane's logic is tested without a canvas.
 */

import type { GenomeKind } from '../../genome/curation'
import { fmt } from '../../units'
import { lowerAffinity } from '../method'
import { displayPercent } from '../model'
import type { PairList } from '../order'
import type { Question } from '../questions'
import type { HostPair, Suggestion } from '../suggest'
import { affinityText } from './contactLayout'

/** A genome as the host map places it. */
export interface HostGenome {
  id: string
  kind: GenomeKind
}

// ---------------------------------------------------------------------------
// Where each element goes.
// ---------------------------------------------------------------------------

/**
 * The MAG each element is placed beside, by id, `null` for none.
 *
 * Kept where `kept` names a MAG still there (and `allowed`, where given);
 * else, for an element a step made, beside the genome its contigs came from
 * (`from`): that MAG, or that element's place — the one earliest in the order,
 * as the stage's order puts a new genome after its first source; else the MAG
 * it meets most densely by the pairs, as `curate/order.ts`'s `elementOrder`
 * places it (a tie to the MAG earlier in the order); else a MAG it is linked
 * to, though they do not meet, so the link is drawn; else none.
 *
 * @param rank Each MAG's place in the stage's order: a MAG it does not name is never a place.
 * @param options.kept The places held before a step, by element id.
 * @param options.allowed The MAGs shown, around the selection: no other is a place.
 * @param options.from The genomes each new element's contigs came from ({@link sourcesOf}).
 */
export function hostAnchors(
  genomes: readonly HostGenome[],
  pairs: PairList,
  links: ReadonlyArray<{ element: string; mag: string }>,
  rank: ReadonlyMap<string, number>,
  options: { kept?: ReadonlyMap<string, string | null>; allowed?: ReadonlySet<string>; from?: ReadonlyMap<string, readonly string[]> } = {},
): Map<string, string | null> {
  const { kept, allowed, from } = options
  const can = (id: string | null | undefined): id is string => id !== undefined && id !== null && rank.has(id) && (allowed === undefined || allowed.has(id))
  const best = bestHosts(genomes, pairs, rank, allowed)
  // Each element's linked MAG earliest in the order, one pass over the links.
  const linked = new Map<string, string>()
  for (const link of links) {
    if (!can(link.mag)) continue
    const held = linked.get(link.element)
    if (held === undefined || (rank.get(link.mag) as number) < (rank.get(held) as number)) linked.set(link.element, link.mag)
  }
  // A source MAG is a place itself; a source element lends its place.
  const sourcePlace = (id: string): string | null => {
    let place: string | null = null
    for (const source of from?.get(id) ?? []) {
      const at = can(source) ? source : (kept?.get(source) ?? null)
      if (!can(at)) continue
      if (place === null || (rank.get(at) as number) < (rank.get(place) as number)) place = at
    }
    return place
  }
  const out = new Map<string, string | null>()
  for (const genome of genomes) {
    if (genome.kind !== 'element') continue
    const held = kept?.get(genome.id) ?? null
    out.set(genome.id, can(held) ? held : (sourcePlace(genome.id) ?? best.get(genome.id)?.mag ?? linked.get(genome.id) ?? null))
  }
  return out
}

/**
 * Where each element new since a binning came from: the genomes of that
 * binning whose contigs it holds now, by id — the MAG an element was made
 * from, the element it was split from. A genome retyped keeps its id, and is
 * not its own source.
 *
 * @param known The elements already placed: no other is new.
 */
export function sourcesOf(
  before: { genomes: readonly HostGenome[]; genomeOf: ArrayLike<number> },
  after: { genomes: readonly HostGenome[]; genomeOf: ArrayLike<number> },
  known: { has(id: string): boolean },
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const fresh = after.genomes.map((genome) => genome.kind === 'element' && !known.has(genome.id))
  if (!fresh.includes(true)) return out
  const n = Math.min(before.genomeOf.length, after.genomeOf.length)
  for (let c = 0; c < n; c++) {
    const g = after.genomeOf[c]
    if (g < 0 || fresh[g] !== true) continue
    const was = before.genomeOf[c]
    const source = was < 0 ? undefined : before.genomes[was]?.id
    const id = after.genomes[g].id
    if (source === undefined || source === id) continue
    const list = out.get(id)
    if (list === undefined) out.set(id, [source])
    else if (!list.includes(source)) list.push(source)
  }
  return out
}

/**
 * Each element's densest MAG by the pairs, by id, with their affinity: the
 * MAG earlier in the order on a tie. Only the MAGs `rank` names (and
 * `allowed`, where given) count; an element meeting none has no entry.
 */
export function bestHosts(
  genomes: readonly HostGenome[],
  pairs: PairList,
  rank: ReadonlyMap<string, number>,
  allowed?: ReadonlySet<string>,
): Map<string, { mag: string; affinity: number }> {
  const best = new Map<string, { mag: string; affinity: number; rank: number }>()
  for (let k = 0; k < pairs.a.length; k++) {
    let e = pairs.a[k]
    let m = pairs.b[k]
    if (genomes[e]?.kind !== 'element') [e, m] = [m, e]
    if (genomes[e]?.kind !== 'element' || genomes[m]?.kind !== 'mag') continue
    const affinity = pairs.affinity[k]
    if (!(affinity > 0)) continue
    const mag = genomes[m].id
    const r = rank.get(mag)
    if (r === undefined || (allowed !== undefined && !allowed.has(mag))) continue
    const element = genomes[e].id
    const held = best.get(element)
    if (held === undefined || affinity > held.affinity || (affinity === held.affinity && r < held.rank)) best.set(element, { mag, affinity, rank: r })
  }
  return new Map([...best].map(([element, { mag, affinity }]) => [element, { mag, affinity }]))
}

/** Each MAG's place in an order: the MAGs it names, then those it does not, in the genomes' order. */
export function magRank(genomes: readonly HostGenome[], order: readonly string[]): Map<string, number> {
  const mags = new Set(genomes.filter((genome) => genome.kind === 'mag').map((genome) => genome.id))
  const rank = new Map<string, number>()
  for (const id of order) if (mags.has(id) && !rank.has(id)) rank.set(id, rank.size)
  for (const genome of genomes) if (genome.kind === 'mag' && !rank.has(genome.id)) rank.set(genome.id, rank.size)
  return rank
}

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------

/** A MAG's band: rows `[from, to)`, its node at `at`, the band's middle, in rows from the top. */
export interface HostBand {
  id: string
  from: number
  to: number
  at: number
}

/** An element's row, and the MAG whose band it is in, `null` at the foot. */
export interface HostPlace {
  id: string
  row: number
  anchor: string | null
}

export interface HostLayout {
  /** The MAGs, top to bottom. */
  mags: HostBand[]
  /** The elements placed, top to bottom: the bands', then the foot's when it is open. */
  elements: HostPlace[]
  /** The rows the bands take. */
  rows: number
  /** The elements beside no MAG, in the order's order: folded, or after the bands when open. */
  foot: string[]
  /** Rows in all: the bands', and the foot's when it is open. */
  total: number
}

/**
 * The two columns' rows: each MAG of the order a band of as many rows as the
 * elements placed beside it (one at least), those elements its rows in the
 * order's order; the elements beside no MAG in the foot, given rows after the
 * bands only when it is open. A genome the order does not know — one a
 * previewed step would create — comes after the others of its kind.
 *
 * @param options.visible Around the selection: only these genomes.
 * @param options.footOpen Whether the foot's elements are given rows.
 */
export function hostLayout(
  genomes: readonly HostGenome[],
  order: readonly string[],
  anchors: ReadonlyMap<string, string | null>,
  options: { visible?: ReadonlySet<string> | null; footOpen?: boolean } = {},
): HostLayout {
  const visible = options.visible ?? null
  const kind = new Map(genomes.map((genome) => [genome.id, genome.kind]))
  const shown = (id: string): boolean => visible === null || visible.has(id)
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const id of order) {
    if (!kind.has(id) || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  for (const genome of genomes) {
    if (seen.has(genome.id)) continue
    seen.add(genome.id)
    ordered.push(genome.id)
  }
  const mags = ordered.filter((id) => kind.get(id) === 'mag' && shown(id))
  const magSet = new Set(mags)
  const beside = new Map<string, string[]>(mags.map((id) => [id, []]))
  const foot: string[] = []
  for (const id of ordered) {
    if (kind.get(id) !== 'element' || !shown(id)) continue
    const anchor = anchors.get(id) ?? null
    if (anchor !== null && magSet.has(anchor)) (beside.get(anchor) as string[]).push(id)
    else foot.push(id)
  }
  const bands: HostBand[] = []
  const elements: HostPlace[] = []
  let rows = 0
  for (const id of mags) {
    const list = beside.get(id) as string[]
    const from = rows
    const to = from + Math.max(1, list.length)
    bands.push({ id, from, to, at: (from + to) / 2 })
    list.forEach((element, k) => elements.push({ id: element, row: from + k, anchor: id }))
    rows = to
  }
  const open = options.footOpen === true
  if (open) foot.forEach((id, k) => elements.push({ id, row: rows + k, anchor: null }))
  return { mags: bands, elements, rows, foot, total: rows + (open ? foot.length : 0) }
}

// ---------------------------------------------------------------------------
// The links.
// ---------------------------------------------------------------------------

/** A link the host map draws: one held, one offered, or both — a held link a suggestion would undo. */
export interface HostLink {
  /** `element`, a tab, `mag`: one key a pair. */
  key: string
  element: string
  mag: string
  /** Held: from the file, taken from a suggestion, or made by hand. */
  held: boolean
  fromFile: boolean
  /** The two in contact: their numbers; `null` where they do not meet. */
  pair: HostPair | null
  /** The suggestion on offer for the pair: a link to make, or a held one to undo. */
  offer: Suggestion | null
  /**
   * Neither held nor offered: a MAG an element chosen meets, drawn faint around
   * it as what its hosts are judged against ({@link neighbourhood}).
   */
  met: boolean
}

/** One key a pair of an element and a MAG. */
export function linkKey(element: string, mag: string): string {
  return `${element}\t${mag}`
}

/**
 * The links to draw: every link held, and every link or unlink on offer, one
 * a pair, with the pair's numbers. Pairs neither held nor offered are not
 * drawn.
 *
 * @param answer The binning drawn.
 * @param offers The link and unlink suggestions on offer, by the two genomes' ids.
 */
export function hostLinks(
  answer: { genomes: readonly HostGenome[]; links: ReadonlyArray<{ element: string; mag: string; fromFile: boolean }>; hosts: readonly HostPair[] },
  offers: ReadonlyArray<{ element: string; mag: string; suggestion: Suggestion }>,
): HostLink[] {
  const pairs = new Map<string, HostPair>()
  for (const pair of answer.hosts) {
    const e = answer.genomes[pair.element]?.id
    const m = answer.genomes[pair.mag]?.id
    if (e !== undefined && m !== undefined) pairs.set(linkKey(e, m), pair)
  }
  const out = new Map<string, HostLink>()
  for (const link of answer.links) {
    const key = linkKey(link.element, link.mag)
    out.set(key, { key, element: link.element, mag: link.mag, held: true, fromFile: link.fromFile, pair: pairs.get(key) ?? null, offer: null, met: false })
  }
  for (const { element, mag, suggestion } of offers) {
    const key = linkKey(element, mag)
    const held = out.get(key)
    // A link offered for a pair held, or an unlink for one not held: the binning moved on; not drawn.
    if (held === undefined) {
      if (suggestion.kind === 'link') out.set(key, { key, element, mag, held: false, fromFile: false, pair: pairs.get(key) ?? null, offer: suggestion, met: false })
    } else if (suggestion.kind === 'unlink') held.offer = suggestion
  }
  return [...out.values()]
}

/**
 * What the head counts of the offers, all of them — drawn or not: the links
 * offered for pairs not held, and the held links an unlink is offered for, as
 * {@link hostLinks} draws them.
 */
export function offerCounts(
  held: ReadonlyArray<{ element: string; mag: string }>,
  offers: ReadonlyArray<{ element: string; mag: string; suggestion: Pick<Suggestion, 'kind'> }>,
): { offered: number; unlink: number } {
  const keys = new Set(held.map((link) => linkKey(link.element, link.mag)))
  let offered = 0
  let unlink = 0
  for (const { element, mag, suggestion } of offers) {
    const isHeld = keys.has(linkKey(element, mag))
    if (suggestion.kind === 'link' && !isHeld) offered++
    else if (suggestion.kind === 'unlink' && isHeld) unlink++
  }
  return { offered, unlink }
}

/** Links held, links offered, and held links an unlink is offered for. */
export interface LinkCounts {
  held: number
  offered: number
  unlink: number
}

/**
 * What the head counts of the links drawn: those held, those offered, and the
 * held ones an unlink is offered for — around the selection, what is shown,
 * not the map's. A MAG an element only meets is no link, and is not counted.
 */
export function drawnCounts(links: ReadonlyArray<Pick<HostLink, 'held' | 'offer' | 'met'>>): LinkCounts {
  let held = 0
  let offered = 0
  let unlink = 0
  for (const link of links) {
    if (link.met) continue
    if (link.held) {
      held++
      if (link.offer?.kind === 'unlink') unlink++
    } else if (link.offer?.kind === 'link') offered++
  }
  return { held, offered, unlink }
}

/**
 * The head's counts, in parts: the links held first — the part that never
 * gives way —, then the links offered and the held ones to unlink where there
 * are any. Every count is of links, one a pair of an element and a MAG — never
 * of questions, which take an element's links together (`96 links · 17 links
 * offered · 1 to unlink`) —; around the selection, each says what is drawn of
 * the map's (`13 of 96 links · 3 of 17 links offered`).
 *
 * @param whole The map's counts, around the selection; `null` where the map draws them all.
 */
export function countParts(drawn: LinkCounts, whole: LinkCounts | null): string[] {
  const of = (n: number, all: number, one: string, many?: string): string => (whole === null ? counted(n, one, many) : `${fmt.int(n)} of ${counted(all, one, many)}`)
  const parts = [of(drawn.held, whole?.held ?? 0, 'link')]
  if (drawn.offered > 0) parts.push(`${of(drawn.offered, whole?.offered ?? 0, 'link')} offered`)
  if (drawn.unlink > 0) parts.push(`${whole === null ? fmt.int(drawn.unlink) : `${fmt.int(drawn.unlink)} of ${fmt.int(whole.unlink)}`} to unlink`)
  return parts
}

/** A link's weight: `1 + 3 × share` CSS pixels, its share of the element's contacts with MAGs. */
export function linkWidth(link: Pick<HostLink, 'pair'>): number {
  const share = link.pair?.share ?? 0
  return 1 + 3 * Math.max(0, Math.min(1, share))
}

/**
 * The genomes shown around the selection: the genomes chosen, every genome
 * linked to them — held or offered —, the other MAGs a chosen MAG's elements
 * are linked to, and the other elements a chosen element's MAGs host.
 */
export function aroundSet(focus: Iterable<string>, links: ReadonlyArray<Pick<HostLink, 'element' | 'mag'>>, kindOf: (id: string) => GenomeKind | undefined): Set<string> {
  const chosen = new Set<string>()
  for (const id of focus) if (kindOf(id) !== undefined) chosen.add(id)
  const out = new Set(chosen)
  // One step out, from the genomes chosen only: never on through what it adds.
  const theirElements = new Set<string>()
  const theirHosts = new Set<string>()
  for (const link of links) {
    if (chosen.has(link.mag)) {
      out.add(link.element)
      theirElements.add(link.element)
    }
    if (chosen.has(link.element)) {
      out.add(link.mag)
      theirHosts.add(link.mag)
    }
  }
  // The other hosts of a chosen MAG's elements; the other elements of a chosen element's hosts.
  for (const link of links) {
    if (theirElements.has(link.element)) out.add(link.mag)
    if (theirHosts.has(link.mag)) out.add(link.element)
  }
  return out
}

/** Around an element, the elements it meets most — the selection card's *elements that meet it*, as many. */
export const AROUND_ELEMENTS = 5
/** Around an element, the MAGs it meets most that no link joins it to: drawn faint, this many. */
export const AROUND_RIVALS = 3

/** What {@link neighbourhood} reads of a binning: its genomes, the pairs that meet, and each element's contacts with each MAG. */
export interface AroundAnswer {
  genomes: readonly HostGenome[]
  pairs: PairList
  hosts: readonly HostPair[]
}

/**
 * What around the selection shows ({@link aroundSet}), and around an element
 * chosen more: the elements it meets most densely — the five the selection
 * card lists, in its order — and the MAGs it meets most that no link drawn
 * joins it to, by their affinity, each a link to draw faint (`met`) with the
 * pair's numbers: the rivals its hosts are judged against.
 *
 * @param links The links drawn: held and offered.
 * @returns `genomes` to show, `met` links to draw, and `meets`, the elements a chosen element meets most.
 */
export function neighbourhood(
  focus: Iterable<string>,
  answer: AroundAnswer,
  links: readonly HostLink[],
  most: { elements?: number; rivals?: number } = {},
): { genomes: Set<string>; met: HostLink[]; meets: Set<string> } {
  const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
  const kindOf = (id: string): GenomeKind | undefined => {
    const g = index.get(id)
    return g === undefined ? undefined : answer.genomes[g].kind
  }
  const focused = [...focus]
  const genomes = aroundSet(focused, links, kindOf)
  const met: HostLink[] = []
  const meets = new Set<string>()
  const joined = new Set(links.map((link) => link.key))
  const elementsMost = most.elements ?? AROUND_ELEMENTS
  const rivalsMost = most.rivals ?? AROUND_RIVALS
  for (const id of new Set(focused)) {
    const e = index.get(id)
    if (e === undefined || answer.genomes[e].kind !== 'element') continue
    // The elements it meets, densest first, as the card orders them.
    const others: Array<{ other: number; affinity: number }> = []
    for (let k = 0; k < answer.pairs.a.length; k++) {
      const other = answer.pairs.a[k] === e ? answer.pairs.b[k] : answer.pairs.b[k] === e ? answer.pairs.a[k] : -1
      if (other >= 0 && answer.genomes[other]?.kind === 'element') others.push({ other, affinity: answer.pairs.affinity[k] })
    }
    others.sort((x, y) => y.affinity - x.affinity || x.other - y.other)
    for (const { other } of others.slice(0, elementsMost)) {
      genomes.add(answer.genomes[other].id)
      meets.add(answer.genomes[other].id)
    }
    // The MAGs it meets that no link drawn joins it to, densest first.
    const rivals = answer.hosts
      .filter((pair) => pair.element === e && pair.contacts > 0 && answer.genomes[pair.mag]?.kind === 'mag' && !joined.has(linkKey(id, answer.genomes[pair.mag].id)))
      .sort((x, y) => y.affinity - x.affinity || y.contacts - x.contacts || x.mag - y.mag)
    for (const pair of rivals.slice(0, rivalsMost)) {
      const mag = answer.genomes[pair.mag].id
      genomes.add(mag)
      met.push({ key: linkKey(id, mag), element: id, mag, held: false, fromFile: false, pair, offer: null, met: true })
    }
  }
  return { genomes, met, meets }
}

/** What is lit with a set of genomes: they, the genomes linked to them, and those links. */
export function relatedTo(focus: ReadonlySet<string>, links: readonly HostLink[]): { genomes: Set<string>; links: Set<string> } {
  const genomes = new Set(focus)
  const keys = new Set<string>()
  for (const link of links) {
    if (!focus.has(link.element) && !focus.has(link.mag)) continue
    keys.add(link.key)
    genomes.add(link.element)
    genomes.add(link.mag)
  }
  return { genomes, links: keys }
}

/** The pairs a suggestion, or a question's every member, would link or unlink, by the genomes' ids. */
export function suggestedPairs(s: Suggestion, idOf: (g: number) => string | undefined): Array<{ element: string; mag: string; kind: 'link' | 'unlink' }> {
  const members: readonly Suggestion[] = 'members' in s ? (s as Question).members : [s]
  const out: Array<{ element: string; mag: string; kind: 'link' | 'unlink' }> = []
  for (const member of members) {
    if (member.kind !== 'link' && member.kind !== 'unlink') continue
    const element = idOf(member.genomes[0])
    const mag = idOf(member.genomes[1])
    if (element !== undefined && mag !== undefined) out.push({ element, mag, kind: member.kind })
  }
  return out
}

/** A question's number: the one rule, in `curate/questions.ts`. */
export { questionNumber } from '../questions'

// ---------------------------------------------------------------------------
// Geometry.
// ---------------------------------------------------------------------------

/** A node's width: on a log scale of its length, from `narrow` (the shortest) to `wide` (the longest). */
export function barWidth(length: number, least: number, most: number, narrow: number, wide: number): number {
  if (!(most > least) || !(least > 0) || !(length > 0)) return (narrow + wide) / 2
  const t = (Math.log(length) - Math.log(least)) / (Math.log(most) - Math.log(least))
  return narrow + (wide - narrow) * Math.max(0, Math.min(1, t))
}

/** A node's height at a row pitch: 6 pixels with room, 3 where rows crowd, thinner past that. */
export function barHeight(pitch: number): number {
  if (pitch >= 9) return 6
  if (pitch >= 5) return 3
  return Math.max(1, Math.round((pitch - 1) * 2) / 2)
}

/** Rows' pitch to show `rows` in `height` pixels, never more than `most`. */
export function fitPitch(rows: number, height: number, most: number): number {
  if (!(rows > 0) || !(height > 0)) return most
  return Math.min(most, height / rows)
}

/** A scroll kept inside its content: `0` to the content's overflow. */
export function clampScroll(scroll: number, content: number, view: number): number {
  return Math.max(0, Math.min(Math.max(0, content - view), scroll))
}

/** A link's curve, from the MAG's side to the element's: its control points, level at both ends. */
export function linkCurve(x0: number, y0: number, x1: number, y1: number): [number, number, number, number, number, number, number, number] {
  const c = (x1 - x0) * 0.5
  return [x0, y0, x0 + c, y0, x1 - c, y1, x1, y1]
}

/** A point of a link's curve, `t` from `0` (the MAG's side) to `1`. */
export function curvePoint(x0: number, y0: number, x1: number, y1: number, t: number): [number, number] {
  const [ax, ay, bx, by, cx, cy, dx, dy] = linkCurve(x0, y0, x1, y1)
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [a * ax + b * bx + c * cx + d * dx, a * ay + b * by + c * cy + d * dy]
}

/** How far a point is from a link's curve, in pixels: measured on 24 chords of it. */
export function linkDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const steps = 24
  let best = Number.POSITIVE_INFINITY
  let [ax, ay] = [x0, y0]
  for (let k = 1; k <= steps; k++) {
    const [bx, by] = curvePoint(x0, y0, x1, y1, k / steps)
    best = Math.min(best, segmentDistance(px, py, ax, ay, bx, by))
    ax = bx
    ay = by
  }
  return best
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * Labels' middles, each as near the middle it wants as the ones before it
 * allow — `size` apart, inside `[lo, hi]` —, the last ones pushed back up from
 * the bottom; in the order given, which is top to bottom.
 */
export function spreadLabels(wanted: readonly number[], lo: number, hi: number, size: number): number[] {
  const out = new Array<number>(wanted.length)
  let floor = lo + size / 2
  wanted.forEach((y, k) => {
    out[k] = Math.max(floor, y)
    floor = out[k] + size
  })
  let ceiling = hi - size / 2
  for (let k = wanted.length - 1; k >= 0; k--) {
    if (out[k] > ceiling) out[k] = ceiling
    ceiling = out[k] - size
  }
  return out
}

/**
 * Which nodes of a column have room for their name: at least `room` from the
 * nodes either side. `ys` top to bottom.
 */
export function roomy(ys: readonly number[], room: number): boolean[] {
  return ys.map((y, k) => (k === 0 || y - ys[k - 1] >= room) && (k === ys.length - 1 || ys[k + 1] - y >= room))
}

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

/**
 * A link as the readout says it: the element and the MAG, whether it is held
 * and where from — or, around an element, that a MAG it meets is not linked —,
 * what is on offer, the affinity and its lower bound, the share of the
 * element's contacts with MAGs it takes (as the map labels it, {@link
 * shareText}), the contacts, and how sure the method is the MAG hosts it — or,
 * before the contacts are read (`counted` false), that its numbers are to
 * come: not that it has none.
 */
export function linkWords(link: HostLink, element: string, mag: string, counted = true): string {
  const parts = [`${element} ↔ ${mag}`]
  if (link.held) parts.push(link.fromFile ? 'linked, from the file' : 'linked')
  else if (link.met) parts.push('not linked')
  if (link.offer?.kind === 'link') parts.push('link offered')
  else if (link.offer?.kind === 'unlink') parts.push('unlink offered')
  if (!counted) {
    parts.push('its numbers once the contacts are read')
    return parts.join(' · ')
  }
  const pair = link.pair
  if (pair === null || !(pair.contacts > 0)) {
    parts.push('no contacts')
    return parts.join(' · ')
  }
  parts.push(
    `affinity ${affinityText(pair.affinity)} (at least ${affinityText(lowerAffinity(pair.affinity, pair.contacts))})`,
    `${shareText(pair.share)} of its MAG contacts`,
    `${fmt.int(pair.contacts)} contact${Math.round(pair.contacts) === 1 ? '' : 's'}`,
    `host ${displayPercent(pair.confidence)}%`,
  )
  return parts.join(' · ')
}

/**
 * A share of an element's contacts with MAGs, as its link is labelled around
 * it and the readout says it: whole from a tenth (`97%`, `12%`), to a tenth of
 * a percent below (`4.2%`, `0.3%`) — a rival's few contacts are not `0%` —, and
 * `<0.1%` past that.
 */
export function shareText(share: number): string {
  if (!(share > 0)) return '0%'
  if (share >= 0.0995) return fmt.pct(share, 0)
  if (share >= 0.00095) return fmt.pct(share, 1)
  return '<0.1%'
}

/** A count of things: `1 element`, `3 elements`. */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${fmt.int(n)} ${n === 1 ? one : many}`
}

/**
 * The elements the map folds, as its foot says them: those that meet no MAG
 * (`1 meets no MAG`, `46 meet no MAG`) — before the contacts are read, those
 * the file links to none.
 */
export function footWords(n: number, contactsRead: boolean): string {
  return contactsRead ? `${fmt.int(n)} ${n === 1 ? 'meets' : 'meet'} no MAG` : `${fmt.int(n)} not linked`
}
