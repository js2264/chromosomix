/**
 * The dot plot as a view of its own (SPECS §28.2): its streaks drawn as the
 * lines they are, at any zoom — the wheel zooms about the pointer, a drag or a
 * sideways scroll moves it, a double click or `0` shows the whole — and the
 * streak under the pointer lit and named on both axes, a press keeping it named.
 *
 * `drawDotplot` is the picture alone, from two axes, the lines and a window;
 * the reference editor's corner plot (§27.3) draws the same picture through an
 * edit. The arithmetic is `dotplot/view.ts`'s.
 */

import type { DotplotStreaks } from '../analysis/types'
import {
  clampView,
  fitView,
  locusOf,
  offsetsOf,
  panView,
  scaleOf,
  streakAt,
  streakEnds,
  toBases,
  toPixels,
  zoomView,
  type DotplotAxis,
  type DotplotLines,
  type DotplotView,
  type PlotRect,
} from '../dotplot/view'
import { formatLocus, formatPosition } from '../genome/assembly'
import { fmt } from '../units'
import { MIN_FIGURE_WIDTH, plotTheme, watchTheme, type PlotFigure, type PlotTheme } from './analysisPlots'
import { figurePaper } from './canvasPalette'
import { el } from './dom'
import { subscribeTextScale } from './textScale'

/** The same way round, and the other: the two ends of the dot plot's own `RdBu_r`. */
export const SAME_WAY = '#b2182b'
export const OTHER_WAY = '#2166ac'

/** Pixels from a streak's line within which the pointer is on it. */
const REACH_PX = 6

/** The largest the plot asks to be, as the dot plot's picture always has (§28.3). */
const MOST_SIDE = 600

/** What a picture of the dot plot is drawn from. */
export interface DotplotPicture {
  x: DotplotAxis & { label: string }
  y: DotplotAxis & { label: string }
  lines: DotplotLines
}

/**
 * What a hover elsewhere lights in the plot — the reference editor's map
 * naming a stretch of the edit (§27.3): its lines drawn over the others, which
 * are dimmed, and its span along x marked, in the accent.
 */
export interface DotplotFocus {
  lines: readonly number[]
  span: readonly [number, number] | null
  accent: string
}

/** How far the lines a focus leaves out are dimmed. */
const DIMMED = 0.2

/** Room around the plot for names and labels; a corner plot has none. */
function marginsOf(compact: boolean): { left: number; right: number; top: number; bottom: number } {
  return compact ? { left: 4, right: 4, top: 4, bottom: 4 } : { left: 86, right: 12, top: 10, bottom: 46 }
}

/**
 * The plot's rectangle in a box: square, since both axes are drawn at one
 * scale and two assemblies of a genome are much of a size — as large as the
 * box allows, and centred across it with its names.
 */
export function plotRectOf(box: { width: number; height: number }, compact = false): PlotRect {
  const m = marginsOf(compact)
  const across = Math.max(10, box.width - m.left - m.right)
  const side = Math.max(10, Math.min(across, box.height - m.top - m.bottom))
  return { x: m.left + (across - side) / 2, y: m.top, width: side, height: side }
}

/** A name cut to fit a room, with an ellipsis; empty where nothing fits. */
function fitted(ctx: CanvasRenderingContext2D, text: string, room: number): string {
  if (ctx.measureText(text).width <= room) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1)
  return cut.length > 1 ? `${cut}…` : ''
}

/**
 * The dot plot in a box: the plot's frame, a rule at every edge between two
 * sequences — no two closer than three pixels — each sequence's name where it
 * fits, the two axes' labels, and every streak in the window as a line, the
 * same way round red and the other blue, the lit one drawn over a halo; and,
 * given a focus, its span along x marked and its lines lit, the others dimmed.
 *
 * @returns The plot's rectangle and the window it drew, for a caller that maps
 *   pointers onto it.
 */
