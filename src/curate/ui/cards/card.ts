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
import { displayPercent } from '../../model'

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
 * decimals from 1 — `0.084`, `0.84`, `1.16`; a dash where there is none.
 */
export function affinityText(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value <= 0) return '0'
  if (value >= 1) return value.toFixed(2)
  const text = value.toPrecision(2)
  // 0.999 rounds up to the next decade: printed as 1 is, from 1.
  return text === '1.0' ? '1.00' : text
}

/** A confidence as a whole percent, never 100: `97%`. */
export function confidenceText(confidence: number): string {
  return `${displayPercent(confidence)}%`
}
