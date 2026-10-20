// @vitest-environment jsdom
/**
 * The ideogram's place in the browser (§5.10): where its switch is, which card
 * its rows are in, what it draws, and what putting it away hands back.
 *
 * The switch is in the Tracks card's `picture` row and nowhere in the bar; the
 * card shows the ideogram's rows while it is drawn and hides the controls about
 * the browser's one axis, and there is no card of its own. What is drawn is the
 * Sequences card's — the ticked sequences, the whole genome when none is — the
 * longest forty at most, and a window applied under it ticks nothing. A click
 * on a chromosome puts the ideogram away with that chromosome named, which the
 * session turns into the browser or the map it replaced (`Session.setIdeogram`,
 * driven end to end by `scripts/ui-ideogram-view.mjs`). The wheel magnifies it
 * about the pointer and back, a sideways scroll and a drag move it, and Shift
 * makes a drag a stretch again once a drag moves the picture.
 *
 * Read off `data-karyotype`, which says where each chromosome went: jsdom draws
 * nothing, and the stub context lets the layout run.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
import { AnnotationStore } from '@/annotations/store'
import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { assemblyOf } from '@/genome/assembly'
import { SequenceSelection } from '@/genome/selection'
import type { KaryotypeOrientation } from '@/render/karyotype'
import { resetDevFeatures } from '@/state/devFeatures'
import { BrowserView } from '@/ui/BrowserView'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: BrowserView[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  resetDevFeatures(true)
})

afterEach(() => {
  for (const view of built.splice(0, built.length)) view.destroy()
  teardown()
  window.sessionStorage.clear()
  resetDevFeatures(null)
})

/** A worker that takes every request and answers none. */
class SilentWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
}

interface Mounted {
  view: BrowserView
  selection: SequenceSelection
  asked: Array<[KaryotypeOrientation | undefined, string | undefined]>
}

/** A browser over these sequences, with a bigWig lane, the ideogram drawn or not, laid out. */
async function mount(
  contigs: Array<[string, number]>,
  options: { ideogram?: KaryotypeOrientation; ticked?: string[]; locus?: string } = {},
): Promise<Mounted> {
  const key = `ideogram-${Math.random()}.bw`
  const store = new AnnotationStore(key, { persist: false })
  const entry = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'ATAC',
    source: { kind: 'remote', url: 'ATAC.bw', name: 'ATAC.bw' },
  })
  store.update(entry.id, { status: 'ready' })
  const selection = new SequenceSelection()
  if (options.ticked !== undefined) selection.set(options.ticked)
  const asked: Mounted['asked'] = []
  const view = new BrowserView({
    assembly: assemblyOf({
      uri: key,
      name: key,
      contigs: contigs.map(([name, length]) => ({ name, length })),
      origin: 'sizes',
    }),
    store,
    client: new AnnotationClient(() => new SilentWorker() as unknown as Worker),
    selection,
    groups: new GroupSettings(key),
    manual: new ManualStore(key),
    onLocusChange: () => {},
    ...(options.ideogram === undefined ? {} : { ideogram: options.ideogram }),
    ...(options.locus === undefined ? {} : { locus: options.locus }),
    onIdeogramChange: (orientation, locus) => asked.push([orientation, locus]),
  })
  built.push(view)
  document.body.append(view.el, view.sideEl)
  // A window as wide as a screen's: jsdom lays nothing out, and the ideogram
  // is drawn through the window its stage is.
  const stage = view.el.querySelector<HTMLElement>('.browser-stage')
  if (stage !== null) Object.defineProperty(stage, 'clientWidth', { value: WIDTH, configurable: true })
  await frame(view)
  return { view, selection, asked }
}

const WIDTH = 1000

/** One frame drawn. */
async function frame(view: BrowserView): Promise<void> {
  view.remeasure()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
}

