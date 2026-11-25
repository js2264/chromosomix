// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's host map (SPECS §33.3), in a DOM: the two columns in
 * the stage's order, each element beside the MAG it meets most; a link held
 * and a link offered, each said as it is; the node under a press, ⌘ and ⇧; a
 * press on a link; an element dragged onto a MAG and linked; the drop target;
 * the elements that meet no MAG folded at the foot and opened; the genomes
 * around the selection; the rows' height; and the thumbnail, which draws and
 * takes no hand.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CuratedBinning, fileBinning, type BaseBinning } from '@/genome/curation'
import { stateAnswer } from '@/curate/answer'
import { background, tally, visibility, type ContigNetwork } from '@/curate/method'
import { CurateModel } from '@/curate/model'
import { methodBinning, neighbourLists, type CurationEvidence, type Suggestion } from '@/curate/suggest'
import { HostPane } from '@/curate/ui/HostPane'
import type { CurateContext } from '@/curate/ui/context'
import { CurationStore } from '@/state/curation'
import type { CurationStateResult } from '@/worker/curateProtocol'
import { community } from '../support/curateCommunity'
import { testContext, type TestStage } from '../support/curateStage'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let panes: HostPane[] = []
let stores = 0

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const pane of panes) pane.dispose()
  panes = []
  teardown()
})

/**
 * The community and one more element, Q (q0, q1), whose contigs meet each
 * other and nothing else: an element that meets no MAG.
 */
function lonely(): { base: BaseBinning; evidence: CurationEvidence } {
  const { base, evidence } = community()
  const n = base.names.length
  const network: ContigNetwork = {
    contigs: n + 2,
    first: Int32Array.from([...evidence.network.first, n]),
    second: Int32Array.from([...evidence.network.second, n + 1]),
    contacts: Float64Array.from([...evidence.network.contacts, 40]),
    within: new Float64Array(n + 2),
  }
  const grown: BaseBinning = {
    names: [...base.names, 'q0', 'q1'],
    lengths: [...base.lengths, 20_000, 20_000],
    genomeOf: Int32Array.from([...base.genomeOf, base.genomes.length, base.genomes.length]),
    genomes: [...base.genomes, { name: 'Q', kind: 'element' }],
    links: base.links,
  }
  const t = visibility(network)
  const binning = methodBinning(CuratedBinning.of(grown, null))
  return {
    base: grown,
    evidence: { network, visibility: t, ...neighbourLists(network), markers: [], background: background(tally(network, t, binning), binning.kinds), names: grown.names, lengths: grown.lengths },
  }
}

interface Mounted extends TestStage {
  pane: HostPane
}

/** A frame: the pane draws in one. */
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * The pane over the community — or over the community and Q — in a plot of
 * 800 × 600 pixels, its first count in and drawn. `declines` counts each
 * binning with the suggestions turned down, as the worker does.
 */
async function mount(options: { lonely?: boolean; unread?: boolean; declines?: boolean; height?: number } = {}): Promise<Mounted> {
  const stage = testContext()
  if (options.lonely === true || options.unread === true || options.declines === true) {
    const { base, evidence } = options.lonely === true ? lonely() : community()
    const store = new CurationStore(`curate-host-dom-${++stores}`, base, fileBinning(base), () => 0)
    const answer = (curation: Parameters<typeof CuratedBinning.of>[1], weights: Parameters<typeof stateAnswer>[2], declined: readonly string[] = []): CurationStateResult => {
      const counted = stateAnswer(evidence, CuratedBinning.of(base, curation), weights, declined)
      // Before the contacts are read: the genomes and the links, no pairs, no hosts, no suggestions.
      if (options.unread !== true) return counted
      return { ...counted, counted: false, pairs: { a: new Int32Array(0), b: new Int32Array(0), contacts: new Float64Array(0), affinity: new Float32Array(0) }, hosts: [], suggestions: [] }
    }
    const model = new CurateModel(
      store,
      { state: (curation, weights, declined) => ({ promise: Promise.resolve(answer(curation, weights, declined)), cancel: () => {} }) },
      { schedule: (run) => (run(), () => {}) },
    )
    ;(stage.ctx as { model: CurateModel }).model = model
    ;(stage.ctx as { shortName: CurateContext['shortName'] }).shortName = (id) => model.answer?.genomes.find((genome) => genome.id === id)?.name ?? id
    stage.model = model
    stage.store = store
  }
  const pane = new HostPane(stage.ctx)
  panes.push(pane)
  // The stage tells its panes what changed; here the test does.
  stage.model.subscribe((change) => pane.update(change))
  document.body.appendChild(pane.element)
  const plot = pane.element.querySelector('.curate-host-plot') as HTMLElement
  const height = options.height ?? 600
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: height, width: 800, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  await stage.model.settled()
  pane.resize()
  await frame()
  return { ...stage, pane }
}

