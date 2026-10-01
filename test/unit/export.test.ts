/**
 * Saving the figure: the DPI arithmetic, the names, and what the formats are
 * called.
 *
 * The DPI arithmetic is the promise a PNG makes: "300 dpi" has to mean 300
 * dots per inch *on the page*, which is a relationship between the image's
 * pixel count and the page's size in points, not a number in a filename. The
 * PDF this app writes by hand is a vector page, and its bytes — the
 * cross-reference offsets, the flip, the compression — are pinned where it is
 * written, in `vector.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import {
  CSS_DPI,
  EXPORT_FORMATS,
  captionStamp,
  exportBaseName,
  fileStamp,
  pointsForCssPixels,
  scaleForDpi,
} from '@/ui/export'

describe('DPI', () => {
  it('scales from the CSS pixel, which is defined as 1/96 inch', () => {
    expect(scaleForDpi(CSS_DPI)).toBe(1)
    expect(scaleForDpi(300)).toBeCloseTo(3.125, 10)
    expect(pointsForCssPixels(96)).toBe(72)
  })
})

describe('exportBaseName', () => {
  it('keeps a name a filesystem can hold', () => {
    expect(exportBaseName('NC_000913.3')).toBe('NC_000913.3')
    expect(exportBaseName('metator_00002_00001 × metator_00001_00000')).toBe(
      'metator_00002_00001_x_metator_00001_00000',
    )
    expect(exportBaseName('contig:1000-2000')).toBe('contig_1000-2000')
    expect(exportBaseName('   ')).toBe('contact-map')
    expect(exportBaseName('')).toBe('contact-map')
  })
})

describe('the formats a map writes', () => {
  // The PDF is a vector page with the cells the one image on it (§7.2), and
  // the label is what tells a reader opening it in Illustrator that there is
  // something to restyle — the same words the 1D browser's card uses.
  it('offers the PDF as vector, first, and the PNG after it', () => {
    expect(EXPORT_FORMATS.map((format) => format.label)).toEqual(['PDF (vector)', 'PNG'])
    expect(EXPORT_FORMATS.map((format) => format.value)).toEqual(['pdf', 'png'])
  })
})

describe('timestamps', () => {
  // Local time on purpose: the person reading the filename is the person who
  // pressed the button. Constructed from parts rather than from an ISO string,
  // which would be parsed as UTC and shift the expectation with the runner.
  const noon = new Date(2026, 7, 3, 14, 52, 33)

  it('stamps a filename sortably, to the second', () => {
    expect(fileStamp(noon)).toBe('20260803-145233')
  })

  it('pads every field, so the sort is a string sort', () => {
    expect(fileStamp(new Date(2026, 0, 9, 1, 2, 3))).toBe('20260109-010203')
  })

  it('writes the same instant for a human on the figure', () => {
    expect(captionStamp(noon)).toBe('2026-08-03 14:52')
  })
})
