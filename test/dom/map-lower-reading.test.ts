// @vitest-environment jsdom
/**
 * The lower triangle in a reading of its own, on the panel (§5.10).
 *
 * Pinned through the seams the picture is made at — what the renderer is handed
 * and what the session is told — because each failure here is a plausible map:
 * an O/E under a count's ramp, the upper's colours moved by a reading put beside
 * them, a lower triangle drawn from the upper's block under the lower's name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import type { LowerPresentation, LowerScale, LowerSeed } from '@/ui/LowerReading'
import { MatrixPanel, type DerivePresentation } from '@/ui/MatrixPanel'
import { scoreChoices } from '@/ui/scores'
import type { ColorScale, DenseMatrix } from '@/types'
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

const N = 12

/** A square of pure distance decay: its O/E is one wherever there is a contact. */
function block(): MatrixResult {
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) values[r * N + c] = 64 / (1 + Math.abs(r - c))
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

const upperDerive: DerivePresentation = { expected: false, smooth: '0', correlate: false, baseline: false }

function lower(over: Partial<LowerPresentation> = {}, derive: Partial<DerivePresentation> = {}) {
  const told = { toggles: [] as Array<{ on: boolean; seed: LowerSeed }>, scales: [] as LowerScale[], oe: [] as boolean[] }
  const presentation: LowerPresentation = {
    on: true,
    set: true,
    onToggle: (on, seed) => told.toggles.push({ on, seed }),
    scores: { choices: scoreChoices({ hasWeights: false }), current: 'count', onChange: () => {} },
    derive: {
      expected: false,
      smooth: '0',
      correlate: false,
      baseline: false,
      onExpectedChange: (on) => told.oe.push(on),
      onSmoothChange: () => {},
      ...derive,
    },
    scale: { transform: 'log1p', colormap: 'default' },
    onScaleChange: (scale) => told.scales.push(scale),
    balance: false,
    read: null,
    ...over,
  }
  return { presentation, told }
}

function map(presentation?: LowerPresentation, turned = false): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    derive: upperDerive,
    scores: { choices: scoreChoices({ hasWeights: false }), current: 'count', onChange: () => {} },
    initial: { transform: 'log1p', colormap: 'default', defaults: { transform: 'log1p', colormap: 'default' } },
    ...(turned ? { turn: { on: true } } : {}),
    ...(presentation === undefined ? {} : { lower: presentation }),
  })
  built.push(panel)
  document.body.append(panel.el, panel.controlsEl)
  return panel
}

/** What the renderer was handed: the block, its gauge, and the lower layer. */
function handed() {
  const got = {
    matrix: null as DenseMatrix | null,
    gauge: null as DenseMatrix | null | undefined,
    lower: undefined as { scale: ColorScale; gauge: DenseMatrix } | null | undefined,
  }
  vi.spyOn(HeatmapView.prototype, 'setMatrix').mockImplementation(function (matrix, _separators, gauge) {
    got.matrix = matrix
    got.gauge = gauge
  })
  vi.spyOn(HeatmapView.prototype, 'setValues').mockImplementation(function (values) {
    if (got.matrix !== null) got.matrix = { ...got.matrix, values }
  })
  vi.spyOn(HeatmapView.prototype, 'setLower').mockImplementation(function (layer) {
    got.lower = layer
  })
  return got
}

function field(panel: MatrixPanel, label: string): HTMLElement {
  const found = Array.from(panel.controlsEl.querySelectorAll<HTMLElement>('.map-lower .field')).find(
    (node) => node.querySelector('.field-label')?.textContent === label,
  )
  if (found === undefined) throw new Error(`no ${label} field on the lower tab`)
  return found
}

describe('the Map card’s second tab', () => {
  it('is offered only with a lower reading, and shows its fields only while it is on', () => {
    const alone = map()
    expect(alone.controlsEl.querySelector('.map-tabs')?.classList.contains('hidden')).toBe(true)
    const { presentation } = lower({ on: false })
    const panel = map(presentation)
    expect(panel.controlsEl.querySelector('.map-tabs')?.classList.contains('hidden')).toBe(false)
    expect(panel.controlsEl.querySelector('.map-lower-fields')?.classList.contains('hidden')).toBe(true)
    panel.setLower({ ...presentation, on: true })
    expect(panel.controlsEl.querySelector('.map-lower-fields')?.classList.contains('hidden')).toBe(false)
    // A deck forming round the map takes it away without rebuilding it.
    panel.setLower(undefined)
    expect(panel.controlsEl.querySelector('.map-tabs')?.classList.contains('hidden')).toBe(true)
  })

  it('switches on from the upper reading as it is now, so the press changes nothing', () => {
    const { presentation, told } = lower({ on: false, set: false })
    const panel = map(presentation)
    field(panel, 'own reading').querySelector('button')?.click()
    expect(told.toggles).toEqual([
      { on: true, seed: { score: 'count', oe: false, smooth: '0', transform: 'log1p', colormap: 'default' } },
    ])
  })

  it('asks for its own O/E, and not the map’s', () => {
    const { presentation, told } = lower()
    const panel = map(presentation)
    field(panel, 'baseline').querySelector('button')?.click()
    expect(told.oe).toEqual([true])
  })
})