export function drawDotplot(
  ctx: CanvasRenderingContext2D,
  picture: DotplotPicture,
  box: { width: number; height: number },
  theme: PlotTheme,
  view: DotplotView | null,
  lit = -1,
  compact = false,
  focus: DotplotFocus | null = null,
): { rect: PlotRect; view: DotplotView } {
  const rect = plotRectOf(box, compact)
  const xOffsets = offsetsOf(picture.x)
  const yOffsets = offsetsOf(picture.y)
  const xTotal = xOffsets[xOffsets.length - 1]
  const yTotal = yOffsets[yOffsets.length - 1]
  const shown = clampView(view ?? fitView(xTotal, yTotal, rect), xTotal, yTotal, rect)
  const at = (x: number, y: number): { px: number; py: number } => toPixels(shown, rect, x, y)

  ctx.save()
  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, box.width, box.height)
  // The data's own extent, a shade off the paper, so the edge of the sets reads.
  const lo = at(0, 0)
  const hi = at(xTotal, yTotal)
  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(lo.px) + 0.5, Math.round(lo.py) + 0.5, Math.round(hi.px - lo.px), Math.round(hi.py - lo.py))

  // The edges between sequences.
  let last = Number.NEGATIVE_INFINITY
  for (const offset of xOffsets.slice(1, -1)) {
    const px = Math.round(at(offset, 0).px) + 0.5
    if (px < rect.x || px > rect.x + rect.width || px - last < 3) continue
    last = px
    ctx.beginPath()
    ctx.moveTo(px, Math.max(rect.y, lo.py))
    ctx.lineTo(px, Math.min(rect.y + rect.height, hi.py))
    ctx.stroke()
  }
  last = Number.NEGATIVE_INFINITY
  for (const offset of yOffsets.slice(1, -1)) {
    const py = Math.round(at(0, offset).py) + 0.5
    if (py < rect.y || py > rect.y + rect.height || py - last < 3) continue
    last = py
    ctx.beginPath()
    ctx.moveTo(Math.max(rect.x, lo.px), py)
    ctx.lineTo(Math.min(rect.x + rect.width, hi.px), py)
    ctx.stroke()
  }

  // The streaks: a line each, and a dot where the line is shorter than one.
  const lines = picture.lines
  const width = compact ? 1.2 : 1.6
  const draw = (i: number, colour: string, lineWidth: number): void => {
    const [ax, ay, bx, by] = streakEnds(lines, i)
    const a = at(ax, ay)
    const b = at(bx, by)
    if (Math.max(a.px, b.px) < rect.x || Math.min(a.px, b.px) > rect.x + rect.width) return
    if (Math.max(a.py, b.py) < rect.y || Math.min(a.py, b.py) > rect.y + rect.height) return
    ctx.strokeStyle = colour
    ctx.fillStyle = colour
    if (Math.hypot(b.px - a.px, b.py - a.py) < lineWidth) {
      ctx.fillRect((a.px + b.px) / 2 - lineWidth / 2, (a.py + b.py) / 2 - lineWidth / 2, lineWidth, lineWidth)
      return
    }
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.moveTo(a.px, a.py)
    ctx.lineTo(b.px, b.py)
    ctx.stroke()
  }
  ctx.lineCap = 'round'
  // A focus's span, washed across the plot under the lines.
  const span = focus?.span ?? null
  const spanPx = span === null ? null : [Math.max(rect.x, at(span[0], 0).px), Math.min(rect.x + rect.width, at(span[1], 0).px)]
  if (focus !== null && spanPx !== null && spanPx[1] > spanPx[0] - 1) {
    ctx.fillStyle = focus.accent
    ctx.globalAlpha = 0.12
    ctx.fillRect(spanPx[0], rect.y, Math.max(1, spanPx[1] - spanPx[0]), rect.height)
    ctx.globalAlpha = 1
  }
  ctx.globalAlpha = focus === null ? 1 : DIMMED
  for (let i = 0; i < lines.x0.length; i++) draw(i, lines.strand[i] === -1 ? OTHER_WAY : SAME_WAY, width)
  ctx.globalAlpha = 1
  if (focus !== null) {
    const shown = focus.lines.filter((i) => i !== lit && i >= 0 && i < lines.x0.length)
    for (const i of shown) draw(i, theme.background, width + 3)
    for (const i of shown) draw(i, lines.strand[i] === -1 ? OTHER_WAY : SAME_WAY, width + 0.8)
  }
  if (lit >= 0 && lit < lines.x0.length) {
    draw(lit, theme.background, width + 5)
    draw(lit, lines.strand[lit] === -1 ? OTHER_WAY : SAME_WAY, width + 2)
  }
  ctx.restore()

  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1)

  // A focus's span along x: a bar over the plot's top edge, as a pieces bar lights a stretch, and its two ends.
  if (focus !== null && spanPx !== null && spanPx[1] > spanPx[0] - 1) {
    const [a, b] = spanPx
    ctx.fillStyle = focus.accent
    ctx.fillRect(a, rect.y - 3, Math.max(2, b - a), 3)
    ctx.globalAlpha = 0.7
    ctx.fillRect(a, rect.y, 1, rect.height)
    ctx.fillRect(Math.max(a, b - 1), rect.y, 1, rect.height)
    ctx.globalAlpha = 1
  }

  if (!compact) {
    // Each sequence's name where it fits: along x under the plot, along y to its left.
    ctx.font = theme.font
    ctx.fillStyle = theme.muted
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    for (let i = 0; i < picture.x.names.length; i++) {
      const a = Math.max(rect.x, at(xOffsets[i], 0).px)
      const b = Math.min(rect.x + rect.width, at(xOffsets[i + 1], 0).px)
      const name = b - a > 8 ? fitted(ctx, picture.x.names[i], b - a - 4) : ''
      if (name !== '') ctx.fillText(name, (a + b) / 2, rect.y + rect.height + 4)
    }
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < picture.y.names.length; i++) {
      const a = Math.max(rect.y, at(0, yOffsets[i]).py)
      const b = Math.min(rect.y + rect.height, at(0, yOffsets[i + 1]).py)
      // Beside the plot, clear of the axis's own label at the box's edge.
      const name = b - a >= 10 ? fitted(ctx, picture.y.names[i], rect.x - 30) : ''
      if (name !== '') ctx.fillText(name, rect.x - 4, (a + b) / 2)
    }
    // The two sets' names.
    ctx.fillStyle = theme.ink
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(fitted(ctx, picture.x.label, rect.width), rect.x + rect.width / 2, box.height - 2)
    ctx.save()
    ctx.translate(12, rect.y + rect.height / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textBaseline = 'middle'
    ctx.fillText(fitted(ctx, picture.y.label, rect.height), 0, 0)
    ctx.restore()
  }
  ctx.restore()
  return { rect, view: shown }
}

