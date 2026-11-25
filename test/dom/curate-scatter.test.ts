// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's GC × coverage scatter (SPECS §33.3), in a DOM: every
 * contig placed by its GC and its coverage, the ones without contacts in the
 * strip at the foot; the readout of a dot and of the plot under the pointer; a
 * press selecting a dot's contig, then its genome; a lasso selecting what it
 * holds, adding with ⇧ and taking away with ⌥; the rest faded while a genome is
 * selected; the selection carried; the genome lit in every pane; the question
 * shown and its number; the wheel, Space held, `0`, Escape; the first count
 * awaited, GC alone before the coverage, a map without GC, the head short of
 * room, the thumbnail, and the binning as a preview would leave it; and the
 * frame — the strays at each end of each axis left out of it and pinned to its
 * edge, a small map's every contig kept — and the coverage axis spelt in one
 * notation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { coverageTickTexts, FRAME_TAIL, PIN_DOWN, PIN_LEFT, PIN_RIGHT, PIN_UP, pinToFrame, pinVector, scatterFrame } from '@/curate/scatter'
import { ScatterPane } from '@/curate/ui/ScatterPane'
import type { CuratePane } from '@/curate/ui/context'
import { optionKey, shiftKey } from '@/ui/commands'
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

/** The pane over the community in a 600 × 400 plot, its first count in and drawn; `coverageOf` sets some contigs' coverage. */
async function mount(options: { gc?: boolean; coverage?: boolean; coverageOf?: Record<string, number> } = {}): Promise<Mounted> {
  const stage = testContext()
  const coverage = { ...COVERAGE, ...options.coverageOf }
  stage.ctx.data.gc = options.gc === false ? null : Float64Array.from(NAMES, (name) => GC[name])
  stage.ctx.data.coverage = options.coverage === false ? null : Float64Array.from(NAMES, (name) => coverage[name])
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

/** A point of the strip at the foot, at a GC: where the contigs without a contact are drawn. */
function inStrip(gc: number): { clientX: number; clientY: number } {
  const [x, , w] = numbers(hand().dataset.plot)
  const [gc0, gc1] = numbers(hand().dataset.domain)
  const [y, h] = numbers(hand().dataset.strip)
  return { clientX: x + ((gc - gc0) / (gc1 - gc0)) * w, clientY: y + h / 2 }
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
    expect(document.querySelector('.curate-scatter-counts')?.getAttribute('title')).toBe('Of the map’s contigs, 1 without contacts, drawn in the strip at the foot.')
    expect(pane.element.classList.contains('is-empty')).toBe(false)
    // A small map's frame holds every contig: none pinned to its edge.
    expect(dots().dataset.wedges).toBe('0')
    // Up is more coverage, across more GC.
    expect(at('p0').clientY).toBeLessThan(at('y0').clientY)
    expect(at('y0').clientY).toBeLessThan(at('x0').clientY)
    expect(at('x0').clientX).toBeLessThan(at('y0').clientX)
  })

  it('says the contig under the pointer — its genome, its affinities, what is offered — and lights it', async () => {
    const { model, said } = await mount()
    pointer('pointermove', at('u0'))
    expect(said.at(-1)).toBe('u0 · unbinned · 50.0 kb · GC 39.0% · 10 Hi-C contacts per kb · best X1, affinity 1.95 · recruit 98%')
    expect(model.hovered).toEqual({ genome: null, contig: index('u0') })
    pointer('pointermove', at('y5'))
    expect(said.at(-1)).toBe('y5 · in X1 · 50.0 kb · GC 57.5% · 40 Hi-C contacts per kb · own affinity 0 · best Y, affinity 1.25 · move 97%')
    expect(model.hovered).toEqual({ genome: 'X1', contig: index('y5') })
    // Between the clouds: where the pointer is, in the data.
    const { clientX, clientY } = at('p0')
    pointer('pointermove', { clientX, clientY: clientY + 60 })
    expect(said.at(-1)).toMatch(/^GC 44\.0% · \d+(\.\d)? Hi-C contacts per kb · drag to lasso$/)
    expect(model.hovered.contig).toBe(-1)
    // The strip at the foot, where no dot is: in the head's own words.
    pointer('pointermove', inStrip(44))
    expect(said.at(-1)).toBe('GC 44.0% · without contacts · drag to lasso')
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

  it('takes a lasso’s Escape whole: the dialog’s own Escape, which lets go of the selection, never hears it', async () => {
    const { model, pane } = await mount()
    model.selectGenomes(['Y'])
    // As the stage lays them: its keys on the window, then the dialog's Escape beside them.
    const dialog: string[] = []
    const stageKeys = (event: KeyboardEvent): void => {
      if (pane.key(event)) event.preventDefault()
    }
    const dialogKeys = (event: KeyboardEvent): void => {
      dialog.push(event.key)
    }
    window.addEventListener('keydown', stageKeys, true)
    window.addEventListener('keydown', dialogKeys, true)
    try {
      const start = at('x0')
      pointer('pointerdown', { clientX: start.clientX - 12, clientY: start.clientY - 12 })
      pointer('pointermove', { clientX: start.clientX + 40, clientY: start.clientY - 12 })
      pointer('pointermove', { clientX: start.clientX + 40, clientY: start.clientY + 20 })
      hand().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(dialog).toEqual([])
      pointer('pointerup', { clientX: start.clientX - 12, clientY: start.clientY + 20 })
      expect(model.selection).toEqual({ genomes: ['Y'], contigs: [] })
      // With nothing in hand, Escape is the stage's.
      hand().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(dialog).toEqual(['Escape'])
    } finally {
      window.removeEventListener('keydown', stageKeys, true)
      window.removeEventListener('keydown', dialogKeys, true)
    }
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
    const { ctx, model, pane, said } = await mount()
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
    // The readout is the drop's from here, never the dot the drag left.
    expect(said.at(-1)).toBeNull()
    expect(model.hovered).toEqual({ genome: null, contig: -1 })
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
    // Its number is its place in the review's queue: after the merge of X's two halves.
    expect(model.queue()[0].kind).toBe('merge')
    expect(model.queue().findIndex((q) => q.key === 'move:y5>Y')).toBe(1)
    expect(marks().dataset.number).toBe('2')
    pane.showSuggestion(null)
    await frame()
    expect(marks().dataset.featured).toBe('0')
    expect(marks().dataset.number).toBe('')
    // In review, the current question by itself.
    model.setMode('review')
    model.moveCurrent(1)
    await frame()
    expect(model.current?.key).toBe('move:y5>Y')
    expect(marks().dataset.featured).toBe('1')
    expect(marks().dataset.number).toBe('2')
  })

  it('zooms with the wheel at the pointer, and fits again with 0', async () => {
    const { pane, said } = await mount()
    const before = numbers(hand().dataset.domain)
    const under = at('y2')
    hand().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300, ...under }))
    await frame()
    expect(pane.element.dataset.zoom).toBe('zoomed')
    const after = numbers(hand().dataset.domain)
    expect(after[1] - after[0]).toBeLessThan(before[1] - before[0])
    expect(after[3] - after[2]).toBeLessThan(before[3] - before[2])
    // What is under the still pointer, said as the view moves under it.
    expect(said.at(-1)).toMatch(/^y2 · in Y · 50\.0 kb · GC 53\.0% · /)
    // The dot under the pointer stays under it; the clouds far from it leave the view.
    expect(at('y2').clientX).toBeCloseTo(under.clientX, 1)
    expect(at('y2').clientY).toBeCloseTo(under.clientY, 1)
    expect(Number(hand().dataset.dots)).toBeLessThan(NAMES.length)
    expect(pane.key(new KeyboardEvent('keydown', { key: '0' }))).toBe(true)
    await frame()
    expect(pane.element.dataset.zoom).toBe('fit')
    expect(numbers(hand().dataset.domain)).toEqual(before)
  })

  it('pans with Space held, and leaves a focused button its Space', async () => {
    const { model, pane } = await mount()
    pane.key(new KeyboardEvent('keydown', { key: '+' }))
    pane.key(new KeyboardEvent('keydown', { key: '+' }))
    await frame()
    const zoomed = numbers(hand().dataset.domain)
    const from = at('y2')
    pointer('pointermove', from)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect(hand().dataset.cursor).toBe('grab')
    pointer('pointerdown', from)
    pointer('pointermove', { clientX: from.clientX + 60, clientY: from.clientY })
    pointer('pointerup', { clientX: from.clientX + 60, clientY: from.clientY })
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
    await frame()
    // The dots dragged right: the view's GC lower, and nothing selected on the way.
    const panned = numbers(hand().dataset.domain)
    expect(panned[0]).toBeLessThan(zoomed[0])
    expect(panned[1] - panned[0]).toBeCloseTo(zoomed[1] - zoomed[0], 6)
    expect(model.selection).toEqual({ genomes: [], contigs: [] })
    // Space on a focused button presses it: the next drag is no pan.
    const button = pane.element.querySelector('.curate-scatter-tools button') as HTMLElement
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(hand().dataset.cursor).not.toBe('grab')
    const still = at('y2')
    pointer('pointerdown', { clientX: still.clientX + 30, clientY: still.clientY - 30 })
    pointer('pointermove', { clientX: still.clientX + 90, clientY: still.clientY - 30 })
    pointer('pointerup', { clientX: still.clientX + 90, clientY: still.clientY - 30 })
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
    await frame()
    expect(numbers(hand().dataset.domain)).toEqual(panned)
  })

  it('waits for the first count, saying so, and is drawn once it lands', async () => {
    const stage = testContext()
    stage.ctx.data.gc = Float64Array.from(NAMES, (name) => GC[name])
    stage.ctx.data.coverage = Float64Array.from(NAMES, (name) => COVERAGE[name])
    const pane = new ScatterPane(stage.ctx)
    panes.push(pane)
    stage.model.subscribe((change) => pane.update(change))
    document.body.appendChild(pane.element)
    expect(pane.view).toBe('waiting')
    expect(pane.element.dataset.view).toBe('waiting')
    expect(pane.element.dataset.ready).toBe('false')
    expect(document.querySelector('.curate-scatter-note')?.textContent).toBe('weighing the binning…')
    await stage.model.settled()
    await frame()
    expect(pane.view).toBe('gc-coverage')
    expect(pane.element.dataset.ready).toBe('true')
    expect(document.querySelector('.curate-scatter-note')?.classList.contains('hidden')).toBe(true)
  })

  it('gives way piece by piece when its head is short of room — the sizes, the strip’s count, the hint’s words, the hint — and cuts no word', async () => {
    const { pane } = await mount()
    const head = pane.element.querySelector('.curate-scatter-head') as HTMLElement
    const piece = (name: string): HTMLElement => pane.element.querySelector(`.curate-scatter-${name}`) as HTMLElement
    // Each piece's width at the stage's text (the hint's with its `drag to `), laid out with the head's padding and gaps.
    const width: Record<string, number> = { counts: 122, bare: 198, hint: 341, verb: 52, legend: 254, tools: 115 }
    const shown = (name: string): boolean => !piece(name).classList.contains('hidden')
    const hint = (): number => (shown('hint') ? 12 + width.hint - (shown('hint-verb') ? 0 : width.verb) : 0)
    const content = (): number => 19 + width.counts + (shown('bare') ? width.bare : 0) + hint() + (shown('legend') ? 12 + width.legend : 0) + 12 + width.tools
    let room = 1200
    Object.defineProperty(head, 'clientWidth', { configurable: true, get: () => room })
    Object.defineProperty(head, 'scrollWidth', { configurable: true, get: () => Math.max(room, content()) })
    const gone = (): string[] => ['legend', 'bare', 'hint-verb', 'hint'].filter((name) => !shown(name))
    const widths: Array<[number, string[]]> = [
      [1200, []],
      [1000, ['legend']],
      [700, ['legend', 'bare']],
      [600, ['legend', 'bare', 'hint-verb']],
      [500, ['legend', 'bare', 'hint-verb', 'hint']],
      [1100, []],
    ]
    for (const [wide, expected] of widths) {
      room = wide
      pane.resize()
      await frame()
      expect(gone()).toEqual(expected)
    }
    // What is left of the hint is `lasso`, and its keys.
    room = 600
    pane.resize()
    await frame()
    const shownText = (node: Node): string =>
      node instanceof Element ? (node.classList.contains('hidden') ? '' : [...node.childNodes].map(shownText).join('')) : (node.textContent ?? '')
    const left = [...piece('hint').children].map((node) => `${node.tagName === 'KBD' ? 'key' : 'word'}:${shownText(node)}`)
    expect(left).toEqual(['word:lasso', `key:${shiftKey()}`, 'word:adds', `key:${optionKey()}`, 'word:takes away'])
  })

  it('labels the coverage axis in one notation: ten thousand as 10,000 over 1,000, never 1e4', async () => {
    const { pane } = await mount()
    // The decades and their halves, where the decades are fewer than three.
    expect(dots().dataset.coverageTicks).toBe('10 50 100')
    pane.dispose()
    document.body.replaceChildren()
    // The element's contigs at 12,000 contacts per kb: the axis reaches past ten thousand.
    await mount({ coverageOf: { p0: 12_000, p1: 12_000 } })
    expect(dots().dataset.coverageTicks).toBe('10 100 1,000 10,000')
    expect(dots().dataset.wedges).toBe('0')
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
    pointer('pointermove', at('x1'))
    expect(model.hovered.genome).toBe('X1')
    pane.setLarge(false)
    // Under no pointer now: X1 no longer lit from here.
    expect(model.hovered).toEqual({ genome: null, contig: -1 })
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

describe('the frame', () => {
  /** `n` values evenly from `lo` to `hi`. */
  const even = (n: number, lo: number, hi: number): number[] => Array.from({ length: n }, (_, k) => lo + ((hi - lo) * k) / (n - 1))

  it('leaves out of the frame the half percent at each end of each axis, and pins what it leaves out to its edge', () => {
    // 1,000 contigs at GC 30–70 % and 10–100 contacts per kb; two strays at a few percent GC, one at 95 %, one at 100,000 contacts per kb, one at a hundredth.
    const gc = [...even(1000, 30, 70), 3, 2, 95, 50, 50]
    const coverage = [...even(1000, 1, 2).map((log) => 10 ** log), 20, 20, 20, 1e5, 0.01]
    const all = gc.map((_, c) => c)
    // Every contig set the frame: the clouds a part of it.
    const whole = scatterFrame(gc, coverage, all)
    expect([whole.gc0 < 2, whole.gc1 > 95, whole.log0 < -2, whole.log1 > 5]).toEqual([true, true, true, true])
    // The strays left out: the clouds, padded.
    expect(FRAME_TAIL).toBe(0.005)
    const frame = scatterFrame(gc, coverage, all, FRAME_TAIL)
    expect(frame.gc0).toBeGreaterThan(28)
    expect(frame.gc0).toBeLessThan(30)
    expect(frame.gc1).toBeGreaterThan(70)
    expect(frame.gc1).toBeLessThan(72)
    expect(10 ** frame.log0).toBeGreaterThan(9)
    expect(10 ** frame.log0).toBeLessThan(10)
    expect(10 ** frame.log1).toBeGreaterThan(100)
    expect(10 ** frame.log1).toBeLessThan(110)
    // Each stray held at the edge it lies past, the rest where they are.
    const pinned = pinToFrame(frame, gc, coverage, all)
    expect(pinned.count).toBe(5)
    expect([...pinned.pin.slice(1000)]).toEqual([PIN_LEFT, PIN_LEFT, PIN_RIGHT, PIN_UP, PIN_DOWN])
    expect([pinned.gc[1000], pinned.gc[1002], pinned.coverage[1000]]).toEqual([frame.gc0, frame.gc1, 20])
    expect(Math.log10(pinned.coverage[1003])).toBeCloseTo(frame.log1, 9)
    expect(Math.log10(pinned.coverage[1004])).toBeCloseTo(frame.log0, 9)
    expect([pinned.pin[0], pinned.pin[999], pinned.gc[500], pinned.coverage[500]]).toEqual([0, 0, gc[500], coverage[500]])
    // Past two edges at once, a corner; without coverage, on GC alone — the strip at the foot holds it.
    const corner = pinToFrame(frame, [3, 3], [1e5, 0], [0, 1])
    expect([...corner.pin]).toEqual([PIN_LEFT | PIN_UP, PIN_LEFT])
    expect(corner.coverage[1]).toBe(0)
  })

  it('keeps every contig of a small map: under 201, half a percent is none', () => {
    const gc = [...even(150, 30, 70), 3]
    const coverage = [...even(150, 1, 2).map((log) => 10 ** log), 1e5]
    const all = gc.map((_, c) => c)
    const frame = scatterFrame(gc, coverage, all, FRAME_TAIL)
    expect(frame.gc0).toBeLessThan(3)
    expect(frame.log1).toBeGreaterThan(5)
    expect(pinToFrame(frame, gc, coverage, all).count).toBe(0)
  })

  it('points a pinned contig’s wedge out past the edges it lies beyond', () => {
    expect(pinVector(0)).toEqual([0, 0])
    expect(pinVector(PIN_LEFT)).toEqual([-1, 0])
    expect(pinVector(PIN_RIGHT)).toEqual([1, 0])
    // Up the plot is up the screen: y down.
    expect(pinVector(PIN_UP)).toEqual([0, -1])
    expect(pinVector(PIN_DOWN)).toEqual([0, 1])
    const [x, y] = pinVector(PIN_RIGHT | PIN_DOWN)
    expect([x, y].map((v) => Number(v.toFixed(6)))).toEqual([0.707107, 0.707107])
  })

  it('spells the coverage axis in one notation from its foot to its top', () => {
    expect(coverageTickTexts([1, 10, 100, 1000, 10000])).toEqual(['1', '10', '100', '1,000', '10,000'])
    expect(coverageTickTexts([0.5, 1, 5])).toEqual(['0.5', '1', '5'])
    // Where one tick needs an exponent, every one has it.
    expect(coverageTickTexts([1e-5, 1e-4, 1e-3])).toEqual(['1e-5', '1e-4', '1e-3'])
    expect(coverageTickTexts([1e-5, 1, 100])).toEqual(['1e-5', '1e0', '1e2'])
    expect(coverageTickTexts([2.5e-5, 1e-3])).toEqual(['2.5e-5', '1e-3'])
    expect(coverageTickTexts([1e7, 1e8])).toEqual(['1e7', '1e8'])
    expect(coverageTickTexts([])).toEqual([])
  })
})
