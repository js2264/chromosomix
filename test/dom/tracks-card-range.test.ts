// @vitest-environment jsdom
/**
 * Ticking a **range** of tracks, on the Tracks card.
 *
 * The card's tick boxes feed the batch bar — one group, one height, one colour,
 * remove them together — and filling that selection was one aim at an
 * eleven-pixel box per row. Ten tracks was ten clicks, which is the arithmetic
 * that makes a batch action cost more than doing the ten by hand.
 *
 * So the gesture every file list has is here: click one box, shift-click
 * another, and every row between the two takes the state the clicked box is
 * moving to. What is worth testing is not that a span is filled — that is one
 * `slice` — but the three ways a span can be computed *wrongly*:
 *
 * - from an **index** remembered at the first click, which a reorder, a removal
 *   or a filter between the two clicks makes a lie (`AnnotationCard.anchor`);
 * - from the **store's** list rather than the card's, which are not the same
 *   list — a computed lane and a metadata column live in the store and are not
 *   rows here (`AnnotationCard.fileRows`);
 * - from an anchor the shift-click **moved**, which turns "extend the span" into
 *   "walk its start down the list".
 *
 * The checkbox stays a checkbox throughout, because the modifier is read from
 * the `click` that a pointer *and* the space bar both fire, rather than from a
 * pointer gesture reimplemented on a div.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { AnnotationStore } from '@/annotations/store'
import { AnnotationCard } from '@/ui/AnnotationCard'
import type { ComputedSource } from '@/annotations/types'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: AnnotationCard[] = []

beforeEach(() => {
  teardown = setUpDom()
  sessionStorage.clear()
})

afterEach(() => {
  for (const card of built.splice(0, built.length)) card.destroy()
  teardown()
  sessionStorage.clear()
})

interface Made {
  store: AnnotationStore
  card: AnnotationCard
}

/**
 * A card with `count` loaded tracks in it, mounted.
 *
 * Mounted because the gesture ends in a `focus` call, and focus in a detached
 * tree goes nowhere. The worker behind the loader is a stub that answers
 * nothing: no file is ever read here, the rows are begun directly on the store.
 */
function make(count: number): Made {
  const store = new AnnotationStore(`ticks-${Math.random()}.metacool`, { persist: false })
  const loader = new AnnotationLoader(
    store,
    { request: () => Promise.resolve(null), drop: () => {} } as never,
    [],
  )
  const card = new AnnotationCard({ store, loader, context: 'browser' })
  built.push(card)
  document.body.appendChild(card.el)
  for (let index = 0; index < count; index += 1) add(store, `t${index}`)
  return { store, card }
}

/** One ordinary file row, named so a test can read the selection back. */
function add(store: AnnotationStore, label: string): string {
  const entry = store.begin({
    card: 'linear',
    kind: 'track',
    source: { kind: 'remote', url: `https://example.org/${label}.bw`, name: `${label}.bw` },
    label,
  })
  store.update(entry.id, { status: 'ready' })
  return entry.id
}

/** A row this card does not list (§8.9), to prove the span is over the ones it does. */
function addComputed(store: AnnotationStore, label: string): string {
  const source: ComputedSource = {
    kind: 'computed',
    name: label,
    task: 'insulation',
    recipe: { taskVersion: 1, params: {} },
    framing: 'chrIV:1–1,531,933 at 1 kb',
  }
  const entry = store.begin({ card: 'linear', kind: 'track', source, label })
  store.update(entry.id, { status: 'ready' })
  return entry.id
}

const ticks = (card: AnnotationCard): HTMLInputElement[] =>
  all<HTMLInputElement>(card.el, '.ann-tick')

/** The labels of the ticked rows, in the order the card lists them. */
function picked(made: Made): string[] {
  return ticks(made.card)
    .filter((box) => box.checked)
    .map((box) => made.store.byId(box.getAttribute('data-tick') ?? '')?.label ?? '?')
}

/**
 * Click the nth box, optionally with shift held.
 *
 * Two events, because that is what a pointer sends and because the card reads
 * one thing from each: the modifier off the `click` (a `change` carries none),
 * and the text-selection default off the `mousedown` in front of it. jsdom runs
 * a dispatched click through the checkbox's own activation behaviour, so the box
 * toggles and fires `change` exactly as a real press does.
 */
function clickTick(card: AnnotationCard, index: number, shift = false): MouseEvent {
  const box = ticks(card)[index]
  expect(box, `no tick box at ${index}`).toBeDefined()
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: shift })
  box.dispatchEvent(down)
  box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: shift }))
  return down
}

/** What the space bar does: a click with no pointer and no modifiers. */
function pressTick(card: AnnotationCard, index: number): void {
  ticks(card)[index].click()
}

describe('the Tracks card’s tick boxes', () => {
  it('is a real checkbox that names the range gesture', () => {
    const made = make(3)
    for (const box of ticks(made.card)) {
      expect(box.type).toBe('checkbox')
      expect(box.title.toLowerCase()).toContain('shift')
    }
  })

  it('ticks one row on a plain click', () => {
    const made = make(4)
    clickTick(made.card, 1)
    expect(picked(made)).toEqual(['t1'])
  })
})

