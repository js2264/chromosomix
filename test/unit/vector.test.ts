/**
 * The vector PDF: the drawing itself, rather than a picture of it.
 *
 * Two things here are silent when wrong and expensive to notice. The first is
 * the *page*: a cross-reference table is a list of byte offsets into the file,
 * so an extra newline above it corrupts every entry below, and a reader either
 * repairs the file or refuses it. The second is the *flip*: PDF's y runs up the
 * page and a canvas's runs down, so a figure whose transform is upside down is
 * still a perfectly valid PDF — of the wrong picture. Both are read back out of
 * the bytes here rather than trusted.
 *
 * The content stream is deflated, so every check inflates it first. That is
 * also the point of the compression test: a genome-wide view of a GTF is a few
 * hundred thousand path operators of repeated digits.
 */

import { describe, expect, it, vi } from 'vitest'

import { VectorPage, escapeText, parseFont, pdfAlpha, pdfColour } from '@/ui/vector'

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** The whole file as latin1, which is how a PDF's structure is meant to be read. */
function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

/**
 * Object 4's stream, inflated.
 *
 * Located by its declared `/Length` rather than by searching for `endstream`,
 * because compressed bytes contain that word as often as chance allows.
 */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const text = latin1(bytes)
  const header = /4 0 obj\n<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/.exec(text)
  if (header === null) throw new Error('no content stream')
  const at = (header.index ?? 0) + header[0].length
  const raw = bytes.slice(at, at + Number(header[1]))
  if (header[2] === undefined) return latin1(raw)
  const stream = new Blob([raw as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return latin1(new Uint8Array(await new Response(stream).arrayBuffer()))
}

describe('pdfColour', () => {
  it('reads the two notations this app produces', () => {
    expect(pdfColour('#ffffff')).toEqual([1, 1, 1])
    expect(pdfColour('#000')).toEqual([0, 0, 0])
    expect(pdfColour('#ff0000')).toEqual([1, 0, 0])
    // Eight digits is a hex colour with alpha; the alpha is `pdfAlpha`'s.
    expect(pdfColour('#00ff0080')).toEqual([0, 1, 0])
    expect(pdfColour('rgb(255, 128, 0)')[1]).toBeCloseTo(128 / 255, 6)
    expect(pdfColour('rgba(0, 0, 255, 0.5)')).toEqual([0, 0, 1])
    expect(pdfColour('rgb(255 128 0 / 50%)')[1]).toBeCloseTo(128 / 255, 6)
  })

  // `render/hue.ts` writes a lane's rotated categories — a gene on the other
  // strand, a read's other mate — as `hsl()`, and every one of them came out
  // black on a vector page beside a PNG that had them in colour.
  it('reads hsl() in both spellings, as CSS Color 4 converts it', () => {
    const close = (actual: number[], expected: number[]): void => {
      actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 3))
    }
    close(pdfColour('hsl(0 100% 50%)'), [1, 0, 0])
    close(pdfColour('hsl(120, 100%, 25%)'), [0, 0.5, 0])
    close(pdfColour('hsla(240, 100%, 50%, 0.4)'), [0, 0, 1])
    // What `hue.ts` writes for the reverse strand of a blue gene track.
    close(pdfColour('hsl(210 55% 48%)'), [0.216, 0.48, 0.744])
    // A hue is an angle, however it is written, and it wraps.
    close(pdfColour('hsl(0.5turn 100% 50%)'), [0, 1, 1])
    close(pdfColour('hsl(-120 100% 50%)'), [0, 0, 1])
    // No saturation is grey, whatever the hue.
    close(pdfColour('hsl(300 0% 40%)'), [0.4, 0.4, 0.4])
  })

  // Black is a visible wrong answer rather than a silent one — a named colour
  // would otherwise come out as whatever the last `rg` happened to leave behind.
  it('falls back to black on anything else', () => {
    expect(pdfColour('rebeccapurple')).toEqual([0, 0, 0])
    expect(pdfColour('')).toEqual([0, 0, 0])
    expect(pdfColour('#12345')).toEqual([0, 0, 0])
  })
})

