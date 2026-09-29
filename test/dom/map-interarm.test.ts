// @vitest-environment jsdom
/**
 * The baseline's inter-arm half on the map (§7.5, §8.15): the score picker's
 * `inter-arm`, on a view of one circle.
 *
 * What the picture cannot say for itself. The cells drawn are the arm-frame
 * expectation of the cells across the two arms and nothing on one arm, whether
 * or not `arms` is on; the two toggles it makes meaningless — the O/E and
 * `arms` — are greyed with the reason; the key and the caption name it in
 * full, where the dropdown has room for one word; and a circle ticked or
 * unticked under the view offers the entry or takes it away without a rebuild.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { armOffsets } from '@/analysis/arms'
import { HeatmapView } from '@/render/heatmap'
import { MatrixPanel, type ArmsPresentation, type DerivePresentation } from '@/ui/MatrixPanel'
import { INTERARM_SCORE, scoreChoices, type ScoreChoice } from '@/ui/scores'
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
    interArm: true,
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
      current: options.current ?? INTERARM_SCORE,
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

describe('the inter-arm half on the map', () => {
  it('draws the cells across the arms and leaves every cell of one arm as paper, with `arms` off', () => {
    const picture = drawn()
    const { panel } = map()
    panel.setData(block(), 'chr')
    let seen = 0
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const value = picture()[r * N + c]
        if (!across(r, c)) {
          expect(Number.isNaN(value), `${r},${c}`).toBe(true)
          continue
        }
        seen++
        const delta = Math.abs(Math.abs(u[r]) - Math.abs(u[c]))
        // Built from one decay per kind, so its expectation is that decay, at
        // the window the toggle turns on at.
        expect(value, `${r},${c}`).toBeCloseTo(20 / (1 + delta), 3)
      }
    }
    expect(seen).toBe(2 * 20 * 20)
  })

  it('names it in full in the caption, where the picker has room for one word', () => {
    const { panel } = map()
    panel.setData(block(), 'chr')
    expect(scoreSelect(panel).selectedOptions[0]?.textContent).toBe('inter-arm')
    expect(panel.figureCaption(new Date()).detail).toContain('inter-arm expected')
  })

  it('greys the O/E and `arms`, and says why, while `ori` stays', () => {
    const { panel } = map({ derive: presentation({ expected: true, arms: arms(50) }) })
    const oe = word(panel, 'O/E')
    expect(oe.disabled).toBe(true)
    const along = word(panel, 'arms')
    expect(along.disabled).toBe(true)
    expect(along.getAttribute('aria-pressed')).toBe('false')
    expect(along.title).toMatch(/always read along them/)
    expect(word(panel, 'ori').disabled).toBe(false)
    // Another score gives both back.
    panel.rederive(presentation({ expected: true, baseline: false, interArm: false, arms: arms(50) }))
    expect(oe.disabled).toBe(false)
    expect(along.disabled).toBe(false)
    expect(along.getAttribute('aria-pressed')).toBe('true')
  })

  it('carries a note of its own on hover, which the whole baseline does not share', () => {
    const { panel } = map()
    const options = Array.from(scoreSelect(panel).options)
    const half = options.find((option) => option.value === INTERARM_SCORE)
    const whole = options.find((option) => option.textContent === 'expected')
    expect(half?.title).toMatch(/inter-arm decay alone/)
    expect(whole?.title).not.toBe(half?.title)
  })

  it('redraws when the origin moves under it, though `arms` is off', () => {
    const picture = drawn()
    const { panel } = map()
    panel.setData(block(), 'chr')
    const before = picture().slice()
    // A quarter turn, which moves both ends of each arm: half a turn only swaps
    // the two arms, and the cells across them are then the same cells.
    panel.rederive(presentation({ arms: { ...arms(undefined), frame: { ...FRAME, origin: 20, originBp: 20_500 } } }))
    const after = picture()
    let moved = 0
    for (let i = 0; i < after.length; i++) {
      if (Number.isNaN(after[i]) !== Number.isNaN(before[i])) moved++
    }
    // The cells between the old and the new origin on each side, a tenth of
    // the circle each way, crossed from one arm to the other.
    expect(moved).toBeGreaterThan(N * N * 0.1)
  })

  it('is offered and taken away with the circle, without a rebuild', () => {
    const { panel, picked } = map({
      derive: presentation({ baseline: false, interArm: false }),
      choices: scoreChoices({ hasWeights: false }),
      current: 'count',
    })
    const select = scoreSelect(panel)
    expect(Array.from(select.options).some((option) => option.value === INTERARM_SCORE)).toBe(false)
    // Ticked: offered, under the baseline it is half of.
    panel.offerScores(scoreChoices({ hasWeights: false, circle: true }), 'count')
    const values = Array.from(select.options).map((option) => option.value)
    expect(values.indexOf(INTERARM_SCORE)).toBe(values.indexOf('baseline') + 1)
    expect(select.value).toBe('count')
    select.value = INTERARM_SCORE
    select.dispatchEvent(new Event('change'))
    expect(picked.at(-1)?.interArm).toBe(true)
    // Unticked while it is drawn: gone, and the picker on what the state
    // resolves to now.
    panel.offerScores(scoreChoices({ hasWeights: false }), 'count')
    expect(Array.from(select.options).some((option) => option.value === INTERARM_SCORE)).toBe(false)
    expect(select.value).toBe('count')
    // Nothing announced back: the list moved under the reader, who chose nothing.
    expect(picked).toHaveLength(1)
  })
})
