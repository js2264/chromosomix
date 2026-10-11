// @vitest-environment jsdom
/**
 * The Export card's *caption* switch (§7.2): whether a saved figure writes
 * under itself what it shows.
 *
 * One preference, remembered and shared — turned off beside the map, it is off
 * in the 1D browser's card too, and still off tomorrow — and one the figure
 * obeys: off, the figure ends at its lowest track, with no room kept for a line
 * that is not written.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EXPORT_PREFS,
  captionField,
  getExportPrefs,
  resetExportPrefsForTests,
  setExportPref,
} from '@/ui/exportPrefs'
import { MatrixPanel } from '@/ui/MatrixPanel'
import { setUpDom, type DomTeardown } from '../support/dom'

const KEY = 'chromosomix:export'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.localStorage.clear()
  resetExportPrefsForTests()
})

afterEach(() => {
  teardown()
})

/** The box a field row carries, and the row's label. */
function parts(row: HTMLElement): { box: HTMLInputElement; label: string } {
  const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (box === null) throw new Error('the row has no checkbox')
  return { box, label: row.querySelector('.field-label')?.textContent ?? '' }
}

describe('the caption switch', () => {
  it('is on until a reader turns it off', () => {
    expect(DEFAULT_EXPORT_PREFS.caption).toBe(true)
    expect(getExportPrefs().caption).toBe(true)
    const row = captionField()
    document.body.append(row)
    expect(parts(row).label).toBe('caption')
    expect(parts(row).box.checked).toBe(true)
  })

  it('remembers the choice across a reload', () => {
    const row = captionField()
    document.body.append(row)
    const { box } = parts(row)
    box.checked = false
    box.dispatchEvent(new Event('change'))
    expect(getExportPrefs().caption).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({ caption: false })
    // A fresh page: the cache forgotten, the stored value read back.
    resetExportPrefsForTests()
    expect(getExportPrefs().caption).toBe(false)
  })

  it('keeps both Export cards in step', () => {
    const beside = captionField()
    const browser = captionField()
    document.body.append(beside, browser)
    setExportPref('caption', false)
    expect(parts(beside).box.checked).toBe(false)
    expect(parts(browser).box.checked).toBe(false)
  })

  it('reads a stored value it does not understand as the default', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ caption: 'yes' }))
    expect(getExportPrefs().caption).toBe(true)
    window.localStorage.setItem(KEY, 'not json')
    resetExportPrefsForTests()
    expect(getExportPrefs().caption).toBe(true)
  })
})

describe('a saved map figure', () => {
  it('keeps room for its caption only while the switch is on', () => {
    const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
    document.body.append(panel.el)
    try {
      const captioned = panel.exportCanvas(96, new Date(2026, 8, 24))
      setExportPref('caption', false)
      const bare = panel.exportCanvas(96, new Date(2026, 8, 24))
      // At 96 dpi a CSS pixel is a pixel: the difference is the caption block,
      // a subject line and at least one line of provenance under it.
      expect(captioned.height - bare.height).toBeGreaterThanOrEqual(10 + 15)
      expect(bare.width).toBe(captioned.width)
    } finally {
      panel.destroy()
    }
  })
})
