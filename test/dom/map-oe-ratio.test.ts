// @vitest-environment jsdom
/**
 * The O/E under a ratio of two maps (§7.5): greyed, unlit and saying why, and
 * not applied — the ratio is taken of the two maps as they are.
 *
 * A ratio is itself the comparison against a baseline, the second map, and the
 * decay with distance the two share divides out with it. The O/E of each first
 * is another figure; so the toggle greys while the ratio is drawn, as it does
 * under a baseline score, and `arms`, which shapes the O/E, greys with it. The
 * setting is the reader's and is not touched: a split or a difference built
 * with it on draws it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import {
  MatrixPanel,
  type ArmsPresentation,
  type ComparePresentation,
  type DerivePresentation,
} from '@/ui/MatrixPanel'
import type { CompareOp } from '@/types'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  vi.restoreAllMocks()
  teardown()
})

const N = 20

/**
 * A block whose every cell is `scale` times one decay with distance: under an
 * O/E each map is 1 everywhere, so a ratio of the two O/Es is 1, while the
 * ratio of the maps themselves is the ratio of their scales.
 */
function block(scale: number): MatrixResult {
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) values[r * N + c] = (scale * 100) / (1 + Math.abs(r - c))
  }
  return {
    nrows: N,
    ncols: N,
    values,
    rowExtent: [0, N],
    colExtent: [0, N],
    rowGroups: [{ label: 'chr', start: 0, end: N, unitStart: 0 }],
    colGroups: [{ label: 'chr', start: 0, end: N, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

const FRAME = { startBin: 0, n: N, origin: 5, circular: true, binsize: 1000, length: N * 1000, originBp: 5_500 }

function arms(window: number | undefined): ArmsPresentation {
  return { window, frame: FRAME, refusal: null, onChange: () => {}, onCentre: () => {} }
}

function presentation(over: Partial<DerivePresentation> = {}): DerivePresentation {
  return {
    expected: true,
    smooth: '0',
    correlate: false,
    baseline: false,
    alongArms: false,
    onExpectedChange: () => {},
    ...over,
  }
}

function compare(op: CompareOp): ComparePresentation {
  return { labels: ['four', 'two'], op, onOpChange: () => {} }
}

function map(op: CompareOp, derive: DerivePresentation = presentation()): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    derive,
    compare: compare(op),
  })
  built.push(panel)
  document.body.append(panel.el, panel.controlsEl)
  return panel
}

/** What the heatmap was last handed to draw. */
function drawn(): () => Float32Array {
  let last: Float32Array | null = null
  vi.spyOn(HeatmapView.prototype, 'setMatrix').mockImplementation(function (matrix) {
    last = matrix.values
  })
  vi.spyOn(HeatmapView.prototype, 'setValues').mockImplementation(function (values) {
    last = values
  })
  return () => {
    if (last === null) throw new Error('nothing drawn')
    return last
  }
}

/** A word button of the Map card's picture row, by its word. */
function word(panel: MatrixPanel, text: string): HTMLButtonElement {
  const button = Array.from(panel.controlsEl.querySelectorAll<HTMLButtonElement>('button')).find(
    (node) => node.querySelector('.btn-word-text')?.textContent === text,
  )
  if (button === undefined) throw new Error(`no ${text} button`)
  return button
}

/** The finite values of a drawn field, rounded to five places. */
function finite(values: Float32Array): number[] {
  return Array.from(values)
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value * 1e5) / 1e5)
}

describe('the O/E under a ratio of two maps', () => {
  it('is greyed and unlit, and says why, though the setting is on', () => {
    const panel = map('ratio')
    const oe = word(panel, 'O/E')
    expect(oe.disabled).toBe(true)
    expect(oe.getAttribute('aria-pressed')).toBe('false')
    expect(oe.title).toMatch(/ratio of two maps/)
    expect(oe.title).toMatch(/split or difference/)
    // The palette and the `e` key ask the same question.
    expect(panel.canToggleExpected).toBe(false)
  })

  it('draws the ratio of the two maps, not of their O/Es', () => {
    const picture = drawn()
    const panel = map('ratio')
    panel.setData(block(4), 'chr', block(2))
    // Of the maps: 4 over 2 in every cell. Of their O/Es it would be 1.
    expect(new Set(finite(picture()))).toEqual(new Set([2]))
    const caption = panel.figureCaption(new Date()).detail
    expect(caption).toContain('four / two')
    expect(caption).not.toContain('O/E')
  })

  it('takes `arms` out with it, while `ori` stays', () => {
    const panel = map('ratio', presentation({ arms: arms(50) }))
    const along = word(panel, 'arms')
    expect(along.disabled).toBe(true)
    expect(along.getAttribute('aria-pressed')).toBe('false')
    expect(along.title).toMatch(/ratio of two maps/)
    expect(word(panel, 'ori').disabled).toBe(false)
  })

  it('stays greyed through a rederive, which repaints the toggle', () => {
    const panel = map('ratio')
    panel.rederive(presentation({ expected: false }))
    panel.rederive(presentation({ expected: true }))
    const oe = word(panel, 'O/E')
    expect(oe.disabled).toBe(true)
    expect(oe.getAttribute('aria-pressed')).toBe('false')
  })

  it('is live and lit on a split or a difference, and drawn there', () => {
    for (const op of ['split', 'difference'] as const) {
      const panel = map(op)
      const oe = word(panel, 'O/E')
      expect(oe.disabled, op).toBe(false)
      expect(oe.getAttribute('aria-pressed'), op).toBe('true')
      expect(oe.title, op).toMatch(/^Observed over expected/)
      expect(panel.canToggleExpected, op).toBe(true)
    }
    // A difference of the two O/Es: each is 1 everywhere, so the difference is 0.
    const picture = drawn()
    const panel = map('difference')
    panel.setData(block(4), 'chr', block(2))
    expect(new Set(finite(picture()))).toEqual(new Set([0]))
  })

  it('greys for the baseline score too, with the baseline’s own reason', () => {
    const panel = map('ratio', presentation({ baseline: true }))
    expect(word(panel, 'O/E').title).toMatch(/already are the expected values/)
  })
})
