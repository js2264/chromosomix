// @vitest-environment jsdom

/**
 * The SVG replay, which is what keeps a charted figure a vector on paper.
 *
 * Everything here is checked as *calls*, not as pixels, because calls are the
 * whole mechanism: the figure hands the same sequence to a canvas on screen and
 * to a {@link VectorPage} in an export, so a wrong call is a wrong PDF and a
 * missing one is a mark that silently vanishes from the file a reader publishes.
 *
 * The curve cases deserve their reason too. A chart library's SVG is cubics and
 * elliptical arcs, and neither survives a careless conversion in a way anyone
 * would notice on screen — an arc flattened a shade off is still a round dot.
 * The assertions therefore test the geometry rather than the call count: a
 * converted arc's points are checked to lie on the circle it came from.
 */

import { describe, expect, it } from 'vitest'

import { arcToCubics, paintPath, paintSvgString, parseTransform } from '@/figures/svgPaint'
import { VectorPage } from '@/ui/vector'

interface Call {
  op: string
  args: unknown[]
}

/** A context that writes down what it was asked to do. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  const note =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push({ op, args })
    }
  const state: Record<string, unknown> = {}
  const target = {
    save: note('save'),
    restore: note('restore'),
    beginPath: note('beginPath'),
    closePath: note('closePath'),
    moveTo: note('moveTo'),
    lineTo: note('lineTo'),
    rect: note('rect'),
    arc: note('arc'),
    quadraticCurveTo: note('quadraticCurveTo'),
    bezierCurveTo: note('bezierCurveTo'),
    fill: note('fill'),
    stroke: note('stroke'),
    clip: note('clip'),
    fillRect: note('fillRect'),
    strokeRect: note('strokeRect'),
    clearRect: note('clearRect'),
    translate: note('translate'),
    rotate: note('rotate'),
    transform: note('transform'),
    setTransform: note('setTransform'),
    drawImage: note('drawImage'),
    setLineDash: note('setLineDash'),
    getLineDash: () => [],
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText: note('fillText'),
    strokeText: note('strokeText'),
  } as unknown as Record<string, unknown>
  for (const name of [
    'fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'font',
    'textAlign', 'textBaseline', 'lineJoin', 'lineCap', 'imageSmoothingEnabled',
  ]) {
    Object.defineProperty(target, name, {
      get: () => state[name],
      set: (value: unknown) => {
        state[name] = value
        calls.push({ op: `set:${name}`, args: [value] })
      },
    })
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

function ops(calls: Call[], op: string): Call[] {
  return calls.filter((call) => call.op === op)
}

describe('parseTransform', () => {
  it('reads the two forms zrender emits', () => {
    expect(parseTransform('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20])
    expect(parseTransform('matrix(3,0,0,3,191.5,282.5)')).toEqual([3, 0, 0, 3, 191.5, 282.5])
  })

  it('composes left to right, as SVG does', () => {
    const m = parseTransform('translate(10 0) scale(2)')
    expect(m).toEqual([2, 0, 0, 2, 10, 0])
    // A point at x = 1 is scaled first and then moved: 1 → 2 → 12.
    expect(m[0] * 1 + m[4]).toBe(12)
  })

  it('rotates about a centre when one is given', () => {
    const m = parseTransform('rotate(90 5 5)')
    const x = m[0] * 5 + m[2] * 0 + m[4]
    const y = m[1] * 5 + m[3] * 0 + m[5]
    expect(x).toBeCloseTo(10, 9)
    expect(y).toBeCloseTo(5, 9)
  })

  it('ignores a transform it does not know rather than throwing', () => {
    expect(parseTransform('wobble(3)')).toEqual([1, 0, 0, 1, 0, 0])
  })
})

describe('paintPath', () => {
  it('walks absolute moves and lines', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M10 20L30 40L50 20Z')
    expect(ops(calls, 'moveTo')[0].args).toEqual([10, 20])
    expect(ops(calls, 'lineTo').map((call) => call.args)).toEqual([
      [30, 40],
      [50, 20],
    ])
    expect(ops(calls, 'closePath')).toHaveLength(1)
  })

  it('repeats the last command for bare coordinate pairs', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M0 0 10 10 20 0')
    // An implicit repeat after `M` is `L`, not another move.
    expect(ops(calls, 'moveTo')).toHaveLength(1)
    expect(ops(calls, 'lineTo').map((call) => call.args)).toEqual([
      [10, 10],
      [20, 0],
    ])
  })

  it('resolves relative commands against the current point', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M-5 -5l86.94 0l0 24l-86.94 0Z')
    expect(ops(calls, 'lineTo').map((call) => call.args)).toEqual([
      [81.94, -5],
      [81.94, 19],
      [-5, 19],
    ])
  })

  it('reads the horizontal and vertical shorthands', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M1 2H10V20h-4v-6')
    expect(ops(calls, 'lineTo').map((call) => call.args)).toEqual([
      [10, 2],
      [10, 20],
      [6, 20],
      [6, 14],
    ])
  })

  it('reflects the previous handle for S and T', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M0 0C1 1 2 2 3 3S5 5 6 6')
    const curves = ops(calls, 'bezierCurveTo')
    expect(curves).toHaveLength(2)
    // The smooth cubic's first handle mirrors (2, 2) through (3, 3).
    expect(curves[1].args.slice(0, 2)).toEqual([4, 4])

    const quad = recorder()
    paintPath(quad.ctx, 'M0 0Q2 4 4 0T8 0')
    const quads = ops(quad.calls, 'quadraticCurveTo')
    expect(quads).toHaveLength(2)
    expect(quads[1].args.slice(0, 2)).toEqual([6, -4])
  })

  it('closes and reopens a subpath without looping on the numbers after Z', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M0 0L4 0L4 4Z M8 8L12 8')
    expect(ops(calls, 'moveTo').map((call) => call.args)).toEqual([
      [0, 0],
      [8, 8],
    ])
    expect(ops(calls, 'closePath')).toHaveLength(1)
  })

  it('turns an arc into cubics that stay on the circle', () => {
    const { ctx, calls } = recorder()
    // The symbol zrender draws every scatter point with: a full circle, written
    // as one arc that very nearly returns to where it started.
    paintPath(ctx, 'M1 0A1 1 0 1 1 1 -0.0001')
    const curves = ops(calls, 'bezierCurveTo')
    expect(curves.length).toBeGreaterThanOrEqual(4)
    for (const curve of curves) {
      const [x, y] = curve.args.slice(4) as [number, number]
      // Every segment end is on the unit circle; the last is the path's own
      // stated endpoint, a ten-thousandth short of the start so the arc is a
      // whole turn rather than nothing.
      expect(Math.hypot(x, y)).toBeCloseTo(1, 3)
    }
  })

  it('reads arc flags that are glued to their neighbours', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M0 0a5 5 0 115 5')
    const curves = ops(calls, 'bezierCurveTo')
    expect(curves.length).toBeGreaterThan(0)
    const last = curves[curves.length - 1].args.slice(4) as [number, number]
    expect(last[0]).toBeCloseTo(5, 6)
    expect(last[1]).toBeCloseTo(5, 6)
  })

  it('stops on junk instead of spinning', () => {
    const { ctx, calls } = recorder()
    paintPath(ctx, 'M0 0L1 1 ? 9 9')
    expect(ops(calls, 'lineTo')).toHaveLength(1)
  })
})

describe('arcToCubics', () => {
  it('splits at most a quarter turn per segment', () => {
    const half = arcToCubics(1, 0, 1, 1, 0, false, true, -1, 0)
    expect(half).toHaveLength(2)
    const full = arcToCubics(1, 0, 1, 1, 0, true, true, 0.9999, -0.0001)
    expect(full.length).toBeGreaterThanOrEqual(4)
  })

  it('is a straight line when a radius is zero', () => {
    expect(arcToCubics(0, 0, 0, 5, 0, false, true, 10, 10)).toEqual([[0, 0, 10, 10, 10, 10]])
  })

  it('grows radii that cannot reach the endpoint', () => {
    // r = 1 cannot span 10 units; the specification says scale it up until it
    // just can, which puts the midpoint at the halfway mark.
    const grown = arcToCubics(0, 0, 1, 1, 0, false, true, 10, 0)
    const last = grown[grown.length - 1]
    expect(last[4]).toBeCloseTo(10, 6)
    expect(last[5]).toBeCloseTo(0, 6)
  })
})

describe('paintSvgString', () => {
  const chart = `<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="100" x="0" y="0" fill="#ffffff"></rect>
    <path d="M10 90L190 90" fill="none" stroke="#54555a" stroke-linecap="round"></path>
    <g clip-path="url(#c0)">
      <path d="M10 80C40 20 80 60 190 10" fill="none" stroke="#5070dd" stroke-width="2"></path>
      <path d="M10 80L190 10L190 90L10 90Z" fill="#5070dd" fill-opacity="0.7"></path>
    </g>
    <text dominant-baseline="central" text-anchor="middle" style="font-size:12px;font-family:sans-serif;font-weight:bold;" y="6" transform="translate(100 96)" fill="#54555a">bases</text>
    <defs><clipPath id="c0"><path d="M9 9l182 0l0 82l-182 0Z"></path></clipPath></defs>
    <style><![CDATA[.zr0-cls-0:hover { cursor:pointer; }]]></style>
  </svg>`

  it('paints the fills and strokes with the colours the picture asked for', () => {
    const { ctx, calls } = recorder()
    paintSvgString(chart, ctx)
    const fills = ops(calls, 'set:fillStyle').map((call) => call.args[0])
    expect(fills).toContain('#ffffff')
    expect(fills).toContain('#5070dd')
    expect(ops(calls, 'set:strokeStyle').map((call) => call.args[0])).toContain('#54555a')
    expect(ops(calls, 'set:lineCap').map((call) => call.args[0])).toContain('round')
  })

  it('never fills a shape whose fill is none', () => {
    const { ctx, calls } = recorder()
    paintSvgString('<svg width="10" height="10"><path d="M0 0L9 9" fill="none" stroke="#000"/></svg>', ctx)
    expect(ops(calls, 'fill')).toHaveLength(0)
    expect(ops(calls, 'stroke')).toHaveLength(1)
  })

  it('carries fill-opacity through as the alpha of that one fill', () => {
    const { ctx, calls } = recorder()
    paintSvgString(chart, ctx)
    const alphas = ops(calls, 'set:globalAlpha').map((call) => call.args[0])
    expect(alphas).toContain(0.7)
    // And puts it back, so the next mark is not tinted by the last one.
    expect(alphas[alphas.length - 1]).toBe(1)
  })

  it('clips a group and lets the clip go with the group', () => {
    const { ctx, calls } = recorder()
    paintSvgString(chart, ctx)
    expect(ops(calls, 'clip')).toHaveLength(1)
    const clipAt = calls.findIndex((call) => call.op === 'clip')
    const saveBefore = calls.slice(0, clipAt).filter((call) => call.op === 'save').length
    const restoreBefore = calls.slice(0, clipAt).filter((call) => call.op === 'restore').length
    expect(saveBefore).toBeGreaterThan(restoreBefore)
    expect(ops(calls, 'save')).toHaveLength(ops(calls, 'restore').length)
  })

  it('writes text with the font, anchor and baseline the SVG names', () => {
    const { ctx, calls } = recorder()
    paintSvgString(chart, ctx)
    const written = ops(calls, 'fillText')
    expect(written).toHaveLength(1)
    expect(written[0].args).toEqual(['bases', 0, 6])
    expect(ops(calls, 'set:font').map((call) => call.args[0])).toContain('bold 12px sans-serif')
    expect(ops(calls, 'set:textAlign').map((call) => call.args[0])).toContain('center')
    expect(ops(calls, 'set:textBaseline').map((call) => call.args[0])).toContain('middle')
    // The run's placement is the group transform, not baked into the call.
    expect(ops(calls, 'transform').map((call) => call.args)).toContainEqual([1, 0, 0, 1, 100, 96])
  })

  it('scales to the box it is asked for', () => {
    const { ctx, calls } = recorder()
    paintSvgString(chart, ctx, { width: 400, height: 200 })
    expect(ops(calls, 'transform')[0].args).toEqual([2, 0, 0, 2, 0, 0])
  })

  // A page's `fillStyle` is a colour string, so a gradient is drawn as bands of
  // its colours, clipped to the shape. It used to be flattened to its middle
  // stop, and every chart's continuous colour bar left as one flat rectangle.
  it('draws a linear gradient as bands of its colours, clipped to the shape', () => {
    const { ctx, calls } = recorder()
    paintSvgString(
      `<svg width="10" height="10">
        <defs><linearGradient id="g"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ff0000"/></linearGradient></defs>
        <rect x="0" y="0" width="10" height="10" fill="url(#g)"/>
      </svg>`,
      ctx,
    )
    expect(ops(calls, 'clip')).toHaveLength(1)
    const colours = ops(calls, 'set:fillStyle').map((call) => String(call.args[0]))
    expect(colours.length).toBeGreaterThanOrEqual(50)
    expect(ops(calls, 'fill')).toHaveLength(colours.length)
    // From the first stop to the last, red rising band by band.
    const reds = colours.map((colour) => Number(/^rgb\((\d+)/.exec(colour)?.[1]))
    expect(reds[0]).toBeLessThan(5)
    expect(reds[reds.length - 1]).toBeGreaterThan(250)
    expect(reds.every((red, index) => index === 0 || red >= reds[index - 1])).toBe(true)
    // The bands are clipped, and the clip is let go of.
    expect(ops(calls, 'save').length).toBe(ops(calls, 'restore').length)
  })

  it('reads a chart colour bar’s gradient in the box of the shape it fills', () => {
    // `zrender`'s own shape for a continuous colour bar: a polygon, turned
    // half a turn, filled top to bottom in its own box.
    const { ctx, calls } = recorder()
    paintSvgString(
      `<svg width="40" height="200">
        <defs><linearGradient gradientUnits="objectBoundingBox" x1="0" y1="0" x2="0" y2="1" id="bar">
          <stop offset="0%" stop-color="rgb(255,255,255)"/>
          <stop offset="50%" stop-color="rgb(251,127,4)"/>
          <stop offset="100%" stop-color="rgb(0,0,0)"/>
        </linearGradient></defs>
        <polygon points="0 0 10 0 10 100 0 100" fill="url(#bar)"/>
      </svg>`,
      ctx,
    )
    // Every band spans the bar's width and stacks down its height: the first
    // white at the top, the last black at the bottom.
    const channels = ops(calls, 'set:fillStyle').map((call) =>
      (/^rgb\((\d+), (\d+), (\d+)\)$/.exec(String(call.args[0])) ?? []).slice(1).map(Number),
    )
    expect(channels[0].every((value) => value > 250)).toBe(true)
    expect(channels[channels.length - 1].every((value) => value < 5)).toBe(true)
    // …and the orange of the middle stop half way down.
    const middle = channels[Math.floor(channels.length / 2)]
    expect(middle[0]).toBeGreaterThan(240)
    expect(middle[2]).toBeLessThan(20)
    const ys = ops(calls, 'moveTo').map((call) => Number(call.args[1]))
    expect(Math.min(...ys)).toBeLessThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThan(100)
  })

  it('is one fill where every stop is one colour', () => {
    const { ctx, calls } = recorder()
    const stops = Array.from({ length: 101 }, (_, i) => `<stop offset="${i}%" stop-color="rgb(207,210,215)"/>`)
    paintSvgString(
      `<svg width="10" height="10">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops.join('')}</linearGradient></defs>
        <rect x="0" y="0" width="10" height="10" fill="url(#g)"/>
      </svg>`,
      ctx,
    )
    expect(ops(calls, 'fill')).toHaveLength(1)
    expect(ops(calls, 'set:fillStyle').map((call) => call.args[0])).toEqual(['rgb(207, 210, 215)'])
  })

  it('still stands a gradient’s middle stop in for it on a stroke', () => {
    const { ctx, calls } = recorder()
    paintSvgString(
      `<svg width="10" height="10">
        <defs><linearGradient id="g"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ff0000"/></linearGradient></defs>
        <path d="M0 0L9 9" fill="none" stroke="url(#g)"/>
      </svg>`,
      ctx,
    )
    expect(ops(calls, 'set:strokeStyle').map((call) => call.args[0])).toEqual(['#000000'])
    expect(ops(calls, 'clip')).toHaveLength(0)
  })

  it('reads a dash pattern', () => {
    const { ctx, calls } = recorder()
    paintSvgString(
      '<svg width="10" height="10"><path d="M0 0L9 9" stroke="#000" stroke-dasharray="4 2"/></svg>',
      ctx,
    )
    expect(ops(calls, 'setLineDash').map((call) => call.args[0])).toContainEqual([4, 2])
  })

  it('skips the rasters and the markup that is not a drawing', () => {
    const { ctx, calls } = recorder()
    paintSvgString(
      `<svg width="10" height="10">
        <title>a picture</title>
        <image href="x.png" width="10" height="10"/>
        <rect x="0" y="0" width="4" height="4" fill="#123456"/>
      </svg>`,
      ctx,
    )
    expect(ops(calls, 'drawImage')).toHaveLength(0)
    expect(ops(calls, 'fillText')).toHaveLength(0)
    expect(ops(calls, 'fill')).toHaveLength(1)
  })
})

/**
 * A page's content stream, inflated, read the way `vector.test.ts` reads one.
 *
 * jsdom's `Blob` has no `stream()`, which the deflate the page writes with and
 * the inflate here both need; the platform's has, and so does every browser.
 */