/** Where each chromosome went, as the view says. */
function places(
  view: BrowserView,
): Array<{ contig: string; along0: number; along1: number; vertical: boolean; body: number; visible: boolean }> {
  return JSON.parse(view.el.dataset.karyotype ?? '[]') as ReturnType<typeof places>
}

/** One chromosome's place, by name. */
function placeOf(view: BrowserView, contig: string): ReturnType<typeof places>[number] {
  const place = places(view).find((each) => each.contig === contig)
  if (place === undefined) throw new Error(`${contig} not drawn`)
  return place
}

/** How far the ideogram is magnified, as the view says. */
const zoomOf = (view: BrowserView): number => Number(view.el.dataset.karyotypeZoom ?? Number.NaN)

/** The canvas, with the pointer capture jsdom does not have. */
function canvasOf(view: BrowserView): HTMLCanvasElement {
  const canvas = view.el.querySelector<HTMLCanvasElement>('.browser-canvas')
  if (canvas === null) throw new Error('no canvas')
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
  canvas.hasPointerCapture = () => false
  return canvas
}

/** A press, a drag through to a point and a release, on the canvas. */
function drag(
  canvas: HTMLCanvasElement,
  from: { clientX: number; clientY: number },
  to: { clientX: number; clientY: number },
  keys: { shiftKey?: boolean } = {},
): void {
  const at = (point: { clientX: number; clientY: number }) => ({ bubbles: true, cancelable: true, button: 0, ...keys, ...point })
  canvas.dispatchEvent(new MouseEvent('pointerdown', at(from)))
  canvas.dispatchEvent(new MouseEvent('pointermove', at({ clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 })))
  canvas.dispatchEvent(new MouseEvent('pointermove', at(to)))
  canvas.dispatchEvent(new MouseEvent('pointerup', at(to)))
}

/** The wheel, once, over a point of the canvas. */
function wheel(canvas: HTMLCanvasElement, point: { clientX: number; clientY: number }, delta: { deltaX?: number; deltaY?: number }): void {
  canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...point, ...delta }))
}

const drawn = (view: BrowserView): string[] => places(view).map((place) => place.contig)

