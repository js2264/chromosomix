// @vitest-environment jsdom
/**
 * The **Genome minimap**, a card in the General column.
 *
 * The same strip the browser's bar draws, with the one thing that bar
 * deliberately refuses: a mark saying where the reader is. So most of what is
 * worth asserting here is about that mark — that it lands where the location
 * says, that it survives being a fifth of a pixel wide, and that a contact map's
 * two ranges become one highlight on the diagonal and two off it, which is the
 * whole argument for one strip serving both modes.
 *
 * Everything is read through the card's public getters rather than off a canvas,
 * for the reason `sequence-bar.test.ts` gives: jsdom has no 2D context, so a
 * card whose bands and spans only existed inside a paint would have none — and
 * neither would a real browser on its first frame. The getters are the state the
 * paint is driven from.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assemblyOf } from '@/genome/assembly'
import { MinimapCard, suitsMinimap, type MinimapWhere } from '@/ui/MinimapCard'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** Four sequences, 1,000 bp each — so a pixel is a round number of bases. */
const GENOME = assemblyOf({
  uri: 'test.cool',
  name: 'test',
  origin: 'cooler',
  contigs: [
    { name: 'I', length: 1000 },
    { name: 'II', length: 1000 },
    { name: 'III', length: 1000 },
    { name: 'IV', length: 1000 },
  ],
})

/** The strip is 400 px wide, so each sequence is 100 px and a pixel is 10 bp. */
const WIDTH = 400

interface Opened {
  card: MinimapCard
  /** Every whole sequence it was asked to open, in order. */
  contigs: string[]
  /** Every window, as the string the router will read. */
  regions: string[]
}

function open(where: MinimapWhere = null, assembly = GENOME): Opened {
  const out: Opened = { card: null as unknown as MinimapCard, contigs: [], regions: [] }
  out.card = new MinimapCard({
    assembly,
    where,
    onOpenContig: (name) => out.contigs.push(name),
    onOpenRegion: (region) => out.regions.push(region),
  })
  document.body.appendChild(out.card.el)
  // jsdom lays nothing out, so the width the strip is drawn and measured at is
  // stated here — which is what a `ResizeObserver` would have reported.
  const stage = out.card.el.querySelector('.minimap-stage') as HTMLElement
  Object.defineProperty(stage, 'clientWidth', { value: WIDTH, configurable: true })
  out.card.remeasure()
  return out
}

/** A press, a move and a release across the strip, in strip pixels. */
function drag(card: MinimapCard, from: number, to: number): void {
  const canvas = card.el.querySelector('.minimap-canvas') as HTMLElement
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: from, bubbles: true }))
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: to }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: to }))
}

const whereOf = (card: MinimapCard): string =>
  (card.el.querySelector('.minimap-where')?.textContent ?? '').trim()

describe('the strip', () => {
  it('is one band per sequence, in the assembly’s own order', () => {
    const view = open()
    expect(view.card.bands.map((band) => band.contig)).toEqual(['I', 'II', 'III', 'IV'])
    view.card.destroy()
  })

  it('lays them end to end across the card, one unit per base pair', () => {
    const view = open()
    expect(view.card.bands.map((band) => [band.from, band.to])).toEqual([
      [0, 100],
      [100, 200],
      [200, 300],
      [300, 400],
    ])
    view.card.destroy()
  })

  it('says what the assembly is and what the two gestures do', () => {
    const view = open()
    const note = view.card.el.querySelector('.minimap-note')?.textContent ?? ''
    expect(note).toContain('4 sequences')
    expect(note).toContain('4.0 kb')
    expect(note).toMatch(/click/i)
    expect(note).toMatch(/drag/i)
    view.card.destroy()
  })

  /**
   * Collapsible and open when the reader arrives. A `<details>`, because that is
   * the disclosure idiom already inside cards here (`.ann-url`, `.meta`) and
   * there is no per-card collapse mechanism to follow instead.
   */
  it('is a card that is expanded until the reader closes it', () => {
    const view = open()
    expect(view.card.el.classList.contains('card')).toBe(true)
    const body = view.card.el.querySelector('details') as HTMLDetailsElement
    expect(body).not.toBeNull()
    expect(view.card.open).toBe(true)
    expect(body.querySelector('summary')?.textContent).toContain('Genome minimap')

    body.open = false
    expect(view.card.open).toBe(false)
    view.card.destroy()
  })
})