async function contentOfPage(page: VectorPage): Promise<string> {
  const { Blob: PlatformBlob } = await import('node:buffer')
  const shimmed = globalThis.Blob
  Object.defineProperty(globalThis, 'Blob', { value: PlatformBlob, configurable: true })
  try {
    const bytes = new Uint8Array(await (await page.toBlob({ created: new Date(0) })).arrayBuffer())
    const latin1 = (raw: Uint8Array): string => new TextDecoder('latin1').decode(raw)
    const header = /4 0 obj\n<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/.exec(latin1(bytes))
    if (header === null) throw new Error('no content stream')
    const at = header.index + header[0].length
    const raw = bytes.slice(at, at + Number(header[1]))
    if (header[2] === undefined) return latin1(raw)
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
    return latin1(new Uint8Array(await new Response(stream).arrayBuffer()))
  } finally {
    Object.defineProperty(globalThis, 'Blob', { value: shimmed, configurable: true })
  }
}

/** Each painting operator in a content stream, with the path in front of it. */
function paintsOf(content: string): Array<{ op: string; path: string[] }> {
  const paints: Array<{ op: string; path: string[] }> = []
  let path: string[] = []
  for (const line of content.split('\n')) {
    if (/ [mlc]$| re$|^h$/.test(line)) path.push(line)
    else if (/^(?:f\*?|S|W\*? n)$/.test(line)) {
      paints.push({ op: line, path })
      path = []
    }
  }
  return paints
}

