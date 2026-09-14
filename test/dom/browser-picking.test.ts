// @vitest-environment jsdom
/**
 * Placing hand-drawn marks by pointing at the **tracks** (§8.1).
 *
 * The Manual annotations card was built against a contact map: the shell armed
 * it through the session's `MatrixPanel`, so in a 1D genome browser — which has
 * no panel — the card was either missing outright or standing there with every
 * pick button disabled. Both of those were visible to a reader as *the feature
 * is not here*, and the marks were: the store was built for a browser session
 * all along, so a previous visit's marks were read out of storage and held in
 * memory with no card to show them and no renderer to draw them.
 *
 * What is worth testing is the whole chain rather than any link of it, because
 * every link was individually reasonable and the chain was broken:
 *
 * - the card is mounted in a browser session, and its buttons say what they are
 *   for on the surface that is actually on screen;
 * - a click on the tracks makes a **crosshair** — `axis: 'both'` — because a
 *   track has one axis and the honest reading of "this coordinate, no direction"
 *   is the mark that is already both;
 * - a drag makes the **square on the diagonal**, both of its spans equal, which
 *   is the same rule read on the other kind of mark;
 * - a drag across a sequence boundary makes nothing, since the near end of one
 *   chromosome is not what the reader drew;
 * - and the mode behaves as a mode: several marks per arming, Escape out.
 *
 * The session is real and so is the view. jsdom has no pointer capture and no
 * layout, so both are lent below; nothing else about this is a stand-in.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintMarkId, type ManualMark, type ManualStore } from '@/annotations/manual'
import { assemblyAxis, assemblyOf, type Assembly } from '@/genome/assembly'
import { Scale } from '@/render/scale'
import { Session, type SessionHost } from '@/app/Session'
import { GRIP_MARGIN } from '@/ui/BrowserView'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: Session[] = []

/** How wide the canvas is told it is; jsdom lays nothing out. */
const WIDTH = 1_000

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  lendLayout()
})

afterEach(() => {
  for (const session of built.splice(0, built.length)) session.destroy()
  takeLayoutBack()
  teardown()
  window.sessionStorage.clear()
})

/**
 * The two things jsdom does not have and this gesture needs.
 *
 * A width, because a canvas with none puts the whole genome inside one pixel and
 * every click lands past the end of the last sequence; and pointer capture,
 * which every drag in this app takes and jsdom implements as nothing at all.
 * Neither is a stand-in for behaviour under test — they are the browser's half
 * of a pointer gesture.
 */
let widthWas: PropertyDescriptor | undefined

function lendLayout(): void {
  widthWas = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => WIDTH,
  })
  const canvas = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  canvas['setPointerCapture'] = () => {}
  canvas['releasePointerCapture'] = () => {}
}

function takeLayoutBack(): void {
  if (widthWas === undefined) delete (window.HTMLElement.prototype as never)['clientWidth']
  else Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', widthWas)
}

/** Two sequences of a thousand bases: units 0–1000 and 1000–2000. */
function genome(uri: string): Assembly {
  return assemblyOf({
    uri,
    name: uri,
    contigs: [
      { name: 'I', length: 1_000 },
      { name: 'II', length: 1_000 },
    ],
    origin: 'sizes',
  })
}

/**
 * Where a locus is on the canvas, through the app's own two mappings.
 *
 * `LocusAxis` for the base pair and `Scale` for the pixel, which is exactly the
 * pair `BrowserView.atUnit` reads a click through in the other direction (§8.4:
 * nothing derives a second mapping, this test included).
 */
function xOf(assembly: Assembly, contig: string, bp: number): number {
  const unit = assemblyAxis(assembly).locusToUnit(contig, bp)
  if (unit === null) throw new Error(`${contig} is not on this axis`)
  return GRIP_MARGIN + new Scale([0, assembly.total], WIDTH - GRIP_MARGIN).toPixel(unit)
}

