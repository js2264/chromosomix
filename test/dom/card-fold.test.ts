// @vitest-environment jsdom
/**
 * Every card in every panel folds to its own heading.
 *
 * The Genome minimap had this first, as a `<details>` whose summary was its
 * heading, and its own note recorded that there was no per-card collapse idiom
 * in this codebase to follow. Twenty other cards then went without one — a
 * column of five settings cards with nothing to put away is a column you scroll
 * past rather than read — and the fix is not twenty `<details>` wrappers but one
 * heading that is also a control, because `cardTitle` is the single place every
 * card's heading is built (`ui/icons.ts`).
 *
 * What that buys is what these tests pin: the gesture is *one* gesture. Press
 * the mark, press the word, press the empty stretch between them, press Enter on
 * the mark with the keyboard — one implementation answers all four, so none of
 * them can drift from the others or double-fire against them. The class lands on
 * the **card**, because what folds is "everything but the heading" and the
 * stylesheet says that once for every card there is.
 *
 * The two guards are the ones a later reader would remove without noticing.
 * A heading that is not a card's — the empty-metadata box builds one — must keep
 * its type and lose the promise, since folding it would hide the sentence that
 * is the whole of its content. And a card is folded, never emptied: its rows,
 * its scroll position and its half-typed fields are all still there afterwards,
 * which is what makes closing one cheap enough to do while reading.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { AnnotationCard } from '@/ui/AnnotationCard'
import { AnnotationLoader } from '@/annotations/loader'
import { cardTitle } from '@/ui/icons'
import { el } from '@/ui/dom'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  sessionStorage.clear()
})

afterEach(() => {
  teardown()
  sessionStorage.clear()
})

/** A card of the ordinary shape: a heading, then whatever it holds. */
function card(title = 'Tracks'): { el: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const head = cardTitle(title, 'chart-area')
  const body = el('div', { class: 'ann-list', text: 'the rows' })
  const node = el('section', { class: 'card' }, head, body)
  document.body.appendChild(node)
  return { el: node, head, body }
}

function chevronOf(head: HTMLElement): HTMLButtonElement {
  const node = head.querySelector('.card-fold')
  expect(node, 'the heading carries no fold control').toBeInstanceOf(HTMLButtonElement)
  return node as HTMLButtonElement
}

describe('the chevron on a card heading', () => {
  it('is the last thing on the line, after the mark and the word', () => {
    const { head } = card()
    // Far right is a matter of `margin-left: auto` in the stylesheet, which
    // jsdom does not lay out; what is checkable here — and what the rule needs —
    // is that the mark is last in the line's reading order rather than beside
    // the icon at its start, which is where a `<details>` marker would have sat.
    expect(head.lastElementChild).toBe(chevronOf(head))
    expect(head.firstElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(head.textContent).toContain('Tracks')
  })

  it('names the card it belongs to, so five of them are told apart', () => {
    const { head } = card('Synthetic tracks')
    const chevron = chevronOf(head)
    expect(chevron.getAttribute('aria-label')).toBe('Collapse Synthetic tracks')
    expect(chevron.type).toBe('button')
  })

  it('says which way it will go, and keeps saying it', () => {
    const { head } = card()
    const chevron = chevronOf(head)
    expect(chevron.getAttribute('aria-expanded')).toBe('true')

    head.click()
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(chevron.getAttribute('aria-label')).toBe('Expand Tracks')

    head.click()
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    expect(chevron.getAttribute('aria-label')).toBe('Collapse Tracks')
  })
})

describe('folding a card', () => {
  it('marks the card and not the heading, so one rule can hide the rest', () => {
    const { el: node, head } = card()
    head.click()
    expect(node.classList.contains('is-folded')).toBe(true)
    expect(head.classList.contains('is-folded')).toBe(false)
  })

  it('answers a press anywhere along the heading', () => {
    const { el: node, head } = card()
    // The word.
    const label = head.querySelector('span') as HTMLElement
    label.click()
    expect(node.classList.contains('is-folded')).toBe(true)
    label.click()
    expect(node.classList.contains('is-folded')).toBe(false)
  })

  it('folds exactly once when the chevron itself is pressed', () => {
    // The failure a second listener on the button would cause: the press toggles
    // on the button and toggles back on the heading it bubbles to, and the card
    // never moves. One listener, on the heading, is why that cannot happen —
    // and it is the same listener the keyboard reaches, since Enter and the
    // space bar on a `<button>` are a click.
    const { el: node, head } = card()
    chevronOf(head).click()
    expect(node.classList.contains('is-folded')).toBe(true)
    chevronOf(head).click()
    expect(node.classList.contains('is-folded')).toBe(false)
  })

  it('folds a controls card too — the Aesthetics column is cards like any other', () => {
    const head = cardTitle('Map', 'sliders-horizontal', 'controls-title')
    const node = el('div', { class: 'controls-card' }, head, el('div', { text: 'the fields' }))
    document.body.appendChild(node)
    expect(head.classList.contains('controls-title')).toBe(true)
    head.click()
    expect(node.classList.contains('is-folded')).toBe(true)
  })

  it('leaves a heading that is not a card’s alone', () => {
    // The guard, not a place: every block in every column is a card now (§26.6),
    // and this is what keeps a heading used outside one from offering a control
    // that would hide half of a box never built to lose it.
    const head = cardTitle('Metadata', 'info')
    const node = el('div', { class: 'not-a-card' }, head, el('p', { text: 'No metadata.' }))
    document.body.appendChild(node)
    head.click()
    expect(node.classList.contains('is-folded')).toBe(false)
    expect(chevronOf(head).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps what the card holds, so opening it again costs nothing', () => {
    const { el: node, head, body } = card()
    head.click()
    // Folded is a class the stylesheet reads, never a body that was taken away:
    // a card is closed while a filter is half-typed in it more often than not.
    expect(body.isConnected).toBe(true)
    expect(body.parentElement).toBe(node)
    expect(body.textContent).toBe('the rows')
  })
})

describe('a real card from a panel', () => {
  it('folds, and its rows are still there when it opens', () => {
    const store = new AnnotationStore(`fold-${Math.random()}.metacool`, { persist: false })
    const loader = new AnnotationLoader(
      store,
      { request: () => Promise.resolve(null), drop: () => {} } as never,
      [],
    )
    const built = new AnnotationCard({ store, loader, context: 'browser' })
    document.body.appendChild(built.el)

    const head = built.el.querySelector('.card-head') as HTMLElement
    expect(head.parentElement).toBe(built.el)
    expect(head.textContent).toContain('Tracks')

    head.click()
    expect(built.el.classList.contains('is-folded')).toBe(true)

    // The card goes on being a card while it is folded: a row added underneath a
    // closed heading is there when the reader opens it, rather than the store
    // and the picture having drifted apart while nobody was looking.
    const row = store.begin({
      card: 'linear',
      kind: 'track',
      label: 'coverage',
      source: { kind: 'remote', url: 'coverage.bw', name: 'coverage' },
    })
    store.update(row.id, { status: 'ready' })
    head.click()
    expect(built.el.classList.contains('is-folded')).toBe(false)
    const names = Array.from(built.el.querySelectorAll<HTMLInputElement>('.ann-name'))
    expect(names.map((input) => input.value)).toContain('coverage')

    built.destroy()
  })
})
