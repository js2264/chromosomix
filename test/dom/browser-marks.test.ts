// @vitest-environment jsdom
/**
 * The reader's own marks (§8.1), seen along one axis.
 *
 * A mark is a two-axis object — a line is a column or a row, an arrowhead is a
 * cell, a rectangle is rows by columns — and a genome browser has one axis. So
 * the question this file asks is the one the browser has to answer before it can
 * draw anything: *where on this axis is that mark, and how many places is it?*
 *
 * - a **line** is one rule at its coordinate, whichever of the three axis values
 *   it carries. Vertical, horizontal and both are three answers to a question
 *   this picture does not ask.
 * - a **rectangle** is its extent, washed over the tracks — and **two** extents
 *   when its sides differ, because an off-diagonal box really is two stretches
 *   of this axis and showing one of them would put the mark somewhere it is not.
 * - an **arrowhead** is a triangle at each end, and one triangle when both ends
 *   are the same place.
 *
 * jsdom refuses a 2D context, so what would be drawn is asked of the view rather
 * than scraped off a canvas — `BrowserView.manualMarks`, which is the plan its
 * own paint draws from, the same bargain `SequenceBar.hairlineAt` makes. The
 * numbers are axis units, so an assertion is about the resolution of a locus
 * rather than about a window size jsdom does not have.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
import { AnnotationStore } from '@/annotations/store'
import { GroupSettings } from '@/annotations/groups'
import { ManualStore, mintMarkId, type LineAxis } from '@/annotations/manual'
import { assemblyOf, type Assembly } from '@/genome/assembly'
import { SequenceSelection } from '@/genome/selection'
import { BrowserView } from '@/ui/BrowserView'
import { TRACK_OPTIONS, PLOT_OPTION_LABELS } from '@/ui/plotOptions'
import { setUpDom, all, silentContext, type DomTeardown } from '../support/dom'

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

/** Two sequences of a thousand bases, laid end to end: units 0–1000 and 1000–2000. */
const ASSEMBLY: Assembly = assemblyOf({
  uri: 'marks.bw',
  name: 'marks.bw',
  contigs: [
    { name: 'I', length: 1_000 },
    { name: 'II', length: 1_000 },
  ],
  origin: 'sizes',
})

interface Mounted {
  view: BrowserView
  manual: ManualStore
}

/**
 * A browser over {@link ASSEMBLY}, with a marks store of its own.
 *
 * No worker: the store is empty, so no lane ever asks for a sample and the
 * client's factory is never called. What is under test is arithmetic over an
 * axis, which is the same arithmetic with a track drawn on it or without one.
 */
function mount(): Mounted {
  const key = `marks-${Math.random()}.bw`
  const manual = new ManualStore(key)
  const view = new BrowserView({
    assembly: ASSEMBLY,
    store: new AnnotationStore(key, { persist: false }),
    client: new AnnotationClient(() => {
      throw new Error('this view reads no files')
    }),
    selection: new SequenceSelection(),
    groups: new GroupSettings(key),
    manual,
    onLocusChange: () => {},
  })
  built.push(view)
  document.body.appendChild(view.el)
  return { view, manual }
}

function line(manual: ManualStore, contig: string, bp: number, axis: LineAxis = 'both'): void {
  manual.add({ id: mintMarkId(), kind: 'line', axis, at: { contig, bp }, colour: '#c0392b' })
}

/**
 * One frame, into a context that accepts every call and draws nothing.
 *
 * What this asks is only "does the paint run": the marks it *would* put on the
 * page are asserted above, through the plan both this and the real canvas draw
 * from. A silent context rather than a `VectorPage`, because the question is
 * about a frame of the whole view — ruler, lanes, marks — and not about the
 * operators one of them emits.
 */
function paint(view: BrowserView): void {
  const ctx = silentContext(document.createElement('canvas'))
  ;(view as unknown as {
    paint(ctx: CanvasRenderingContext2D, width: number, height: number): void
  }).paint(ctx, 800, 400)
}

describe('lines', () => {
  it('draws one rule per line, whichever axis it names', () => {
    // The browser has one axis, so all three are the same rule on it. A line
    // picked on a track is `both`; the other two are what a map's own forms make.
    const { view, manual } = mount()
    line(manual, 'I', 400, 'vertical')
    line(manual, 'I', 500, 'horizontal')
    line(manual, 'I', 600, 'both')
    expect(view.manualMarks.map((mark) => [mark.kind, mark.from])).toEqual([
      ['line', 400],
      ['line', 500],
      ['line', 600],
    ])
  })

  it('puts a line on the second sequence past the first one', () => {
    // The axis is a concatenation, so the same base pair is two places depending
    // on which sequence it is on — which is the whole reason a mark is a locus.
    const { view, manual } = mount()
    line(manual, 'II', 250)
    expect(view.manualMarks[0]).toMatchObject({ kind: 'line', from: 1_250 })
  })

  it('keeps the mark’s own colour', () => {
    const { view, manual } = mount()
    manual.add({
      id: mintMarkId(),
      kind: 'line',
      axis: 'both',
      at: { contig: 'I', bp: 10 },
      colour: '#0f8a5f',
    })
    expect(view.manualMarks[0].colour).toBe('#0f8a5f')
  })
})