/**
 * Where you are, in 1D: one highlight, the window projected onto the strip.
 *
 * The card takes **0-based half-open** coordinates in both modes, which is the
 * trap this feature is built around: the 1D browser's own `locus` is 1-based
 * inclusive and the conversion is the caller's one line, stated once, rather
 * than a guess made per widget.
 */
describe('a 1D window', () => {
  it('projects onto the strip where the sequence is', () => {
    const view = open({ kind: 'window', range: { contig: 'II', start: 200, end: 600 } })
    expect(view.card.spans).toEqual([
      { role: 'window', contig: 'II', start: 200, end: 600, from: 120, to: 160 },
    ])
    view.card.destroy()
  })

  it('moves when the view does, through update', () => {
    const view = open({ kind: 'window', range: { contig: 'I', start: 0, end: 1000 } })
    expect(view.card.spans[0].from).toBe(0)
    view.card.update({ kind: 'window', range: { contig: 'IV', start: 0, end: 1000 } })
    expect(view.card.spans).toEqual([
      { role: 'window', contig: 'IV', start: 0, end: 1000, from: 300, to: 400 },
    ])
    view.card.destroy()
  })

  /**
   * The whole reason a minimum width exists. 400 px over 4,000 bp is 10 bp a
   * pixel, so one base is a tenth of a pixel: drawn honestly it is nothing at
   * all, and the card would stop answering its only question at exactly the zoom
   * where the reader most needs it answered.
   */
  it('is still drawn when it is a sliver of the genome', () => {
    const view = open({ kind: 'window', range: { contig: 'III', start: 500, end: 501 } })
    const [mark] = view.card.spans
    expect(mark.to - mark.from).toBeGreaterThanOrEqual(2)
    // …and still over the place it names: 500-501 bp is 250.0-250.1 px in, so
    // the widened mark is grown about that middle rather than snapped anywhere.
    expect((mark.from + mark.to) / 2).toBeCloseTo(250.05, 5)
    // The base pairs it reports are the real ones, not the widened ones.
    expect([mark.start, mark.end]).toEqual([500, 501])
    view.card.destroy()
  })

  it('keeps a sliver at either end inside the strip', () => {
    const first = open({ kind: 'window', range: { contig: 'I', start: 0, end: 1 } })
    expect(first.card.spans[0].from).toBe(0)
    expect(first.card.spans[0].to).toBe(2)
    first.card.destroy()

    const last = open({ kind: 'window', range: { contig: 'IV', start: 999, end: 1000 } })
    expect(last.card.spans[0].to).toBe(WIDTH)
    expect(last.card.spans[0].from).toBe(WIDTH - 2)
    last.card.destroy()
  })

  it('reads out where it is, in the coordinates it will emit', () => {
    const view = open({ kind: 'window', range: { contig: 'II', start: 200, end: 600 } })
    expect(whereOf(view.card)).toBe('II:200–600')
    view.card.destroy()
  })
})

/**
 * Where you are, in 2D: a map has two ranges, and one strip carries both.
 *
 * On the diagonal they are the same window and there is one mark — which is also
 * exactly the picture a 1D viewport draws, because a 1D viewport *is* the
 * diagonal. Off it they are two places on one genome, and drawing two is the
 * honest answer rather than a shortcoming of the layout.
 */