describe('shift-clicking a tick box', () => {
  it('fills the span downwards from the row clicked first', () => {
    const made = make(5)
    clickTick(made.card, 1)
    clickTick(made.card, 3, true)
    expect(picked(made)).toEqual(['t1', 't2', 't3'])
  })

  it('fills the span upwards just as well', () => {
    const made = make(5)
    clickTick(made.card, 3)
    clickTick(made.card, 1, true)
    expect(picked(made)).toEqual(['t1', 't2', 't3'])
  })

  it('clears the span when the box clicked is already ticked', () => {
    const made = make(5)
    clickTick(made.card, 0)
    clickTick(made.card, 4, true)
    expect(picked(made)).toEqual(['t0', 't1', 't2', 't3', 't4'])

    // Moving to unticked, so the whole span goes with it.
    clickTick(made.card, 2, true)
    expect(picked(made)).toEqual(['t3', 't4'])
  })

  it('re-extends from the same anchor rather than from the last click', () => {
    const made = make(5)
    clickTick(made.card, 1)
    clickTick(made.card, 4, true)
    expect(picked(made)).toEqual(['t1', 't2', 't3', 't4'])

    // The anchor is still t1, so this clears t1–t3 and leaves t4. An anchor that
    // had walked forward to t4 would have cleared t3–t4 and left t1 and t2.
    clickTick(made.card, 3, true)
    expect(picked(made)).toEqual(['t4'])
  })

  it('is a plain click when nothing has been clicked yet, and sets the anchor', () => {
    const made = make(5)
    clickTick(made.card, 3, true)
    expect(picked(made)).toEqual(['t3'])

    clickTick(made.card, 0, true)
    expect(picked(made)).toEqual(['t0', 't1', 't2', 't3'])
  })

  it('suppresses the text selection a shift-click would otherwise drag out', () => {
    const made = make(3)
    expect(clickTick(made.card, 0).defaultPrevented).toBe(false)
    expect(clickTick(made.card, 2, true).defaultPrevented).toBe(true)
  })

  it('rebuilds the list once for the whole span', () => {
    const made = make(6)
    clickTick(made.card, 0)
    const list = made.card.el.querySelector('.ann-list')
    expect(list).not.toBeNull()
    const watch = new MutationObserver(() => {})
    watch.observe(list as Node, { childList: true })

    clickTick(made.card, 5, true)
    expect(picked(made)).toHaveLength(6)
    // One `replaceChildren`, not one per row taken in.
    expect(watch.takeRecords()).toHaveLength(1)
    watch.disconnect()
  })

  it('leaves the focus on the box that was clicked', () => {
    const made = make(4)
    clickTick(made.card, 0)
    clickTick(made.card, 3, true)
    expect(document.activeElement?.getAttribute('data-tick')).toBe(
      made.store.entries[3]?.id ?? null,
    )
  })

  it('feeds the batch bar, which is what the gesture is for', () => {
    const made = make(5)
    clickTick(made.card, 0)
    clickTick(made.card, 3, true)
    expect(made.card.el.querySelector('.ann-batch-count')?.textContent).toBe('4 selected')
  })
})

describe('the anchor is a row, not a position', () => {
  it('follows the anchored row when the list is reordered between the clicks', () => {
    const made = make(5)
    clickTick(made.card, 0)

    // t0 to the bottom, exactly as a drag or an arrow key would move it: the
    // list is now t1 t2 t3 t4 t0, and the anchor is at the *end* of it.
    made.store.moveTo(made.store.entries[0].id, 4)
    expect(ticks(made.card).map((box) => made.store.byId(box.getAttribute('data-tick') ?? '')?.label))
      .toEqual(['t1', 't2', 't3', 't4', 't0'])

    clickTick(made.card, 2, true)
    // t3 t4 t0, and not the t1 t2 t3 a remembered index would have taken.
    expect(picked(made)).toEqual(['t3', 't4', 't0'])
  })

  it('falls back to a plain click when the anchored row has been removed', () => {
    const made = make(5)
    clickTick(made.card, 0)
    made.store.remove(made.store.entries[0].id)
    expect(picked(made)).toEqual([])

    clickTick(made.card, 1, true)
    expect(picked(made)).toEqual(['t2'])

    // And that click is the new anchor, so the next shift-click has a span.
    clickTick(made.card, 3, true)
    expect(picked(made)).toEqual(['t2', 't3', 't4'])
  })

  it('counts over the rows this card lists, not over everything in the store', () => {
    const made = make(0)
    add(made.store, 't0')
    add(made.store, 't1')
    // A computed lane sits between them in the store and is not a row here
    // (§8.9), so a span counted in the store's own index space would stop one
    // row short of where the reader clicked.
    addComputed(made.store, 'insulation')
    add(made.store, 't2')
    add(made.store, 't3')
    expect(ticks(made.card)).toHaveLength(4)

    // t1 and t2 are neighbours here and two apart in the store, with the
    // computed row between them: a span counted in the store's index space and
    // applied to this list would reach a row past the one that was clicked.
    clickTick(made.card, 1)
    clickTick(made.card, 2, true)
    expect(picked(made)).toEqual(['t1', 't2'])
  })
})

describe('a keyboard toggle', () => {
  it('takes one row and moves the anchor, having no shift to read', () => {
    const made = make(5)
    clickTick(made.card, 0)
    pressTick(made.card, 3)
    expect(picked(made)).toEqual(['t0', 't3'])

    // The span runs from t3, the row the space bar took, and not from t0.
    clickTick(made.card, 1, true)
    expect(picked(made)).toEqual(['t0', 't1', 't2', 't3'])
  })
})