describe('the replay onto a page', () => {
  // `zrender` draws a box plot's box, whiskers and median as one path, filled
  // and then stroked. The page let go of a path at its first paint, so the
  // stroke reached the PDF as a bare `S`, and every exported box plot lost its
  // outline, its whiskers and its median.
  it('strokes a path it has filled, with the path in front of both', async () => {
    const page = new VectorPage(100, 100)
    paintSvgString(
      `<svg width="100" height="100">
        <path d="M30 40L70 40L70 60L30 60Z M50 40L50 20M40 20L60 20M50 60L50 80M40 80L60 80M30 50L70 50"
          fill="#ffffff" stroke="#5070dd"/>
      </svg>`,
      page.ctx,
    )
    const paints = paintsOf(await contentOfPage(page))
    expect(paints.map((paint) => paint.op)).toEqual(['f', 'S'])
    expect(paints[1].path).toEqual(paints[0].path)
    // The box, both whiskers, both caps and the median: six subpaths.
    expect(paints[1].path.filter((segment) => segment.endsWith(' m'))).toHaveLength(6)
  })

  it('reaches a PDF as curves and text rather than as pixels', async () => {
    const page = new VectorPage(200, 100)
    paintSvgString(
      `<svg width="200" height="100" viewBox="0 0 200 100">
        <path d="M10 80C40 20 80 60 190 10" fill="none" stroke="#5070dd" stroke-width="2"/>
        <text x="0" y="0" style="font-size:12px;" transform="translate(100 96)" fill="#54555a">bases</text>
      </svg>`,
      page.ctx,
    )
    // jsdom's `Blob` has no `stream()`, which the deflate the page writes with
    // needs; the platform's own does, and it is the one the browser will use.
    const { Blob: PlatformBlob } = await import('node:buffer')
    const shimmed = globalThis.Blob
    Object.defineProperty(globalThis, 'Blob', { value: PlatformBlob, configurable: true })
    let bytes: Uint8Array
    try {
      const blob = await page.toBlob({ title: 'replay', created: new Date(0) })
      bytes = new Uint8Array(await blob.arrayBuffer())
    } finally {
      Object.defineProperty(globalThis, 'Blob', { value: shimmed, configurable: true })
    }
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text.startsWith('%PDF-')).toBe(true)
    // The two things that say "drawing" rather than "photograph": a font
    // resource for the run of text, and no image XObject anywhere.
    expect(text).toContain('/Helvetica')
    expect(text).not.toContain('/Subtype /Image')
    // And it is tiny, which a raster of the same picture could not be.
    expect(bytes.byteLength).toBeLessThan(4000)
  })
})