describe('pdfAlpha', () => {
  it('is the opacity a colour carries of its own', () => {
    expect(pdfAlpha('rgba(0, 0, 255, 0.5)')).toBe(0.5)
    expect(pdfAlpha('rgb(0 0 255 / 25%)')).toBe(0.25)
    expect(pdfAlpha('hsl(210 55% 48% / 0.4)')).toBe(0.4)
    expect(pdfAlpha('#00ff0080')).toBeCloseTo(128 / 255, 6)
    expect(pdfAlpha('#0f08')).toBeCloseTo(136 / 255, 6)
    expect(pdfAlpha('transparent')).toBe(0)
  })

  it('is opaque for a colour that states none, or one it cannot read', () => {
    expect(pdfAlpha('#fff')).toBe(1)
    expect(pdfAlpha('rgb(1, 2, 3)')).toBe(1)
    expect(pdfAlpha('rebeccapurple')).toBe(1)
    // An alpha past either end is clamped, as the canvas clamps it.
    expect(pdfAlpha('rgba(0, 0, 0, 3)')).toBe(1)
    expect(pdfAlpha('rgba(0, 0, 0, -1)')).toBe(0)
  })
})

describe('parseFont', () => {
  it('takes the size and the weight out of a CSS shorthand', () => {
    expect(parseFont('11px system-ui, sans-serif')).toEqual({ size: 11, bold: false })
    expect(parseFont('bold 12.5px Helvetica')).toEqual({ size: 12.5, bold: true })
    expect(parseFont('600 10px ui-sans-serif')).toEqual({ size: 10, bold: true })
    expect(parseFont('italic serif')).toEqual({ size: 10, bold: false })
  })
})

describe('escapeText', () => {
  it('escapes what would close the string early', () => {
    expect(escapeText('(meta)cooler')).toBe('\\(meta\\)cooler')
    expect(escapeText('a\\b')).toBe('a\\\\b')
  })

  it('writes a non-ASCII byte in octal, and drops what WinAnsi has no byte for', () => {
    expect(escapeText('é')).toBe('\\351')
    expect(escapeText('chrI‑α')).toBe('chrI??')
  })

  // Every colour bar ends with `≤ 0.000061` under its lowest stop, and WinAnsi
  // has no byte for that sign — so the exported legend read `? 0.000061`.
  it('spells out the maths signs WinAnsi lacks', () => {
    expect(escapeText('≤ 0.000061')).toBe('<= 0.000061')
    expect(escapeText('≥ 1')).toBe('>= 1')
    expect(escapeText('−3')).toBe('-3')
  })

  // The one character in an ordinary figure that Latin-1 has no byte for: every
  // track writes its range as `0 – 130`.
  it('finds WinAnsi’s typography, en dash included', () => {
    expect(escapeText('0 – 130')).toBe('0 \\226 130')
    expect(escapeText('a … b • c')).toBe('a \\205 b \\225 c')
    expect(escapeText('0 · 1')).toBe('0 \\267 1')
  })

  // `fmt.int` groups digits in the *viewer's* locale, and half of Europe groups
  // them with a space that WinAnsi has no byte for. Without the fold, a figure
  // exported in French read `7?071 in view` — every grouped number corrupted by
  // the app's own formatter.
  it('folds the spaces a locale groups digits with onto the one WinAnsi has', () => {
    const french = new Intl.NumberFormat('fr-FR').format(7071)
    expect(french).not.toBe('7071')
    expect(escapeText(french)).toBe('7\\240071')
    expect(escapeText('7\u202f071')).toBe('7\\240071')
    expect(escapeText('7\u2009071')).toBe('7\\240071')
    // The one Latin-1 already had keeps its own byte, which is the same byte.
    expect(escapeText('7\u00a0071')).toBe('7\\240071')
  })
})

