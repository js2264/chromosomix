// @vitest-environment jsdom
/**
 * The 1D browser's *track height* box, which says what the lanes are (§8.8).
 *
 * The same box sits on the map's Tracks card and on the browser's, and beside
 * a map it reads the lanes on screen: the height they share, blank where they
 * disagree, and a step from blank starts at their middle height. The browser
 * built it without its lanes, so there it went on showing the last number it
 * had applied — `90` over a stack of 46-pixel lanes the box beside the map
 * called 46 — and a press of *down* made a 46-pixel track taller.
 *
 * Asked of the store rather than of a draw: jsdom draws nothing, and the box is
 * told of a change when the store makes it, before any repaint would.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
import { AnnotationStore } from '@/annotations/store'
import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { assemblyOf } from '@/genome/assembly'
import { SequenceSelection } from '@/genome/selection'
import { BrowserView } from '@/ui/BrowserView'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: BrowserView[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
})

afterEach(() => {
  for (const view of built.splice(0, built.length)) view.destroy()
  teardown()
  window.sessionStorage.clear()
})

/** A worker that takes every request and answers none: the lanes ask, and nothing here is about what they get. */
class SilentWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
}

/** A browser with two bigWig lanes, both `size` pixels tall, and the box from its Tracks card. */
function mount(size: number): { view: BrowserView; store: AnnotationStore; box: HTMLInputElement; ids: string[] } {
  const key = `track-height-${Math.random()}.bw`
  const store = new AnnotationStore(key, { persist: false })
  const ids = ['a', 'b'].map((name) => {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      label: name,
      source: { kind: 'remote', url: `${name}.bw`, name: `${name}.bw` },
    })
    store.update(entry.id, { status: 'ready' })
    store.restyle(entry.id, { size })
    return entry.id
  })
  const view = new BrowserView({
    assembly: assemblyOf({
      uri: key,
      name: key,
      contigs: [
        { name: 'I', length: 1_000 },
        { name: 'II', length: 1_000 },
      ],
      origin: 'sizes',
    }),
    store,
    client: new AnnotationClient(() => new SilentWorker() as unknown as Worker),
    selection: new SequenceSelection(),
    groups: new GroupSettings(key),
    manual: new ManualStore(key),
    onLocusChange: () => {},
  })
  built.push(view)
  // In the document, as the Aesthetics column has it: a box that has left the
  // page stops listening the first time it is spoken to.
  document.body.append(view.el, view.sideEl)
  const field = Array.from(view.sideEl.querySelectorAll<HTMLElement>('.field-stepper')).find(
    (node) => node.querySelector('.field-label')?.textContent === 'track height',
  )
  const box = field?.querySelector('input')
  if (box === undefined || box === null) throw new Error('no track height box on the Tracks card')
  return { view, store, box, ids }
}

describe('the browser’s track height box', () => {
  it('says the height the lanes share, not one it was never told', () => {
    expect(mount(46).box.value).toBe('46')
  })

  it('follows the lanes when something else moves them, and is blank while they disagree', () => {
    const { store, box, ids } = mount(46)
    // A drag on one lane's border, which the box did not make.
    store.restyle(ids[0], { size: 120 })
    expect(box.value).toBe('')
    store.restyle(ids[1], { size: 120 })
    expect(box.value).toBe('120')
  })

  it('steps from the lanes, so down makes them shorter', async () => {
    const { view, store, box } = mount(46)
    // A frame drawn, so the view has laid out the lanes it draws: a height
    // chosen here is given to those, as stretch and shrink give theirs.
    view.remeasure()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    const down = box.parentElement?.querySelector<HTMLButtonElement>('button')
    down?.click()
    expect(box.value).toBe('45')
    expect(store.entries.map((entry) => entry.style.size)).toEqual([45, 45])
  })
})
