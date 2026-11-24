// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's GC × coverage scatter (SPECS §33.3), in a DOM: every
 * contig placed by its GC and its coverage, the ones without contacts in the
 * strip at the foot; the readout of a dot and of the plot under the pointer; a
 * press selecting a dot's contig, then its genome; a lasso selecting what it
 * holds, adding with ⇧ and taking away with ⌥; the rest faded while a genome is
 * selected; the selection carried; the genome lit in every pane; the question
 * shown; the wheel, `0`, GC alone before the coverage, a map without GC, the
 * thumbnail, and the binning as a preview would leave it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ScatterPane } from '@/curate/ui/ScatterPane'
import type { CuratePane } from '@/curate/ui/context'
import { NAMES } from '../support/curateCommunity'
import { testContext, type TestStage } from '../support/curateStage'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let panes: ScatterPane[] = []

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
 * The community's contigs, each organism one cloud: X (x0–x5, and u0 in the
 * pool) at GC 30–39 % and 10 contacts per kb, Y (y0–y4, and y5 binned in X1)
 * at 50–57.5 % and 40, Z at 62–66.5 % and 120 — z3 without a contact —, the
 * element P at 44–45.5 % and 300.
 */
const GC: Record<string, number> = {
  x0: 30,
  x1: 31.5,
  x2: 33,
  x3: 34.5,
  x4: 36,
  x5: 37.5,
  u0: 39,
  y0: 50,
  y1: 51.5,
  y2: 53,
  y3: 54.5,
  y4: 56,
  y5: 57.5,
  z0: 62,
  z1: 63.5,
  z2: 65,
  z3: 66.5,
  p0: 44,
  p1: 45.5,
}
const COVERAGE: Record<string, number> = { x0: 10, x1: 10, x2: 10, x3: 10, x4: 10, x5: 10, u0: 10, y0: 40, y1: 40, y2: 40, y3: 40, y4: 40, y5: 40, z0: 120, z1: 120, z2: 120, z3: 0, p0: 300, p1: 300 }
const index = (name: string): number => NAMES.indexOf(name)

interface Mounted extends TestStage {
  pane: ScatterPane
}

/** A frame: the pane draws in one. */
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** The pane over the community in a 600 × 400 plot, its first count in and drawn. */
async function mount(options: { gc?: boolean; coverage?: boolean } = {}): Promise<Mounted> {
  const stage = testContext()
  stage.ctx.data.gc = options.gc === false ? null : Float64Array.from(NAMES, (name) => GC[name])
  stage.ctx.data.coverage = options.coverage === false ? null : Float64Array.from(NAMES, (name) => COVERAGE[name])
  const pane = new ScatterPane(stage.ctx)
  panes.push(pane)
  // The stage tells its panes what changed; here the test does.
  stage.model.subscribe((change) => pane.update(change))
  document.body.appendChild(pane.element)
  const plot = pane.element.querySelector('.curate-scatter-plot') as HTMLElement
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  await stage.model.settled()
  pane.resize()
  await frame()
  return { ...stage, pane }
}

const hand = (): HTMLElement => document.querySelector('.curate-scatter-hand') as HTMLElement
const dots = (): HTMLElement => document.querySelector('.curate-scatter-dots') as HTMLElement
const marks = (): HTMLElement => document.querySelector('.curate-scatter-marks') as HTMLElement
const numbers = (text: string | undefined): number[] => (text ?? '').split(' ').map(Number)

/** A contig's dot, in client pixels, from the plot and the view the hand says it draws: as a script reads them. */
function at(name: string): { clientX: number; clientY: number } {
  const [x, y, w, h] = numbers(hand().dataset.plot)
  const [gc0, gc1, log0, log1] = numbers(hand().dataset.domain)
  const cover = COVERAGE[name]
  if (!(cover > 0)) throw new Error(`${name} is in the strip`)
  return { clientX: x + ((GC[name] - gc0) / (gc1 - gc0)) * w, clientY: y + h - ((Math.log10(cover) - log0) / (log1 - log0)) * h }
}

function pointer(type: string, where: { clientX: number; clientY: number }, init: PointerEventInit = {}): void {
  hand().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...where, ...init }))
}

function press(where: { clientX: number; clientY: number }, init: PointerEventInit = {}): void {
  pointer('pointerdown', where, init)
  pointer('pointerup', where, init)
}

