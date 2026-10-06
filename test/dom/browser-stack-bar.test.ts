// @vitest-environment jsdom
/**
 * The bar under the 1D browser's stack (§5.8), which makes every track taller
 * or shorter together, **each in proportion**.
 *
 * Pinned here is what the store ends up holding, since that is the whole of
 * what the bar does: every lane's height times one factor, read from the
 * heights the gesture began with, and put back by Escape. And where it is: the
 * browser on its own has it, a deck's tracks cell — which has the cell's own
 * bar for its height — does not. A double click fills the column, which is a
 * measurement jsdom cannot make; `scripts/ui-stack-bar.mjs` drives it.
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

/** A worker that takes every request and answers none. */
class SilentWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
}

/** A browser with a bigWig lane of each height given, laid out; `map` makes it a deck's tracks cell. */
async function mount(sizes: number[], map?: string): Promise<{ view: BrowserView; store: AnnotationStore }> {
  const key = `stack-bar-${Math.random()}.bw`
  const store = new AnnotationStore(key, { persist: false })
  sizes.forEach((size, at) => {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      label: `t${at}`,
      source: { kind: 'remote', url: `t${at}.bw`, name: `t${at}.bw` },
    })
    store.update(entry.id, { status: 'ready' })
    store.restyle(entry.id, { size })
  })
  const view = new BrowserView({
    assembly: assemblyOf({ uri: key, name: key, contigs: [{ name: 'I', length: 1_000 }], origin: 'sizes' }),
    store,
    client: new AnnotationClient(() => new SilentWorker() as unknown as Worker),
    selection: new SequenceSelection(),
    groups: new GroupSettings(key),
    manual: new ManualStore(key),
    onLocusChange: () => {},
    ...(map === undefined ? {} : { map }),
  })
  built.push(view)
  document.body.append(view.el, view.sideEl)
  // A frame drawn, so the view has laid out the lanes the bar scales.
  view.remeasure()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  return { view, store }
}

const heights = (store: AnnotationStore): number[] => store.entries.map((entry) => entry.style.size)

/** The bar, with the pointer capture jsdom does not have stubbed in. */
function barOf(view: BrowserView): HTMLElement {
  const bar = view.el.querySelector<HTMLElement>('.browser-stack-resize')
  if (bar === null) throw new Error('no stack bar')
  bar.setPointerCapture = () => {}
  bar.releasePointerCapture = () => {}
  bar.hasPointerCapture = () => false
  return bar
}

const pointer = (type: string, clientY: number): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY })

describe('the stack bar', () => {
  it('is under the 1D browser’s stack, and not in a deck’s tracks cell', async () => {
    const alone = await mount([40, 80])
    const bar = alone.view.el.querySelector('.browser-stack-resize')
    expect(bar).not.toBeNull()
    expect(bar?.classList.contains('hidden')).toBe(false)
    const cell = await mount([40, 80], 'cell-1')
    expect(cell.view.el.querySelector('.browser-stack-resize')).toBeNull()
  })

  it('steps every track from the keyboard, each in proportion', async () => {
    const { view, store } = await mount([40, 80])
    const bar = barOf(view)
    // 24 pixels on a stack of 120: every lane times 1.2.
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(heights(store)).toEqual([48, 96])
  })

  it('follows a drag in proportion, and Escape puts every track back', async () => {
    const { view, store } = await mount([40, 80])
    const bar = barOf(view)
    bar.dispatchEvent(pointer('pointerdown', 100))
    // Sixty pixels down on a stack of 120: every lane half as tall again.
    bar.dispatchEvent(pointer('pointermove', 160))
    expect(heights(store)).toEqual([60, 120])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(heights(store)).toEqual([40, 80])
    // Up by half the stack, let go there: every lane half its height.
    bar.dispatchEvent(pointer('pointerdown', 100))
    bar.dispatchEvent(pointer('pointerup', 40))
    expect(heights(store)).toEqual([20, 40])
  })

  it('reads every step of one drag from where the drag began, not from the step before', async () => {
    const { view, store } = await mount([30, 60])
    const bar = barOf(view)
    bar.dispatchEvent(pointer('pointerdown', 200))
    for (const y of [230, 260, 290]) bar.dispatchEvent(pointer('pointermove', y))
    bar.dispatchEvent(pointer('pointerup', 290))
    // Ninety pixels on a stack of ninety: doubled once, not compounded.
    expect(heights(store)).toEqual([60, 120])
  })
})
