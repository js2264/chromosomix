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

/**
 * What the band looks like while it is being dragged out.
 *
 * The 1D browser writes three chips over its marquee — where the drag started,
 * where the pointer is now, and how much lies between — because the ruler above
 * it is at whatever resolution the *view* is, so at 20 kb per pixel the nearest
 * tick is eighty thousand bases from the edge being dragged. That is more true
 * here, not less: this ruler is the whole assembly at all times. So it is the
 * same drawing, from `render/browser.ts`, and the numbers it is given are what
 * this asserts — jsdom refuses a 2D context, and the chips' placement is the
 * browser's own and has its own tests.
 */
describe('the band being dragged out', () => {
  const press = (bar: SequenceBar, from: number, to: number): void => {
    const canvas = bar.el.querySelector('.seqbar-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: from, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: to }))
  }

  it('reads out the sequence and both ends, to the base', () => {
    const view = open()
    press(view.bar, 120, 160)
    expect(view.bar.selection).toEqual({ contig: 'II', start: 200, end: 600 })
    view.bar.destroy()
  })

  /** The anchor first, because the two chips are placed at their own edges. */
  it('reports a backwards drag from where the press landed', () => {
    const view = open()
    press(view.bar, 160, 120)
    expect(view.bar.selection).toEqual({ contig: 'II', start: 600, end: 200 })
    view.bar.destroy()
  })

  /** The same clamp the release applies, so the picture cannot contradict it. */
  it('clamps the moving end to the sequence the press landed in', () => {
    const view = open()
    press(view.bar, 250, 350)
    expect(view.bar.selection).toEqual({ contig: 'III', start: 500, end: 1000 })
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 350 }))
    expect(view.regions).toEqual(['III:500-1000'])
    view.bar.destroy()
  })

  it('says nothing while no drag is out', () => {
    const view = open()
    expect(view.bar.selection).toBeNull()
    view.bar.destroy()
  })
})

/**
 * Escape, which is the way out of a marquee dragged in the wrong place.
 *
 * A region is committed on release and a release cannot be taken back, so
 * without this the only way out of a drag begun by accident is to let it
 * navigate somewhere and come back. The key is read **on the window**, and that
 * is the whole of it: the listener used to be on the canvas, which takes no
 * focus, so the key went wherever the reader last clicked and the drag went
 * through regardless.
 */
describe('escaping a drag', () => {
  const escape = (): void => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  it('drops the band and opens nothing', () => {
    const view = open()
    const canvas = view.bar.el.querySelector('.seqbar-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 120, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    expect(view.bar.selection).not.toBeNull()

    escape()
    expect(view.bar.selection).toBeNull()
    // And the release that follows — the reader's hand is still on the button —
    // must not finish the gesture that was just abandoned.
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }))
    expect(view.regions).toEqual([])
    expect(view.contigs).toEqual([])
    view.bar.destroy()
  })

  /** Including a press that has not travelled, which would otherwise click. */
  it('cancels a press before it becomes anything', () => {
    const view = open()
    const canvas = view.bar.el.querySelector('.seqbar-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 250, bubbles: true }))
    escape()
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 250 }))
    expect(view.contigs).toEqual([])
    view.bar.destroy()
  })

  it('leaves a bar with no drag in progress alone', () => {
    const view = open()
    escape()
    drag(view.bar, 120, 160)
    expect(view.regions).toEqual(['II:200-600'])
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

/**
 * What the strip does under a pointer that has not pressed anything.
 *
 * A band is fifty pixels of shading with a name in the middle, so without a line
 * following the pointer there is no way to see *where in it* a drag would start
 * — which on a chromosome an inch wide is a megabase of ambiguity. The hairline
 * is the 1D browser's own, in the same colour, so a hand that has learned one
 * surface has learned the other; the caret cursor is the other half, and says
 * that what this gesture does is name a stretch rather than move an edge.
 *
 * jsdom refuses a 2D context, so what a test can see is the *state* the paint is
 * driven from rather than the pixels. That is the honest boundary: the drawing
 * itself is `drawGuide`, which the browser has been using for as long as it has
 * had a pointer.
 */
describe('the pointer over the strip', () => {
  const move = (bar: SequenceBar, x: number): void => {
    const canvas = bar.el.querySelector('.seqbar-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, bubbles: true }))
  }
  const leave = (bar: SequenceBar): void => {
    const canvas = bar.el.querySelector('.seqbar-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
  }

  it('follows it, and lets go when it leaves', () => {
    const view = open()
    move(view.bar, 210)
    expect(view.bar.hairlineAt).toBe(210)
    move(view.bar, 211)
    expect(view.bar.hairlineAt).toBe(211)
    leave(view.bar)
    expect(view.bar.hairlineAt).toBeNull()
    view.bar.destroy()
  })

  // While a drag is out, its two edges are what the eye is on and a third line
  // beside one of them is noise.
  it('draws no hairline while a band is being dragged out', () => {
    const view = open()
    const canvas = view.bar.el.querySelector('.seqbar-canvas') as HTMLElement
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 120, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    move(view.bar, 160)
    expect(view.bar.hairlineAt).toBeNull()
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }))
    // …and it comes back the moment the drag is over.
    move(view.bar, 160)
    expect(view.bar.hairlineAt).toBe(160)
    view.bar.destroy()
  })

  it('stays inside the strip when the pointer runs past its edge', () => {
    const view = open()
    move(view.bar, WIDTH + 200)
    expect(view.bar.hairlineAt).toBe(WIDTH)
    move(view.bar, -50)
    expect(view.bar.hairlineAt).toBe(0)
    view.bar.destroy()
  })
})

/**
 * The cursor, which is the other half of the affordance.
 *
 * The strip carries two gestures at once — a press picks a sequence, a drag
 * names a window inside one — and what tells them apart before either happens is
 * the pointer. A hand over a band says the press will open it; the caret comes
 * back the moment the hand starts travelling, because naming a stretch is what
 * selecting text does and a hand there would promise a pick that is no longer
 * what the gesture means.
 */
describe('what the pointer says the press will do', () => {
  const stage = (bar: SequenceBar): HTMLElement =>
    bar.el.querySelector('.seqbar-stage') as HTMLElement
  const over = (bar: SequenceBar, x: number): void => {
    stage(bar).dispatchEvent(new MouseEvent('mousemove', { clientX: x, bubbles: true }))
  }

  it('is a hand over a band, because a press there opens that sequence', () => {
    const view = open()
    over(view.bar, 40)
    expect(stage(view.bar).classList.contains('is-over-band')).toBe(true)
    expect(stage(view.bar).classList.contains('is-dragging')).toBe(false)
    view.bar.destroy()
  })

  it('gives the caret back once the hand is naming a stretch', () => {
    const view = open()
    over(view.bar, 40)
    stage(view.bar).dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: 40, bubbles: true }),
    )
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
    expect(stage(view.bar).classList.contains('is-dragging')).toBe(true)
    expect(stage(view.bar).classList.contains('is-over-band')).toBe(false)
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 200 }))
    expect(stage(view.bar).classList.contains('is-dragging')).toBe(false)
    view.bar.destroy()
  })

  it('says nothing once the pointer has left the strip', () => {
    const view = open()
    over(view.bar, 40)
    stage(view.bar).dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    expect(stage(view.bar).classList.contains('is-over-band')).toBe(false)
    view.bar.destroy()
  })
})
