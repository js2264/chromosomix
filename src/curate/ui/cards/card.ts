/**
 * What every card of the curation stage's inspector is made of (SPECS §33.3):
 * the card itself — an `edit-card` with its lowercase heading, uppercased by
 * the stylesheet, a name in it keeping its own case — and the act, a bordered
 * button with a mark, a word and the key that reaches it, titled with that key
 * as the platform prints it (⌘ on a Mac, Ctrl elsewhere).
 *
 * One copy for every card, as the edit stage's private `act` was not: its key
 * was a `.kbd` that grew the button by its bottom border, and its title said
 * `(⌘Z)` on every platform.
 */

import { el } from '../../../ui/dom'
import { icon, type IconName } from '../../../ui/icons'
import { keyBadge, withKey } from '../../../ui/commands'
import { fmt } from '../../../units'
import type { CurationStep, GenomeKind } from '../../../genome/curation'
import type { CurationStateResult } from '../../../worker/curateProtocol'
import { displayPercent } from '../../model'
import { priceOf, priceVerdict } from '../../price'
import type { Quality } from '../../quality'
import { grade } from '../grade'

/** A card: its root, its heading and the body under it. */
export interface Card {
  element: HTMLElement
  head: HTMLElement
  body: HTMLElement
}

/**
 * A card headed `head` — lowercase words, which the stylesheet uppercases.
 *
 * The root carries `data-card`, the head's words joined by dashes, for the
 * gallery scripts to find it whatever the head says later.
 */
export function card(head: string): Card {
  const heading = el('h3', { class: 'edit-card-head', text: head })
  const body = el('div', { class: 'curate-card-body' })
  const element = el(
    'section',
    { class: 'edit-card curate-card', attrs: { 'data-card': head.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') } },
    heading,
    body,
  )
  return { element, head: heading, body }
}

/**
 * A heading's words with a name in it, the name in its own case: `genome ·
 * 00700_00001`, which the stylesheet would print `GENOME · 00700_00001`.
 *
 * @param title The name in full, where the heading prints it short.
 */
export function setHead(head: HTMLElement, words: string, name?: string, title?: string): void {
  if (name === undefined) {
    head.replaceChildren(words)
    return
  }
  head.replaceChildren(words, nameSpan(name, title))
}

/** A name, kept in its own case wherever it sits: a heading, a row. */
export function nameSpan(name: string, title?: string): HTMLElement {
  return el('span', { class: 'is-name', text: name, title: title ?? name })
}

/**
 * An act: `button.btn.edit-act` holding its mark at 14 px, its word, and its
 * key as an inline badge; titled `title (key)`. Without `keys`, the mark and
 * the word alone.
 */
export function act(label: string, iconName: IconName, title: string, run: () => void, keys?: string): HTMLButtonElement {
  const button = el('button', {
    class: 'btn edit-act',
    type: 'button',
    title: withKey(title, keys),
    on: { click: () => run() },
  })
  button.append(icon(iconName, { size: 14 }), el('span', { class: 'edit-act-label', text: label }))
  if (keys !== undefined) button.append(keyBadge(keys, { class: 'kbd-inline' }))
  button.dataset.title = withKey(title, keys)
  return button
}

/**
 * Hold an act back, its title saying why (§26.3), or let it act again with the
 * title it was made with (`why` null).
 */
export function refuse(button: HTMLButtonElement, why: string | null): HTMLButtonElement {
  button.disabled = why !== null
  button.title = why ?? button.dataset.title ?? button.title
  return button
}

/** A row of acts, wrapping. */
export function acts(...buttons: Array<HTMLButtonElement | null>): HTMLElement {
  const row = el('div', { class: 'edit-acts curate-card-acts' })
  for (const button of buttons) if (button !== null) row.appendChild(button)
  return row
}

/**
 * An affinity as the stage prints it: two significant figures below 1, two
 * decimals from 1 — `0.084`, `0.84`, `1.16`; past four decimal places an
 * exponent, as the contact map's readout and an axis take one (`2.1e-5`, not a
 * run of zeros); a dash where there is none.
 */
export function affinityText(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value <= 0) return '0'
  if (value >= 1) return value.toFixed(2)
  if (value < 1e-4) return value.toExponential(1)
  const text = value.toPrecision(2)
  // 0.999 rounds up to the next decade: printed as 1 is, from 1.
  return text === '1.0' ? '1.00' : text
}

/**
 * A preview's key, as the model keys one (`CurateModel.preview`): a step's
 * own, a question's steps together; `null` for none. What a card or the
 * chooser compares to know the preview held is still its own.
 */
export function previewKey(steps: CurationStep | readonly CurationStep[] | null): string | null {
  if (steps === null) return null
  if (!Array.isArray(steps)) return JSON.stringify(steps)
  const list = steps as readonly CurationStep[]
  if (list.length === 0) return null
  return JSON.stringify(list.length === 1 ? list[0] : list)
}

/** Contacts counted: `1 contact`, `2,286 contacts`. */
export function contactsText(contacts: number): string {
  const n = Math.round(contacts)
  return `${fmt.int(n)} ${n === 1 ? 'contact' : 'contacts'}`
}

/** A confidence as a whole percent, never 100: `97%`. */
export function confidenceText(confidence: number): string {
  return `${displayPercent(confidence)}%`
}

/** A genome's swatch, as the list draws it: a MAG's filled, an element's a ring, in the genome's colour. */
export function swatch(css: string, kind: GenomeKind): HTMLElement {
  const node = el('span', { class: `curate-swatch curate-swatch-${kind}`, attrs: { 'aria-hidden': 'true' } })
  node.style.setProperty('--swatch', css)
  return node
}

/** How a step moves one of a genome's numbers in metaTOR's grades: down, up to high quality, or neither. */
export type Shift = 'demoted' | 'promoted' | null

const GRADE_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, none: 1, contaminated: 0 }

