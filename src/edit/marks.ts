/**
 * The suggestions, drawn over the map (SPECS §27.3): what the method proposes,
 * on the picture the reader is judging it by, in the accent — a suggestion is
 * something a reader can act on (§26.5), an offer and never a caution, so
 * nothing here is drawn in a warning's colour.
 *
 * - A **diamond** on the diagonal where it takes a junction away: the map says
 *   the reference is discontinuous there.
 * - A **corner** — an L of two strokes opening into its quadrant — where it
 *   brings two ends together: the corner of the block of contacts that stops
 *   there, which is the evidence, drawn in both triangles.
 * - A **number** beside it, the one the rail and the list give it.
 * - And for the one lit — hovered on the map, on the rail or in the list — what
 *   it would do: a turning arrow along a stretch it turns, an arrow from a
 *   stretch it moves to the line where it goes in, a cut across the diagonal
 *   where it splits, an arrow between two ends it joins.
 *
 * Canvas calls only, against a context and the numbers to place things by.
 */

import type { StageInk } from './draw'
import type { Suggestion } from './suggest'

/** A suggestion as the map draws it. */
export interface MarkedSuggestion {
  suggestion: Suggestion
  /** Its number, as the rail and the list give it. */
  number: number
  lit: boolean
}

/** What the marks are drawn from on one frame. */
export interface MarksFrame {
  size: number
  toX: (unit: number) => number
  toY: (unit: number) => number
  ink: StageInk
  marks: readonly MarkedSuggestion[]
}

/** A mark's place on the map, for the pointer to find it by: in pixels, and in units of the axis. */
export interface MarkSpot {
  key: string
  x: number
  y: number
  col: number
  row: number
  /** A corner, rather than a point on the diagonal. */
  corner: boolean
}

/** Every place a suggestion is drawn at: its diamonds and its corners, both triangles. */
export function markSpots(frame: Omit<MarksFrame, 'ink'>): MarkSpot[] {
  const spots: MarkSpot[] = []
  const spot = (key: string, col: number, row: number, corner: boolean): void => {
    spots.push({ key, x: frame.toX(col), y: frame.toY(row), col, row, corner })
  }
  for (const { suggestion } of frame.marks) {
    for (const x of suggestion.breaks) spot(suggestion.key, x, x, false)
    for (const corner of suggestion.corners) {
      spot(suggestion.key, corner.col, corner.row, true)
      spot(suggestion.key, corner.row, corner.col, true)
    }
  }
  return spots
}

/** Draw every suggestion's marks, the lit one last and strongest. */
export function drawSuggestions(ctx: CanvasRenderingContext2D, frame: MarksFrame): void {
  const ordered = [...frame.marks].sort((a, b) => Number(a.lit) - Number(b.lit))
  for (const mark of ordered) {
    if (mark.lit) drawDoing(ctx, frame, mark.suggestion)
    drawMarks(ctx, frame, mark)
  }
}

function visible(frame: MarksFrame, x: number, y: number, room = 24): boolean {
  return x >= -room && x <= frame.size + room && y >= -room && y <= frame.size + room
}

/** A stroke with a halo of the background under it, so it reads over the darkest contacts. */
function haloed(ctx: CanvasRenderingContext2D, ink: StageInk, width: number, path: () => void, alpha = 1): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.globalAlpha = 0.75 * alpha
  ctx.strokeStyle = ink.background
  ctx.lineWidth = width + 2.5
  ctx.beginPath()
  path()
  ctx.stroke()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = ink.accent
  ctx.lineWidth = width
  ctx.beginPath()
  path()
  ctx.stroke()
  ctx.globalAlpha = 1
}