const canvas = (): HTMLElement => document.querySelector('.curate-host-canvas') as HTMLElement

/** Every node drawn, its bar's middle, as a script driving the stage reads them. */
const nodes = (): Record<string, [number, number]> => JSON.parse(canvas().dataset.nodes ?? '{}') as Record<string, [number, number]>

/** A node's middle, in client pixels (the plot is at the origin). */
function node(id: string): { clientX: number; clientY: number } {
  const at = nodes()[id]
  if (at === undefined) throw new Error(`${id} is not drawn`)
  return { clientX: at[0], clientY: at[1] }
}

/** The key's words for the marks drawn: the item of a mark not drawn is hidden. */
const keyWords = (): Array<string | null> => [...document.querySelectorAll('.curate-host-key-item:not(.hidden) .curate-host-key-word')].map((word) => word.textContent)

/** The middle of the link from a MAG to an element: halfway across, halfway between their rows. */
function linkMiddle(mag: string, element: string): { clientX: number; clientY: number } {
  const [magX, elementX] = (canvas().dataset.columns ?? '').split(' ').map(Number)
  return { clientX: (magX + elementX) / 2, clientY: (nodes()[mag][1] + nodes()[element][1]) / 2 }
}

function pointer(type: string, at: { clientX: number; clientY: number }, init: PointerEventInit = {}): void {
  canvas().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...at, ...init }))
}

function press(at: { clientX: number; clientY: number }, init: PointerEventInit = {}): void {
  pointer('pointerdown', at, init)
  pointer('pointerup', at, init)
}