/** A lasso drawn as a box round some contigs' dots, `margin` pixels out. */
function lasso(names: readonly string[], init: PointerEventInit = {}, margin = 10): void {
  const points = names.map(at)
  const x0 = Math.min(...points.map((p) => p.clientX)) - margin
  const x1 = Math.max(...points.map((p) => p.clientX)) + margin
  const y0 = Math.min(...points.map((p) => p.clientY)) - margin
  const y1 = Math.max(...points.map((p) => p.clientY)) + margin
  pointer('pointerdown', { clientX: x0, clientY: y0 }, init)
  for (const [x, y] of [
    [(x0 + x1) / 2, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 1],
  ])
    pointer('pointermove', { clientX: x, clientY: y }, init)
  pointer('pointerup', { clientX: x0, clientY: y0 + 1 }, init)
}

const contigs = (...names: string[]): number[] => names.map(index).sort((a, b) => a - b)

describe('the GC × coverage scatter', () => {
  it('places every contig with a GC content, the one without a contact in the strip at the foot', async () => {
    const { pane } = await mount()
    expect(pane.view).toBe('gc-coverage')
    expect(pane.element.dataset.pane).toBe('scatter')
    expect(pane.element.dataset.ready).toBe('true')
    expect(hand().dataset.dots).toBe(String(NAMES.length))
    // The strip sits under the plot.
    const [, y, , h] = numbers(hand().dataset.plot)
    const [stripY] = numbers(hand().dataset.strip)
    expect(stripY).toBeGreaterThan(y + h)
    expect(document.querySelector('.curate-scatter-counts')?.textContent).toBe('19 contigs\u00a0· 1 without contacts')
    expect(pane.element.classList.contains('is-empty')).toBe(false)
    // Up is more coverage, across more GC.
    expect(at('p0').clientY).toBeLessThan(at('y0').clientY)
    expect(at('y0').clientY).toBeLessThan(at('x0').clientY)
    expect(at('x0').clientX).toBeLessThan(at('y0').clientX)
  })

  it('says the contig under the pointer — its genome, its affinities, what is offered — and lights it', async () => {
    const { model, said } = await mount()
    pointer('pointermove', at('u0'))
    expect(said.at(-1)).toBe('u0 · 50.0 kb · GC 39.0% · 10 Hi-C contacts per kb · unbinned · best X1, affinity 1.95 · recruit 98%')
    expect(model.hovered).toEqual({ genome: null, contig: index('u0') })
    pointer('pointermove', at('y5'))
    expect(said.at(-1)).toBe('y5 · 50.0 kb · GC 57.5% · 40 Hi-C contacts per kb · in X1 · own affinity 0 · best Y, affinity 1.25 · move 97%')
    expect(model.hovered).toEqual({ genome: 'X1', contig: index('y5') })
    // Between the clouds: where the pointer is, in the data.
    const { clientX, clientY } = at('p0')
    pointer('pointermove', { clientX, clientY: clientY + 60 })
    expect(said.at(-1)).toMatch(/^GC 44\.0% · \d+(\.\d)? Hi-C contacts per kb · drag to lasso$/)
    expect(model.hovered.contig).toBe(-1)
    hand().dispatchEvent(new PointerEvent('pointerleave'))
    expect(said.at(-1)).toBeNull()
  })

  it('selects a dot’s contig on a press, its genome on a second, the contig on a third; a press on nothing lets go', async () => {
    const { model } = await mount()
    press(at('x1'))
    expect(model.selection).toEqual({ genomes: [], contigs: [index('x1')] })
    press(at('x1'))
    expect(model.selection).toEqual({ genomes: ['X1'], contigs: [] })
    press(at('x1'))
    expect(model.selection).toEqual({ genomes: [], contigs: [index('x1')] })
    // ⌘ toggles one more in, and out again.
    press(at('x2'), { metaKey: true })
    expect(model.selection.contigs).toEqual(contigs('x1', 'x2'))
    press(at('x2'), { metaKey: true })
    expect(model.selection.contigs).toEqual(contigs('x1'))
    // The pool's contig has no genome to go on to.
    press(at('u0'))
    press(at('u0'))
    expect(model.selection).toEqual({ genomes: [], contigs: [index('u0')] })
    const { clientX, clientY } = at('p0')
    press({ clientX, clientY: clientY + 60 })
    expect(model.selection).toEqual({ genomes: [], contigs: [] })
  })

  it('lassoes the contigs it holds; ⇧ adds, ⌥ takes away, a selected genome given up for its contigs', async () => {
    const { model, said } = await mount()
    lasso(['y0', 'y4', 'y5'])
    expect(model.selection).toEqual({ genomes: [], contigs: contigs('y5', 'y0', 'y1', 'y2', 'y3', 'y4') })
    expect(said.at(-1)).toBe('selected 6 contigs · 300.0 kb · 5 in Y, 1 in X1')
    lasso(['p0', 'p1'], { shiftKey: true })
    expect(model.selection.contigs).toEqual(contigs('y5', 'y0', 'y1', 'y2', 'y3', 'y4', 'p0', 'p1'))
    lasso(['y5'], { altKey: true })
    expect(model.selection.contigs).toEqual(contigs('y0', 'y1', 'y2', 'y3', 'y4', 'p0', 'p1'))
    // X1 selected whole, then its stray contig taken away: X1's own three.
    model.selectGenomes(['X1'])
    lasso(['y5'], { altKey: true })
    expect(model.selection).toEqual({ genomes: [], contigs: contigs('x0', 'x1', 'x2') })
  })

  it('lets go of a lasso on Escape, selecting nothing', async () => {
    const { model, pane } = await mount()
    const start = at('y0')
    pointer('pointerdown', { clientX: start.clientX - 12, clientY: start.clientY - 12 })
    pointer('pointermove', { clientX: start.clientX + 40, clientY: start.clientY - 12 })
    pointer('pointermove', { clientX: start.clientX + 40, clientY: start.clientY + 20 })
    expect(pane.key(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    pointer('pointerup', { clientX: start.clientX - 12, clientY: start.clientY + 20 })
    expect(model.selection).toEqual({ genomes: [], contigs: [] })
    expect(pane.key(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
  })

  it('fades every other dot while genomes are selected, and rings the selected contigs over them', async () => {
    const { model } = await mount()
    expect([dots().dataset.full, dots().dataset.faded, dots().dataset.ringed]).toEqual(['19', '0', '0'])
    model.selectGenomes(['Y'])
    await frame()
    expect([dots().dataset.full, dots().dataset.faded, dots().dataset.ringed]).toEqual(['5', '14', '0'])
    model.selectContigs([index('y5'), index('u0')])
    await frame()
    expect([dots().dataset.full, dots().dataset.faded, dots().dataset.ringed]).toEqual(['0', '19', '2'])
    model.clearSelection()
    await frame()
    expect([dots().dataset.full, dots().dataset.faded, dots().dataset.ringed]).toEqual(['19', '0', '0'])
  })

  it('carries the selected contigs when a drag starts on one, and lassoes when it starts on another', async () => {
    const { ctx, model, pane } = await mount()
    // From a dot not selected: a lasso, which replaces the selection.
    model.selectContigs([index('y5'), index('u0')])
    await frame()
    const other = at('y0')
    pointer('pointerdown', other)
    pointer('pointermove', { clientX: other.clientX + 40, clientY: other.clientY - 20 })
    pointer('pointermove', { clientX: other.clientX + 40, clientY: other.clientY + 20 })
    expect(ctx.dragging).toBeNull()
    pointer('pointerup', { clientX: other.clientX - 2, clientY: other.clientY + 20 })
    expect(model.selection.contigs).toEqual(contigs('y0', 'y1', 'y2'))
    // From a selected one: the selection, carried.
    model.selectContigs([index('y5'), index('u0')])
    await frame()
    const from = at('y5')
    pointer('pointerdown', from)
    pointer('pointermove', { clientX: from.clientX + 30, clientY: from.clientY + 10 })
    expect(ctx.dragging).toEqual({ kind: 'contigs', contigs: contigs('y5', 'u0') })
    expect(ctx.dropWords({ kind: 'genome', id: 'Y' })?.refused).toBe(false)
    // Nothing drops on the scatter itself: clouds overlap.
    const asPane: CuratePane = pane
    expect(asPane.dropTargetAt(from.clientX, from.clientY)).toBeNull()
  })

  it('lights the genome under the pointer in any pane, and rings what is offered into a selected genome', async () => {
    const { model } = await mount()
    model.hover('Y')
    await frame()
    expect(marks().dataset.lit).toBe('5')
    model.hover(null)
    await frame()
    expect(marks().dataset.lit).toBe('0')
    // X1 selected: u0, which a recruit would bring into it, ringed.
    model.selectGenomes(['X1'])
    await frame()
    expect(marks().dataset.candidates).toBe('1')
  })

  it('rings the question shown: its contigs, its number as the review counts it', async () => {
    const { model, pane } = await mount()
    const move = model.offered().find((s) => s.key === 'move:y5>Y')
    expect(move).toBeDefined()
    pane.showSuggestion(move ?? null)
    await frame()
    expect(marks().dataset.featured).toBe('1')
    expect(hand().dataset.current).toBe('move:y5>Y')
    pane.showSuggestion(null)
    await frame()
    expect(marks().dataset.featured).toBe('0')
    // In review, the current question by itself.
    model.setMode('review')
    model.moveCurrent(1)
    await frame()
    expect(model.current?.key).toBe('move:y5>Y')
    expect(marks().dataset.featured).toBe('1')
  })

  it('zooms with the wheel at the pointer, and fits again with 0', async () => {
    const { pane } = await mount()
    const before = numbers(hand().dataset.domain)
    const under = at('y2')
    hand().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300, ...under }))
    await frame()
    expect(pane.element.dataset.zoom).toBe('zoomed')
    const after = numbers(hand().dataset.domain)
    expect(after[1] - after[0]).toBeLessThan(before[1] - before[0])
    expect(after[3] - after[2]).toBeLessThan(before[3] - before[2])
    // The dot under the pointer stays under it; the clouds far from it leave the view.
    expect(at('y2').clientX).toBeCloseTo(under.clientX, 1)
    expect(at('y2').clientY).toBeCloseTo(under.clientY, 1)
    expect(Number(hand().dataset.dots)).toBeLessThan(NAMES.length)
    expect(pane.key(new KeyboardEvent('keydown', { key: '0' }))).toBe(true)
    await frame()
    expect(pane.element.dataset.zoom).toBe('fit')
    expect(numbers(hand().dataset.domain)).toEqual(before)
  })

  it('draws GC alone in a band until the contacts are read, and says so', async () => {
    const { ctx, pane } = await mount({ coverage: false })
    expect(pane.view).toBe('gc')
    expect(pane.element.dataset.ready).toBe('false')
    expect(hand().dataset.dots).toBe(String(NAMES.length))
    expect(document.querySelector('.curate-scatter-note')?.textContent).toBe('GC alone for now: the height, Hi-C contacts per kb, comes once every contact between contigs is read.')
    ctx.data.coverage = Float64Array.from(NAMES, (name) => COVERAGE[name])
    pane.update('state')
    await frame()
    expect(pane.view).toBe('gc-coverage')
    expect(document.querySelector('.curate-scatter-note')?.classList.contains('hidden')).toBe(true)
  })

  it('says a map without GC stores none, and draws no dot', async () => {
    const { pane } = await mount({ gc: false })
    expect(pane.view).toBe('no-gc')
    expect(hand().dataset.dots).toBe('0')
    // Nothing to lasso, size or zoom: the head keeps none of it.
    expect(pane.element.classList.contains('is-empty')).toBe(true)
    expect(document.querySelector('.curate-scatter-counts')?.textContent).toBe('')
    expect(document.querySelector('.curate-scatter-note')?.textContent).toBe('This map stores no GC content for its contigs.')
  })

  it('as a thumbnail, draws the dots and the selection, without its head or the hand', async () => {
    const { model, pane } = await mount()
    model.selectGenomes(['Y'])
    pane.setLarge(false)
    await frame()
    expect(pane.element.classList.contains('is-small')).toBe(true)
    expect(dots().dataset.full).toBe('5')
    press(at('x1'))
    expect(model.selection).toEqual({ genomes: ['Y'], contigs: [] })
    expect(pane.key(new KeyboardEvent('keydown', { key: '0' }))).toBe(false)
  })

  it('draws the binning as a preview would leave it', async () => {
    const { model, said } = await mount()
    model.preview({ op: 'merge', into: 'X1', genomes: ['X2'] }, true)
    await model.settled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await frame()
    expect(model.previewing).toBe(true)
    pointer('pointermove', at('x4'))
    expect(said.at(-1)).toContain(' · in X1 · ')
    model.preview(null)
    await frame()
    pointer('pointermove', at('x5'))
    expect(said.at(-1)).toContain(' · in X2 · ')
  })
})
