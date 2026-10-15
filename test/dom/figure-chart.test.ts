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
import { specOf, type MatrixFigureSpec, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle } from '@/figures/style'
import { VectorPage, pdfColour } from '@/ui/vector'
import type { CurveOutput, MatrixOutput } from '@/analysis/types'
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

/** A channel as the page writes it: three decimals, trailing zeros dropped. */
function trim(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, '')
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

  /**
   * The one thing a pure test of the option cannot see.
   *
   * A violin is a `custom` series: the option can be perfectly well formed and
   * the renderer can still draw nothing, because the datum it hangs on was
   * filtered out by the axis before `renderItem` ran. That is exactly what
   * happened — sixteen violins came out as an empty plot with its axes drawn
   * neatly around them — so the check is on the *picture*.
   */
  it('draws a violin as a shape, on a log ordinate too', async () => {
    for (const scale of ['linear', 'log'] as const) {
      const built = spec()
      const style = defaultStyle(built)
      style.mark = 'violin'
      style.y.scale = scale
      const figure = chartFigure({ spec: built, style })
      document.body.append(figure.el)
      // The host has no width in jsdom, so the chart is measured by hand.
      Object.defineProperty(figure.el, 'clientWidth', { value: 640, configurable: true })
      Object.defineProperty(figure.el, 'clientHeight', { value: 400, configurable: true })
      await figure.ready

      const page = new VectorPage(640, 400)
      figure.draw(page.ctx, { width: 640, height: 400 })
      const content = await contentOf(await pdfOf(page, `violin-${scale}`))
      // The series' own colours, as fills. Nothing else on this figure is
      // painted in them — the legend is off, because the categories are named
      // on the abscissa — so their absence means no shape was drawn.
      for (const colour of ['#0072B2', '#D55E00']) {
        const [r, g, b] = pdfColour(colour)
        const fill = `${trim(r)} ${trim(g)} ${trim(b)} rg`
        expect(content, `${scale} ordinate, ${colour}`).toContain(fill)
      }
      figure.destroy()
    }
  })

  /**
   * A box plot, as the renderer really draws one.
   *
   * `zrender` draws each box as one path — the box, both whiskers, their caps
   * and the median — filled in the series' colour and then stroked in the ink.
   * The page let go of a path at its first paint, so the stroke reached the
   * PDF with nothing in front of it, and every exported box plot was a row of
   * tinted rectangles with no outline, whisker or median.
   */
  it('strokes a box plot’s box, whiskers and median along the path it fills', async () => {
    const built = spec()
    const style = defaultStyle(built)
    style.mark = 'box'
    const figure = chartFigure({ spec: built, style })
    document.body.append(figure.el)
    Object.defineProperty(figure.el, 'clientWidth', { value: 640, configurable: true })
    Object.defineProperty(figure.el, 'clientHeight', { value: 400, configurable: true })
    await figure.ready

    const page = new VectorPage(640, 400)
    figure.draw(page.ctx, { width: 640, height: 400 })
    const content = await contentOf(await pdfOf(page, 'box'))
    // Each painting operator, with the path in front of it and the colour it
    // paints in.
    const paints: Array<{ op: string; path: string[]; colour: string }> = []
    let path: string[] = []
    let fill = ''
    let stroke = ''
    for (const line of content.split('\n')) {
      if (line.endsWith(' rg')) fill = line.slice(0, -3)
      else if (line.endsWith(' RG')) stroke = line.slice(0, -3)
      else if (/ [mlc]$| re$|^h$/.test(line)) path.push(line)
      else if (/^(?:f\*?|S|W\*? n)$/.test(line)) {
        paints.push({ op: line, path, colour: line === 'S' ? stroke : fill })
        path = []
      }
    }
    // Nothing on the figure is painted with no path to paint.
    expect(paints.filter((paint) => paint.path.length === 0)).toEqual([])
    for (const colour of ['#0072B2', '#D55E00']) {
      const [r, g, b] = pdfColour(colour)
      const at = paints.findIndex(
        (paint) => paint.op === 'f' && paint.colour === `${trim(r)} ${trim(g)} ${trim(b)}`,
      )
      expect(at, colour).toBeGreaterThanOrEqual(0)
      const box = paints[at].path
      expect(box.filter((segment) => segment.endsWith(' m')), colour).toHaveLength(6)
      expect(paints[at + 1].op, colour).toBe('S')
      expect(paints[at + 1].path, colour).toEqual(box)
    }
    figure.destroy()
  })

  /**
   * The other thing a pure test of the option cannot see.
   *
   * A bar chart of a list makes three claims that only a render settles: that
   * the bars are drawn at all, that the axis prints the *names* rather than the
   * indices the bars stand at, and that the ordinate is spelled in the per cent
   * its own name declares. All three are formatters and series types the option
   * can hold perfectly well while ECharts draws an empty plot with neat axes
   * around it — which is how the violin failed.
   */
  it('draws a stacked bar chart, named along the abscissa and per cent up the side', async () => {
    const output: CurveOutput = {
      kind: 'curve',
      id: 'cistrans-fractions',
      label: 'Cis and trans fraction per sequence',
      xLabel: 'Sequence',
      yLabel: 'Share of the sequence’s contacts (%)',
      xScale: 'linear',
      yScale: 'linear',
      yDomain: [0, 1],
      xTicks: ['I', 'II', 'III'],
      series: [
        {
          name: 'cis',
          x: new Float64Array([0, 1, 2]),
          y: new Float64Array([0.9, 0.75, 0.5]),
          mark: 'bars',
          stack: 'contacts',
        },
        {
          name: 'trans',
          x: new Float64Array([0, 1, 2]),
          y: new Float64Array([0.1, 0.25, 0.5]),
          mark: 'bars',
          stack: 'contacts',
        },
      ],
    }
    const built = specOf(output) as XyFigureSpec
    // The task said bars, so the figure opens on them.
    expect(built.mark).toBe('bars')
    const style = defaultStyle(built)
    style.legend = 'none'
    const figure = chartFigure({ spec: built, style })
    document.body.append(figure.el)
    // The host has no width in jsdom, so the chart is measured by hand.
    Object.defineProperty(figure.el, 'clientWidth', { value: 640, configurable: true })
    Object.defineProperty(figure.el, 'clientHeight', { value: 400, configurable: true })
    await figure.ready

    const page = new VectorPage(640, 400)
    figure.draw(page.ctx, { width: 640, height: 400 })
    const content = await contentOf(await pdfOf(page, 'cistrans-fractions'))
    // Both halves of every bar, in the series' own colours — the legend is off,
    // so nothing else on this figure is painted in them.
    for (const colour of ['#0072B2', '#D55E00']) {
      const [r, g, b] = pdfColour(colour)
      expect(content).toContain(`${trim(r)} ${trim(g)} ${trim(b)} rg`)
    }
    // The sequences, under their own bars, rather than `0`, `1`, `2`.
    for (const name of ['I', 'II', 'III']) expect(content).toContain(`(${name}) Tj`)
    // And the share said as a percentage (§26.2), with no idle zeros.
    expect(content).toMatch(/\(\d+%\) Tj/)
    expect(content).not.toMatch(/\(\d+\.0%\) Tj/)

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

  /**
   * A matrix's colour bar is a gradient in the chart's SVG, and a page cannot
   * hold one — so the replay draws it as bands. It used to be flattened to its
   * middle stop: every pileup in a PDF had a key of one orange rectangle.
   */
  it('keeps a matrix’s colour bar a ramp on the page', async () => {
    // Two values only, so the cells are two colours and every other colour on
    // the page is the bar's.
    const n = 6
    const output = {
      kind: 'matrix',
      id: 'pileup',
      label: 'Pileup',
      nrows: n,
      ncols: n,
      values: new Float32Array(n * n).map((_, i) => (i % 2 === 0 ? 0 : 1)),
      xLabel: 'x',
      yLabel: 'y',
      xTicks: [],
      yTicks: [],
      colormap: 'fall',
    } as unknown as MatrixOutput
    const built = specOf(output) as MatrixFigureSpec
    const figure = chartFigure({ spec: built, style: defaultStyle(built) })
    document.body.append(figure.el)
    Object.defineProperty(figure.el, 'clientWidth', { value: 480, configurable: true })
    Object.defineProperty(figure.el, 'clientHeight', { value: 400, configurable: true })
    await figure.ready

    const page = new VectorPage(480, 400)
    figure.draw(page.ctx, { width: 480, height: 400 })
    const content = await contentOf(await pdfOf(page, 'pileup'))
    const fills = new Set(content.match(/^[\d.]+ [\d.]+ [\d.]+ rg$/gm) ?? [])
    expect(fills.size).toBeGreaterThan(40)
    // Both ends of `fall`, white and black, are on the page.
    expect(fills).toContain('1 1 1 rg')
    expect([...fills].some((fill) => fill.split(' ').slice(0, 3).every((v) => Number(v) < 0.03))).toBe(true)

    figure.destroy()
  })
})
