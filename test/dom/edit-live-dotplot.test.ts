// @vitest-environment jsdom
/**
 * The stage's corner dot plot, in a DOM (SPECS §27.3): absent without another
 * reference to set the file against; one run of the dot plot task in the
 * annotations worker, for the file's own set against the other; its streaks
 * drawn through the edit, cut where a step cuts them; and folded away, and
 * remembered folded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import type { DotplotStreaks, MatrixOutput } from '@/analysis/types'
import { LiveDotplot, type LiveDotplotProps } from '@/edit/LiveDotplot'
import { EditedAssembly, emptyEdit, withStep, type ReferenceEdit } from '@/genome/edit'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
})
afterEach(() => teardown())

const ORIGINAL = { names: ['I', 'II'], lengths: [5000, 3000] }

const STREAKS: DotplotStreaks = {
  x: { label: 'assembly.fa', names: ['I', 'II'], lengths: [5000, 3000] },
  y: { label: 'theory.fa', names: ['chrA'], lengths: [10_000] },
  x0: Float64Array.from([1000, 5000]),
  x1: Float64Array.from([3000, 8000]),
  y0: Float64Array.from([0, 5000]),
  y1: Float64Array.from([2000, 8000]),
  strand: Int8Array.from([1, -1]),
  anchors: Int32Array.from([200, 300]),
}

function sequence(id: string, label: string, matched: number): unknown {
  return { id, kind: 'sequence', status: 'ready', label, overlap: { matched, total: 2, missing: [], extra: [] } }
}

function corner(
  entries: unknown[],
  light: LiveDotplotProps['light'] = () => {},
): { plot: LiveDotplot | null; asked: unknown[]; setEdit: (edit: ReferenceEdit) => void } {
  const asked: unknown[] = []
  let edit = emptyEdit(ORIGINAL)
  const output: MatrixOutput = {
    kind: 'matrix',
    id: 'dotplot-density',
    label: 'Streaks',
    nrows: 1,
    ncols: 1,
    values: new Float32Array(1),
    xLabel: '',
    yLabel: '',
    xTicks: [],
    yTicks: [],
    colormap: 'RdBu_r',
    streaks: STREAKS,
  }
  const client = {
    cancellable: (payload: unknown) => {
      asked.push(payload)
      return { promise: Promise.resolve({ outputs: [output], notes: [] }), cancel: () => {} }
    },
  }
  const props: LiveDotplotProps = {
    store: { entries } as unknown as AnnotationStore,
    client: client as unknown as AnnotationClient,
    assembly: () => EditedAssembly.of(edit),
    framing: () => ({ uri: 'yeast.cool', rows: [0, 0], cols: [0, 0], binsize: 0, binsPerCell: 1, balance: false, value: 'count', normalise: null, level: 'bin', label: 'yeast.cool' }),
    say: () => {},
    frame: () => {},
    light,
    memoryKey: 'stage|yeast.cool',
  }
  const plot = LiveDotplot.of(props)
  if (plot !== null) {
    document.body.append(plot.element)
    plot.place(0, 0, 600)
  }
  return { plot, asked, setEdit: (next) => (edit = next) }
}

describe('the stage’s corner dot plot', () => {
  it('is absent where the session holds no other reference', () => {
    expect(corner([sequence('own', 'assembly.fa', 2)]).plot).toBeNull()
  })

  it('finds the file’s own set’s streaks against the other, once, and says what it draws', async () => {
    const { plot, asked } = corner([sequence('ref', 'theory.fa', 0), sequence('own', 'assembly.fa', 2)])
    expect(plot).not.toBeNull()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'run', task: 'dotplot', params: { x: 'own', y: 'ref', streaks: 'one to one' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(plot?.element.querySelector('.edit-dotplot-caption')?.textContent).toBe('2 streaks · the edit along x, theory.fa along y')
    expect(plot?.element.querySelector('select')?.textContent).toBe('against theory.fa')
  })

  it('draws the streaks through the edit as it stands, found again never', async () => {
    const { plot, asked, setEdit } = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)])
    await new Promise((resolve) => setTimeout(resolve, 0))
    // I split at 2 kb, in the middle of its streak: two lines where there was one.
    setEdit(withStep(emptyEdit(ORIGINAL), { op: 'split', sequence: 'I', at: 2000 }, 'reader', 0))
    plot?.refresh()
    expect(plot?.element.querySelector('.edit-dotplot-caption')?.textContent).toBe('3 streaks · the edit along x, theory.fa along y')
    expect(asked).toHaveLength(1)
  })

  it('folds away to a button, and is remembered folded', async () => {
    const first = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)])
    ;(first.plot?.element.querySelector('.edit-dotplot-fold') as HTMLButtonElement).click()
    expect(first.plot?.element.classList.contains('is-folded')).toBe(true)
    first.plot?.destroy()
    const again = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)])
    expect(again.plot?.element.classList.contains('is-folded')).toBe(true)
    // Folded, nothing is found until it is wanted.
    expect(again.asked).toHaveLength(0)
    ;(again.plot?.element.querySelector('.edit-dotplot-open') as HTMLButtonElement).click()
    expect(again.asked).toHaveLength(1)
  })
})

/** A pointer or a wheel at `(x, y)` on an element, as jsdom can make one. */
function fire(target: Element, type: string, x: number, y: number, extra: Record<string, number> = {}): void {
  const event =
    type === 'wheel'
      ? new WheelEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra })
      : new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })
  if (type.startsWith('pointer')) Object.defineProperty(event, 'pointerId', { value: 1 })
  target.dispatchEvent(event)
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