function key(pane: HostPane, name: string, init: KeyboardEventInit = {}): boolean {
  return pane.key(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

describe('the host map', () => {
  it('lays the MAGs out in the stage’s order, each element beside the MAG it meets most', async () => {
    const { pane, model } = await mount()
    expect(pane.element.dataset.pane).toBe('hosts')
    expect(pane.element.dataset.view).toBe('all')
    expect(pane.element.dataset.ready).toBe('true')
    expect(model.order).toEqual(['Y', 'X1', 'X2', 'Z', 'P'])
    const at = nodes()
    // The MAGs top to bottom, on the left; P on the right, level with Y, the MAG it meets most.
    const mags = ['Y', 'X1', 'X2', 'Z']
    expect(mags.map((id) => at[id][1])).toEqual([...mags.map((id) => at[id][1])].sort((a, b) => a - b))
    expect(new Set(mags.map((id) => at[id][1])).size).toBe(4)
    expect(at.P[0]).toBeGreaterThan(at.Y[0])
    expect(at.P[1]).toBe(at.Y[1])
    expect(canvas().dataset.rows).toBe('4')
    expect(pane.element.querySelector('.curate-host-counts')?.textContent).toBe('1 link · 1 link offered · 1 to unlink')
    const z = pane.nodeAt('Z')
    expect(z?.clientX).toBeCloseTo(node('Z').clientX, 1)
    expect(z?.clientY).toBeCloseTo(node('Z').clientY, 1)
    expect(pane.nodeAt('nowhere')).toBeNull()
  })

  it('counts the links in the head in parts that give way whole, and keys its marks under the map', async () => {
    const { pane, model } = await mount()
    const counts = pane.element.querySelector('.curate-host-counts') as HTMLElement
    // The links held never give way; what is offered does, whole, where the head is narrow. Links, never questions.
    expect([...counts.children].map((part) => [part.textContent, part.classList.contains('curate-host-count-more')])).toEqual([
      ['1 link', false],
      [' · 1 link offered', true],
      [' · 1 to unlink', true],
    ])
    expect(counts.title).toBe('1 link held, 1 link the contacts offer and 1 held link they no longer support — each link an element and a MAG, where the suggestions ask an element’s links as one question')
    expect((pane.element.querySelector('.curate-host-view[data-view="around"] .curate-host-view-more') as HTMLElement).textContent).toBe(' the selection')
    const foot = pane.element.querySelector('.curate-host-foot') as HTMLElement
    const key = foot.querySelector('.curate-host-key') as HTMLElement
    expect(foot.classList.contains('hidden')).toBe(false)
    expect(key.classList.contains('hidden')).toBe(false)
    // Each mark that is drawn: no MAG met without a link here.
    expect(keyWords()).toEqual(['linked', 'offered', 'to unlink'])
    expect(foot.classList.contains('has-status')).toBe(false)
    // Around the selection the foot says what is shown, which a narrow foot says before its key.
    model.selectGenomes(['Y'])
    ;(pane.element.querySelector('.curate-host-view[data-view="around"]') as HTMLButtonElement).click()
    await frame()
    expect(foot.classList.contains('has-status')).toBe(true)
  })

  it('gives way in the head and the foot as they are measured, whole pieces, the links held last', async () => {
    const { pane, model } = await mount()
    model.selectGenomes(['Y'])
    ;(pane.element.querySelector('.curate-host-view[data-view="around"]') as HTMLButtonElement).click()
    await frame()
    const head = pane.element.querySelector('.curate-host-head') as HTMLElement
    const counts = pane.element.querySelector('.curate-host-counts') as HTMLElement
    const foot = pane.element.querySelector('.curate-host-foot') as HTMLElement
    const status = pane.element.querySelector('.curate-host-status') as HTMLElement
    const shown = (node: Element): boolean => !node.classList.contains('hidden')
    const visible = (node: Node): string =>
      node instanceof Element ? (node.classList.contains('hidden') ? '' : [...node.childNodes].map(visible).join('')) : (node.textContent ?? '')
    // Each piece's width at the stage's text, laid out with the head's and the foot's gaps.
    const more = (): HTMLElement[] => [...counts.querySelectorAll<HTMLElement>('.curate-host-count-more')]
    const viewMore = pane.element.querySelector('.curate-host-view-more') as HTMLElement
    const headWidth = (): number => 7 * visible(counts).length + (shown(viewMore) ? 120 : 0) + 200
    const lead = pane.element.querySelector('.curate-host-status-lead') as HTMLElement
    const keyBox = pane.element.querySelector('.curate-host-key') as HTMLElement
    const footWidth = (): number => (keyBox.classList.contains('is-crowded') ? 0 : 300) + 7 * visible(status).length + 20
    let room = 1000
    for (const [node, width] of [
      [head, () => headWidth()],
      [foot, () => footWidth()],
    ] as const) {
      Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => room })
      Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => Math.max(room, width()) })
    }
    for (const node of [counts, status]) {
      Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => 1 })
      Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => 1 })
    }
    const state = (): string[] => [shown(viewMore) ? 'view' : '', more().every(shown) ? 'counts' : '', shown(lead) ? 'lead' : '', keyBox.classList.contains('is-crowded') ? '' : 'key'].filter((s) => s !== '')
    // The head: its counts 364 px whole, 77 the links held alone, the view's words 120, the rest 200.
    // The foot: the key 300, `around the selection · ` 161, `3 of 5 genomes` 98, the rest 20.
    const widths: Array<[number, string[]]> = [
      [1000, ['view', 'counts', 'lead', 'key']],
      [600, ['counts', 'lead', 'key']],
      [500, ['key']],
      [300, []],
      [1000, ['view', 'counts', 'lead', 'key']],
    ]
    expect(visible(counts)).toBe('1 of 1 link · 1 of 1 link offered · 1 of 1 to unlink')
    for (const [wide, expected] of widths) {
      room = wide
      pane.resize()
      await frame()
      expect([wide, state()]).toEqual([wide, expected])
    }
    // What stays: the links held, whole.
    room = 300
    pane.resize()
    await frame()
    expect(visible(counts)).toBe('1 of 1 link')
  })

  it('says a link held and one offered: from where, what is on offer, and what it rests on', async () => {
    const { said, model } = await mount()
    // The file links P to Z, on a read pair: an unlink is on offer.
    pointer('pointermove', linkMiddle('Z', 'P'))
    expect(said.at(-1)).toMatch(/^P ↔ Z · linked, from the file · unlink offered · affinity 0\.0033 \(at least 0\.000\d+\) · 0\.8% of its MAG contacts · 1 contact · host 0%$/)
    // The link hovered lights its element.
    expect(model.hovered.genome).toBe('P')
    // Y hosts P: a link on offer.
    pointer('pointermove', linkMiddle('Y', 'P'))
    expect(said.at(-1)).toMatch(/^P ↔ Y · link offered · affinity 0\.53 \(at least 0\.4\d\) · 99% of its MAG contacts · 120 contacts · host 99%$/)
    pointer('pointermove', node('Y'))
    expect(said.at(-1)).toBe('Y · 250.0 kb · 5 contigs · 100% complete · 1.00 redundant · hosts no element · 1 link offered')
    expect(model.hovered.genome).toBe('Y')
    pointer('pointermove', node('P'))
    expect(said.at(-1)).toBe('P · 100.0 kb · 2 contigs · hosted by Z · a link offered to Y · meets Y most, affinity 0.27')
    canvas().dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
    expect(said.at(-1)).toBeNull()
    expect(model.hovered.genome).toBeNull()
  })

  it('selects the node a press is on; ⌘ toggles one, ⇧ extends along its column; a press on a link selects both ends', async () => {
    const { model } = await mount()
    press(node('X1'))
    expect(model.selection.genomes).toEqual(['X1'])
    press(node('Z'), { metaKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'Z'])
    press(node('Z'), { metaKey: true })
    expect(model.selection.genomes).toEqual(['X1'])
    press(node('Z'), { shiftKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'X2', 'Z'])
    press(linkMiddle('Z', 'P'))
    expect(model.selection.genomes).toEqual(['P', 'Z'])
  })

  it('selects nothing on a press on nothing; a drag there, or a key held, keeps the selection', async () => {
    const { model } = await mount()
    const [magX, elementX] = (canvas().dataset.columns ?? '').split(' ').map(Number)
    // Between the columns, above every row and every link.
    const nothing = { clientX: (magX + elementX) / 2, clientY: 60 }
    model.selectGenomes(['X1', 'Y'])
    press(nothing, { metaKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'Y'])
    pointer('pointerdown', nothing)
    pointer('pointermove', { clientX: nothing.clientX, clientY: nothing.clientY + 30 })
    pointer('pointerup', { clientX: nothing.clientX, clientY: nothing.clientY + 30 })
    expect(model.selection.genomes).toEqual(['X1', 'Y'])
    press(nothing)
    expect(model.selection.genomes).toEqual([])
  })

  it('lets go of a press with Escape, and of the genome it lit when it is made small', async () => {
    const { pane, model, said } = await mount()
    pointer('pointerdown', node('X1'))
    expect(key(pane, 'Escape')).toBe(true)
    pointer('pointerup', node('X1'))
    // Let go of: no click.
    expect(model.selection.genomes).toEqual([])
    expect(key(pane, 'Escape')).toBe(false)
    pointer('pointermove', node('Y'))
    expect(model.hovered.genome).toBe('Y')
    pane.setLarge(false)
    expect(model.hovered.genome).toBeNull()
    expect(said.at(-1)).toBeNull()
  })

  it('links an element dragged onto a MAG, through the stage’s drop', async () => {
    const { ctx, model, pane } = await mount()
    const from = node('P')
    pointer('pointerdown', from)
    expect(ctx.dragging).toBeNull()
    pointer('pointermove', { clientX: from.clientX - 40, clientY: from.clientY + 10 })
    expect(ctx.dragging).toEqual({ kind: 'genomes', ids: ['P'] })
    const y = node('Y')
    expect(pane.dropTargetAt(y.clientX, y.clientY)).toEqual({ kind: 'genome', id: 'Y' })
    expect(ctx.dropWords({ kind: 'genome', id: 'Y' })).toEqual({ words: 'link P to Y', refused: false })
    expect(ctx.drop({ kind: 'genome', id: 'Y' })).toBe(true)
    await model.settled()
    await frame()
    expect(model.answer?.links.map((link) => `${link.element}>${link.mag}`).sort()).toEqual(['P>Y', 'P>Z'])
    // Held now, and P where it was.
    expect(document.querySelector('.curate-host-counts')?.textContent).toBe('2 links · 1 to unlink')
    expect(nodes().P[1]).toBe(nodes().Y[1])
  })

  it('carries the selection a drag starts on, and takes a drop on a node, never between the columns', async () => {
    const { ctx, model, pane } = await mount()
    model.selectGenomes(['X1', 'X2'])
    pointer('pointerdown', node('X2'), { pointerId: 2 })
    pointer('pointermove', { clientX: node('X2').clientX, clientY: node('X2').clientY + 30 }, { pointerId: 2 })
    expect(ctx.dragging).toEqual({ kind: 'genomes', ids: ['X1', 'X2'] })
    expect(ctx.dropWords({ kind: 'genome', id: 'Y' })).toEqual({ words: 'merge X1, X2 into Y', refused: false })
    const p = node('P')
    expect(pane.dropTargetAt(p.clientX, p.clientY)).toEqual({ kind: 'genome', id: 'P' })
    // A MAG dropped on an element is refused by the grammar, and said why.
    expect(ctx.dropWords({ kind: 'genome', id: 'P' })?.refused).toBe(true)
    const middle = linkMiddle('Z', 'P')
    expect(pane.dropTargetAt(middle.clientX, middle.clientY)).toBeNull()
    expect(pane.dropTargetAt(2, 2)).toBeNull()
  })

  it('frames a suggestion shown, and marks it for a script', async () => {
    const { pane, model } = await mount()
    const host = model.queue().find((q) => q.key === 'host:P')
    expect(host?.members.map((m) => m.kind).sort()).toEqual(['link', 'unlink'])
    pane.showSuggestion(host ?? null)
    expect(canvas().dataset.current).toBe('host:P')
    pane.showSuggestion(null)
    expect(canvas().dataset.current).toBe('')
  })

  it('scrolls rows taller than the view with the wheel, and shows a question framed while small once it is made large', async () => {
    const { pane, model } = await mount({ height: 130 })
    for (let k = 0; k < 4; k++) key(pane, '+')
    await frame()
    expect(pane.element.dataset.zoom).toBe('rows')
    canvas().dispatchEvent(new WheelEvent('wheel', { deltaY: 500, clientX: 400, clientY: 60, bubbles: true, cancelable: true }))
    await frame()
    expect(Number(canvas().dataset.scroll)).toBeGreaterThan(0)
    expect(nodes().P).toBeUndefined()
    // The review frames its question, then makes the host map large.
    pane.setLarge(false)
    pane.showSuggestion(model.queue().find((q) => q.key === 'host:P') ?? null)
    pane.setLarge(true)
    await frame()
    expect(nodes().P).toBeDefined()
  })

  it('changes the rows’ height with + and −, fits with 0, and leaves other keys', async () => {
    const { pane } = await mount()
    const pitch = (): number => Number(canvas().dataset.pitch)
    const fitted = pitch()
    expect(key(pane, '-')).toBe(true)
    await frame()
    // Every row is in view already: no lower than fits.
    expect(pitch()).toBeCloseTo(fitted, 6)
    expect(key(pane, '+')).toBe(true)
    await frame()
    expect(pitch()).toBeCloseTo(fitted * 1.25, 6)
    expect(key(pane, '0')).toBe(true)
    await frame()
    expect(pitch()).toBeCloseTo(fitted, 6)
    expect(key(pane, 'x')).toBe(false)
    expect(key(pane, '+', { metaKey: true })).toBe(false)
  })

  it('shows only what is around the selection when asked', async () => {
    const { pane, model } = await mount()
    ;(pane.element.querySelector('.curate-host-view[data-view="around"]') as HTMLButtonElement).click()
    await frame()
    expect(pane.element.dataset.view).toBe('around')
    expect(pane.view).toBe('around')
    const note = pane.element.querySelector('.curate-host-note') as HTMLElement
    expect(note.classList.contains('hidden')).toBe(false)
    expect(note.textContent).toBe('Select a genome, in the list or on a map, to see it with its links, its partners’ other links and, for an element, the genomes it meets most.')
    // Nothing chosen, nothing drawn: none of the map's links.
    expect(pane.element.querySelector('.curate-host-counts')?.textContent).toBe('0 of 1 link')
    // Y, the element offered to it, and that element's other host.
    model.selectGenomes(['Y'])
    await frame()
    expect(Object.keys(nodes()).sort()).toEqual(['P', 'Y', 'Z'])
    expect(note.classList.contains('hidden')).toBe(true)
    expect(pane.element.querySelector('.curate-host-status')?.textContent).toBe('around the selection · 3 of 5 genomes')
    // The head counts what is drawn of the map's.
    const counts = pane.element.querySelector('.curate-host-counts') as HTMLElement
    expect(counts.textContent).toBe('1 of 1 link · 1 of 1 link offered · 1 of 1 to unlink')
    expect(counts.title).toBe(
      'Drawn around the selection: 1 of the map’s 1 link held, 1 of its 1 link offered and 1 of its 1 held link to unlink — each link an element and a MAG, where the suggestions ask an element’s links as one question',
    )
    ;(pane.element.querySelector('.curate-host-view[data-view="all"]') as HTMLButtonElement).click()
    await frame()
    expect(Object.keys(nodes()).sort()).toEqual(['P', 'X1', 'X2', 'Y', 'Z'])
    expect(counts.textContent).toBe('1 link · 1 link offered · 1 to unlink')
  })

  it('shows around an element its hosts, their other elements, and the MAGs it meets that no link joins it to, faint', async () => {
    const { pane, model, said } = await mount({ declines: true })
    // y5's move turned down, its contacts with P count for X1, and the link to X1 they offer turned down too: P meets X1, unlinked.
    expect(model.reject(model.offered().find((s) => s.key === 'move:y5>Y') as Suggestion)).toBe(true)
    await model.settled()
    expect(model.reject(model.offered().find((s) => s.key === 'link:P>X1') as Suggestion)).toBe(true)
    await model.settled()
    model.selectGenomes(['P'])
    ;(pane.element.querySelector('.curate-host-view[data-view="around"]') as HTMLButtonElement).click()
    await frame()
    // Its hosts Z (held) and Y (offered), and X1, which it meets.
    expect(Object.keys(nodes()).sort()).toEqual(['P', 'X1', 'Y', 'Z'])
    expect(pane.element.querySelector('.curate-host-status')?.textContent).toBe('around the selection · 4 of 5 genomes')
    // What it meets is no link: the head counts the links alone.
    expect(pane.element.querySelector('.curate-host-counts')?.textContent).toBe('1 of 1 link · 1 of 1 link offered · 1 of 1 to unlink')
    // The key says what the faint curve is.
    expect(keyWords()).toEqual(['linked', 'offered', 'to unlink', 'meets'])
    // The curve said as it is: met, not linked, with its numbers.
    pointer('pointermove', linkMiddle('X1', 'P'))
    expect(said.at(-1)).toMatch(/^P ↔ X1 · not linked · affinity [\d.]+ \(at least [\d.]+\) · [\d.]+% of its MAG contacts · 24 contacts · host \d+%$/)
    expect(model.hovered.genome).toBe('P')
    // A press on it selects its two ends, as on any link.
    press(linkMiddle('X1', 'P'))
    expect(model.selection.genomes).toEqual(['P', 'X1'])
    // Every genome again: no rival drawn, and no key for one.
    ;(pane.element.querySelector('.curate-host-view[data-view="all"]') as HTMLButtonElement).click()
    await frame()
    expect(keyWords()).toEqual(['linked', 'offered', 'to unlink'])
  })

  it('shows around an element its hosts’ other elements', async () => {
    const { pane, model } = await mount({ lonely: true })
    // Q linked to Z, which P is linked to: around P, Q is drawn with its link — one no contact supports, an unlink offered.
    expect(model.drop({ kind: 'genomes', ids: ['Q'] }, { kind: 'genome', id: 'Z' })).toBe(true)
    await model.settled()
    model.selectGenomes(['P'])
    ;(pane.element.querySelector('.curate-host-view[data-view="around"]') as HTMLButtonElement).click()
    await frame()
    expect(Object.keys(nodes()).sort()).toEqual(['P', 'Q', 'Y', 'Z'])
    expect(pane.element.querySelector('.curate-host-counts')?.textContent).toBe('2 of 2 links · 1 of 1 link offered · 2 of 2 to unlink')
  })

  it('draws small as a thumbnail: no head, no readout, no hand', async () => {
    const { pane, said, model } = await mount()
    pane.setLarge(false)
    await frame()
    expect(pane.element.classList.contains('is-small')).toBe(true)
    expect(pane.element.dataset.large).toBe('false')
    const before = said.length
    pointer('pointermove', node('Y'))
    press(node('Y'))
    expect(said.length).toBe(before)
    expect(model.selection.genomes).toEqual([])
    expect(pane.dropTargetAt(node('Y').clientX, node('Y').clientY)).toBeNull()
    expect(key(pane, '0')).toBe(false)
  })
})

