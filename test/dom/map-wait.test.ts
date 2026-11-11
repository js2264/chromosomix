// @vitest-environment jsdom
/**
 * The spinner a map shows while a sharper picture is on its way (§2).
 *
 * In the corner's top row, left of the keys, and alone in the corner where the
 * legend is off. An element rather than something the canvas draws: it turns
 * in CSS, so a wait never redraws the map, and a figure, drawn from the canvas,
 * never carries one. It waits a moment before showing, so a read served from
 * the chunk cache says nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import { getPlotOptions, setPlotOptions } from '@/ui/plotOptions'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []
const legend = getPlotOptions().legend

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  vi.useFakeTimers()
})

afterEach(() => {
  for (const panel of built.splice(0)) panel.destroy()
  setPlotOptions({ legend })
  vi.useRealTimers()
  teardown()
})

function panel(): MatrixPanel {
  const it = new MatrixPanel({ binsize: 10_000 })
  built.push(it)
  document.body.append(it.el)
  return it
}

/** The spinner, and the row it stands in. */
function spinner(it: MatrixPanel): HTMLElement {
  const mark = it.el.querySelector<HTMLElement>('.map-wait')
  if (mark === null) throw new Error('no spinner')
  return mark
}

describe('the spinner', () => {
  it('shows only once a wait has lasted a moment, and goes when it ends', () => {
    const it = panel()
    it.setWaiting(true)
    expect(spinner(it).hidden, 'a cached read says nothing').toBe(true)
    vi.advanceTimersByTime(200)
    expect(spinner(it).hidden).toBe(false)
    it.setWaiting(false)
    expect(spinner(it).hidden).toBe(true)
  })

  it('never shows for a wait that ends within the grace period', () => {
    const it = panel()
    it.setWaiting(true)
    vi.advanceTimersByTime(50)
    it.setWaiting(false)
    vi.advanceTimersByTime(500)
    expect(spinner(it).hidden).toBe(true)
  })

  it('stands in the corner’s top row, left of the keys', () => {
    const it = panel()
    const row = spinner(it).parentElement
    expect(row?.classList.contains('map-key-top')).toBe(true)
    const keys = it.el.querySelector('.map-keys')
    expect(keys?.parentElement).toBe(row)
    // Before the keys in a row that ends at the corner: left of the legend.
    expect(row?.firstElementChild).toBe(spinner(it))
  })

  it('stays in the corner where the legend is off', () => {
    const it = panel()
    setPlotOptions({ legend: false })
    expect(it.el.querySelector('.map-keys')?.classList.contains('hidden')).toBe(true)
    it.setWaiting(true)
    vi.advanceTimersByTime(200)
    expect(spinner(it).hidden).toBe(false)
  })

  it('leaves its grace period behind when the panel goes', () => {
    const it = panel()
    it.setWaiting(true)
    it.destroy()
    built.splice(built.indexOf(it), 1)
    expect((it as unknown as { waitTimer: unknown }).waitTimer).toBeNull()
    vi.advanceTimersByTime(500)
    expect(spinner(it).hidden).toBe(true)
  })
})