describe('rectangles', () => {
  it('washes one band over a box on the diagonal', () => {
    // What a drag on a track makes: the same stretch on both axes.
    const { view, manual } = mount()
    const span = { contig: 'I', from: 200, to: 400 }
    manual.add({ id: mintMarkId(), kind: 'rect', a: span, b: { ...span }, colour: '#1f5fa9' })
    expect(view.manualMarks).toEqual([
      { id: expect.any(String), kind: 'band', colour: '#1f5fa9', from: 200, to: 400 },
    ])
  })

  it('washes both bands over a box that is off it', () => {
    // Two stretches of this axis, and drawing one of them would be a picture
    // that says the mark is somewhere it is not.
    const { view, manual } = mount()
    manual.add({
      id: mintMarkId(),
      kind: 'rect',
      a: { contig: 'I', from: 100, to: 200 },
      b: { contig: 'II', from: 300, to: 500 },
      colour: '#111318',
    })
    expect(view.manualMarks.map((mark) => [mark.from, mark.to])).toEqual([
      [100, 200],
      [1_300, 1_500],
    ])
  })

  it('clips a band to the window rather than dropping it', () => {
    // A domain wider than the screen is the ordinary case: a box drawn only when
    // both of its ends are in view would vanish exactly when it is zoomed into.
    const { view, manual } = mount()
    manual.add({
      id: mintMarkId(),
      kind: 'rect',
      a: { contig: 'I', from: 0, to: 900 },
      b: { contig: 'I', from: 0, to: 900 },
      colour: '#111318',
    })
    view.showLocus('I:401-600')
    expect(view.manualMarks).toEqual([
      { id: expect.any(String), kind: 'band', colour: '#111318', from: 400, to: 600 },
    ])
  })
})

describe('arrowheads', () => {
  it('anchors both ends of a loop', () => {
    const { view, manual } = mount()
    manual.add({
      id: mintMarkId(),
      kind: 'arrowhead',
      a: { contig: 'I', bp: 100 },
      b: { contig: 'II', bp: 100 },
      colour: '#c0392b',
    })
    expect(view.manualMarks.map((mark) => [mark.kind, mark.from])).toEqual([
      ['anchor', 100],
      ['anchor', 1_100],
    ])
  })

  it('anchors a mark on the diagonal once', () => {
    // One place named twice; a second triangle there would only darken the first.
    const { view, manual } = mount()
    manual.add({
      id: mintMarkId(),
      kind: 'arrowhead',
      a: { contig: 'I', bp: 700 },
      b: { contig: 'I', bp: 700 },
      colour: '#c0392b',
    })
    expect(view.manualMarks).toHaveLength(1)
  })
})

describe('marks this axis has never heard of', () => {
  it('draws nothing for a sequence the assembly does not have, and does not throw', () => {
    // A mark carried over from another file, or made before a `chrom.sizes`
    // renamed everything. `locusToUnit` answers `null` and the mark is skipped —
    // the alternative being a browser that throws on a frame.
    const { view, manual } = mount()
    line(manual, 'chrIV', 400)
    manual.add({
      id: mintMarkId(),
      kind: 'rect',
      a: { contig: 'chrIV', from: 1, to: 2 },
      b: { contig: 'chrIV', from: 1, to: 2 },
      colour: '#111318',
    })
    manual.add({
      id: mintMarkId(),
      kind: 'arrowhead',
      a: { contig: 'chrIV', bp: 1 },
      b: { contig: 'I', bp: 500 },
      colour: '#111318',
    })
    // The one end that *is* on this axis is still drawn: half a loop is where
    // the reader can see it, and the other half is somewhere this file has not.
    expect(view.manualMarks).toEqual([
      { id: expect.any(String), kind: 'anchor', colour: '#111318', from: 500, to: 500 },
    ])
    // …and the frame that follows draws, rather than throwing on the mark it
    // cannot place. A context is lent for this one call, since the plan above
    // says *what* would be drawn and this says the drawing itself runs.
    expect(() => paint(view)).not.toThrow()
  })

  it('draws nothing for a sequence that has been unticked', () => {
    // The same rule by the other road: a restricted axis simply has fewer
    // segments, and nothing downstream knows a restriction happened (§8.4).
    const selection = new SequenceSelection(['I'])
    const key = `unticked-${Math.random()}.bw`
    const manual = new ManualStore(key)
    const view = new BrowserView({
      assembly: ASSEMBLY,
      store: new AnnotationStore(key, { persist: false }),
      client: new AnnotationClient(() => {
        throw new Error('this view reads no files')
      }),
      selection,
      groups: new GroupSettings(key),
      manual,
      onLocusChange: () => {},
    })
    built.push(view)
    line(manual, 'II', 250)
    line(manual, 'I', 250)
    expect(view.manualMarks.map((mark) => mark.from)).toEqual([250])
  })

  it('draws nothing at all for a view with no marks store', () => {
    // A file that cannot carry marks (§8.5) has no store, and a view handed none
    // draws none rather than reaching for one.
    const key = `none-${Math.random()}.bw`
    const view = new BrowserView({
      assembly: ASSEMBLY,
      store: new AnnotationStore(key, { persist: false }),
      client: new AnnotationClient(() => {
        throw new Error('this view reads no files')
      }),
      selection: new SequenceSelection(),
      groups: new GroupSettings(key),
      onLocusChange: () => {},
    })
    built.push(view)
    expect(view.manualMarks).toEqual([])
  })
})

describe('the Tracks card', () => {
  it('offers every shared track option, the tooltip included', () => {
    // The row used to be six toggles spelled out by hand, and `tooltip` was not
    // among them: the card that follows the pointer could be turned off beside a
    // map and, here, only with the `p` key. Driven from `TRACK_OPTIONS`, an
    // option added to the set arrives in both cards or in neither.
    const { view } = mount()
    const titles = all<HTMLButtonElement>(view.sideEl, '.btn-toggle').map((node) => node.title)
    for (const key of TRACK_OPTIONS) {
      expect(titles.some((title) => title.startsWith(PLOT_OPTION_LABELS[key].label))).toBe(true)
    }
    // …and the one that is this view's own, which no map has a use for.
    expect(titles.some((title) => title.startsWith(PLOT_OPTION_LABELS['gutter'].label))).toBe(true)
  })
})