describe('a 2D block', () => {
  it('is one highlight on the diagonal, and it is the window case', () => {
    const view = open({
      kind: 'block',
      rows: { contig: 'II', start: 0, end: 1000 },
      columns: { contig: 'II', start: 0, end: 1000 },
    })
    expect(view.card.spans).toEqual([
      { role: 'window', contig: 'II', start: 0, end: 1000, from: 100, to: 200 },
    ])
    expect(whereOf(view.card)).toContain('on the diagonal')
    view.card.destroy()
  })

  it('is two highlights off it, one per axis', () => {
    const view = open({
      kind: 'block',
      rows: { contig: 'II', start: 0, end: 1000 },
      columns: { contig: 'IV', start: 0, end: 1000 },
    })
    expect(view.card.spans).toEqual([
      { role: 'rows', contig: 'II', start: 0, end: 1000, from: 100, to: 200 },
      { role: 'columns', contig: 'IV', start: 0, end: 1000, from: 300, to: 400 },
    ])
    view.card.destroy()
  })

  /** Two marks must not read as one confusing one: the readout names each axis. */
  it('says which highlight is which', () => {
    const view = open({
      kind: 'block',
      rows: { contig: 'II', start: 0, end: 1000 },
      columns: { contig: 'IV', start: 0, end: 1000 },
    })
    expect(whereOf(view.card)).toBe('rows II:0–1,000 · columns IV:0–1,000')
    view.card.destroy()
  })

  /**
   * The same block on the same genome is the same picture in both modes — which
   * is the request, restated as an assertion: only what is highlighted differs.
   */
  it('draws what the 1D browser draws for the same place', () => {
    const oneD = open({ kind: 'window', range: { contig: 'III', start: 100, end: 900 } })
    const twoD = open({
      kind: 'block',
      rows: { contig: 'III', start: 100, end: 900 },
      columns: { contig: 'III', start: 100, end: 900 },
    })
    expect(twoD.card.spans).toEqual(oneD.card.spans)
    expect(twoD.card.bands).toEqual(oneD.card.bands)
    oneD.card.destroy()
    twoD.card.destroy()
  })
})

/**
 * Nothing chosen. Nothing is highlighted, and the readout says so in words —
 * rather than a wash over the whole strip, which is indistinguishable from a
 * card with a tinted background, so "you are everywhere" and "the paint failed"
 * would look the same.
 */
describe('the whole genome', () => {
  it('highlights nothing and says which of the two that is', () => {
    const view = open(null)
    expect(view.card.spans).toEqual([])
    expect(whereOf(view.card)).toBe('the whole genome')
    view.card.destroy()
  })

  it('withholds a mark for a sequence the assembly does not have', () => {
    const view = open({ kind: 'window', range: { contig: 'chrZ', start: 0, end: 10 } })
    expect(view.card.spans).toEqual([])
    view.card.destroy()
  })
})

describe('moving from the strip', () => {
  it('opens the whole sequence a press lands on', () => {
    const view = open()
    drag(view.card, 250, 250)
    expect(view.contigs).toEqual(['III'])
    expect(view.regions).toEqual([])
    view.card.destroy()
  })

  // A hand that moves four pixels was aiming at a chromosome. Reading it as a
  // window would answer a click with a region nobody could see themselves make.
  it('reads a twitch as a click, not as a forty-base window', () => {
    const view = open()
    drag(view.card, 250, 254)
    expect(view.contigs).toEqual(['III'])
    expect(view.regions).toEqual([])
    view.card.destroy()
  })

  it('names a window inside the sequence a drag started in', () => {
    const view = open()
    drag(view.card, 120, 160)
    // 0-based, no thousands separators, a plain hyphen — the string
    // `metacooler/range.ts` reads and the one `SequenceBar` already emits.
    expect(view.regions).toEqual(['II:200-600'])
    expect(view.contigs).toEqual([])
    view.card.destroy()
  })

  it('reads a backwards drag as the same window', () => {
    const view = open()
    drag(view.card, 160, 120)
    expect(view.regions).toEqual(['II:200-600'])
    view.card.destroy()
  })

  /**
   * A drag across a sequence boundary. A region names **one** contig — that is
   * what the reader, `parseMetacoolerRange` and the crumb all mean by one — so
   * the part that crossed is refused and the window is clamped to the sequence
   * the press landed in, exactly as `SequenceBar.dragged` does. Deciding it at
   * the press is what makes it predictable: it is where the reader was looking.
   */
  it('refuses to let a drag cross into the next sequence', () => {
    const view = open()
    drag(view.card, 250, 350)
    expect(view.regions).toEqual(['III:500-1000'])
    expect(view.regions[0]).not.toContain('IV')
    view.card.destroy()
  })

  it('shows what a drag would open while it is being made', () => {
    const view = open({ kind: 'window', range: { contig: 'I', start: 0, end: 1000 } })
    const canvas = view.card.el.querySelector('.minimap-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 120, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    expect(view.card.selection).toEqual({ contig: 'II', start: 200, end: 600 })
    // The readout follows the gesture rather than the stale location behind it.
    expect(whereOf(view.card)).toContain('II:200–600')
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }))
    expect(view.card.selection).toBeNull()
    view.card.destroy()
  })

  /** The same clamp the release applies, so the picture cannot contradict it. */
  it('clamps what it shows to the sequence the press landed in', () => {
    const view = open()
    const canvas = view.card.el.querySelector('.minimap-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 250, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 350 }))
    expect(view.card.selection).toEqual({ contig: 'III', start: 500, end: 1000 })
    view.card.destroy()
  })
})