function gradeRank(completeness: number, redundancy: number): number {
  return GRADE_RANK[grade(completeness, redundancy) ?? 'none']
}

/**
 * Which of a genome's two weighted numbers moves its grade, from `before` to
 * `after`: a grade that falls marks the number that pulls it down — the
 * redundancy past 1.05 or 1.10, the completeness under a threshold — and one
 * that reaches high quality the number that lifts it; the other is `null`.
 */
export function qualityShift(before: Quality, after: Quality): { completeness: Shift; redundancy: Shift } {
  const was = gradeRank(before.weightedCompleteness, before.weightedRedundancy)
  const now = gradeRank(after.weightedCompleteness, after.weightedRedundancy)
  // Each number moved alone, the other kept as it was.
  const byCompleteness = gradeRank(after.weightedCompleteness, before.weightedRedundancy)
  const byRedundancy = gradeRank(before.weightedCompleteness, after.weightedRedundancy)
  if (now < was) {
    const redundancy = byRedundancy < was
    return { completeness: byCompleteness < was || !redundancy ? 'demoted' : null, redundancy: redundancy ? 'demoted' : null }
  }
  if (now > was && now === GRADE_RANK.high) {
    const completeness = byCompleteness > was
    const redundancy = byRedundancy > was
    return { completeness: completeness || !redundancy ? 'promoted' : null, redundancy: redundancy ? 'promoted' : null }
  }
  return { completeness: null, redundancy: null }
}

/**
 * What a step would leave, genome by genome (`curate/price.ts`): each genome
 * it changes, its weighted completeness and redundancy before → after, a line
 * each — `50% + 50% → 100%` where it takes in whole genomes, `100% → 100%`
 * where it gains or loses some contigs, the genomes those come from on rows of
 * their own — the number that makes its grade fall in the warning colour, the
 * one that makes it high quality in the finished one; its length where the map
 * holds no markers. `null` when the step changes no genome's contigs (a link,
 * a rename).
 *
 * @param nameOf A genome's name as printed, by id, given the name it has after.
 */
export function priceList(
  before: CurationStateResult,
  after: CurationStateResult,
  nameOf: (id: string, name: string) => string,
  limit = 3,
): HTMLElement | null {
  const rows = priceOf(before, after)
  if (rows.length === 0) return null
  const present = new Set(after.genomes.map((genome) => genome.id))
  const list = el('ul', { class: 'curate-card-price' })
  for (const row of rows.slice(0, limit)) {
    const genome = after.genomes.find((g) => g.id === row.id)
    // What it was made of: itself, and the genomes it takes in whole. A genome
    // that only gives it some contigs is not summed in: it has its own row.
    const parts = row.from.filter((from) => from.id === row.id || !present.has(from.id))
    const q = row.after
    const lines: Array<{ text: string; shift: Shift }> = []
    if (q !== null && parts.every((from) => from.quality !== null)) {
      const sum = (pick: (quality: Quality) => number, form: (x: number) => string): string =>
        parts.length === 0 ? form(pick(q)) : `${parts.map((from) => form(pick(from.quality as Quality))).join(' + ')} → ${form(pick(q))}`
      const first = parts[0]?.quality ?? null
      const shift = first === null ? { completeness: null, redundancy: null } : qualityShift(first, q)
      lines.push(
        { text: `completeness ${sum((x) => x.weightedCompleteness, (x) => fmt.pct(x, 0))}`, shift: shift.completeness },
        { text: `redundancy ${sum((x) => x.weightedRedundancy, (x) => fmt.fixed(x, 2))}`, shift: shift.redundancy },
      )
    } else {
      const length = genome?.length ?? 0
      const was = parts.reduce((total, from) => total + (before.genomes.find((g) => g.id === from.id)?.length ?? 0), 0)
      const contigs = genome?.contigs ?? 0
      lines.push({ text: `${parts.length === 0 ? fmt.bp(length) : `${fmt.bp(was)} → ${fmt.bp(length)}`} · ${fmt.int(contigs)} ${contigs === 1 ? 'contig' : 'contigs'}`, shift: null })
    }
    const verdict = priceVerdict(row)
    const title = `${row.name}: ${lines.map((line) => line.text).join(', ')}${verdict === 'demoted' ? ' — its grade falls' : verdict === 'promoted' ? ' — high quality' : ''}`
    // A genome the step makes: nothing to add up, its numbers as they would be.
    const name = el('span', { class: 'curate-card-price-name' }, nameOf(row.id, row.name), parts.length === 0 ? el('span', { class: 'curate-card-price-new', text: 'new' }) : null)
    const item = el('li', { class: `curate-card-price-row${lines.length > 1 ? ' is-two' : ''}`, title }, name)
    for (const line of lines) item.appendChild(el('span', { class: `curate-card-price-line${line.shift === null ? '' : ` is-${line.shift}`}`, text: line.text }))
    list.appendChild(item)
  }
  if (rows.length > limit) list.appendChild(el('li', { class: 'curate-card-price-more', text: `and ${fmt.int(rows.length - limit)} more` }))
  return list
}