/** The Tracks card in the browser's column. */
function tracksCard(view: BrowserView): HTMLElement {
  const card = [...view.sideEl.querySelectorAll<HTMLElement>('.controls-card')].find(
    (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Tracks',
  )
  if (card === undefined) throw new Error('no Tracks card')
  return card
}

const switchOf = (view: BrowserView): HTMLButtonElement | null =>
  view.sideEl.querySelector<HTMLButtonElement>('button[title^="Ideogram"]')

const YEAST: Array<[string, number]> = [
  ['I', 230_218],
  ['II', 813_184],
  ['III', 316_620],
  ['IV', 1_531_933],
  ['V', 576_874],
]

describe('the ideogram’s switch and rows', () => {
  it('is in the Tracks card’s picture row, and not in the bar; there is no card of its own', async () => {
    const { view } = await mount(YEAST)
    const toggle = switchOf(view)
    expect(toggle).not.toBeNull()
    expect(tracksCard(view).contains(toggle)).toBe(true)
    expect(toggle?.closest('.field')?.querySelector('.field-label')?.textContent).toBe('picture')
    expect(view.el.querySelector('.browser-bar button[title^="Ideogram"]')).toBeNull()
    const titles = [...view.sideEl.querySelectorAll('.controls-title')].map((node) => node.textContent?.trim())
    expect(titles).not.toContain('Ideogram')
  })

  it('is absent with the dev feature off, and so are the ideogram’s rows', async () => {
    resetDevFeatures(false)
    const { view } = await mount(YEAST)
    expect(switchOf(view)).toBeNull()
    expect(tracksCard(view).querySelector('.ideogram-only')).toBeNull()
  })

  it('shows the ideogram’s rows while it is drawn, and steps the one axis’s controls aside', async () => {
    const off = await mount(YEAST)
    const card = tracksCard(off.view)
    expect(card.classList.contains('is-ideogram')).toBe(false)
    // The rows are there either way, shown by the card's class.
    expect(card.querySelector('select[title="What a chromosome is filled with"]')?.closest('.ideogram-only')).not.toBeNull()
    expect(card.querySelector('button[title^="Flip"]')?.classList.contains('ideogram-only')).toBe(true)
    expect(card.querySelector('button[title^="Fit the whole genome across"]')?.classList.contains('axis-only')).toBe(true)
    const on = await mount(YEAST, { ideogram: 'vertical' })
    expect(tracksCard(on.view).classList.contains('is-ideogram')).toBe(true)
    expect(switchOf(on.view)?.getAttribute('aria-pressed')).toBe('true')
  })

  it('asks for the ideogram, and to put it away, through the switch', async () => {
    const off = await mount(YEAST)
    switchOf(off.view)?.click()
    expect(off.asked).toEqual([['vertical', undefined]])
    const on = await mount(YEAST, { ideogram: 'vertical' })
    switchOf(on.view)?.click()
    expect(on.asked).toEqual([[undefined, undefined]])
  })
})

describe('what the ideogram draws', () => {
  it('draws the whole genome where nothing is ticked, standing in the axis’s order', async () => {
    const { view } = await mount(YEAST, { ideogram: 'vertical' })
    expect(drawn(view)).toEqual(['I', 'II', 'III', 'IV', 'V'])
    expect(places(view).every((place) => place.vertical)).toBe(true)
  })

  it('draws the ticked sequences, and follows the Sequences card as it changes', async () => {
    const { view, selection } = await mount(YEAST, { ideogram: 'vertical', ticked: ['II', 'IV'] })
    expect(drawn(view)).toEqual(['II', 'IV'])
    selection.set(['I', 'III', 'V'])
    await frame(view)
    expect(drawn(view)).toEqual(['I', 'III', 'V'])
    selection.clear()
    await frame(view)
    expect(drawn(view)).toEqual(['I', 'II', 'III', 'IV', 'V'])
  })

  it('lays one ticked chromosome lying, and greys the flip, which would do nothing', async () => {
    const { view } = await mount(YEAST, { ideogram: 'vertical', ticked: ['IV'] })
    expect(drawn(view)).toEqual(['IV'])
    expect(places(view)[0].vertical).toBe(false)
    const flip = tracksCard(view).querySelector<HTMLButtonElement>('button[title^="One chromosome is drawn lying"]')
    expect(flip?.disabled).toBe(true)
  })

  it('draws the longest forty at most, in the axis’s order', async () => {
    const many: Array<[string, number]> = Array.from({ length: 45 }, (_, i) => [`chr${i + 1}`, 1_000_000 + i * 1_000])
    const { view } = await mount(many, { ideogram: 'vertical' })
    const names = drawn(view)
    expect(names).toHaveLength(40)
    // The five shortest are the first five, and are the ones left out.
    expect(names[0]).toBe('chr6')
    expect(names.at(-1)).toBe('chr45')
  })

  it('leaves a dot out of the whole genome, and draws it where it was ticked', async () => {
    const genome: Array<[string, number]> = [
      ['chr1', 248_956_422],
      ['chr2', 242_193_529],
      ['chrM', 16_569],
    ]
    const whole = await mount(genome, { ideogram: 'vertical' })
    expect(drawn(whole.view)).toEqual(['chr1', 'chr2'])
    const asked = await mount(genome, { ideogram: 'vertical', ticked: ['chr1', 'chrM'] })
    expect(drawn(asked.view)).toEqual(['chr1', 'chrM'])
  })

  it('ticks nothing for a window it is drawn over', async () => {
    const { view, selection } = await mount(YEAST, { ideogram: 'vertical', ticked: ['II', 'III'], locus: 'IV:1,001-2,000' })
    expect(selection.has('IV')).toBe(false)
    expect(drawn(view)).toEqual(['II', 'III'])
  })
})

describe('putting the ideogram away', () => {
  it('names the chromosome a click landed on, whole', async () => {
    const { view, asked } = await mount(YEAST, { ideogram: 'vertical' })
    const canvas = canvasOf(view)
    const iii = placeOf(view, 'III')
    const point = { clientX: iii.body, clientY: (iii.along0 + iii.along1) / 2 }
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...point }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, ...point }))
    expect(asked).toEqual([[undefined, 'III:1-316,620']])
  })
})

