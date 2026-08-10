// @vitest-environment jsdom
/**
 * The 1D browser's bar, over the Chromosomes table.
 *
 * The table is where a reader of a cooler lands, and the only way out of it into
 * a *window* was to type one — which asks for a coordinate they are usually
 * looking for rather than one they have. The bar is the browser's own: the same
 * box with the same gene search behind it, the same **go**, the same switch to
 * the tracks, and a ruler of the whole assembly that a drag names a window in.
 *
 * The gesture is what most of this file is about, and the reason it can be
 * tested at all is that the hit-testing is a function of the axis and the width
 * rather than of what a paint returned: jsdom has no 2D context, so a bar whose
 * bands came from `drawRuler` would have none — and so would a real browser on
 * its first frame.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assemblyOf } from '@/genome/assembly'
import { SequenceBar } from '@/ui/SequenceBar'
import { buttonNamed, setUpDom, type DomTeardown } from '../support/dom'

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
  bar: SequenceBar
  /** Every whole sequence it was asked to open, in order. */
  contigs: string[]
  /** Every window, as the string the router will read. */
  regions: string[]
  /** How many times it asked for the whole genome. */
  wholes: string[]
}

function open(): Opened {
  const out: Opened = { bar: null as unknown as SequenceBar, contigs: [], regions: [], wholes: [] }
  out.bar = new SequenceBar({
    assembly: GENOME,
    onOpenContig: (name) => out.contigs.push(name),
    onOpenRegion: (region) => out.regions.push(region),
    onOpenWhole: () => out.wholes.push('*'),
  })
  document.body.appendChild(out.bar.el)
  // jsdom lays nothing out, so the width the strip is drawn and measured at is
  // stated here — which is what a `ResizeObserver` would have reported.
  const stage = out.bar.el.querySelector('.seqbar-stage') as HTMLElement
  Object.defineProperty(stage, 'clientWidth', { value: WIDTH, configurable: true })
  out.bar.remeasure()
  return out
}

/** A press, a move and a release across the strip, in canvas pixels. */
function drag(bar: SequenceBar, from: number, to: number): void {
  const canvas = bar.el.querySelector('.seqbar-canvas') as HTMLElement
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: from, bubbles: true }))
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: to }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: to }))
}

describe('the bar', () => {
  it('carries the box, go and nothing that zooms', () => {
    const view = open()
    expect(view.bar.el.querySelector('.input-region')).not.toBeNull()
    expect(buttonNamed(view.bar.el, 'go')).not.toBeNull()
    // The two the browser has and this deliberately does not: there is no
    // viewport under this ruler to be zoomed, and no track stack to fit.
    const titles = [...view.bar.el.querySelectorAll('button')].map((node) => node.title).join(' ')
    expect(titles).not.toMatch(/zoom/i)
    expect(titles).not.toMatch(/stretch|shrink/i)
    view.bar.destroy()
  })

  it('says what the assembly is and that the strip can be dragged', () => {
    const view = open()
    const note = view.bar.el.querySelector('.summary')?.textContent ?? ''
    expect(note).toContain('4 sequences')
    expect(note).toContain('4.0 kb')
    expect(note).toMatch(/drag/i)
    view.bar.destroy()
  })

  it('takes the switch the session hands it', () => {
    const toggle = document.createElement('button')
    toggle.textContent = 'tracks'
    const bar = new SequenceBar({
      assembly: GENOME,
      extraControl: toggle,
      onOpenContig: () => {},
      onOpenRegion: () => {},
    })
    expect(buttonNamed(bar.el, 'tracks')).not.toBeNull()
    bar.destroy()
  })
})

describe('a drag across the strip', () => {
  /**
   * The whole point of the feature: a window without typing one. 400 px over
   * 4,000 bp is 10 bp a pixel, and the drag starts 20 px into chromosome II.
   */
  it('names a window inside the sequence it started in', () => {
    const view = open()
    drag(view.bar, 120, 160)
    expect(view.regions).toEqual(['II:200-600'])
    expect(view.contigs).toEqual([])
    view.bar.destroy()
  })

  it('reads a backwards drag as the same window', () => {
    const view = open()
    drag(view.bar, 160, 120)
    expect(view.regions).toEqual(['II:200-600'])
    view.bar.destroy()
  })

  /**
   * A region names one contig — that is what the reader, `parseMetacoolerRange`
   * and the breadcrumb all mean by one — so a drag that runs off the end of a
   * chromosome is clamped rather than refused, and the chromosome is the one the
   * button went down in. Deciding it at the *press* is what makes it
   * predictable: it is where the reader was looking.
   */
  it('clamps to the sequence the press landed in', () => {
    const view = open()
    // From the middle of III into the middle of IV: III's own end, not IV's.
    drag(view.bar, 250, 350)
    expect(view.regions).toEqual(['III:500-1000'])
    view.bar.destroy()
  })

  it('emits a plain, machine-readable region rather than a display one', () => {
    const view = open()
    drag(view.bar, 0, 100)
    // No thousands separators, a plain hyphen, 0-based half-open — what
    // `metacooler/range.ts` reads and what pastes into other tools.
    expect(view.regions[0]).toMatch(/^I:\d+-\d+$/)
    view.bar.destroy()
  })
})

describe('a press that does not travel', () => {
  it('opens the whole sequence under it', () => {
    const view = open()
    drag(view.bar, 250, 250)
    expect(view.contigs).toEqual(['III'])
    expect(view.regions).toEqual([])
    view.bar.destroy()
  })

  // A hand that moves four pixels was aiming at a chromosome. Reading it as a
  // window would answer a click with a region nobody could see themselves make.
  it('reads a twitch as a click, not as a forty-base window', () => {
    const view = open()
    drag(view.bar, 250, 254)
    expect(view.contigs).toEqual(['III'])
    expect(view.regions).toEqual([])
    view.bar.destroy()
  })
})

describe('the box', () => {
  const submit = (bar: SequenceBar, text: string): void => {
    const input = bar.el.querySelector('.input-region') as HTMLInputElement
    input.value = text
    buttonNamed(bar.el, 'go')?.click()
  }

  it('opens a whole sequence for a bare name', () => {
    const view = open()
    submit(view.bar, 'IV')
    expect(view.contigs).toEqual(['IV'])
    expect(view.regions).toEqual([])
    view.bar.destroy()
  })

  it('opens a window for coordinates', () => {
    const view = open()
    submit(view.bar, 'II:100-200')
    expect(view.regions).toEqual(['II:100-200'])
    view.bar.destroy()
  })

  // `*` is what the browser's own box takes for the whole genome, and a reader
  // who has learned it on one surface should not find it inert on the other.
  it('takes * for the whole genome', () => {
    const view = open()
    submit(view.bar, '*')
    expect(view.wholes).toEqual(['*'])
    expect(view.contigs).toEqual([])
    view.bar.destroy()
  })

  it('does nothing at all for an empty box', () => {
    const view = open()
    submit(view.bar, '   ')
    expect(view.contigs).toEqual([])
    expect(view.regions).toEqual([])
    view.bar.destroy()
  })
})
