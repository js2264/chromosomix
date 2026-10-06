// @vitest-environment jsdom
/**
 * How to zoom into a region, said in the picture's corner while the pointer is
 * over it (§7.2) — the map's under its key, the 1D browser's under its ruler.
 *
 * What is pinned is what the words say, since that is what changes with the
 * picture: Option and Shift's line only where there is a diagonal for Shift to
 * pin a box to, Option's alone under the diagonal lock (which already pins it),
 * a stretch under a turn, and the reader's own modifiers. That it shows only
 * on hover is a stylesheet rule, which jsdom does not apply; the gallery script
 * `scripts/ui-reframe-hint.mjs` looks at it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
import { AnnotationStore } from '@/annotations/store'
import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { assemblyOf } from '@/genome/assembly'
import { SequenceSelection } from '@/genome/selection'
import { BrowserView } from '@/ui/BrowserView'
import { resetDiagonalLock, setDiagonalLocked } from '@/ui/diagonalLock'
import { MatrixPanel } from '@/ui/MatrixPanel'
import { setPlotOption } from '@/ui/plotOptions'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const panels: MatrixPanel[] = []
const views: BrowserView[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.localStorage.clear()
  resetDiagonalLock()
})

afterEach(() => {
  for (const panel of panels.splice(0, panels.length)) panel.destroy()
  for (const view of views.splice(0, views.length)) view.destroy()
  teardown()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetDiagonalLock()
})

/** A map of `rows × cols`, laid out in a 400-pixel box, since jsdom lays nothing out. */
function map(rows: [number, number], cols: [number, number]): MatrixPanel {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
  panels.push(panel)
  document.body.append(panel.el)
  const nrows = rows[1] - rows[0]
  const ncols = cols[1] - cols[0]
  panel.setData(
    {
      nrows,
      ncols,
      values: new Float32Array(nrows * ncols).fill(1),
      rowExtent: rows,
      colExtent: cols,
      rowGroups: [{ label: 'IV', start: 0, end: nrows, unitStart: rows[0] }],
      colGroups: [{ label: 'IV', start: 0, end: ncols, unitStart: cols[0] }],
      level: 'bin',
      binsPerCell: 1,
    } as unknown as MatrixResult,
    'IV',
  )
  return panel
}

const lines = (root: ParentNode, selector: string): string[] =>
  [...(root.querySelector(selector)?.children ?? [])].map((line) => line.textContent ?? '')

describe('on a map', () => {
  it('says Option and a drag, and Shift with it for the diagonal, where there is one', () => {
    const panel = map([0, 40], [0, 40])
    expect(lines(panel.el, '.map-hint')).toEqual([
      'Alt + drag to zoom into a region',
      'Shift + Alt + drag to zoom along the diagonal',
    ])
  })

  it('says Option alone under the diagonal lock, which already pins the box', () => {
    const panel = map([0, 40], [0, 40])
    setDiagonalLocked(true)
    expect(lines(panel.el, '.map-hint')).toEqual(['Alt + drag to zoom along the diagonal'])
    setDiagonalLocked(false)
    expect(lines(panel.el, '.map-hint')).toHaveLength(2)
  })

  it('leaves Shift out on a block the diagonal does not cross', () => {
    const panel = map([0, 40], [100, 140])
    expect(lines(panel.el, '.map-hint')).toEqual(['Alt + drag to zoom into a region'])
  })

  it('prints a Mac’s own marks on a Mac', () => {
    vi.stubGlobal('navigator', { ...window.navigator, platform: 'MacIntel', userAgent: 'MacIntel' })
    const panel = map([0, 40], [0, 40])
    expect(lines(panel.el, '.map-hint')).toEqual([
      '⌥ + drag to zoom into a region',
      '⇧ + ⌥ + drag to zoom along the diagonal',
    ])
  })

  it('stays in the corner with the legend off, the keys gone from above it', () => {
    const panel = map([0, 40], [0, 40])
    setPlotOption('legend', false)
    try {
      const slot = panel.el.querySelector('.map-key-slot')
      expect(slot?.classList.contains('hidden')).toBe(false)
      expect(slot?.querySelector('.map-keys')?.classList.contains('hidden')).toBe(true)
      expect(slot?.querySelector('.map-hint')?.classList.contains('hidden')).toBe(false)
    } finally {
      setPlotOption('legend', true)
    }
  })
})

describe('in the 1D browser', () => {
  /** A worker that takes every request and answers none. */
  class SilentWorker {
    onmessage: unknown = null
    onerror: unknown = null
    postMessage(): void {}
    terminate(): void {}
  }

  it('says Option and a drag over the tracks, or a drag along the ruler, under the ruler', () => {
    const key = `reframe-${Math.random()}`
    const view = new BrowserView({
      assembly: assemblyOf({ uri: key, name: key, contigs: [{ name: 'I', length: 1_000 }], origin: 'sizes' }),
      store: new AnnotationStore(key, { persist: false }),
      client: new AnnotationClient(() => new SilentWorker() as unknown as Worker),
      selection: new SequenceSelection(),
      groups: new GroupSettings(key),
      manual: new ManualStore(key),
      onLocusChange: () => {},
    })
    views.push(view)
    expect(lines(view.el, '.browser-hint')).toEqual(['Alt + drag to zoom into a stretch', 'or drag along the ruler'])
    const hint = view.el.querySelector<HTMLElement>('.browser-hint')
    expect(Number.parseFloat(hint?.style.top ?? '')).toBeGreaterThan(0)
  })
})