describe('the elements that meet no MAG', () => {
  it('folds them at the foot, counted, and opens them on a press', async () => {
    const { pane, model } = await mount({ lonely: true })
    expect(model.answer?.genomes.map((genome) => genome.id)).toContain('Q')
    const fold = pane.element.querySelector('.curate-host-fold') as HTMLButtonElement
    expect(fold.classList.contains('hidden')).toBe(false)
    expect(fold.textContent).toBe('1 meets no MAG')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(nodes().Q).toBeUndefined()
    fold.click()
    await frame()
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(canvas().dataset.rows).toBe('5')
    // In the elements' column, below every band.
    expect(nodes().Q[1]).toBeGreaterThan(nodes().Z[1])
    expect(nodes().Q[0]).toBeGreaterThan(nodes().Y[0])
    fold.click()
    await frame()
    expect(nodes().Q).toBeUndefined()
  })

  it('opens the foot to show one a part frames', async () => {
    const { pane, ctx } = await mount({ lonely: true })
    const fold = pane.element.querySelector('.curate-host-fold') as HTMLButtonElement
    expect(nodes().Q).toBeUndefined()
    ctx.frame({ genomes: ['Q'] })
    await frame()
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(nodes().Q).toBeDefined()
  })

  it('says of one that it meets no MAG', async () => {
    const { pane, said } = await mount({ lonely: true })
    ;(pane.element.querySelector('.curate-host-fold') as HTMLButtonElement).click()
    await frame()
    pointer('pointermove', node('Q'))
    expect(said.at(-1)).toBe('Q · 40.0 kb · 2 contigs · no host · meets no MAG')
  })
})