describe('the camera over the ideogram', () => {
  /**
   * The ideogram of the yeast five, standing, the wheel turned towards the
   * reader over II's middle — far enough from the picture's edges that the
   * picture can move as far as holding it there takes.
   */
  async function magnified(): Promise<Mounted & { canvas: HTMLCanvasElement; point: { clientX: number; clientY: number } }> {
    const mounted = await mount(YEAST, { ideogram: 'vertical' })
    const canvas = canvasOf(mounted.view)
    const ii = placeOf(mounted.view, 'II')
    const point = { clientX: ii.body, clientY: (ii.along0 + ii.along1) / 2 }
    wheel(canvas, point, { deltaY: -400 })
    await frame(mounted.view)
    return { ...mounted, canvas, point }
  }

  it('opens at rest, and the wheel magnifies it about the pointer — the chromosome there staying there', async () => {
    const { view, point } = await magnified()
    expect(zoomOf(view)).toBeGreaterThan(2)
    const ii = placeOf(view, 'II')
    expect(ii.body).toBeCloseTo(point.clientX, 0)
    expect(ii.along0).toBeLessThan(point.clientY)
    expect(ii.along1).toBeGreaterThan(point.clientY)
    // Its neighbours, further out on either side.
    expect(placeOf(view, 'I').body).toBeLessThan(0)
  })

  it('goes back to every chromosome whole, and no further, and so does W', async () => {
    const { view, canvas, point } = await magnified()
    wheel(canvas, point, { deltaY: 5000 })
    await frame(view)
    expect(zoomOf(view)).toBe(1)
    const rest = places(view)
    wheel(canvas, point, { deltaY: -400 })
    await frame(view)
    view.fitIdeogram()
    await frame(view)
    expect(zoomOf(view)).toBe(1)
    expect(places(view)).toEqual(rest)
  })

  it('moves the chromosomes sideways with a sideways scroll', async () => {
    const { view, canvas, point } = await magnified()
    const before = placeOf(view, 'II').body
    wheel(canvas, point, { deltaX: 30 })
    await frame(view)
    expect(placeOf(view, 'II').body).toBeCloseTo(before - 30, 0)
  })

  it('moves the picture with a drag once magnified, and a press that does not travel still opens', async () => {
    const { view, canvas, point, asked } = await magnified()
    const before = placeOf(view, 'II')
    drag(canvas, point, { clientX: point.clientX + 25, clientY: point.clientY - 20 })
    await frame(view)
    const after = placeOf(view, 'II')
    expect(after.body - before.body).toBeCloseTo(25, 0)
    expect(after.along0 - before.along0).toBeCloseTo(-20, 0)
    expect(asked).toEqual([])
    const on = { clientX: after.body, clientY: point.clientY }
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...on }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, ...on }))
    expect(asked).toEqual([[undefined, 'II:1-813,184']])
  })

  it('takes a drag with Shift held, magnified, as a stretch to open', async () => {
    const { view, canvas, point, asked } = await magnified()
    const before = placeOf(view, 'II')
    drag(canvas, point, { clientX: point.clientX, clientY: point.clientY + 15 }, { shiftKey: true })
    expect(asked).toHaveLength(1)
    const [[orientation, locus]] = asked
    expect(orientation).toBeUndefined()
    expect(locus).toMatch(/^II:\d/)
    // Chosen, not moved.
    expect(placeOf(view, 'II')).toEqual(before)
  })
})
