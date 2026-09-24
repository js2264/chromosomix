// @vitest-environment jsdom
/**
 * The Export card's *track captions* switch (§7.2), and the style a caption
 * is written in when it is on.
 *
 * Two properties are asserted, both silent when wrong. The switch is one
 * preference, remembered and shared: turned off beside the map, it is off in
 * the 1D browser's card too, and still off tomorrow. And a figure's caption is
 * small and *fixed* — the reader's text size is about their screen, and a
 * caption that grew with it put the type of a panel heading over the signal it
 * only labels.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FIGURE_NAME_FONT, FIGURE_RANGE_FONT, figureLabelStyle } from '@/render/laneLabel'
import {
  DEFAULT_EXPORT_PREFS,
  getExportPrefs,
  resetExportPrefsForTests,
  setExportPref,
  trackCaptionsField,
} from '@/ui/exportPrefs'
import { setTextScale, TEXT_SCALE_STEPS } from '@/ui/textScale'

const KEY = 'metacooler-viewer:export'

beforeEach(() => {
  window.localStorage.clear()
  resetExportPrefsForTests()
})

afterEach(() => {
  setTextScale(1)
  document.body.replaceChildren()
})

/** The box a field row carries, and the row's label. */
function parts(row: HTMLElement): { box: HTMLInputElement; label: string } {
  const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (box === null) throw new Error('the row has no checkbox')
  return { box, label: row.querySelector('.field-label')?.textContent ?? '' }
}

describe('the track captions switch', () => {
  it('is on until a reader turns it off', () => {
    expect(DEFAULT_EXPORT_PREFS.trackCaptions).toBe(true)
    expect(getExportPrefs().trackCaptions).toBe(true)
    const row = trackCaptionsField()
    document.body.append(row)
    expect(parts(row)).toMatchObject({ label: 'track captions' })
    expect(parts(row).box.checked).toBe(true)
  })

  it('remembers the choice across a reload', () => {
    const row = trackCaptionsField()
    document.body.append(row)
    const { box } = parts(row)
    box.checked = false
    box.dispatchEvent(new Event('change'))
    expect(getExportPrefs().trackCaptions).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({ trackCaptions: false })
    // A fresh page: the cache forgotten, the stored value read back.
    resetExportPrefsForTests()
    expect(getExportPrefs().trackCaptions).toBe(false)
  })

  it('keeps both Export cards in step', () => {
    const beside = trackCaptionsField()
    const browser = trackCaptionsField()
    document.body.append(beside, browser)
    setExportPref('trackCaptions', false)
    expect(parts(beside).box.checked).toBe(false)
    expect(parts(browser).box.checked).toBe(false)
  })

  it('reads a stored value it does not understand as the default', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ trackCaptions: 'yes' }))
    expect(getExportPrefs().trackCaptions).toBe(true)
    window.localStorage.setItem(KEY, 'not json')
    resetExportPrefsForTests()
    expect(getExportPrefs().trackCaptions).toBe(true)
  })
})

describe('a caption in a saved figure', () => {
  it('is written smaller than on screen, and not in bold', () => {
    const style = figureLabelStyle()
    expect(style.nameFont).toBe(FIGURE_NAME_FONT)
    expect(style.rangeFont).toBe(FIGURE_RANGE_FONT)
    const px = (font: string): number => Number(/([\d.]+)px/.exec(font)?.[1])
    // The screen's smallest caption is nine pixels, beside a map, at 600.
    expect(px(style.nameFont)).toBeLessThan(9 * 0.75)
    expect(px(style.rangeFont)).toBeLessThanOrEqual(px(style.nameFont))
    expect(style.nameFont).not.toMatch(/\b(600|700|bold)\b/)
  })

  it('does not grow with the reader’s text size', () => {
    const at = TEXT_SCALE_STEPS.map((step) => {
      setTextScale(step)
      return figureLabelStyle()
    })
    for (const style of at) expect(style).toEqual(at[0])
  })

  it('keeps no room for controls a page does not have', () => {
    const style = figureLabelStyle()
    expect(style.autoSlot).toBe(0)
    expect(style.progressWidth).toBe(0)
  })
})
