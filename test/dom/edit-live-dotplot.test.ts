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

function corner(entries: unknown[]): { plot: LiveDotplot | null; asked: unknown[]; setEdit: (edit: ReferenceEdit) => void } {
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
