/**
 * The vector PDF: the drawing itself, rather than a picture of it.
 *
 * Three things here are silent when wrong and expensive to notice. The first is
 * the *page*: a cross-reference table is a list of byte offsets into the file,
 * so an extra newline above it corrupts every entry below, and a reader either
 * repairs the file or refuses it. The second is the *flip*: PDF's y runs up the
 * page and a canvas's runs down, so a figure whose transform is upside down is
 * still a perfectly valid PDF — of the wrong picture. The third is the *path*:
 * a canvas keeps it through a fill and the stroke after it, and PDF ends it at
 * the fill, so a page that forgets the difference still writes a PDF every
 * reader opens — whose stroke has nothing to draw. All three are read back out
 * of the bytes here rather than trusted.
 *
 * The content stream is deflated, so every check inflates it first. That is
 * also the point of the compression test: a genome-wide view of a GTF is a few
 * hundred thousand path operators of repeated digits.
 */

import { describe, expect, it } from 'vitest'

import { VectorPage, escapeText, parseFont, pdfColour } from '@/ui/vector'

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

/**
 * The content stream as a reader paints it: each painting operator with the
 * path construction in front of it.
 *
 * A PDF path is ended by the operator that paints it, so a paint with nothing
 * in front of it draws nothing — which is what a bare `S` after a fill did.
 * Anything but construction inside a path object is a broken stream, and is
 * thrown on rather than skipped.
 */
function paintsOf(content: string): Array<{ op: string; path: string[] }> {
  const paints: Array<{ op: string; path: string[] }> = []
  let path: string[] = []
  for (const line of content.split('\n')) {
    if (/ [mlc]$| re$|^h$/.test(line)) path.push(line)
    else if (/^(?:f\*?|S|W\*? n)$/.test(line)) {
      paints.push({ op: line, path })
      path = []
    } else if (path.length > 0) throw new Error(`\`${line}\` inside a path object`)
  }
  return paints
}

async function paintsOfPage(page: VectorPage): Promise<Array<{ op: string; path: string[] }>> {
  return paintsOf(await contentOf(await bytesOf(await page.toBlob())))
}