describe('across steps', () => {
  it('keeps an element beside its MAG after a step, and lays it out again on tidy', async () => {
    const { model, said } = await mount()
    expect(nodes().P[1]).toBe(nodes().Y[1])
    // Y given z0, which P never meets, then Y's own contigs given to Z: Y lasts, and P meets Z most.
    model.selectContigs([12])
    expect(model.moveSelected('Y')).toBe(true)
    await model.settled()
    model.selectContigs([7, 8, 9, 10, 11])
    expect(model.moveSelected('Z')).toBe(true)
    await model.settled()
    await frame()
    pointer('pointermove', node('P'))
    expect(said.at(-1)).toMatch(/· meets Z most, affinity [\d.]+$/)
    // Nothing moved under the hand: P beside Y, where it was.
    expect(nodes().P[1]).toBe(nodes().Y[1])
    model.tidy()
    await frame()
    expect(nodes().P[1]).toBe(nodes().Z[1])
  })

  it('puts an element a step makes beside the genome its contigs came from, previewed and made; tidy, beside the MAG it meets most', async () => {
    const { model, said } = await mount()
    // y5 is Y's, binned in X1: an element made of it comes from X1, and meets Y most.
    const made = model.mint('element')
    model.preview({ op: 'create', id: made.id, name: made.name, kind: 'element', contigs: ['y5'] }, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await frame()
    expect(model.previewing).toBe(true)
    expect(nodes()[made.id][1]).toBe(nodes().X1[1])
    model.preview(null)
    model.selectContigs([3])
    const id = model.createFromSelected('element') as string
    await model.settled()
    await frame()
    // Where its contigs were, and P where it was: nothing moved under the hand.
    expect(nodes()[id][1]).toBe(nodes().X1[1])
    expect(nodes().P[1]).toBe(nodes().Y[1])
    pointer('pointermove', node(id))
    expect(said.at(-1)).toMatch(/· meets Y most, affinity [\d.]+$/)
    model.tidy()
    await frame()
    // Y's band holds it and P now, Y's node between them.
    const half = Number(canvas().dataset.pitch) / 2
    expect(Math.abs(nodes()[id][1] - nodes().Y[1])).toBeCloseTo(half, 1)
    expect(Math.abs(nodes().P[1] - nodes().Y[1])).toBeCloseTo(half, 1)
  })

  it('draws a step as it would be while it is previewed: the link offered, held', async () => {
    const { model } = await mount()
    model.preview({ op: 'link', element: 'P', mag: 'Y' }, true)
    await model.settled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await frame()
    expect(model.previewing).toBe(true)
    // As it would be: held, and nothing offered on a binning not yet made.
    expect(document.querySelector('.curate-host-counts')?.textContent).toBe('2 links')
    model.preview(null)
    await frame()
    expect(document.querySelector('.curate-host-counts')?.textContent).toBe('1 link · 1 link offered · 1 to unlink')
  })
})

describe('before the contacts are read', () => {
  it('draws the file’s links, each element beside the MAG it is linked to, and says what is to come', async () => {
    const { pane } = await mount({ unread: true })
    expect(pane.element.dataset.ready).toBe('false')
    // P is linked by the file to Z: beside it, until the contacts say otherwise.
    expect(nodes().P[1]).toBe(nodes().Z[1])
    expect(pane.element.querySelector('.curate-host-counts')?.textContent).toBe('1 link')
    expect(pane.element.querySelector('.curate-host-status')?.textContent).toBe('the file’s links, until the contacts are read')
    // Every link drawn is held until then: no key to read.
    expect(pane.element.querySelector('.curate-host-key')?.classList.contains('hidden')).toBe(true)
  })

  it('says of a link that its numbers are to come, not that it has none', async () => {
    const { said } = await mount({ unread: true })
    pointer('pointermove', linkMiddle('Z', 'P'))
    expect(said.at(-1)).toBe('P ↔ Z · linked, from the file · its numbers once the contacts are read')
  })
})

describe('an empty map', () => {
  it('says how to make an element where there is none', async () => {
    const { pane, model } = await mount()
    model.selectGenomes(['P'])
    model.retypeSelected('mag')
    await model.settled()
    await frame()
    const note = pane.element.querySelector('.curate-host-note') as HTMLElement
    expect(note.classList.contains('hidden')).toBe(false)
    expect(note.textContent).toBe('No mobile elements in this map: select contigs and press E to make one.')
  })
})
