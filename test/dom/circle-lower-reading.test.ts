// @vitest-environment jsdom
// @dev-feature circle
/**
 * The lower reading's tabs (§5.10) while a metagenome's map is drawn round
 * (§7.6).
 *
 * A chord is one number for a pair of sections, with no triangle below a
 * diagonal to read in another way, so the Map card's `◥ map` / `◣ lower` row
 * steps aside with the square's own rows — and the lower pane with it, or a
 * reader who had it open would be left with the lower triangle's fields and
 * none of the circle's. The reading itself is kept: the square comes back with
 * it, on the tab the reader left open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CirclePresentation } from '@/ui/CircleView'
import type { LowerPresentation } from '@/ui/LowerReading'
import { MatrixPanel } from '@/ui/MatrixPanel'
import { scoreChoices } from '@/ui/scores'
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

/** Two genomes of six bins each, so the block has two sections to draw round. */
function block(): MatrixResult {
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) values[r * N + c] = 64 / (1 + Math.abs(r - c))
  const groups = [
    { label: 'MAG_1', start: 0, end: 6, unitStart: 0 },
    { label: 'MAG_2', start: 6, end: N, unitStart: 6 },
  ]
  return {
    nrows: N,
    ncols: N,
    values,
    rowExtent: [0, N],
    colExtent: [0, N],
    rowGroups: groups,
    colGroups: groups,
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

const lower: LowerPresentation = {
  on: true,
  set: true,
  onToggle: () => {},
  scores: { choices: scoreChoices({ hasWeights: false }), current: 'count', onChange: () => {} },
  derive: {
    expected: true,
    smooth: '0',
    correlate: false,
    baseline: false,
    onExpectedChange: () => {},
    onSmoothChange: () => {},
  },
  scale: { transform: 'log1p', colormap: 'default' },
  onScaleChange: () => {},
  balance: false,
  read: null,
}

function map(round: CirclePresentation): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    derive: { expected: false, smooth: '0', correlate: false, baseline: false },
    scores: { choices: scoreChoices({ hasWeights: false }), current: 'count', onChange: () => {} },
    initial: { transform: 'log1p', colormap: 'default', defaults: { transform: 'log1p', colormap: 'default' } },
    lower,
    round,
  })
  built.push(panel)
  document.body.append(panel.el, panel.controlsEl)
  panel.setData(block(), 'two genomes')
  return panel
}

const tabs = (panel: MatrixPanel) => panel.controlsEl.querySelector<HTMLElement>('.map-tabs')!
const lowerPane = (panel: MatrixPanel) => panel.controlsEl.querySelector<HTMLElement>('.map-lower')
const tab = (panel: MatrixPanel, name: 'map' | 'lower') =>
  [...tabs(panel).querySelectorAll<HTMLButtonElement>('.map-tab')].find((node) => node.textContent?.endsWith(name))!

describe('the lower reading’s tabs on a map drawn round', () => {
  it('step aside with the square’s rows, and come back on the tab the reader left open', () => {
    const panel = map({ on: false })
    expect(panel.el.classList.contains('is-circle')).toBe(false)
    expect(tabs(panel).classList.contains('hidden')).toBe(false)
    tab(panel, 'lower').click()
    expect(lowerPane(panel)?.classList.contains('hidden')).toBe(false)

    panel.setCircle({ on: true })
    expect(panel.el.classList.contains('is-circle')).toBe(true)
    expect(tabs(panel).classList.contains('hidden')).toBe(true)
    // The map's own pane is the whole card — the circle's rows are in it — and
    // the lower one is not in the card at all.
    expect(lowerPane(panel)).toBeNull()
    expect(panel.controlsEl.querySelector('.map-tabs + *')?.classList.contains('hidden')).toBe(false)

    panel.setCircle({ on: false })
    expect(tabs(panel).classList.contains('hidden')).toBe(false)
    expect(tab(panel, 'lower').getAttribute('aria-selected')).toBe('true')
    expect(lowerPane(panel)?.classList.contains('hidden')).toBe(false)
  })

  it('leave the reading set, so the square under the circle keeps it', () => {
    const panel = map({ on: true })
    expect(panel.el.classList.contains('is-circle')).toBe(true)
    expect(tabs(panel).classList.contains('hidden')).toBe(true)
    panel.setCircle({ on: false })
    expect(tab(panel, 'lower').classList.contains('is-set')).toBe(true)
  })
})