const host: SessionHost = {
  sessionChanged: () => {},
  stateChanged: () => {},
  panelsChanged: () => {},
  openFileDialog: () => {},
  openStore: () => {},
  openWorkspaceFile: () => {},
  panelLayout: () => ({}) as never,
  applyPanelLayout: () => {},
  notify: () => {},
  activity: () => {},
}

/** The private doors a browser session comes in through, without a file to read. */
interface Innards {
  assembly: Assembly | null
  annotations: { manual: ManualStore } | null
  browser: { remeasure(): void } | null
  setUpBrowserAnnotations(assembly: Assembly): void
  mountBrowser(state: { uri: string; view: string }): void
  carry(next: string): void
}

interface Open {
  session: Session
  inside: Innards
  assembly: Assembly
  marks: readonly ManualMark[]
  /** The card's own element, which is where its forms and buttons are. */
  card: HTMLElement
  /** Press the button with this label in the form with this title. */
  press(form: string, label: string): void
  /** What the button in this form says now. */
  label(form: string): string
  armed(form: string): boolean
  disabled(form: string): boolean
  /** Click the tracks at a locus, as a reader would. */
  click(contig: string, bp: number): void
  /** Drag across the tracks, from one locus to another. */
  drag(from: [string, number], to: [string, number]): void
}

/**
 * A genome browser with its annotation column, exactly as opening a bigWig
 * builds one — minus the read, which needs a worker and a file and decides
 * nothing here.
 */
function open(uri = 'yeast.bw'): Open {
  const session = new Session(host)
  built.push(session)
  const inside = session as unknown as Innards
  const assembly = genome(uri)
  inside.setUpBrowserAnnotations(assembly)
  inside.assembly = assembly
  inside.mountBrowser({ uri, view: 'browser' })
  // The frame the view would have had. On a page a `ResizeObserver` and the
  // constructor's own `requestAnimationFrame` measure the stage; jsdom has
  // neither observer nor layout, so a scale that still spans the whole genome in
  // one pixel would put every click past the end of the last sequence.
  inside.browser?.remeasure()
  return attach(session, inside, assembly)
}

function attach(session: Session, inside: Innards, assembly: Assembly): Open {
  const card = Array.from(session.annotationsHost.querySelectorAll<HTMLElement>('.card')).find(
    (node) => node.querySelector('.card-head')?.textContent?.trim() === 'Manual annotations',
  )
  if (card === undefined) throw new Error('the Manual annotations card is not mounted')
  const form = (title: string): HTMLElement => {
    const node = Array.from(card.querySelectorAll<HTMLElement>('.manual-form')).find(
      (candidate) => candidate.querySelector('.manual-form-title')?.textContent === title,
    )
    if (node === undefined) throw new Error(`no form called ${title}`)
    return node
  }
  // The pick button is the second of the two in a form's action row; the first
  // is `add`, which takes what has been typed.
  const picker = (title: string): HTMLButtonElement => {
    const node = Array.from(form(title).querySelectorAll('button')).find(
      (button) => button.textContent?.trim() !== 'add',
    )
    if (node === undefined) throw new Error(`no pick button in ${title}`)
    return node
  }
  // Inside the session's own content element rather than the document: the
  // shell is what puts that element on the page, and there is no shell here.
  const canvas = session.contentEl.querySelector('canvas.browser-canvas')
  if (canvas === null) throw new Error('no browser canvas is mounted')
  const at = (type: string, x: number): void => {
    canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 200, button: 0, bubbles: true }))
  }
  return {
    session,
    inside,
    assembly,
    get marks() {
      return inside.annotations?.manual.marks ?? []
    },
    card,
    press: (title, label) => {
      const node = Array.from(form(title).querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label,
      )
      if (node === undefined) throw new Error(`no button called ${label} in ${title}`)
      node.click()
    },
    label: (title) => picker(title).textContent?.trim() ?? '',
    armed: (title) => picker(title).classList.contains('is-armed'),
    disabled: (title) => picker(title).disabled,
    click: (contig, bp) => {
      const x = xOf(assembly, contig, bp)
      at('pointerdown', x)
      at('pointerup', x)
    },
    drag: (from, to) => {
      const x0 = xOf(assembly, from[0], from[1])
      const x1 = xOf(assembly, to[0], to[1])
      at('pointerdown', x0)
      at('pointermove', x1)
      at('pointerup', x1)
    },
  }
}

