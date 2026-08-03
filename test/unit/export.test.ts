/**
 * Saving the figure: the DPI arithmetic, and the PDF this app writes by hand.
 *
 * The PDF is the part worth pinning. A cross-reference table is a list of byte
 * offsets into the file itself, so an extra newline anywhere above it silently
 * corrupts every entry below — a reader either repairs the file or refuses it,
 * and neither is visible from the code. These tests read the offsets back out
 * of the bytes and check that each one lands on the object it claims.
 *
 * The DPI arithmetic is the other half of the promise: "300 dpi" has to mean
 * 300 dots per inch *on the page*, which is a relationship between the image's
 * pixel count and the page's size in points, not a number in a filename.
 */

import { describe, expect, it } from 'vitest'

import {
  CSS_DPI,
  canvasToPdf,
  exportBaseName,
  pointsForCssPixels,
  scaleForDpi,
} from '@/ui/export'

/** A canvas with nothing on it, which is all the PDF writer reads. */
function fakeCanvas(width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }),
  } as unknown as HTMLCanvasElement
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

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

describe('canvasToPdf', () => {
  it('writes a page whose size makes the image land at the asked-for DPI', async () => {
    // 625 x 313 device pixels of a 200 x 100 CSS-pixel figure, at 300 dpi.
    const canvas = fakeCanvas(625, 313)
    const pdf = await canvasToPdf(canvas, { dpi: 300 })
    const text = new TextDecoder('latin1').decode(await bytesOf(pdf))

    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)
    expect(box).not.toBeNull()
    const [pageWidth, pageHeight] = [Number(box?.[1]), Number(box?.[2])]
    // Points are 1/72 inch, so pixels / (points / 72) is dots per inch.
    expect(625 / (pageWidth / 72)).toBeCloseTo(300, 6)
    expect(313 / (pageHeight / 72)).toBeCloseTo(300, 6)
    expect(text).toContain('/Width 625 /Height 313')
    expect(text).toContain('/ColorSpace /DeviceRGB')
  })

  it('is a PDF a reader will open: header, xref offsets, trailer', async () => {
    const pdf = await canvasToPdf(fakeCanvas(8, 4), { dpi: 96, title: 'a map' })
    const bytes = await bytesOf(pdf)
    const text = new TextDecoder('latin1').decode(bytes)

    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/Title (a map)')

    // `startxref` points at the table; the table's entries point at the objects.
    const startxref = /startxref\s+(\d+)/.exec(text)
    expect(startxref).not.toBeNull()
    const tableAt = Number(startxref?.[1])
    expect(text.slice(tableAt, tableAt + 4)).toBe('xref')

    const entries = [...text.slice(tableAt).matchAll(/^(\d{10}) 00000 n $/gm)]
    expect(entries).toHaveLength(6)
    entries.forEach((entry, index) => {
      const offset = Number(entry[1])
      expect(text.startsWith(`${index + 1} 0 obj`, offset)).toBe(true)
    })
  })

  it('compresses the image, and says so', async () => {
    // 64 x 64 of black is 12 kB raw and a few dozen bytes deflated, so the
    // filter is measurable rather than merely declared.
    const pdf = await canvasToPdf(fakeCanvas(64, 64), { dpi: 96 })
    const text = new TextDecoder('latin1').decode(await bytesOf(pdf))
    expect(text).toContain('/Filter /FlateDecode')
    const length = /\/Length (\d+) >>\s*stream/.exec(text)
    expect(Number(length?.[1])).toBeLessThan(64 * 64 * 3)
  })
})
