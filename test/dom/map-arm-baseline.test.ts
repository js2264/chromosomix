// @vitest-environment jsdom
/**
 * The baseline along both arms on the map (§7.5, §8.15): the score picker's
 * `arm decay`, on a view of one circle.
 *
 * What the picture cannot say for itself. Every cell drawn is the arm-frame
 * expectation — both diagonals, the main one and the secondary one — whether
 * or not `arms` is on; the two toggles it makes meaningless — the O/E and
 * `arms` — are greyed with the reason; the key says it once and the caption in
 * full; and a circle ticked or unticked under the view offers the entry or
 * takes it away without a rebuild.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { armOffsets } from '@/analysis/arms'
import { HeatmapView } from '@/render/heatmap'
import { MatrixPanel, type ArmsPresentation, type DerivePresentation } from '@/ui/MatrixPanel'
import { ARM_BASELINE_SCORE, scoreChoices, type ScoreChoice } from '@/ui/scores'
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

/** A circle of 40 bins of 1 kb, its origin at bin 10, its two arms zipped. */
const N = 40
const FRAME = { startBin: 0, n: N, origin: 10, circular: true, binsize: 1000, length: N * 1000, originBp: 10_500 }
const u = armOffsets({ n: N, origin: 10, circular: true })
const across = (r: number, c: number): boolean => u[r] >= 0 !== u[c] >= 0

function block(): MatrixResult {
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const delta = Math.abs(Math.abs(u[r]) - Math.abs(u[c]))
      values[r * N + c] = (across(r, c) ? 20 : 40) / (1 + delta)
    }
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

function arms(window: number | undefined): ArmsPresentation {
  return { window, frame: FRAME, refusal: null, onChange: () => {}, onCentre: () => {} }
}

function presentation(over: Partial<DerivePresentation> = {}): DerivePresentation {
  return {
    expected: false,
    smooth: '0',
    correlate: false,
    baseline: true,
    alongArms: true,
    arms: arms(undefined),
    onExpectedChange: () => {},
    ...over,
  }
}

function map(options: { derive?: DerivePresentation; choices?: readonly ScoreChoice[]; current?: string } = {}) {
  const picked: ScoreChoice[] = []
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    derive: options.derive ?? presentation(),
    scores: {
      choices: options.choices ?? scoreChoices({ hasWeights: false, circle: true }),
      current: options.current ?? ARM_BASELINE_SCORE,
      onChange: (choice) => picked.push(choice),
    },
  })
  built.push(panel)
  document.body.append(panel.el, panel.controlsEl)
  return { panel, picked }
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

function scoreSelect(panel: MatrixPanel): HTMLSelectElement {
  for (const field of panel.controlsEl.querySelectorAll('.field')) {
    if (field.querySelector('.field-label')?.textContent !== 'score') continue
    const select = field.querySelector<HTMLSelectElement>('select')
    if (select !== null) return select
  }
  throw new Error('no score picker')
}

describe('the baseline along both arms on the map', () => {
  it('draws both diagonals over the whole square, with `arms` off', () => {
    const picture = drawn()
    const { panel } = map()
    panel.setData(block(), 'chr')
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const delta = Math.abs(Math.abs(u[r]) - Math.abs(u[c]))
        // Built from one decay per kind, so its expectation is that decay, at
        // the window the toggle turns on at: the main diagonal's on each arm,
        // the secondary diagonal's across the two — and no cell left out.
        expect(picture()[r * N + c], `${r},${c}`).toBeCloseTo((across(r, c) ? 20 : 40) / (1 + delta), 3)
      }
    }
  })

  it('says so in the key once and in the caption in full', async () => {
    const { panel } = map()
    panel.setData(block(), 'chr')
    // The key is set by the frame that draws the block.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(scoreSelect(panel).selectedOptions[0]?.textContent).toBe('arm decay')
    expect(panel.figureCaption(new Date()).detail).toContain('expected along the arms')
    // The picker's word, once: not `Arm decay expected`.
    const key = panel.el.querySelector('.map-key-title')?.textContent ?? ''
    expect(key).toMatch(/^Arm decay/)
    expect(key).not.toMatch(/expected/i)
  })

  it('greys the O/E and `arms`, and says why, while `ori` stays', () => {
    const { panel } = map({ derive: presentation({ expected: true, arms: arms(50) }) })
    const oe = word(panel, 'O/E')
    expect(oe.disabled).toBe(true)
    const along = word(panel, 'arms')
    expect(along.disabled).toBe(true)
    expect(along.getAttribute('aria-pressed')).toBe('false')
    expect(along.title).toMatch(/already are the expected along both arms/)
    expect(word(panel, 'ori').disabled).toBe(false)
    // Another score gives both back.
    panel.rederive(presentation({ expected: true, baseline: false, alongArms: false, arms: arms(50) }))
    expect(oe.disabled).toBe(false)
    expect(along.disabled).toBe(false)
    expect(along.getAttribute('aria-pressed')).toBe('true')
  })

  it('carries a note of its own on hover, which the plain baseline does not share', () => {
    const { panel } = map()
    const options = Array.from(scoreSelect(panel).options)
    const along = options.find((option) => option.value === ARM_BASELINE_SCORE)
    const plain = options.find((option) => option.textContent === 'expected')
    expect(along?.title).toMatch(/both diagonals/)
    expect(plain?.title).not.toBe(along?.title)
  })

  it('redraws when the origin moves under it, though `arms` is off', () => {
    const picture = drawn()
    const { panel } = map()
    panel.setData(block(), 'chr')
    const before = picture().slice()
    // A quarter turn: the map was built round the origin at bin 10, so read
    // from bin 20 its cells fall into other kinds and separations.
    panel.rederive(presentation({ arms: { ...arms(undefined), frame: { ...FRAME, origin: 20, originBp: 20_500 } } }))
    const after = picture()
    let moved = 0
    for (let i = 0; i < after.length; i++) if (Math.abs(after[i] - before[i]) > 1e-3) moved++
    expect(moved).toBeGreaterThan(N * N * 0.1)
  })

  it('is offered and taken away with the circle, without a rebuild', () => {
    const { panel, picked } = map({
      derive: presentation({ baseline: false, alongArms: false }),
      choices: scoreChoices({ hasWeights: false }),
      current: 'count',
    })
    const select = scoreSelect(panel)
    expect(Array.from(select.options).some((option) => option.value === ARM_BASELINE_SCORE)).toBe(false)
    // Ticked: offered, under the baseline it is half of.
    panel.offerScores(scoreChoices({ hasWeights: false, circle: true }), 'count')
    const values = Array.from(select.options).map((option) => option.value)
    expect(values.indexOf(ARM_BASELINE_SCORE)).toBe(values.indexOf('baseline') + 1)
    expect(select.value).toBe('count')
    select.value = ARM_BASELINE_SCORE
    select.dispatchEvent(new Event('change'))
    expect(picked.at(-1)?.alongArms).toBe(true)
    // Unticked while it is drawn: gone, and the picker on what the state
    // resolves to now.
    panel.offerScores(scoreChoices({ hasWeights: false }), 'count')
    expect(Array.from(select.options).some((option) => option.value === ARM_BASELINE_SCORE)).toBe(false)
    expect(select.value).toBe('count')
    // Nothing announced back: the list moved under the reader, who chose nothing.
    expect(picked).toHaveLength(1)
  })
})