/** What the readout says of a place, or of a streak. */
export function describeStreak(picture: DotplotPicture, i: number, anchors?: ArrayLike<number>): string {
  const lines = picture.lines
  const xOffsets = offsetsOf(picture.x)
  const yOffsets = offsetsOf(picture.y)
  const x = locusOf(picture.x, xOffsets, lines.x0[i])
  const y = locusOf(picture.y, yOffsets, lines.y0[i])
  if (x === null || y === null) return ''
  const xs = formatLocus({ contig: x.name, start: x.at, end: x.at + (lines.x1[i] - lines.x0[i]) })
  const ys = formatLocus({ contig: y.name, start: y.at, end: y.at + (lines.y1[i] - lines.y0[i]) })
  const way = lines.strand[i] === -1 ? 'the other way round' : 'the same way round'
  const count = anchors === undefined ? '' : ` · ${Number(anchors[i]).toLocaleString('en-US')} anchors`
  return `${xs} × ${ys} · ${way}${count}`
}

/** What a hand does over a dot plot's canvas, in the canvas's own CSS pixels. */
export interface DotplotHands {
  /** Zoom by `factor` — above one, in — about `(x, y)`. */
  zoom(factor: number, x: number, y: number): void
  /** Move the picture by `(dx, dy)` pixels, following the hand. */
  pan(dx: number, dy: number): void
  /** Show both sets whole. */
  whole(): void
  /** The pointer over the plot, not dragging — and after a wheel, where it is. */
  point(x: number, y: number): void
  /** A press that did not travel. */
  press(x: number, y: number): void
  /** The pointer gone from the canvas, not dragging. */
  leave(): void
}

/**
 * The dot plot's gestures on a canvas (§28.2), for the view of its own and the
 * reference editor's corner plot (§27.3) alike: the wheel zooms about the
 * pointer, a drag or a sideways scroll moves the picture — as over a map
 * (§7.2) — and a double click shows the whole.
 */