describe('the card in a browser session', () => {
  it('is mounted, under the tracks it annotates', () => {
    const titles = Array.from(
      open().session.annotationsHost.querySelectorAll('.card-head'),
    ).map((node) => node.textContent?.trim())
    expect(titles).toContain('Manual annotations')
    // Under the Tracks card, which is the place it holds beside a map: a mark
    // says *look here* about the picture the tracks are drawn on.
    expect(titles.indexOf('Manual annotations')).toBeGreaterThan(titles.indexOf('Tracks'))
  })

  it('offers to pick on the track, and means it', () => {
    // Enabled, because there is something to point at — and worded for what that
    // something is. "Pick on map" beside a browser would send a reader looking
    // for a map that is not there.
    const view = open()
    expect(view.disabled('Lines')).toBe(false)
    expect(view.label('Lines')).toBe('pick on track')
    expect(view.label('Rectangles')).toBe('draw on track')
  })
})

describe('a click on the tracks', () => {
  it('places a crosshair at the locus under the pointer', () => {
    // `both`, whatever the axis select says: a track has one axis, so a click on
    // it names a coordinate and not a direction. The same mark on a map is
    // already the vertical *and* the horizontal, with nothing left to resolve.
    const view = open()
    view.press('Lines', 'pick on track')
    view.click('I', 400)
    expect(view.marks).toEqual([
      { id: expect.any(String), kind: 'line', axis: 'both', at: { contig: 'I', bp: 400 }, colour: expect.any(String) },
    ])
  })

  it('reads the second sequence as the second sequence', () => {
    const view = open()
    view.press('Lines', 'pick on track')
    view.click('II', 250)
    expect(view.marks[0]).toMatchObject({ at: { contig: 'II', bp: 250 } })
  })

  it('stays armed for as many marks as the reader places', () => {
    // Marking up a figure is several marks, and the round trip to the sidebar
    // between each one was the whole cost of doing it here.
    const view = open()
    view.press('Lines', 'pick on track')
    view.click('I', 100)
    view.click('I', 200)
    view.click('II', 300)
    expect(view.marks).toHaveLength(3)
    expect(view.armed('Lines')).toBe(true)
  })

  it('makes an arrowhead on the diagonal, which is what one axis can say', () => {
    const view = open()
    view.press('Arrowheads', 'pick on track')
    view.click('I', 640)
    expect(view.marks).toEqual([
      {
        id: expect.any(String),
        kind: 'arrowhead',
        a: { contig: 'I', bp: 640 },
        b: { contig: 'I', bp: 640 },
        colour: expect.any(String),
      },
    ])
  })

  it('places nothing in the margin before the axis', () => {
    // The strip this view keeps for its lane handles holds no coordinate at all.
    const view = open()
    view.press('Lines', 'pick on track')
    const canvas = view.session.contentEl.querySelector(
      'canvas.browser-canvas',
    ) as HTMLCanvasElement
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new MouseEvent(type, { clientX: 1, clientY: 200, button: 0, bubbles: true }))
    }
    expect(view.marks).toHaveLength(0)
  })
})

