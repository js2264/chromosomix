/**
 * The host map's arithmetic (SPECS §33.3), apart from its canvas: which MAG
 * each element is placed beside, the rows the two columns take, the links
 * drawn between them and what each rests on, the genomes shown around the
 * selection, a link's curve and how near a point is to it, labels pushed apart
 * where they crowd, and the words the readout prints.
 *
 * **Two columns that share their rows.** The MAGs on the left in the stage's
 * order, the elements on the right, each **beside the MAG it meets most** —
 * so a link mostly runs level, and a MAG that hosts many elements fans out to
 * them. Every MAG is a **band** of rows, one for each element placed beside
 * it, one at least, its node at the band's middle; an element is a row of the
 * band of its MAG. Elements that meet no MAG, and are linked to none, fold
 * into the foot. Where an element is placed is **kept across steps**, as the
 * stage's order is: set when the stage opens and on *tidy*, an element keeps
 * its MAG while that MAG lasts, a new one goes beside the MAG it meets most,
 * and one gone leaves no hole.
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
 * else the MAG it meets most densely by the pairs, as `curate/order.ts`'s
 * `elementOrder` places it (a tie to the MAG earlier in the order); else a MAG
 * it is linked to, though they do not meet, so the link is drawn; else none.
 *
 * @param rank Each MAG's place in the stage's order: a MAG it does not name is never a place.
 * @param options.kept The places held before a step, by element id.
 * @param options.allowed The MAGs shown, around the selection: no other is a place.
 */
export function hostAnchors(
  genomes: readonly HostGenome[],
  pairs: PairList,
  links: ReadonlyArray<{ element: string; mag: string }>,
  rank: ReadonlyMap<string, number>,
  options: { kept?: ReadonlyMap<string, string | null>; allowed?: ReadonlySet<string> } = {},
): Map<string, string | null> {
  const { kept, allowed } = options
  const can = (id: string | undefined): id is string => id !== undefined && rank.has(id) && (allowed === undefined || allowed.has(id))
  const best = new Map<number, { mag: number; affinity: number; rank: number }>()
  for (let k = 0; k < pairs.a.length; k++) {
    let e = pairs.a[k]
    let m = pairs.b[k]
    if (genomes[e]?.kind !== 'element') [e, m] = [m, e]
    if (genomes[e]?.kind !== 'element' || genomes[m]?.kind !== 'mag') continue
    const affinity = pairs.affinity[k]
    if (!(affinity > 0)) continue
    const id = genomes[m].id
    if (!can(id)) continue
    const r = rank.get(id) as number
    const held = best.get(e)
    if (held === undefined || affinity > held.affinity || (affinity === held.affinity && r < held.rank)) best.set(e, { mag: m, affinity, rank: r })
  }
  const out = new Map<string, string | null>()
  genomes.forEach((genome, g) => {
    if (genome.kind !== 'element') return
    const held = kept?.get(genome.id) ?? null
    if (held !== null && can(held)) {
      out.set(genome.id, held)
      return
    }
    const found = best.get(g)
    if (found !== undefined) {
      out.set(genome.id, genomes[found.mag].id)
      return
    }
    let linked: string | null = null
    for (const link of links) {
      if (link.element !== genome.id || !can(link.mag)) continue
      if (linked === null || (rank.get(link.mag) as number) < (rank.get(linked) as number)) linked = link.mag
    }
    out.set(genome.id, linked)
  })
  return out
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
    out.set(key, { key, element: link.element, mag: link.mag, held: true, fromFile: link.fromFile, pair: pairs.get(key) ?? null, offer: null })
  }
  for (const { element, mag, suggestion } of offers) {
    const key = linkKey(element, mag)
    const held = out.get(key)
    // A link offered for a pair held, or an unlink for one not held: the binning moved on; not drawn.
    if (held === undefined) {
      if (suggestion.kind === 'link') out.set(key, { key, element, mag, held: false, fromFile: false, pair: pairs.get(key) ?? null, offer: suggestion })
    } else if (suggestion.kind === 'unlink') held.offer = suggestion
  }
  return [...out.values()]
}

/** A link's weight: `1 + 3 × share` CSS pixels, its share of the element's contacts with MAGs. */
export function linkWidth(link: Pick<HostLink, 'pair'>): number {
  const share = link.pair?.share ?? 0
  return 1 + 3 * Math.max(0, Math.min(1, share))
}

/**
 * The genomes shown around the selection: the genomes chosen, every genome
 * linked to them — held or offered —, and the other MAGs their elements are
 * linked to.
 */
export function aroundSet(focus: Iterable<string>, links: ReadonlyArray<Pick<HostLink, 'element' | 'mag'>>, kindOf: (id: string) => GenomeKind | undefined): Set<string> {
  const chosen = new Set<string>()
  for (const id of focus) if (kindOf(id) !== undefined) chosen.add(id)
  const out = new Set(chosen)
  // One step out, from the genomes chosen only: never on through what it adds.
  const theirs = new Set<string>()
  for (const link of links) {
    if (chosen.has(link.mag)) {
      out.add(link.element)
      theirs.add(link.element)
    }
    if (chosen.has(link.element)) out.add(link.mag)
  }
  // The other hosts of a chosen MAG's elements.
  for (const link of links) if (theirs.has(link.element)) out.add(link.mag)
  return out
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

/**
 * A question's number as the review's band and the suggestions card print it
 * — the likely ones from 1, the less sure from 1 again — found by its key or a
 * member's; `null` for one not in the queue.
 */
export function questionNumber(queue: readonly Question[], key: string, likely: number): number | null {
  let at = queue.findIndex((q) => q.key === key)
  if (at < 0) at = queue.findIndex((q) => q.members.some((m) => m.key === key))
  if (at < 0) return null
  const first = queue.filter((q) => q.confidence >= likely).length
  return at < first ? at + 1 : at - first + 1
}

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
 * and where from, what is on offer, the affinity and its lower bound, the
 * share of the element's contacts with MAGs it takes, the contacts, and how
 * sure the method is the MAG hosts it.
 */
export function linkWords(link: HostLink, element: string, mag: string): string {
  const parts = [`${element} ↔ ${mag}`]
  if (link.held) parts.push(link.fromFile ? 'linked, from the file' : 'linked')
  if (link.offer?.kind === 'link') parts.push('link offered')
  else if (link.offer?.kind === 'unlink') parts.push('unlink offered')
  const pair = link.pair
  if (pair === null || !(pair.contacts > 0)) {
    parts.push('no contacts')
    return parts.join(' · ')
  }
  parts.push(
    `affinity ${affinityText(pair.affinity)} (at least ${affinityText(lowerAffinity(pair.affinity, pair.contacts))})`,
    `${fmt.pct(pair.share, 0)} of its MAG contacts`,
    `${fmt.int(pair.contacts)} contact${Math.round(pair.contacts) === 1 ? '' : 's'}`,
    `host ${displayPercent(pair.confidence)}%`,
  )
  return parts.join(' · ')
}

/** A count of things: `1 element`, `3 elements`. */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${fmt.int(n)} ${n === 1 ? one : many}`
}