describe('VectorPage', () => {
  it('is a PDF a reader will open: header, xref offsets, trailer', async () => {
    const page = new VectorPage(200, 100)
    page.ctx.fillStyle = '#336699'
    page.ctx.fillRect(10, 10, 30, 20)
    const bytes = await bytesOf(await page.toBlob({ title: 'a genome' }))
    const text = latin1(bytes)

    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/Title (a genome)')

    const startxref = /startxref\s+(\d+)/.exec(text)
    expect(startxref).not.toBeNull()
    const tableAt = Number(startxref?.[1])
    expect(text.slice(tableAt, tableAt + 4)).toBe('xref')

    const entries = [...text.slice(tableAt).matchAll(/^(\d{10}) 00000 n $/gm)]
    expect(entries).toHaveLength(7)
    entries.forEach((entry, index) => {
      expect(text.startsWith(`${index + 1} 0 obj`, Number(entry[1]))).toBe(true)
    })
  })

  // CSS pixels are 1/96 inch and points are 1/72, so a 96-pixel figure is
  // 72 points wide however many marks are on it.
  it('sizes the page in points from the figure in CSS pixels', async () => {
    const page = new VectorPage(192, 96)
    const text = latin1(await bytesOf(await page.toBlob()))
    expect(text).toContain('/MediaBox [0 0 144 72]')
  })

  it('carries no image: the marks are paths', async () => {
    const page = new VectorPage(100, 50)
    page.ctx.fillRect(0, 0, 10, 10)
    const text = latin1(await bytesOf(await page.toBlob()))
    expect(text).not.toContain('/Subtype /Image')
    expect(await contentOf(await bytesOf(await page.toBlob()))).toMatch(/^f$/m)
  })

  // The whole of the coordinate conversion. A page drawn upside down is a
  // perfectly valid PDF of the wrong picture, which is exactly the kind of bug
  // that survives a review.
  it('flips y, so the top of the canvas is the top of the page', async () => {
    const page = new VectorPage(100, 50)
    page.ctx.beginPath()
    page.ctx.moveTo(0, 0)
    page.ctx.lineTo(100, 50)
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    // Canvas (0, 0) is the top-left, which in page space is y = height.
    expect(content).toContain('0 50 m')
    expect(content).toContain('100 0 l')
    // …and the one `cm` that turns pixels into points sits above it all.
    expect(content).toMatch(/^q 0\.75 0 0 0\.75 0 0 cm/)
  })

  it('bakes a translate and a rotate into the coordinates', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.save()
    page.ctx.translate(20, 30)
    page.ctx.beginPath()
    page.ctx.moveTo(0, 0)
    page.ctx.lineTo(10, 0)
    page.ctx.stroke()
    page.ctx.restore()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect(content).toContain('20 70 m')
    expect(content).toContain('30 70 l')
    // `save`/`restore` are `q`/`Q`, and they balance. One extra `Q` closes the
    // page-level `q … cm` the stream opens with.
    expect((content.match(/^q$/gm) ?? []).length).toBe(1)
    expect((content.match(/^Q$/gm) ?? []).length).toBe(2)
  })

  // An unmatched `restore` is a no-op on a canvas and a corrupt stream in a PDF.
  it('never writes a Q it has no q for', async () => {
    const page = new VectorPage(10, 10)
    page.ctx.restore()
    page.ctx.restore()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    // Only the one that closes the page's own `q … cm`.
    expect((content.match(/^Q$/gm) ?? []).length).toBe(1)
  })

  it('gives each distinct alpha its own graphics state, opaque included', async () => {
    const page = new VectorPage(50, 50)
    page.ctx.globalAlpha = 0.5
    page.ctx.fillRect(0, 0, 10, 10)
    page.ctx.globalAlpha = 1
    page.ctx.fillRect(10, 0, 10, 10)
    page.ctx.globalAlpha = 0.5
    page.ctx.fillRect(20, 0, 10, 10)
    const bytes = await bytesOf(await page.toBlob())
    const text = latin1(bytes)

    const names = [...text.matchAll(/\/(GS\d+) << \/Type \/ExtGState \/ca ([\d.]+)/g)]
    expect(names).toHaveLength(2)
    // Two states, two *different* names — a collision would make one dictionary
    // key win and tint half the figure.
    expect(new Set(names.map((match) => match[1])).size).toBe(2)
    expect(new Set(names.map((match) => match[2]))).toEqual(new Set(['0.5', '1']))
    // Opaque is restated rather than skipped, because PDF alpha is graphics
    // state and survives until something replaces it.
    const content = await contentOf(bytes)
    expect((content.match(/gs$/gm) ?? []).length).toBe(3)
  })

  // A canvas multiplies a colour's own alpha into `globalAlpha`. The loops on a
  // map are ringed in `rgba(…, 0.9)` over a fill of `rgba(…, 0.25)`; written
  // opaque, the fill hid the pixels the ring was drawn to show.
  it('folds a colour’s own alpha into the fill and stroke opacities', async () => {
    const page = new VectorPage(50, 50)
    page.ctx.globalAlpha = 0.5
    page.ctx.fillStyle = 'rgba(255, 0, 0, 0.4)'
    page.ctx.strokeStyle = '#0000ff'
    page.ctx.fillRect(0, 0, 10, 10)
    page.ctx.globalAlpha = 1
    page.ctx.strokeStyle = 'hsl(210 55% 48% / 0.3)'
    page.ctx.strokeRect(10, 0, 10, 10)
    const bytes = await bytesOf(await page.toBlob())
    const states = [...latin1(bytes).matchAll(/\/GS\d+ << \/Type \/ExtGState \/ca ([\d.]+) \/CA ([\d.]+) >>/g)]
    expect(states.map((match) => [match[1], match[2]])).toEqual([
      ['0.2', '0.5'],
      ['0.4', '0.3'],
    ])
    // The colour itself is written without its alpha.
    const content = await contentOf(bytes)
    expect(content).toContain('1 0 0 rg')
    expect(content).toContain('0.216 0.48 0.744 RG')
  })

  // A raster is drawn at `globalAlpha` alone, whatever colour was last set.
  it('draws a raster at globalAlpha, not at the fill colour’s alpha', async () => {
    // The page reads a raster's pixels through a scratch canvas, which is all
    // of the DOM this needs: white, as the page composites onto.
    const scratch = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => undefined,
        drawImage: () => undefined,
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      }),
    }
    vi.stubGlobal('document', { createElement: () => scratch })
    try {
      const page = new VectorPage(20, 20)
      page.ctx.fillStyle = 'rgba(0, 0, 0, 0.1)'
      page.ctx.globalAlpha = 0.8
      page.ctx.drawImage({ width: 2, height: 2 } as unknown as CanvasImageSource, 0, 0, 20, 20)
      const text = latin1(await bytesOf(await page.toBlob()))
      expect(text).toContain('/Subtype /Image')
      expect(text).toMatch(/\/ExtGState \/ca 0\.8 \/CA 0\.8 >>/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // The loops on a map and the beads of a model are circles drawn from 0 to 2π,
  // and a sweep of a whole turn taken modulo a whole turn is no sweep at all:
  // every one of them was a point, which is to say nothing on the page.
  it('draws a whole-turn arc as the whole circle', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.arc(50, 50, 20, 0, Math.PI * 2)
    page.ctx.fill()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    // Start at 3 o'clock, pass through 9 o'clock, and come back.
    expect(content).toContain('70 50 m')
    expect(content).toContain('30 50 l')
    expect(content).toMatch(/70 50 l\nf/)
    // A sweep past a whole turn is still one circle, not the remainder.
    const again = new VectorPage(100, 100)
    again.ctx.beginPath()
    again.ctx.arc(50, 50, 20, 0, Math.PI * 5)
    again.ctx.fill()
    expect(await contentOf(await bytesOf(await again.toBlob()))).toContain('30 50 l')
    // …and a part-turn is still a part-turn: a half from 0 ends at 9 o'clock.
    const half = new VectorPage(100, 100)
    half.ctx.beginPath()
    half.ctx.arc(50, 50, 20, 0, Math.PI)
    half.ctx.stroke()
    const halfContent = await contentOf(await bytesOf(await half.toBlob()))
    expect(halfContent).toMatch(/30 50 l\nS/)
    expect(halfContent).not.toContain('50 70 l')
  })

  it('writes text as text, in a base-14 font, bold when asked', async () => {
    const page = new VectorPage(200, 40)
    page.ctx.font = '11px system-ui'
    page.ctx.fillText('chrI:1,000', 5, 20)
    page.ctx.font = 'bold 13px system-ui'
    page.ctx.fillText('(x)', 5, 35)
    const bytes = await bytesOf(await page.toBlob())
    expect(latin1(bytes)).toContain('/BaseFont /Helvetica-Bold')

    const content = await contentOf(bytes)
    expect(content).toContain('(chrI:1,000) Tj')
    expect(content).toContain('/F1 11 Tf')
    expect(content).toContain('/F2 13 Tf')
    // Parentheses in a track name would otherwise close the literal string.
    expect(content).toContain('(\\(x\\)) Tj')
  })

  // `laneText` strokes a halo behind each label so a name survives over the
  // track's own ink. PDF has a render mode for exactly that, so the figure keeps
  // what the screen had rather than putting a name straight onto the features.
  it('keeps a label’s halo, as a stroked run under the filled one', async () => {
    const page = new VectorPage(100, 20)
    page.ctx.strokeStyle = '#ffffff'
    page.ctx.lineWidth = 3
    page.ctx.strokeText('name', 5, 10)
    page.ctx.fillStyle = '#000000'
    page.ctx.fillText('name', 5, 10)
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect((content.match(/\(name\) Tj/g) ?? []).length).toBe(2)
    // Stroke first, at the halo's colour and width; then the fill over it.
    // `[] 0 d` is the dash pattern, part of the stroke state since the
    // alignment lane needed a dotted mate thread: empty is solid, which is what
    // an empty pattern means on a canvas too.
    expect(content).toMatch(/1 1 1 RG\n3 w\n0 j\n0 J\n\[\] 0 d\nBT\n1 Tr/)
    expect(content.indexOf('1 Tr')).toBeLessThan(content.indexOf('0 Tr'))
  })

  it('promotes a quadratic to the cubic PDF has, keeping the endpoints', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.moveTo(0, 100)
    page.ctx.quadraticCurveTo(50, 0, 100, 100)
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    // Control points at two thirds of the way to the quadratic's, and the curve
    // still ends where it was told to.
    expect(content).toContain('33.333 66.667 66.667 66.667 100 0 c')
  })

  it('clips with the current path rather than painting it', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.save()
    page.ctx.beginPath()
    page.ctx.rect(10, 10, 50, 50)
    page.ctx.clip()
    page.ctx.restore()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect(content).toContain('W n')
    // The rectangle went into the clip, so it is not also filled.
    expect(content).not.toMatch(/^f$/m)
  })

  it('compresses the content stream, and says so', async () => {
    const page = new VectorPage(400, 400)
    for (let i = 0; i < 2000; i++) page.ctx.fillRect(i % 400, (i * 7) % 400, 3, 3)
    const bytes = await bytesOf(await page.toBlob())
    const text = latin1(bytes)
    expect(text).toContain('/Filter /FlateDecode')
    const declared = /4 0 obj\n<< \/Length (\d+) \/Filter/.exec(text)
    const content = await contentOf(bytes)
    expect(Number(declared?.[1])).toBeLessThan(content.length / 4)
  })
})

describe('the state a charted figure needs', () => {
  it('writes the line cap, so a tick is the length the screen drew it', async () => {
    const page = new VectorPage(100, 50)
    const ctx = page.ctx
    ctx.strokeStyle = '#000000'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(10, 10)
    ctx.lineTo(40, 10)
    ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob({ title: 'cap' })))
    expect(content).toContain('1 J')
  })

  it('composes a transform rather than replacing the caller’s', async () => {
    const page = new VectorPage(100, 100)
    const ctx = page.ctx
    ctx.translate(20, 30)
    // A doubling about the new origin: the point (5, 5) must land at (30, 40),
    // which on a page whose y runs up is (30, 60).
    ctx.transform(2, 0, 0, 2, 0, 0)
    ctx.fillStyle = '#000000'
    ctx.beginPath()
    ctx.moveTo(5, 5)
    ctx.lineTo(6, 5)
    ctx.fill()
    const content = await contentOf(await bytesOf(await page.toBlob({ title: 'compose' })))
    expect(content).toContain('30 60 m')
  })
})