describe('pdfColour', () => {
  it('reads the two notations this app produces', () => {
    expect(pdfColour('#ffffff')).toEqual([1, 1, 1])
    expect(pdfColour('#000')).toEqual([0, 0, 0])
    expect(pdfColour('#ff0000')).toEqual([1, 0, 0])
    // Eight digits is a hex colour with alpha; the alpha is `globalAlpha`'s job.
    expect(pdfColour('#00ff0080')).toEqual([0, 1, 0])
    expect(pdfColour('rgb(255, 128, 0)')[1]).toBeCloseTo(128 / 255, 6)
    expect(pdfColour('rgba(0, 0, 255, 0.5)')).toEqual([0, 0, 1])
  })

  // Black is a visible wrong answer rather than a silent one — a named colour
  // would otherwise come out as whatever the last `rg` happened to leave behind.
  it('falls back to black on anything else', () => {
    expect(pdfColour('rebeccapurple')).toEqual([0, 0, 0])
    expect(pdfColour('')).toEqual([0, 0, 0])
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
    expect(escapeText('P(s) of IV')).toBe('P\\(s\\) of IV')
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

  // The figure's provenance, where `pdfinfo` looks for it first: a figure
  // dropped into a manuscript keeps its name and its date when the caption is
  // cropped off.
  it('writes the title, the producer and the date it was made', async () => {
    const page = new VectorPage(20, 20)
    const created = new Date(Date.UTC(2026, 7, 3, 14, 52, 33))
    const text = latin1(await bytesOf(await page.toBlob({ title: 'a deck', created })))
    expect(text).toContain('/Title (a deck)')
    expect(text).toContain('/Producer (')
    expect(text).toContain('/CreationDate (D:20260803145233Z)')
  })

  // What the deck's figure stands on: a cell's drawing sets absolute
  // transforms of its own, and the origin is applied inside them, so the cell
  // lands at its place on the page as itself rather than at the page's corner.
  it('places a sub-drawing at its origin, absolute transforms and all', async () => {
    const page = new VectorPage(200, 100)
    page.setOrigin(120, 30)
    page.ctx.setTransform(2, 0, 0, 2, 0, 0)
    page.ctx.beginPath()
    page.ctx.moveTo(5, 5)
    page.ctx.lineTo(10, 5)
    page.ctx.stroke()
    page.setOrigin(0, 0)
    page.ctx.setTransform(1, 0, 0, 1, 0, 0)
    page.ctx.beginPath()
    page.ctx.moveTo(1, 1)
    page.ctx.lineTo(2, 1)
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    // (5, 5) at twice the size is (10, 10), then 120 across and 30 down; the
    // page's y runs up, so 40 down a 100-pixel page is 60.
    expect(content).toContain('130 60 m')
    expect(content).toContain('140 60 l')
    // Back at the page's own corner once the origin is put back.
    expect(content).toContain('1 99 m')
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

  // A whole turn is the whole circle, as the canvas has it. The flattening took
  // the sweep modulo a turn, which read exactly one turn as none: every full
  // circle — a points lane's dots, a loop's ring — was a path of zero length.
  it('draws a full circle whole', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.arc(50, 50, 10, 0, Math.PI * 2)
    page.ctx.fill()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    // A move, then four quarter turns as cubics; every curve's end is on the circle.
    expect(content.match(/ m$/gm) ?? []).toHaveLength(1)
    expect(content.match(/ c$/gm) ?? []).toHaveLength(4)
    const points = [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) [mc]$/gm)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ])
    for (const [x, y] of points) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(10, 2)
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    // It reaches both sides of the centre on both axes: a circle, not a point.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 0)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 0)
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

  it('fills with a radial gradient as a shading painted through the path', async () => {
    const page = new VectorPage(100, 100)
    const ctx = page.ctx
    const gradient = ctx.createRadialGradient(40, 40, 0, 50, 50, 10)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(0.5, '#ff0000')
    gradient.addColorStop(1, '#000000')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(50, 50, 10, 0, Math.PI * 2)
    ctx.fill()
    // A colour string afterwards is a flat fill again.
    ctx.fillStyle = '#00ff00'
    ctx.fillRect(0, 0, 5, 5)
    const bytes = await bytesOf(await page.toBlob({ title: 'gradient' }))
    const file = latin1(bytes)
    const content = await contentOf(bytes)
    // In page space, y flipped, as every path is: (40, 40) → (40, 60).
    expect(file).toContain('/Sh0 << /ShadingType 3 /ColorSpace /DeviceRGB /Coords [40 60 0 50 50 10]')
    expect(file).toContain('/FunctionType 3')
    expect(file).toContain('/Bounds [0.5]')
    expect(content).toMatch(/q\n[^]*W n\n\/Sh0 sh\nQ/)
    expect(content).toContain('0 1 0 rg')
  })

  it('draws an arc as cubics on the circle, the way the canvas turns', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    // Counter-clockwise a quarter turn, from the right to the top: on the page,
    // whose y runs up, the top of the circle is y = 60.
    page.ctx.arc(50, 50, 10, 0, -Math.PI / 2, true)
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect(content).toContain('60 50 m')
    expect(content).toMatch(/ 50 60 c$/m)
    // The control points of a quarter turn sit 0.5523 of the radius along the tangents.
    expect(content).toContain('60 55.523 55.523 60 50 60 c')
  })
})

/** `rect(10, 10, 20, 20)` on a 100-pixel page, whose y runs up. */
const SQUARE = ['10 90 m', '30 90 l', '30 70 l', '10 70 l', 'h']

// A canvas's `fill`, `stroke` and `clip` read the current path and leave it,
// until `beginPath`; a PDF painting operator ends the path it paints. The page
// wrote its path once and let it go, so a shape filled and then stroked
// printed a bare `S`: a box plot's outline, whiskers and median, the reader's
// arrowheads, a bar track's outline and the browser's chips, all gone.
describe('the current path, kept as a canvas keeps it', () => {
  it('writes a path filled and then stroked in front of both', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.rect(10, 10, 20, 20)
    page.ctx.fill()
    page.ctx.stroke()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'f', path: SQUARE },
      { op: 'S', path: SQUARE },
    ])
  })

  // The reader's arrowhead: a halo stroked in the page's colour, then the
  // mark's own colour filled over it. Only the halo used to reach the PDF.
  it('writes a path stroked and then filled in front of both', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.moveTo(50, 10)
    page.ctx.lineTo(60, 30)
    page.ctx.lineTo(40, 30)
    page.ctx.closePath()
    page.ctx.strokeStyle = '#ffffff'
    page.ctx.stroke()
    page.ctx.fillStyle = '#ff0000'
    page.ctx.fill()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    const triangle = ['50 90 m', '60 70 l', '40 70 l', 'h']
    expect(paintsOf(content)).toEqual([
      { op: 'S', path: triangle },
      { op: 'f', path: triangle },
    ])
    // In the mark's colour, not left at the halo's.
    expect(content).toMatch(/^1 0 0 rg\n50 90 m$/m)
  })

  it('fills, clips to and fills again one path', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.rect(10, 10, 20, 20)
    page.ctx.fill()
    page.ctx.save()
    page.ctx.clip()
    page.ctx.fill()
    page.ctx.restore()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'f', path: SQUARE },
      { op: 'W n', path: SQUARE },
      { op: 'f', path: SQUARE },
    ])
  })

  it('empties the path at beginPath, and nowhere else', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.rect(10, 10, 20, 20)
    page.ctx.fill()
    page.ctx.beginPath()
    page.ctx.moveTo(0, 50)
    page.ctx.lineTo(100, 50)
    page.ctx.stroke()
    // Nothing to paint is nothing written, rather than a bare operator.
    page.ctx.beginPath()
    page.ctx.fill()
    page.ctx.stroke()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'f', path: SQUARE },
      { op: 'S', path: ['0 50 m', '100 50 l'] },
    ])
  })

  // As a canvas has it: the second stroke strokes both lines, because nothing
  // between the two emptied the path.
  it('adds what is moved to after a paint to the same path', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.moveTo(0, 10)
    page.ctx.lineTo(50, 10)
    page.ctx.stroke()
    page.ctx.moveTo(0, 20)
    page.ctx.lineTo(50, 20)
    page.ctx.stroke()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'S', path: ['0 90 m', '50 90 l'] },
      { op: 'S', path: ['0 90 m', '50 90 l', '0 80 m', '50 80 l'] },
    ])
  })

  it('paints a fillRect and a strokeRect without disturbing a path being built', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.moveTo(0, 50)
    page.ctx.fillRect(10, 10, 20, 20)
    page.ctx.strokeRect(10, 10, 20, 20)
    page.ctx.clearRect(0, 0, 100, 100)
    page.ctx.lineTo(100, 50)
    page.ctx.stroke()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'f', path: SQUARE },
      { op: 'S', path: SQUARE },
      { op: 'S', path: ['0 50 m', '100 50 l'] },
    ])
  })

  // A canvas places a path's points under the transform current when they are
  // added, and scales a stroke's width by the one current when it strokes.
  it('keeps a path where it was built, at the width of the transform it is stroked under', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.setTransform(2, 0, 0, 2, 0, 0)
    page.ctx.beginPath()
    page.ctx.rect(5, 5, 10, 10)
    page.ctx.fill()
    page.ctx.lineWidth = 3
    page.ctx.setTransform(1, 0, 0, 1, 0, 0)
    page.ctx.stroke()
    page.ctx.setTransform(4, 0, 0, 4, 0, 0)
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect(paintsOf(content)).toEqual([
      { op: 'f', path: SQUARE },
      { op: 'S', path: SQUARE },
      { op: 'S', path: SQUARE },
    ])
    expect(content.match(/^[\d.]+ w$/gm)).toEqual(['3 w', '12 w'])
  })

  // The path is not drawing state: a canvas's `restore` lets go of the clip
  // and keeps the path that made it.
  it('outlives the restore of the save it was built in', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.save()
    page.ctx.rect(10, 10, 20, 20)
    page.ctx.clip()
    page.ctx.restore()
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect(paintsOf(content)).toEqual([
      { op: 'W n', path: SQUARE },
      { op: 'S', path: SQUARE },
    ])
    expect(content).toMatch(/^W n\nQ$/m)
  })

  // A sub-drawing placed at an origin has a canvas of its own on screen, and a
  // canvas starts with no path: the path one deck cell leaves is not the
  // next cell's to paint.
  it('starts each sub-drawing placed at an origin on an empty path', async () => {
    const page = new VectorPage(100, 100)
    page.setOrigin(10, 10)
    page.ctx.beginPath()
    page.ctx.rect(0, 0, 20, 20)
    page.ctx.fill()
    page.setOrigin(50, 50)
    page.ctx.stroke()
    page.ctx.moveTo(0, 0)
    page.ctx.lineTo(10, 0)
    page.ctx.stroke()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'f', path: SQUARE },
      { op: 'S', path: ['50 50 m', '60 50 l'] },
    ])
  })

  it('keeps the path after a gradient fill, for the stroke round it', async () => {
    const page = new VectorPage(100, 100)
    const gradient = page.ctx.createRadialGradient(20, 20, 0, 20, 20, 10)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(1, '#000000')
    page.ctx.fillStyle = gradient
    page.ctx.beginPath()
    page.ctx.rect(10, 10, 20, 20)
    page.ctx.fill()
    page.ctx.stroke()
    const content = await contentOf(await bytesOf(await page.toBlob()))
    expect(paintsOf(content)).toEqual([
      { op: 'W n', path: SQUARE },
      { op: 'S', path: SQUARE },
    ])
    expect(content).toMatch(/^W n\n\/Sh0 sh\nQ$/m)
  })

  // A closed subpath hands its start on: on a canvas and after PDF's `h`
  // alike, what follows begins there, so a curve's handles are worked out
  // from there — and a line drawn on an empty path is a move.
  it('starts what follows a closePath where the closed subpath began', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.closePath()
    page.ctx.lineTo(10, 10)
    page.ctx.lineTo(40, 10)
    page.ctx.lineTo(40, 40)
    page.ctx.closePath()
    page.ctx.quadraticCurveTo(10, 70, 40, 70)
    page.ctx.stroke()
    // From (10, 10): the first handle two thirds of the way to (10, 70), the
    // second two thirds of the way to it from (40, 70).
    expect(await paintsOfPage(page)).toEqual([
      { op: 'S', path: ['10 90 m', '40 90 l', '40 60 l', 'h', '10 50 20 30 40 30 c'] },
    ])
  })

  it('fills and clips by the even-odd rule when asked to', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.beginPath()
    page.ctx.rect(0, 0, 100, 100)
    page.ctx.rect(25, 25, 50, 50)
    page.ctx.fill('evenodd')
    page.ctx.clip('evenodd')
    page.ctx.fill()
    expect((await paintsOfPage(page)).map((paint) => paint.op)).toEqual(['f*', 'W* n', 'f'])
  })

  // A canvas clipped to nothing draws nothing; PDF's `W` must have a path.
  it('clips everything away with an empty path, as a canvas does', async () => {
    const page = new VectorPage(100, 100)
    page.ctx.save()
    page.ctx.beginPath()
    page.ctx.clip()
    page.ctx.fillRect(10, 10, 20, 20)
    page.ctx.restore()
    expect(await paintsOfPage(page)).toEqual([
      { op: 'W n', path: ['0 0 0 0 re'] },
      { op: 'f', path: SQUARE },
    ])
  })
})
