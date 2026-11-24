// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's contact map (SPECS §33.3), in a DOM: the genome under a
 * press, a run dragged along the diagonal, the selection carried, the drop
 * target at a bar's block, the readout's words, and the close-up — asked for
 * the selected genomes' contigs and their candidates, read again after a step,
 * its genomes' names selecting their contigs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { focusPicture } from '@/curate/focus'
import { ContactPane } from '@/curate/ui/ContactPane'
import type { CurateContext } from '@/curate/ui/context'
import type { CurationFocusResult } from '@/worker/curateProtocol'
import { community } from '../support/curateCommunity'
import { testContext, type TestStage } from '../support/curateStage'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let panes: ContactPane[] = []

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

/** The contacts among some contigs, as the worker answers a `curationFocus` (`worker/curate.ts`). */
function focusOf(contigs: Int32Array): CurationFocusResult {
  const { evidence } = community()
  const slot = new Map<number, number>()
  contigs.forEach((c, k) => {
    if (!slot.has(c)) slot.set(c, k)
  })
  const found: Array<[number, number, number]> = []
  contigs.forEach((c, k) => {
    if (slot.get(c) !== k) return
    for (let n = evidence.offsets[c]; n < evidence.offsets[c + 1]; n++) {
      const other = slot.get(evidence.neighbours[n])
      if (other === undefined || other <= k) continue
      found.push([k, other, evidence.counts[n]])
    }
  })
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let total = 0
  for (let c = 0; c < evidence.visibility.length; c++) total += evidence.visibility[c]
  const answer = {
    contigs: Int32Array.from(contigs),
    i: Int32Array.from(found, (f) => f[0]),
    j: Int32Array.from(found, (f) => f[1]),
    contacts: Float64Array.from(found, (f) => f[2]),
    within: Float64Array.from(contigs, (c) => evidence.network.within[c]),
    visibility: Float64Array.from(contigs, (c) => evidence.visibility[c]),
    total,
    background: evidence.background.rho,
  }
  return { ...answer, picture: focusPicture(contigs.length, answer, evidence.background.rho) }
}

interface Mounted extends TestStage {
  pane: ContactPane
  asked: Int32Array[]
}

/** A frame: the pane draws in one. */
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * The pane over the community, in a square plot (600 pixels unless asked), its
 * first count in and drawn; its close-ups answered as the worker would, or
 * never (`read: false`).
 */
async function mount(options: { side?: number; read?: boolean } = {}): Promise<Mounted> {
  const side = options.side ?? 600
  const stage = testContext()
  const asked: Int32Array[] = []
  ;(stage.ctx as { focus: CurateContext['focus'] }).focus = (contigs) => {
    asked.push(Int32Array.from(contigs))
    return { promise: options.read === false ? new Promise<CurationFocusResult>(() => {}) : Promise.resolve(focusOf(contigs)), cancel: () => {} }
  }
  const pane = new ContactPane(stage.ctx)
  panes.push(pane)
  // The stage tells its panes what changed; here the test does.
  stage.model.subscribe((change) => pane.update(change))
  document.body.appendChild(pane.element)
  const plot = pane.element.querySelector('.curate-contact-plot') as HTMLElement
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: side, bottom: side, width: side, height: side, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  await stage.model.settled()
  pane.resize()
  await frame()
  order = stage.model.order
  return { ...stage, pane, asked }
}

/** Where the map is drawn, and its cells: from the overlay, as a script driving the stage reads them. */
function geometry(): { x: number; y: number; size: number; n: number; domain: number[] } {
  const overlay = document.querySelector('.curate-contact-overlay') as HTMLElement
  const [x, y, size] = (overlay.dataset.map ?? '0 0 0').split(' ').map(Number)
  return { x, y, size, n: Number(overlay.dataset.cells), domain: (overlay.dataset.domain ?? '').split(' ').map(Number) }
}

/** The middle of cell (row, column), in client pixels, at the view drawn. */
function cell(row: number, col: number): { clientX: number; clientY: number } {
  const { x, y, size, domain } = geometry()
  const k = size / (domain[1] - domain[0])
  return { clientX: x + (col + 0.5 - domain[0]) * k, clientY: y + (row + 0.5 - domain[2]) * k }
}

/** A point on the top bar over a unit: on its colour strip, or on its names. */
function topBar(unit: number, names = false): { clientX: number; clientY: number } {
  const { x, y, size, domain } = geometry()
  const k = size / (domain[1] - domain[0])
  return { clientX: x + (unit + 0.5 - domain[0]) * k, clientY: names ? y - 30 : y - 8 }
}

const overlay = (): HTMLElement => document.querySelector('.curate-contact-overlay') as HTMLElement