/**
 * Escape, which is the way out of a drag begun in the wrong place. Read **on the
 * window and capturing**: a canvas takes no focus, so a listener on it gets the
 * key only if the reader happened to have clicked there last.
 */
describe('escaping a drag', () => {
  it('drops the mark and opens nothing', () => {
    const view = open()
    const canvas = view.card.el.querySelector('.minimap-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 120, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    expect(view.card.selection).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(view.card.selection).toBeNull()

    // …and the release of the same button must not finish the abandoned drag.
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }))
    expect(view.regions).toEqual([])
    expect(view.contigs).toEqual([])
    view.card.destroy()
  })
})

/**
 * The two ends of an assembly, both of which reach this card in real sessions: a
 * bigWig of one scaffold, and a file whose lengths have not arrived yet.
 */
describe('an assembly at its limits', () => {
  it('draws one band across the whole strip for a single sequence', () => {
    const one = assemblyOf({
      uri: 'one.sizes',
      name: 'one',
      origin: 'sizes',
      contigs: [{ name: 'scaffold_1', length: 5000 }],
    })
    const view = open({ kind: 'window', range: { contig: 'scaffold_1', start: 0, end: 2500 } }, one)
    expect(view.card.bands).toEqual([{ contig: 'scaffold_1', from: 0, to: WIDTH }])
    expect(view.card.spans[0]).toMatchObject({ from: 0, to: 200 })
    drag(view.card, 100, 200)
    expect(view.regions).toEqual(['scaffold_1:1250-2500'])
    view.card.destroy()
  })

  it('survives an assembly with no sequences at all', () => {
    const none = assemblyOf({ uri: 'empty', name: 'empty', origin: 'features', contigs: [] })
    const view = open(null, none)
    expect(view.card.bands).toEqual([])
    expect(view.card.spans).toEqual([])
    expect(whereOf(view.card)).toBe('the whole genome')
    // Every gesture is a no-op rather than a throw: there is nothing to aim at.
    expect(() => drag(view.card, 10, 200)).not.toThrow()
    expect(view.regions).toEqual([])
    expect(view.contigs).toEqual([])
    view.card.destroy()
  })
})

/**
 * Nothing in the app tears a General-column card down — `setGeneral` just
 * `replaceChildren`s — so this card is built to be abandoned *and* to be torn
 * down, and neither may be a mistake.
 */
describe('the card’s life', () => {
  it('can be destroyed twice', () => {
    const view = open()
    view.card.destroy()
    expect(() => view.card.destroy()).not.toThrow()
  })

  it('is inert once destroyed, mid-gesture or not', () => {
    const view = open()
    const canvas = view.card.el.querySelector('.minimap-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 120, bubbles: true }))
    view.card.destroy()
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }))
    expect(view.regions).toEqual([])
    expect(() => view.card.update(null)).not.toThrow()
  })
})

/**
 * The gate, stated once so the two mount points cannot drift: the same rule that
 * withholds the browser's bar and the Sequences card on a metagenome, where a
 * hundred thousand contigs are a texture rather than a strip a hand can aim at.
 */
describe('who gets a minimap', () => {
  it('is a cooler, and not a metagenome', () => {
    expect(suitsMinimap({ hasGenomes: false })).toBe(true)
    expect(suitsMinimap({ hasGenomes: true })).toBe(false)
  })
})
