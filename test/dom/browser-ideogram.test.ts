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
 * driven end to end by `scripts/ui-ideogram-view.mjs`).
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
  await frame(view)
  return { view, selection, asked }
}

/** One frame drawn. */
async function frame(view: BrowserView): Promise<void> {
  view.remeasure()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
}

/** Where each chromosome went, as the view says. */
function places(view: BrowserView): Array<{ contig: string; along0: number; along1: number; vertical: boolean; body: number }> {
  return JSON.parse(view.el.dataset.karyotype ?? '[]') as ReturnType<typeof places>
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
    const canvas = view.el.querySelector<HTMLCanvasElement>('.browser-canvas')
    if (canvas === null) throw new Error('no canvas')
    canvas.setPointerCapture = () => {}
    canvas.releasePointerCapture = () => {}
    canvas.hasPointerCapture = () => false
    const iii = places(view).find((place) => place.contig === 'III')
    if (iii === undefined) throw new Error('III not drawn')
    const point = { clientX: iii.body, clientY: (iii.along0 + iii.along1) / 2 }
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...point }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, ...point }))
    expect(asked).toEqual([[undefined, 'III:1-316,620']])
  })
})