/** A genome's row and column on the map: its place in the stage's order, MAGs then elements. */
let order: readonly string[] = []
const slot = (id: string): number => order.indexOf(id)
/** The cell of two genomes, by id. */
const pair = (row: string, col: string): { clientX: number; clientY: number } => cell(slot(row), slot(col))

function pointer(type: string, at: { clientX: number; clientY: number }, init: PointerEventInit = {}): void {
  overlay().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...at, ...init }))
}

function press(at: { clientX: number; clientY: number }, init: PointerEventInit = {}): void {
  pointer('pointerdown', at, init)
  pointer('pointerup', at, init)
}

function key(pane: ContactPane, name: string, init: KeyboardEventInit = {}): boolean {
  return pane.key(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

describe('the genome map', () => {
  it('draws every genome a cell, MAGs then elements, and says so to a script', async () => {
    const { pane } = await mount()
    expect(pane.element.dataset.pane).toBe('contacts')
    expect(pane.element.dataset.view).toBe('genomes')
    expect(pane.element.dataset.ready).toBe('true')
    expect(geometry().n).toBe(5)
    expect(pane.element.querySelector('.curate-crumb')?.textContent).toBe('genomes')
    expect(pane.element.querySelector('.curate-key-title')?.textContent).toBe('affinity')
  })

  it('selects the genome a press on the diagonal is on, both off it; ⌘ toggles, ⇧ extends along the order', async () => {
    const { model } = await mount()
    // The genomes that meet densely are neighbours: Y, X1, X2, then Z; P, the element, after.
    expect(order).toEqual(['Y', 'X1', 'X2', 'Z', 'P'])
    press(pair('X2', 'X2'))
    expect(model.selection.genomes).toEqual(['X2'])
    press(pair('X1', 'Y'))
    expect(model.selection.genomes).toEqual(['X1', 'Y'])
    press(pair('P', 'P'), { metaKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'Y', 'P'])
    press(pair('P', 'P'), { metaKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'Y'])
    press(pair('X1', 'X1'))
    press(pair('Z', 'Z'), { shiftKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'X2', 'Z'])
  })

  it('selects the run a drag along the diagonal covers, live', async () => {
    const { model } = await mount()
    pointer('pointerdown', pair('Y', 'Y'))
    pointer('pointermove', pair('X1', 'X1'))
    expect(model.selection.genomes).toEqual(['Y', 'X1'])
    pointer('pointermove', pair('X2', 'X2'))
    pointer('pointerup', pair('X2', 'X2'))
    expect(model.selection.genomes).toEqual(['Y', 'X1', 'X2'])
  })

  it('selects a genome pressed on a bar, and carries the selection a drag starts on', async () => {
    const { model, ctx } = await mount()
    press(topBar(slot('X2')))
    expect(model.selection.genomes).toEqual(['X2'])
    pointer('pointerdown', pair('X2', 'X2'))
    expect(ctx.dragging).toBeNull()
    pointer('pointermove', { clientX: pair('X2', 'X2').clientX + 30, clientY: pair('X2', 'X2').clientY })
    expect(ctx.dragging).toEqual({ kind: 'genomes', ids: ['X2'] })
    expect(ctx.dropWords({ kind: 'genome', id: 'X1' })).toEqual({ words: 'merge X2 into X1', refused: false })
    expect(ctx.drop({ kind: 'genome', id: 'X1' })).toBe(true)
    await model.settled()
    expect(model.answer?.genomes.map((genome) => genome.id)).toEqual(['X1', 'Y', 'Z', 'P'])
    expect(model.selection.genomes).toEqual(['X1'])
  })

  it('takes a drop on a genome’s block or its diagonal cell, never off the diagonal', async () => {
    const { pane } = await mount()
    const bar = topBar(slot('Y'))
    expect(pane.dropTargetAt(bar.clientX, bar.clientY)).toEqual({ kind: 'genome', id: 'Y' })
    const names = topBar(slot('P'), true)
    expect(pane.dropTargetAt(names.clientX, names.clientY)).toEqual({ kind: 'genome', id: 'P' })
    const diagonal = pair('Z', 'Z')
    expect(pane.dropTargetAt(diagonal.clientX, diagonal.clientY)).toEqual({ kind: 'genome', id: 'Z' })
    const off = pair('X1', 'Z')
    expect(pane.dropTargetAt(off.clientX, off.clientY)).toBeNull()
    expect(pane.dropTargetAt(2, 2)).toBeNull()
  })

  it('says what a cell is: a pair’s affinity and its lower bound, its contacts, what is offered and held', async () => {
    const { said, model } = await mount()
    pointer('pointermove', pair('X1', 'X2'))
    expect(said.at(-1)).toBe('X1 × X2 · affinity 1.50 (at least 1.42) · 540 contacts · merge 99%')
    expect(model.hovered.genome).toBe('X1')
    pointer('pointermove', pair('Y', 'Y'))
    expect(said.at(-1)).toBe('Y · 250.0 kb · 5 contigs · 100% complete · 1.00 redundant')
    pointer('pointermove', pair('P', 'Z'))
    expect(said.at(-1)).toMatch(/^P × Z · affinity 0\.0029 \(at least 0\.00031\) · 1 contact · linked, from the file · unlink \d+%$/)
    pointer('pointermove', pair('Y', 'Z'))
    expect(said.at(-1)).toBe('Y × Z · affinity 0.0011 (at least 0.00011) · 1 contact')
    pointer('pointermove', pair('P', 'P'))
    expect(said.at(-1)).toBe('P · 100.0 kb · 2 contigs · an element, hosted by Z')
    overlay().dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
    expect(said.at(-1)).toBeNull()
    expect(model.hovered.genome).toBeNull()
  })

  it('reads the pair beside a diagonal of small cells, and runs along the diagonal from there', async () => {
    const { model, ctx } = await mount({ side: 150 })
    const { x, y, size, domain } = geometry()
    const k = size / (domain[1] - domain[0])
    expect(k).toBeLessThan(12)
    // Two pixels right of the corner X1 × X2 shares with the diagonal, a pixel up: the pair's cell.
    expect(slot('X2')).toBe(slot('X1') + 1)
    const beside = { clientX: x + slot('X2') * k + 2, clientY: y + slot('X2') * k - 1 }
    press(beside)
    expect(model.selection.genomes).toEqual(['X1', 'X2'])
    // A drag from it runs along the diagonal, from the genome there…
    model.clearSelection()
    pointer('pointerdown', beside)
    pointer('pointermove', pair('Z', 'Z'))
    pointer('pointerup', pair('Z', 'Z'))
    expect(model.selection.genomes).toEqual(['X2', 'Z'])
    // …or carries the selection, where that genome is in it.
    pointer('pointerdown', beside, { pointerId: 2 })
    pointer('pointermove', pair('Y', 'Y'), { pointerId: 2 })
    expect(ctx.dragging).toEqual({ kind: 'genomes', ids: ['X2', 'Z'] })
  })

  it('zooms with + and −, fits with 0, and frames a suggestion shown', async () => {
    const { pane, model } = await mount()
    expect(key(pane, '+')).toBe(true)
    await frame()
    const zoomed = geometry().domain
    expect(zoomed[1] - zoomed[0]).toBeCloseTo(4, 6)
    expect(key(pane, '0')).toBe(true)
    await frame()
    expect(geometry().domain.slice(0, 2)).toEqual([0, 5])
    expect(key(pane, 'x')).toBe(false)
    const merge = model.offered().find((s) => s.kind === 'merge')!
    pane.showSuggestion(merge)
    expect(overlay().dataset.current).toBe('merge:X1+X2')
    pane.showSuggestion(null)
    expect(overlay().dataset.current).toBe('')
  })

  it('draws small as a thumbnail: no head, no readout, no hand', async () => {
    const { pane, said, model } = await mount()
    pane.setLarge(false)
    await frame()
    expect(pane.element.classList.contains('is-small')).toBe(true)
    const before = said.length
    pointer('pointermove', pair('X1', 'X2'))
    press(pair('X2', 'X2'))
    expect(said.length).toBe(before)
    expect(model.selection.genomes).toEqual([])
    expect(pane.dropTargetAt(pair('X2', 'X2').clientX, pair('X2', 'X2').clientY)).toBeNull()
    expect(key(pane, '0')).toBe(false)
  })
})

describe('the close-up', () => {
  it('asks once for the selected genomes’ contigs, longest first, then their candidates', async () => {
    const { pane, model, asked } = await mount()
    model.selectGenomes(['X2', 'X1'])
    pane.closeUp()
    await model.settled()
    await frame()
    // X1 (x0–x2 and y5, all 50 kb: the file's order), X2 (x3–x5), then u0, which a recruit would bring into X1.
    expect(asked.map((contigs) => Array.from(contigs))).toEqual([[0, 1, 2, 3, 4, 5, 6, 18]])
    expect(pane.element.dataset.view).toBe('contigs')
    expect(pane.element.dataset.ready).toBe('true')
    expect(geometry().n).toBe(8)
    expect(pane.element.querySelector('.curate-crumb-here')?.textContent).toBe('X1, X2')
    expect(pane.element.querySelector('.curate-crumb-count')?.textContent).toBe('7 contigs · 1 candidate')
    expect(pane.element.querySelector('.curate-key-title')?.textContent).toBe('observed / expected')
  })

  it('says what two contigs’ cell is, from the contacts the answer carries', async () => {
    const { pane, model, said } = await mount()
    model.selectGenomes(['X1', 'X2'])
    pane.closeUp()
    await frame()
    await frame()
    pointer('pointermove', cell(0, 1))
    expect(said.at(-1)).toMatch(/^x0 × x1 · 60 contacts · [\d.,]+× expected$/)
    pointer('pointermove', cell(0, 7))
    expect(said.at(-1)).toMatch(/^x0 × u0 · 60 contacts · /)
    pointer('pointermove', cell(7, 7))
    expect(said.at(-1)).toMatch(/^u0 · 50\.0 kb · unbinned · recruit into X1 \d+%/)
    pointer('pointermove', cell(3, 3))
    expect(said.at(-1)).toMatch(/^y5 · 50\.0 kb · in X1 · move to Y \d+%/)
  })

  it('selects a genome’s contigs by its name on the bar, and takes a drop on a genome’s span alone', async () => {
    const { pane, model } = await mount()
    model.selectGenomes(['X1', 'X2'])
    pane.closeUp()
    await frame()
    press(topBar(5, true))
    expect(model.selection.contigs).toEqual([4, 5, 6])
    press(topBar(7, true))
    expect(model.selection.contigs).toEqual([18])
    const span = topBar(5)
    expect(pane.dropTargetAt(span.clientX, span.clientY)).toEqual({ kind: 'genome', id: 'X2' })
    const candidate = topBar(7)
    expect(pane.dropTargetAt(candidate.clientX, candidate.clientY)).toBeNull()
    // A contig pressed, then carried.
    press(cell(3, 3))
    expect(model.selection.contigs).toEqual([3])
    pointer('pointerdown', cell(3, 3))
    pointer('pointermove', { clientX: cell(3, 3).clientX, clientY: cell(3, 3).clientY + 40 })
    expect(pane.view).toBe('contigs')
  })

  it('asks again after a step, keeping the picture it holds until the new one lands', async () => {
    const { pane, model, asked } = await mount()
    model.selectGenomes(['X1', 'X2'])
    pane.closeUp()
    await frame()
    const recruit = model.offered().find((s) => s.kind === 'recruit')!
    model.accept(recruit)
    await model.settled()
    await frame()
    // u0 is X1's now, and no candidate is left.
    expect(asked.map((contigs) => Array.from(contigs))).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 18],
      [0, 1, 2, 3, 18, 4, 5, 6],
    ])
    expect(pane.element.querySelector('.curate-crumb-count')?.textContent).toBe('8 contigs')
  })

  it('follows a genome merged away to the one that holds its contigs, and goes back by its crumb', async () => {
    const { pane, model, asked } = await mount()
    model.selectGenomes(['X2'])
    pane.closeUp()
    await frame()
    expect(Array.from(asked[0])).toEqual([4, 5, 6])
    model.selectGenomes(['X1', 'X2'])
    model.mergeSelected()
    await model.settled()
    await frame()
    expect(pane.element.querySelector('.curate-crumb-here')?.textContent).toBe('X1')
    expect(Array.from(asked.at(-1) ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 18])
    ;(pane.element.querySelector('.curate-crumb') as HTMLButtonElement).click()
    await frame()
    expect(pane.element.dataset.view).toBe('genomes')
    expect(geometry().n).toBe(4)
  })

  it('goes back to the genome level as it was left: zoomed where it was, or whole', async () => {
    const { pane, model } = await mount()
    key(pane, '+')
    key(pane, '+')
    await frame()
    const zoomed = geometry().domain
    model.selectGenomes(['X1'])
    pane.closeUp()
    await frame()
    key(pane, '+')
    await frame()
    pane.back()
    await frame()
    expect(geometry().domain).toEqual(zoomed)
    key(pane, '0')
    pane.closeUp()
    await frame()
    key(pane, '+')
    key(pane, '+')
    pane.back()
    await frame()
    expect(geometry().domain).toEqual([0, 5, 0, 5])
  })

  it('says it is reading a close-up until its contacts land', async () => {
    const { pane, model } = await mount({ read: false })
    model.selectGenomes(['X2'])
    pane.closeUp()
    await frame()
    const note = pane.element.querySelector('.curate-contact-note') as HTMLElement
    expect(note.classList.contains('hidden')).toBe(false)
    expect(note.textContent).toBe('reading the contacts among 3 contigs…')
    expect(pane.element.dataset.ready).toBe('false')
  })

  it('opens on a double click on the diagonal, and says what to do with nothing selected', async () => {
    const { pane, said } = await mount()
    pane.closeUp()
    expect(pane.view).toBe('genomes')
    expect(said.at(-1)).toBe('Select genomes, in the list or on the map, then press Enter for their contigs.')
    press(pair('Y', 'Y'))
    overlay().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ...pair('Y', 'Y') }))
    await frame()
    expect(pane.view).toBe('contigs')
    expect(pane.element.querySelector('.curate-crumb-here')?.textContent).toBe('Y')
    pane.back()
    await frame()
    expect(pane.view).toBe('genomes')
  })
})
