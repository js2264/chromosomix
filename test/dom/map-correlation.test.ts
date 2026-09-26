// @vitest-environment jsdom
/**
 * The map's correlation, as the panel asks for it and draws it (§7.5, §18.6).
 *
 * Three things the picture cannot show when they are wrong. The square sent to
 * be correlated is the O/E with an empty pixel as the zero it is — the matrix
 * the compartment call correlates — while the picture drawn under the veil keeps
 * such a pixel as paper, which is what the O/E map has always drawn. The answer,
 * once it lands, is drawn without deriving the block again: a held correlation
 * replaces the whole field. And a despeckle that is still to come is waited for
 * rather than raced, so the correlation is of the field its caption names.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CorrelationField } from '@/analysis/compartments'
import * as derive from '@/render/derive'
import { HeatmapView } from '@/render/heatmap'
import { parseSmooth } from '@/render/smooth'
import { MatrixPanel, type DerivePresentation } from '@/ui/MatrixPanel'
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

const N = 24

/** A chromosome's worth of balanced counts falling off with distance, every fifth pixel empty. */
function block(): MatrixResult {
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) values[r * N + c] = (r + c) % 5 === 0 && r !== c ? 0 : 40 / (1 + Math.abs(r - c))
  }
  return {
    nrows: N,
    ncols: N,
    values,
    rowExtent: [0, N],
    colExtent: [0, N],
    rowGroups: [{ label: 'IV', start: 0, end: N, unitStart: 0 }],
    colGroups: [{ label: 'IV', start: 0, end: N, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

/** A correlation job that answers when told to. */
function jobs() {
  const sent: Float32Array[] = []
  let answer: ((field: CorrelationField) => void) | null = null
  return {
    sent,
    correlateBlock: (values: Float32Array) => {
      sent.push(values.slice())
      return {
        promise: new Promise<CorrelationField>((resolve) => {
          answer = resolve
        }),
        cancel: () => {},
      }
    },
    answer: () => {
      const values = new Float32Array(N * N).fill(0.25)
      answer?.({ values, kept: N, dropped: 0 })
    },
  }
}

function map(presentation: Partial<DerivePresentation>): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    derive: { expected: false, smooth: '0', correlate: true, baseline: false, ...presentation },
  })
  built.push(panel)
  document.body.append(panel.el)
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

describe('the correlation on the map', () => {
  it('is sent the ratio with an empty pixel as a zero, and draws it as paper meanwhile', () => {
    const picture = drawn()
    const job = jobs()
    const panel = map({ correlateBlock: job.correlateBlock })
    const data = block()
    panel.setData(data, 'IV')
    expect(job.sent).toHaveLength(1)
    const [square] = job.sent
    let empty = 0
    for (let i = 0; i < square.length; i++) {
      if (data.values[i] !== 0) continue
      empty++
      expect(square[i]).toBe(0)
      expect(Number.isNaN(picture()[i])).toBe(true)
    }
    expect(empty).toBeGreaterThan(50)
    // …and everywhere else the two are the same ratio.
    for (let i = 0; i < square.length; i++) if (data.values[i] !== 0) expect(picture()[i]).toBe(square[i])
  })

  it('draws the answer without deriving the block again, and asks for it once', async () => {
    const picture = drawn()
    const job = jobs()
    const panel = map({ correlateBlock: job.correlateBlock })
    const derived = vi.spyOn(derive, 'deriveBlock')
    panel.setData(block(), 'IV')
    // Once, for the square sent and the picture drawn meanwhile.
    const before = derived.mock.calls.length
    expect(before).toBe(1)
    job.answer()
    await vi.waitFor(() => expect(picture()[1]).toBe(0.25))
    expect(derived.mock.calls.length).toBe(before)
    expect(job.sent).toHaveLength(1)
  })

  it('waits for a despeckle still to come, and correlates what it gives', async () => {
    drawn()
    const job = jobs()
    let smoothed: ((field: derive.SmoothedField) => void) | null = null
    const requests: derive.SmoothingRequest[] = []
    const panel = map({
      smooth: 'a50',
      correlateBlock: job.correlateBlock,
      smoothBlock: (request) => {
        requests.push(request)
        return {
          promise: new Promise<derive.SmoothedField>((resolve) => {
            smoothed = resolve
          }),
          cancel: () => {},
        }
      },
    })
    // Big enough for the adaptive filter to be sent away rather than done here.
    const side = 1100
    const values = new Float32Array(side * side)
    for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) values[r * side + c] = 40 / (1 + Math.abs(r - c))
    panel.setData(
      {
        ...block(),
        nrows: side,
        ncols: side,
        values,
        rowExtent: [0, side],
        colExtent: [0, side],
        rowGroups: [{ label: 'IV', start: 0, end: side, unitStart: 0 }],
        colGroups: [{ label: 'IV', start: 0, end: side, unitStart: 0 }],
      } as unknown as MatrixResult,
      'IV',
    )
    expect(requests).toHaveLength(1)
    expect(job.sent).toHaveLength(0)
    // The filter answers with a field of its own, which is what is correlated.
    const field = new Float32Array(side * side).fill(3)
    smoothed!({ values: field, over: new Float32Array(side * side).fill(2), applied: parseSmooth('a50')!, scope: null })
    await vi.waitFor(() => expect(job.sent).toHaveLength(1))
    expect(job.sent[0][5]).toBeCloseTo(1.5, 6)
  })
})
