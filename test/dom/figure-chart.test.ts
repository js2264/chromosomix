// @vitest-environment jsdom
/**
 * The one place the chart library and this application actually meet.
 *
 * Everything either side of it is tested apart — the option is a pure function
 * of a spec and a style (`figure-option`), the replay is a pure function of an
 * SVG picture (`svg-paint`) — and neither of those would catch the thing that
 * matters most here: that a real ECharts render, through a real
 * {@link VectorPage}, still comes out a *drawing*.
 *
 * That is the promise the whole overhaul was made under. A charting library
 * that could only give back pixels would have cost the PDF export, and a PDF
 * export that is a photograph of a plot is not an export at all — it is a
 * screenshot with a different extension, fifty times the size, that no journal
 * can restyle. So the assertions below are about the *bytes*: a font resource
 * for the axis labels, curve operators for the line, and no image anywhere.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chartFigure } from '@/figures/echartsFigure'
import { specOf, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle } from '@/figures/style'
import { VectorPage } from '@/ui/vector'
import type { CurveOutput } from '@/analysis/types'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let shimmedBlob: typeof Blob

beforeEach(async () => {
  teardown = setUpDom()
  // jsdom's `Blob` has no `stream()`, which both the deflate the page writes
  // with and the inflate below need. The platform's has one, and so does every
  // browser this runs in — so it is jsdom that is the odd environment here,
  // not the code.
  const { Blob: PlatformBlob } = await import('node:buffer')
  shimmedBlob = globalThis.Blob
  Object.defineProperty(globalThis, 'Blob', { value: PlatformBlob, configurable: true })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'Blob', { value: shimmedBlob, configurable: true })
  teardown()
})

function spec(): XyFigureSpec {
  const output: CurveOutput = {
    kind: 'curve',
    id: 'ps',
    label: 'Contact probability',
    xLabel: 'separation (bp)',
    yLabel: 'P(s)',
    xScale: 'linear',
    yScale: 'linear',
    series: [
      {
        name: 'chrI',
        x: new Float64Array([1, 2, 3, 4, 5]),
        y: new Float64Array([9, 4, 6, 2, 5]),
      },
      {
        name: 'chrII',
        x: new Float64Array([1, 2, 3, 4, 5]),
        y: new Float64Array([3, 7, 2, 8, 1]),
      },
    ],
  }
  return specOf(output) as XyFigureSpec
}

/** The page's content stream, inflated, the way `vector.test.ts` reads one. */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const latin1 = (raw: Uint8Array): string => new TextDecoder('latin1').decode(raw)
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

async function pdfOf(page: VectorPage, title: string): Promise<Uint8Array> {
  const blob = await page.toBlob({ title, created: new Date(0) })
  return new Uint8Array(await blob.arrayBuffer())
}

describe('chartFigure', () => {
  it('exports a real vector page: paths and text, no raster', async () => {
    const figure = chartFigure({ spec: spec(), style: defaultStyle(spec()) })
    document.body.append(figure.el)
    await figure.ready

    const box = { width: 640, height: 400 }
    const page = new VectorPage(box.width, box.height)
    figure.draw(page.ctx, box)
    const bytes = await pdfOf(page, 'P(s)')
    const text = new TextDecoder('latin1').decode(bytes)

    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text).not.toContain('/Subtype /Image')
    expect(text).toContain('/Helvetica')

    const content = await contentOf(bytes)
    // The two series and the grid are strokes; the axis labels are text runs.
    expect(content).toMatch(/\bS\b/)
    expect(content).toMatch(/\(chrI\) Tj/)
    // Escaped, because a parenthesis would close a PDF string early.
    expect(content).toMatch(/\(separation \\\(bp\\\)\) Tj/)

    figure.destroy()
  })

  it('draws the figure the reader has, not the one the task returned', async () => {
    const built = spec()
    const style = defaultStyle(built)
    style.hidden = ['chrII']
    style.legend = 'none'
    const figure = chartFigure({ spec: built, style })
    document.body.append(figure.el)
    await figure.ready

    const box = { width: 480, height: 300 }
    const page = new VectorPage(box.width, box.height)
    figure.draw(page.ctx, box)
    const content = await contentOf(await pdfOf(page, 'hidden'))
    // Neither the line nor a legend entry for a series that is switched off.
    expect(content).not.toContain('(chrII) Tj')

    figure.destroy()
  })

  it('draws at the size it is asked for, not at the size on screen', async () => {
    const figure = chartFigure({ spec: spec(), style: defaultStyle(spec()) })
    document.body.append(figure.el)
    await figure.ready

    const wide = new VectorPage(1200, 600)
    figure.draw(wide.ctx, { width: 1200, height: 600 })
    const text = new TextDecoder('latin1').decode(await pdfOf(wide, 'wide'))
    // 1200 CSS pixels is 900 points, whatever the drawer's column was.
    expect(text).toContain('/MediaBox [0 0 900 450]')

    figure.destroy()
  })

  it('takes a style change and redraws from it', async () => {
    const built = spec()
    const figure = chartFigure({ spec: built, style: defaultStyle(built) })
    document.body.append(figure.el)
    await figure.ready

    const style = defaultStyle(built)
    style.mark = 'points'
    figure.update(style)
    expect(figure.current().mark).toBe('points')

    const page = new VectorPage(400, 300)
    figure.draw(page.ctx, { width: 400, height: 300 })
    const content = await contentOf(await pdfOf(page, 'points'))
    // A scatter of five points per series is filled dots, not stroked runs.
    expect(content).toMatch(/\bf\b/)

    figure.destroy()
  })
})