describe('the picture with a lower reading', () => {
  it('puts the lower reading below the diagonal and the upper’s on and above it', () => {
    const got = handed()
    const { presentation } = lower({}, { expected: true })
    const panel = map(presentation)
    const data = block()
    panel.setData(data, 'chr')
    const values = got.matrix?.values
    expect(values).toBeDefined()
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const at = values![r * N + c]
        if (r > c) expect(at).toBeCloseTo(1, 5)
        else expect(at).toBe(data.values[r * N + c])
      }
    }
  })

  it('colours it on a scale of its own, handed over to the O/E and announced', () => {
    const got = handed()
    const { presentation, told } = lower({}, { expected: true })
    const panel = map(presentation)
    panel.setData(block(), 'chr')
    expect(got.lower?.scale.transform).toBe('log2')
    expect(got.lower?.scale.colormap).toBe('RdBu_r')
    expect(got.lower?.scale.neutral).toBe(1)
    expect(told.scales.at(-1)).toMatchObject({ transform: 'log2', colormap: 'RdBu_r' })
  })

  it('measures the upper’s range on the upper’s own square, so its colours do not move', () => {
    const got = handed()
    const { presentation } = lower({}, { expected: true })
    const panel = map(presentation)
    const data = block()
    panel.setData(data, 'chr')
    expect(got.gauge?.values).toEqual(data.values)
    // …and the lower's on the lower's: a square of ones.
    expect(Array.from(got.lower?.gauge.values ?? []).every((v) => Math.abs(v - 1) < 1e-5)).toBe(true)
  })

  it('draws one reading over the square where it needs a read it was not handed', () => {
    const got = handed()
    const { presentation } = lower({ read: { balance: true } }, { expected: true })
    const panel = map(presentation)
    const data = block()
    panel.setData(data, 'chr')
    expect(got.lower).toBeNull()
    expect(got.matrix?.values).toEqual(data.values)
  })

  it('reads the second block where it was handed one, and not the upper’s', () => {
    const got = handed()
    const { presentation } = lower({ read: { balance: true } })
    const panel = map(presentation)
    const data = block()
    const other = { ...block(), values: new Float32Array(N * N).fill(5) } as MatrixResult
    panel.setData(data, 'chr', other)
    expect(got.matrix?.values[N * (N - 1)]).toBe(5)
    expect(got.matrix?.values[N - 1]).toBe(data.values[N - 1])
  })

  it('shows its key under the first while it is drawn, and takes it away when it is not', () => {
    handed()
    const { presentation } = lower()
    const panel = map(presentation)
    panel.setData(block(), 'chr')
    const keys = () => Array.from(panel.el.querySelectorAll('.map-key')).filter((node) => !node.classList.contains('hidden'))
    expect(keys().length).toBe(2)
    panel.rederive(upperDerive, undefined, undefined, { ...presentation, on: false })
    expect(keys().length).toBe(1)
  })

  it('turns into two bands, the second read from the lower reading’s own square', () => {
    const turns: Array<{ fold?: number } | null> = []
    vi.spyOn(HeatmapView.prototype, 'setTurn').mockImplementation(function (turn) {
      turns.push(turn)
    })
    const got = handed()
    const { presentation } = lower({}, { expected: true })
    const panel = map(presentation, true)
    panel.setData(block(), 'chr')
    const turn = turns.at(-1)
    expect(turn?.fold).toBeDefined()
    const matrix = got.matrix!
    const fold = turn!.fold!
    // The second band's diagonal row is the lower reading's, an O/E of one.
    const diagonal = matrix.values.subarray(fold * matrix.ncols, (fold + 1) * matrix.ncols)
    const drawnCells = Array.from(diagonal).filter((v) => !Number.isNaN(v))
    expect(drawnCells.length).toBeGreaterThan(0)
    expect(drawnCells.every((v) => Math.abs(v - 1) < 1e-5)).toBe(true)
  })
})