describe('the corner dot plot in the hand', () => {
  it('zooms about the pointer by the wheel, moves by a drag, and shows the whole on a double click', async () => {
    const { plot } = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)])
    await settle()
    const canvas = plot?.element.querySelector('.edit-dotplot-canvas') as HTMLCanvasElement
    const whole = canvas.dataset.view
    fire(canvas, 'wheel', 96, 96, { deltaY: -400 })
    await settle()
    const zoomed = canvas.dataset.view?.split(' ').map(Number) ?? []
    expect(canvas.dataset.view).not.toBe(whole)
    expect(zoomed[1] - zoomed[0]).toBeLessThan(10_000 / 2)
    fire(canvas, 'pointerdown', 96, 96)
    fire(canvas, 'pointermove', 60, 96)
    fire(canvas, 'pointerup', 60, 96)
    await settle()
    const moved = canvas.dataset.view?.split(' ').map(Number) ?? []
    expect(moved[0]).toBeGreaterThan(zoomed[0])
    expect(moved[2]).toBe(zoomed[2])
    fire(canvas, 'dblclick', 96, 96)
    await settle()
    expect(canvas.dataset.view).toBe(whole)
  })

  it('is sized by its grip, kept on the map, remembered, and given its own size back by a double click', () => {
    const first = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)])
    const canvas = first.plot?.element.querySelector('.edit-dotplot-canvas') as HTMLCanvasElement
    // Its own: a third of a 600-pixel map.
    expect(canvas.style.width).toBe('192px')
    const grip = first.plot?.element.querySelector('.edit-dotplot-grip') as HTMLElement
    fire(grip, 'pointerdown', 100, 100)
    fire(grip, 'pointermove', 60, 140)
    expect(canvas.style.width).toBe('232px')
    // Never off the map: 600 less its margin, and the picker and the caption.
    fire(grip, 'pointermove', -2000, 2000)
    expect(canvas.style.width).toBe('520px')
    fire(grip, 'pointerup', -2000, 2000)
    first.plot?.destroy()
    const again = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)])
    const sized = again.plot?.element.querySelector('.edit-dotplot-canvas') as HTMLCanvasElement
    expect(sized.style.width).toBe('520px')
    fire(again.plot?.element.querySelector('.edit-dotplot-grip') as HTMLElement, 'dblclick', 0, 0)
    expect(sized.style.width).toBe('192px')
  })

  it('lights the lines of a stretch hovered on the map, and on the map the stretch of a line hovered in it', async () => {
    const lit: unknown[] = []
    const { plot } = corner([sequence('own', 'assembly.fa', 2), sequence('ref', 'theory.fa', 0)], (stretch) => lit.push(stretch))
    await settle()
    const canvas = plot?.element.querySelector('.edit-dotplot-canvas') as HTMLCanvasElement
    plot?.focusOn({ sequence: 'II', from: 0, to: 3000 })
    await settle()
    expect(canvas.dataset.focused).toBe('1')
    plot?.focusOn(null)
    await settle()
    expect(canvas.dataset.focused).toBe('0')
    // On I's line, at its middle: 2 kb along x and 1 kb along y, in a plot 4 pixels in from the canvas's edge.
    const [x0, x1, y0] = canvas.dataset.view?.split(' ').map(Number) ?? []
    const scale = (x1 - x0) / 184
    fire(canvas, 'pointermove', 4 + (2000 - x0) / scale, 4 + (1000 - y0) / scale)
    expect(lit.at(-1)).toEqual({ sequence: 'I', from: 1000, to: 3000 })
    fire(canvas, 'pointerleave', 0, 0)
    expect(lit.at(-1)).toBeNull()
  })
})