export function handDotplot(canvas: HTMLCanvasElement, hands: DotplotHands): void {
  const local = (event: MouseEvent): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  let press: { x: number; y: number; moved: boolean; pointer: number } | null = null
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const { x, y } = local(event)
    press = { x, y, moved: false, pointer: event.pointerId }
    canvas.setPointerCapture?.(event.pointerId)
    canvas.focus({ preventScroll: true })
  })
  canvas.addEventListener('pointermove', (event) => {
    const { x, y } = local(event)
    if (press !== null) {
      if (!press.moved && Math.hypot(x - press.x, y - press.y) < 3) return
      press.moved = true
      canvas.classList.add('is-dragging')
      hands.pan(x - press.x, y - press.y)
      press.x = x
      press.y = y
      return
    }
    hands.point(x, y)
  })
  const release = (event: PointerEvent): void => {
    if (press === null) return
    const clicked = !press.moved
    if (canvas.hasPointerCapture?.(press.pointer) === true) canvas.releasePointerCapture(press.pointer)
    press = null
    canvas.classList.remove('is-dragging')
    if (!clicked) return
    const { x, y } = local(event)
    hands.press(x, y)
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  canvas.addEventListener('pointerleave', () => {
    if (press === null) hands.leave()
  })
  canvas.addEventListener('dblclick', (event) => {
    event.preventDefault()
    hands.whole()
  })
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const { x, y } = local(event)
      // As over a map (§7.2): up and down zoom, sideways slides along the diagonal, ⌘ up and down slide.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        hands.pan(-event.deltaX, -event.deltaX)
      } else if (event.metaKey && !event.ctrlKey) {
        hands.pan(0, -event.deltaY)
      } else {
        hands.zoom(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002)), x, y)
      }
      hands.point(x, y)
    },
    { passive: false },
  )
}

