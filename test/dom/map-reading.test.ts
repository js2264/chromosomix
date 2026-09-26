// @vitest-environment jsdom
/**
 * What the map says it is drawn as, for a task that measures it as drawn (§18.8).
 *
 * The framing a task runs on names the score; `reading` names the rest of the
 * picture — what its counts are divided by and the scale they are drawn on —
 * and the inter-arm alignment takes its reading from it. Each case is one way a
 * reader can have the map on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixPanel, type ArmsPresentation, type DerivePresentation } from '@/ui/MatrixPanel'
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

const N = 40

function map(derive: Partial<DerivePresentation>, transform?: 'log10'): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    derive: { expected: false, smooth: '0', correlate: false, baseline: false, ...derive },
    ...(transform === undefined ? {} : { initial: { transform } }),
  })
  built.push(panel)
  document.body.append(panel.el)
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) values[r * N + c] = 20 / (1 + Math.abs(r - c))
  panel.setData(
    {
      nrows: N,
      ncols: N,
      values,
      rowExtent: [0, N],
      colExtent: [0, N],
      rowGroups: [{ label: 'chr', start: 0, end: N, unitStart: 0 }],
      colGroups: [{ label: 'chr', start: 0, end: N, unitStart: 0 }],
      level: 'bin',
      binsPerCell: 1,
    } as unknown as MatrixResult,
    'chr',
  )
  return panel
}

const ARMS: ArmsPresentation = {
  window: 30,
  frame: { startBin: 0, n: N, origin: 0, circular: true, binsize: 1000, length: N * 1000, originBp: 0 },
  refusal: null,
}

describe('the reading a map is drawn with', () => {
  it('is the counts on their own scale where nothing divides them', () => {
    const reading = map({}).analysisFraming('x.cool')?.reading
    expect(reading).toMatchObject({ expected: 'none', window: 0 })
  })

  it('is the O/E, on the scale the panel took for it', () => {
    const panel = map({ expected: true })
    const reading = panel.analysisFraming('x.cool')?.reading
    expect(reading?.expected).toBe('decay')
    // A ratio is drawn on log2 unless the reader chose otherwise (`preferredTransform`).
    expect(reading?.transform).toBe('log2')
  })

  it('is the O/E along the arms, with their window, where the arms are in force', () => {
    expect(map({ expected: true, arms: ARMS }).analysisFraming('x.cool')?.reading).toMatchObject({
      expected: 'arms',
      window: 30,
    })
    // Offered but refused on this view: the decay is what divides it.
    const refused = map({ expected: true, arms: { ...ARMS, refusal: 'no origin' } }).analysisFraming('x.cool')?.reading
    expect(refused).toMatchObject({ expected: 'decay', window: 0 })
  })

  it('reads a correlation as the ratio it is taken of, and the baseline as the counts', () => {
    const correlated = map({ correlate: true })
    expect(correlated.analysisFraming('x.cool')?.reading?.expected).toBe('decay')
    expect(map({ expected: true, baseline: true }).analysisFraming('x.cool')?.reading?.expected).toBe('none')
  })

  it('reads the ratio under a correlation on the ratio’s own scale, not the one on screen', () => {
    // The counts are read on the scale the reader drew them with…
    expect(map({}, 'log10').analysisFraming('x.cool')?.reading?.transform).toBe('log10')
    // …and the ratio under a correlation on its own, whatever the picture's
    // scale is — which, once the coefficient is on screen, is the coefficient's.
    expect(map({ correlate: true }, 'log10').analysisFraming('x.cool')?.reading?.transform).toBe('log2')
  })
})