function drawMarks(ctx: CanvasRenderingContext2D, frame: MarksFrame, mark: MarkedSuggestion): void {
  const { toX, toY, ink } = frame
  const { suggestion, lit } = mark
  const alpha = lit ? 1 : 0.88

  // Where it takes a junction away: a diamond on the diagonal.
  const r = lit ? 6.5 : 5
  for (const x of suggestion.breaks) {
    const px = toX(x)
    const py = toY(x)
    if (!visible(frame, px, py)) continue
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(px, py - r)
    ctx.lineTo(px + r, py)
    ctx.lineTo(px, py + r)
    ctx.lineTo(px - r, py)
    ctx.closePath()
    ctx.fillStyle = ink.accent
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = ink.background
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Where it brings two ends together: a corner opening into its quadrant, in
  // both triangles.
  const length = lit ? 14 : 11
  const width = lit ? 3 : 2.25
  for (const corner of suggestion.corners) {
    const places: Array<[number, number, 1 | -1, 1 | -1]> = [
      [toX(corner.col), toY(corner.row), corner.colSide, corner.rowSide],
      [toX(corner.row), toY(corner.col), corner.rowSide, corner.colSide],
    ]
    for (const [px, py, across, down] of places) {
      if (!visible(frame, px, py)) continue
      haloed(
        ctx,
        ink,
        width,
        () => {
          ctx.moveTo(px + across * length, py)
          ctx.lineTo(px, py)
          ctx.lineTo(px, py + down * length)
        },
        alpha,
      )
    }
  }

  // Its number, beside its first mark in the upper triangle.
  const anchor = badgeAt(frame, suggestion)
  if (anchor !== null) {
    const [bx, by] = anchor
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.arc(bx, by, lit ? 9 : 8, 0, 2 * Math.PI)
    ctx.fillStyle = ink.accent
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = ink.background
    ctx.stroke()
    ctx.fillStyle = ink.background
    ctx.font = `600 ${lit ? 11 : 10}px ${ink.font.replace(/^\d+px\s*/, '')}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(mark.number), bx, by + 0.5)
    ctx.globalAlpha = 1
  }
}

/** Where a suggestion's number goes: up and right of its first corner, else of its first diamond. */
function badgeAt(frame: MarksFrame, suggestion: Suggestion): [number, number] | null {
  const { toX, toY } = frame
  const corner = suggestion.corners[0]
  const [x, y] =
    corner !== undefined
      ? [toX(corner.col), toY(corner.row)]
      : suggestion.breaks[0] !== undefined
        ? [toX(suggestion.breaks[0]), toY(suggestion.breaks[0])]
        : [Number.NaN, Number.NaN]
  if (!visible(frame, x, y, 0)) return null
  return [Math.min(frame.size - 10, x + 13), Math.max(10, y - 13)]
}

/** A point on the diagonal, in pixels. */
function onDiagonal(frame: MarksFrame, unit: number): [number, number] {
  return [frame.toX(unit), frame.toY(unit)]
}

/**
 * An arrow along a curve bowed off the diagonal into the upper triangle, from
 * one point on it to another, with a head at `to` — and at `from` as well for
 * a turn, which goes both ways.
 */
function bowedArrow(ctx: CanvasRenderingContext2D, frame: MarksFrame, from: [number, number], to: [number, number], both: boolean): void {
  const [x0, y0] = from
  const [x1, y1] = to
  const length = Math.hypot(x1 - x0, y1 - y0)
  if (length < 6) return
  // Off the diagonal, up and to the right, by a third of the span.
  const bow = Math.max(16, Math.min(90, length * 0.33))
  const mx = (x0 + x1) / 2 + bow / Math.SQRT2
  const my = (y0 + y1) / 2 - bow / Math.SQRT2
  haloed(ctx, frame.ink, 2, () => {
    ctx.moveTo(x0, y0)
    ctx.quadraticCurveTo(mx, my, x1, y1)
  })
  const head = (tipX: number, tipY: number, fromX: number, fromY: number): void => {
    const angle = Math.atan2(tipY - fromY, tipX - fromX)
    const size = 8
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - size * Math.cos(angle - 0.45), tipY - size * Math.sin(angle - 0.45))
    ctx.lineTo(tipX - size * Math.cos(angle + 0.45), tipY - size * Math.sin(angle + 0.45))
    ctx.closePath()
    ctx.fillStyle = frame.ink.accent
    ctx.fill()
  }
  head(x1, y1, mx, my)
  if (both) head(x0, y0, mx, my)
}

/** A dashed outline of a stretch's square on the diagonal: what would move or turn. */
function stretchOutline(ctx: CanvasRenderingContext2D, frame: MarksFrame, stretch: readonly [number, number]): void {
  const [a, b] = stretch
  const x0 = frame.toX(a)
  const y0 = frame.toY(a)
  const x1 = frame.toX(b)
  const y1 = frame.toY(b)
  ctx.setLineDash([5, 4])
  ctx.strokeStyle = frame.ink.background
  ctx.lineWidth = 3
  ctx.globalAlpha = 0.6
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
  ctx.globalAlpha = 1
  ctx.strokeStyle = frame.ink.accent
  ctx.lineWidth = 1.5
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
  ctx.setLineDash([])
}

/** A short line across the diagonal: where a stretch goes in, or where a sequence is cut. */
function across(ctx: CanvasRenderingContext2D, frame: MarksFrame, unit: number, half: number): void {
  const [x, y] = onDiagonal(frame, unit)
  haloed(ctx, frame.ink, 2.5, () => {
    ctx.moveTo(x - half, y + half)
    ctx.lineTo(x + half, y - half)
  })
}

/** What the lit suggestion would do. */
function drawDoing(ctx: CanvasRenderingContext2D, frame: MarksFrame, suggestion: Suggestion): void {
  switch (suggestion.kind) {
    case 'turn': {
      const stretch = suggestion.stretch
      if (stretch === null) return
      stretchOutline(ctx, frame, stretch)
      bowedArrow(ctx, frame, onDiagonal(frame, stretch[0]), onDiagonal(frame, stretch[1]), true)
      return
    }
    case 'move': {
      const stretch = suggestion.stretch
      const target = suggestion.target
      if (stretch === null || target === null) return
      stretchOutline(ctx, frame, stretch)
      across(ctx, frame, target, 11)
      bowedArrow(ctx, frame, onDiagonal(frame, (stretch[0] + stretch[1]) / 2), onDiagonal(frame, target), false)
      return
    }
    case 'split': {
      const at = suggestion.breaks[0]
      if (at !== undefined) across(ctx, frame, at, 14)
      return
    }
    case 'join': {
      const [a, b] = suggestion.extent
      bowedArrow(ctx, frame, onDiagonal(frame, a), onDiagonal(frame, b), true)
      return
    }
  }
}