/** The dot plot's streaks as a view of their own: zoomed, moved, and read under the pointer. */
export function dotplotFigure(streaks: DotplotStreaks): PlotFigure {
  const picture: DotplotPicture = { x: streaks.x, y: streaks.y, lines: streaks }
  const canvas = el('canvas', {
    class: 'analysis-figure-canvas dotplot-canvas',
    style: { width: '100%' },
    attrs: { tabindex: '0', 'aria-label': `Dot plot of ${streaks.x.label} against ${streaks.y.label}` },
  })
  const readout = el('div', { class: 'dotplot-readout', attrs: { 'aria-live': 'polite' } })
  const whole = el('button', { class: 'btn btn-quiet dotplot-whole', text: 'the whole', attrs: { type: 'button' }, title: 'Show both sets whole (0, or a double click)' })
  const host = el('div', { class: 'analysis-figure-canvas-host dotplot-host' }, canvas, whole, readout)
  let width = 0
  let fill = false
  let view: DotplotView | null = null
  let laid: { rect: PlotRect; view: DotplotView } | null = null
  let lit = -1
  let pinned = -1
  let frame = 0
  const xOffsets = offsetsOf(streaks.x)
  const yOffsets = offsetsOf(streaks.y)
  const xTotal = xOffsets[xOffsets.length - 1]
  const yTotal = yOffsets[yOffsets.length - 1]

  const heightFor = (w: number): number => {
    const m = marginsOf(false)
    return Math.min(MOST_SIDE, Math.max(MIN_FIGURE_WIDTH, w - m.left - m.right)) + m.top + m.bottom
  }
  const say = (text: string): void => {
    readout.textContent = text
  }
  const idle = (): string =>
    `${streaks.x0.length.toLocaleString('en-US')} streaks · scroll to zoom, drag to move, double-click for the whole · ${streaks.x.label} along x, ${streaks.y.label} along y`
  const redraw = (): void => {
    frame = 0
    const cssWidth = Math.max(MIN_FIGURE_WIDTH, Math.round(width))
    const cssHeight = fill ? Math.max(MIN_FIGURE_WIDTH, Math.round(host.clientHeight - readout.offsetHeight)) : heightFor(cssWidth)
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    canvas.style.height = `${cssHeight}px`
    const wantWidth = Math.max(1, Math.round(cssWidth * dpr))
    const wantHeight = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== wantWidth) canvas.width = wantWidth
    if (canvas.height !== wantHeight) canvas.height = wantHeight
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const shownLit = pinned >= 0 ? pinned : lit
    laid = drawDotplot(ctx, picture, { width: cssWidth, height: cssHeight }, plotTheme(host), view, shownLit)
    view = view === null ? null : laid.view
    whole.classList.toggle('hidden', view === null)
    // Where the lit streak is drawn, in the canvas's own pixels: what a gallery
    // or a test aims at, as the stage's overlay says its view.
    if (shownLit >= 0) {
      const [ax, ay, bx, by] = streakEnds(streaks, shownLit)
      const a = toPixels(laid.view, laid.rect, ax, ay)
      const b = toPixels(laid.view, laid.rect, bx, by)
      canvas.dataset.lit = [a.px, a.py, b.px, b.py].map((value) => value.toFixed(1)).join(' ')
    } else {
      delete canvas.dataset.lit
    }
  }
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(redraw)
  }
  const shownView = (): DotplotView | null => laid?.view ?? null
  const reset = (): void => {
    view = null
    schedule()
    say(idle())
  }
  const zoomBy = (factor: number, px?: number, py?: number): void => {
    const current = shownView()
    if (laid === null || current === null) return
    const cx = px ?? laid.rect.x + laid.rect.width / 2
    const cy = py ?? laid.rect.y + laid.rect.height / 2
    view = clampView(zoomView(current, laid.rect, cx, cy, factor), xTotal, yTotal, laid.rect)
    schedule()
  }
  const panBy = (dx: number, dy: number): void => {
    const current = shownView()
    if (laid === null || current === null) return
    view = clampView(panView(current, laid.rect, dx, dy), xTotal, yTotal, laid.rect)
    schedule()
  }
  /** What is under the pointer, said: the streak, or the place on both axes. */
  const readAt = (x: number, y: number): void => {
    const current = shownView()
    if (laid === null || current === null) return
    const inside = x >= laid.rect.x && x <= laid.rect.x + laid.rect.width && y >= laid.rect.y && y <= laid.rect.y + laid.rect.height
    const next = inside ? streakAt(streaks, current, laid.rect, x, y, REACH_PX) : -1
    if (next !== lit) {
      lit = next
      schedule()
    }
    canvas.classList.toggle('is-on-streak', next >= 0)
    if (pinned >= 0) return
    if (next >= 0) {
      say(describeStreak(picture, next, streaks.anchors))
      return
    }
    if (!inside) {
      say(idle())
      return
    }
    const bases = toBases(current, laid.rect, x, y)
    const xs = locusOf(streaks.x, xOffsets, bases.x)
    const ys = locusOf(streaks.y, yOffsets, bases.y)
    const scale = scaleOf(current, laid.rect)
    say(`${xs === null ? '—' : formatPosition(xs.name, xs.at)} × ${ys === null ? '—' : formatPosition(ys.name, ys.at)} · ${fmt.bp(scale)} a pixel`)
  }

  handDotplot(canvas, {
    zoom: (factor, x, y) => zoomBy(factor, x, y),
    pan: panBy,
    whole: () => {
      pinned = -1
      reset()
    },
    point: readAt,
    press: (x, y) => {
      // A press on a streak keeps it named; anywhere else lets it go.
      pinned = -1
      readAt(x, y)
      pinned = lit
      schedule()
    },
    leave: () => {
      lit = -1
      canvas.classList.remove('is-on-streak')
      if (pinned < 0) say(idle())
      schedule()
    },
  })
  canvas.addEventListener('keydown', (event) => {
    const step = 40
    const keys: Record<string, () => void> = {
      '+': () => zoomBy(1.6),
      '=': () => zoomBy(1.6),
      '-': () => zoomBy(1 / 1.6),
      _: () => zoomBy(1 / 1.6),
      '0': reset,
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
      Escape: () => {
        pinned = -1
        say(idle())
        schedule()
      },
    }
    const run = keys[event.key]
    if (run === undefined || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    run()
  })
  whole.addEventListener('click', () => {
    pinned = -1
    reset()
  })

  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const next = entries[0]?.contentRect.width ?? 0
          if (Math.abs(next - width) < 0.5 && !fill) return
          width = next
          redraw()
        })
  observer?.observe(host)
  if (observer === null) redraw()
  say(idle())
  const stopTheme = watchTheme(schedule)
  const stopText = subscribeTextScale(schedule)

  return {
    el: host,
    draw(ctx: CanvasRenderingContext2D, box: { width: number; height: number }): void {
      // What an export draws is the window on screen, without the pointer's
      // light, on paper whatever the theme where it is mounted (§7.2).
      drawDotplot(ctx, picture, box, plotTheme(figurePaper()), view)
    },
    setFill(on: boolean): void {
      if (fill === on) return
      fill = on
      host.classList.toggle('analysis-figure-fill', on)
      redraw()
    },
    destroy(): void {
      observer?.disconnect()
      stopTheme()
      stopText()
      if (frame !== 0) cancelAnimationFrame(frame)
    },
  }
}