describe('a drag across the tracks', () => {
  it('makes the square on the diagonal', () => {
    // One axis, so the same stretch is the rows and the columns — which is a
    // square on the diagonal and not a 1D-only kind of mark.
    const view = open()
    view.press('Rectangles', 'draw on track')
    view.drag(['I', 200], ['I', 600])
    expect(view.marks).toHaveLength(1)
    const rect = view.marks[0]
    if (rect.kind !== 'rect') throw new Error('expected a rectangle')
    expect(rect.a).toEqual({ contig: 'I', from: 200, to: 600 })
    expect(rect.b).toEqual(rect.a)
  })

  it('orders the span whichever way the hand went', () => {
    const view = open()
    view.press('Rectangles', 'draw on track')
    view.drag(['I', 600], ['I', 200])
    const rect = view.marks[0]
    if (rect.kind !== 'rect') throw new Error('expected a rectangle')
    expect(rect.a).toEqual({ contig: 'I', from: 200, to: 600 })
  })

  it('refuses one that crosses a sequence boundary', () => {
    // The axis is a concatenation, so a drag can begin in one chromosome and end
    // in another. That is not a locus, and clamping to the near end would hand
    // back a region the reader never selected — the rule the copy-a-locus drag
    // has always followed.
    const view = open()
    view.press('Rectangles', 'draw on track')
    view.drag(['I', 900], ['II', 100])
    expect(view.marks).toHaveLength(0)
    // …and the mode is still on, so the next drag can be the one they meant.
    expect(view.armed('Rectangles')).toBe(true)
  })

  it('places nothing for a click, since a click is not a box', () => {
    const view = open()
    view.press('Rectangles', 'draw on track')
    view.click('I', 400)
    expect(view.marks).toHaveLength(0)
  })
})

describe('the mode', () => {
  it('gives the button back on Escape', () => {
    // On the window, because the mode is armed from a button in a side panel and
    // the focus at the moment the reader changes their mind is very often not on
    // the plot.
    const view = open()
    view.press('Lines', 'pick on track')
    expect(view.armed('Lines')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(view.armed('Lines')).toBe(false)
    expect(view.label('Lines')).toBe('pick on track')
    view.click('I', 400)
    expect(view.marks).toHaveLength(0)
  })

  it('gives it back on Done, and again when another form arms over it', () => {
    const view = open()
    view.press('Lines', 'pick on track')
    view.press('Lines', 'Done')
    expect(view.armed('Lines')).toBe(false)

    view.press('Lines', 'pick on track')
    view.press('Rectangles', 'draw on track')
    expect(view.armed('Lines')).toBe(false)
    expect(view.armed('Rectangles')).toBe(true)
  })
})

describe('marks across a change of file', () => {
  it('follow the reader from the browser into the map', () => {
    // Memory is keyed on the file, which is right and is why this is needed: a
    // browser opened on a bigWig scopes to the bigWig and the cooler dropped on
    // it afterwards scopes to the cooler. Same genome, same coordinates, same
    // reader, different key — so the marks drawn while reading the tracks would
    // vanish exactly when the map they were drawn for arrived.
    const view = open('yeast.bw')
    view.press('Lines', 'pick on track')
    view.click('I', 400)
    expect(view.marks).toHaveLength(1)

    const next = genome('yeast.cool')
    view.inside.carry(next.uri)
    view.inside.setUpBrowserAnnotations(next)
    expect(view.inside.annotations?.manual.marks).toEqual([
      expect.objectContaining({ kind: 'line', at: { contig: 'I', bp: 400 } }),
    ])
  })

  it('are not doubled when the workspace comes back to the same key', () => {
    // A change of resolution reopens the same file, so the new store has already
    // read these marks out of storage. Carried rows are matched by id for
    // exactly this: adding them again would double every mark on every switch.
    const view = open('yeast.bw')
    view.inside.annotations?.manual.add({
      id: mintMarkId(),
      kind: 'line',
      axis: 'both',
      at: { contig: 'I', bp: 120 },
      colour: '#111318',
    })
    view.inside.carry('yeast.bw')
    view.inside.setUpBrowserAnnotations(view.assembly)
    expect(view.inside.annotations?.manual.marks).toHaveLength(1)
  })
})
