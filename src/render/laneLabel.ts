/**
 * What is written on a lane, drawn once and *reported back*.
 *
 * Every lane in this application carries the same block of small print: a
 * colour chip, one name or several, and under them what the value axis spans.
 * It was written twice — once in the 1D browser and once beside the map — and
 * the two copies drifted exactly where it mattered. The browser's version
 * measured each end of the range separately and remembered the box, which is
 * what makes a limit something a reader can put a caret in; the map's joined the
 * pair into one string and forgot where it had put it, which is what made the
 * same two numbers inert there.
 *
 * So there is one implementation, and its return value is the point of it: a
 * label that only *draws* can never be pointed at. The boxes come back in canvas
 * coordinates from the same pass that measured the text into them, because any
 * second measurement is a second opinion about the same font — and the
 * difference between the two opinions is exactly the pixel the click misses by.
 *
 * Orientation-agnostic, like everything else in this directory: every mark is
 * placed through {@link laneRect} and {@link laneText}, so a right-hand lane's
 * quarter turn is `render/lane.ts`'s business and not this module's (§8.4).
 */

import { laneRect, laneText, valueAcross, type LaneFrame } from './lane'
import { formatLimit, normaliser } from './tracks'

/** A rectangle in canvas pixels: what a pointer is tested against. */
export type LabelBox = [x: number, y: number, width: number, height: number]

/** One name on a lane, and the colour its ink is drawn in. */
export interface LaneLabelName {
  /** The entry this name belongs to, so a control can be tied back to it. */
  id: string
  text: string
  colour: string
}

/**
 * The sizes a surface writes its small print at.
 *
 * Passed in rather than chosen here, and that is deliberate. Beside a map a lane
 * can be sixteen pixels tall and its text has to be nine; in the browser a lane
 * is ninety and its name is the thing a reader looks for, so it is twelve and
 * heavier. Neither set is a default the other should inherit — a shared module
 * that picked one would reflow the surface it did not pick.
 */
export interface LaneLabelStyle {
  nameFont: string
  rangeFont: string
  /** The colour chip before a name, in CSS pixels. `0` draws none. */
  swatch: number
  /** Where the first name's line sits, measured from the label's own end. */
  nameTop: number
  /** Line height for a column of names, one per overlaid track. */
  nameLine: number
  /** How far under the name the range sits, when the lane is tall enough. */
  detailDrop: number
  /** Clear space between the lane's near end and the start of the block. */
  inset: number
  /** How tall a limit's click target is: the text, plus a little either side. */
  hitHeight: number
  /** Room kept after the range for the lane's autoscale button. `0` for none. */
  autoSlot: number
  /**
   * How close to the lane's far border counts as being on it.
   *
   * Not decoration: it is what the resize drag grabs, and a limit's click target
   * that reached into it would promise a caret where the press resizes.
   */
  grip: number
}

/**
 * A column to right-align the block in, when the surface has one.
 *
 * `null` draws the block over the data, starting at the lane's near end, which
 * is what a lane beside a map always does — the margin there belongs to the
 * heatmap's own block labels, and a bottom canvas cannot grow backwards to make
 * one of its own.
 */
export interface LaneLabelColumn {
  /** The leftmost the block may start: past whatever hangs in the margin. */
  start: number
  /** Where a right-aligned block ends: clear of the data and of the handle. */
  end: number
  /** What to add to a measured width when reporting what the column wants. */
  pad: number
}

export interface LaneLabelSpec {
  /** One name, or one per track when a group is drawn into a single lane. */
  names: readonly LaneLabelName[]
  /**
   * What goes under the names: a phrase, a pair of limits, or nothing.
   *
   * The pair is not a string. Written as one it can be drawn and no more; kept
   * as two numbers it is drawn as two separately measured runs, each of which
   * comes back as a box — which is the whole difference between a range you read
   * and a range you edit.
   */
  detail: { kind: 'text'; text: string } | { kind: 'limits'; min: number; max: number } | null
  /**
   * Which end of the lane the block sits at, across.
   *
   * The end the signal is *not* growing from, which is a fact about where the
   * baseline is and therefore about the edge and the flip together — see
   * {@link labelEndFor}. A caption at the other end is written through the data
   * it is naming, which is the one place a caption must not be. Feature lanes
   * have no baseline and pass `near`.
   */
  labelAt: 'near' | 'far'
  column: LaneLabelColumn | null
  style: LaneLabelStyle
  palette: { text: string; halo: string }
}

/** A colour chip, and the square it was drawn in. */
export interface SwatchBox {
  id: string
  box: LabelBox
}

/** One end of a lane's value axis, and the box it was drawn in. */
export interface LimitBox {
  part: 'min' | 'max'
  /** Exactly the text on screen, so an editor opens on what a reader sees. */
  value: string
  box: LabelBox
}

export interface LaneLabelBoxes {
  swatches: SwatchBox[]
  /**
   * Empty when the range is a phrase rather than a pair, and — deliberately —
   * when the lane is too short to hold a click target clear of its own resize
   * border. The numbers are still drawn; only the caret is given up, and it
   * comes back the moment the lane is dragged taller.
   */
  limits: LimitBox[]
  /** Centre of the lane's autoscale button, in canvas pixels. */
  auto: { x: number; y: number } | null
  /** Where across the lane the first name's line fell: the handle's row. */
  nameAcross: number
  /** How wide a column this block would like, including the column's padding. */
  wanted: number
}

/**
 * Draw a lane's label block and hand back everything that can be pointed at.
 *
 * The caller clips the *data* and releases the clip before calling this: with a
 * name column the block sits outside the lane's own rectangle, and a clip to the
 * data would take it away.
 */
export function drawLaneLabel(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  spec: LaneLabelSpec,
): LaneLabelBoxes {
  const { style, palette, names, column } = spec
  const out: LaneLabelBoxes = {
    swatches: [],
    limits: [],
    auto: null,
    nameAcross: style.nameTop,
    wanted: 0,
  }
  if (names.length === 0) return out

  // Which way the text advances along the axis. A bottom lane reads left to
  // right; a right-hand lane turns a quarter turn anticlockwise and reads
  // *upward*, so every run after the first starts at a smaller `along`.
  const dir = frame.orientation === 'bottom' ? 1 : -1
  const near = frame.orientation === 'bottom'
    ? frame.alongFrom + style.inset
    : frame.alongTo - style.inset
  const want = (width: number): void => {
    if (width > out.wanted) out.wanted = width
  }

  ctx.save()
  ctx.font = style.nameFont
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  // In the column, one name per line — because the column is as wide as the
  // widest of them, and two names side by side would make it as wide as both.
  // Only where the lane has the height for it; a short overlay lane keeps the
  // single row it has always had, and the column simply widens to fit.
  const rows =
    column !== null && frame.thickness >= style.nameTop + names.length * style.nameLine + 6
      ? names.length
      : 1
  const block = (rows - 1) * style.nameLine
  // Under the names when the lane has room for a second line, beside them when
  // it has not: a clipped lane should lose the *layout* rather than the fact.
  const stacked = frame.thickness >= style.nameTop + block + style.detailDrop + 6
  const label = block + (stacked ? style.detailDrop : 0)
  // In the column, centred on the lane — because there the label is beside its
  // track rather than on top of it, and a caption in a column of them belongs
  // level with the middle of the thing it names. Over the data it stays at the
  // end of the lane the signal is *not* growing from, which for an unflipped
  // track is where it has always been.
  // At the far end the block is measured back from that edge — and back by
  // enough that its *last* line still clears the lane's own resize border. The
  // near end can use the plain inset because the border is at the other end;
  // here `nameTop` on its own would put the range inside the grip, which is
  // exactly the overlap that costs a lane its caret (see `clear`, below). A
  // flipped track used to lose the ability to type its limits for that reason.
  const farGuard = Math.max(style.nameTop, style.grip + style.hitHeight / 2)
  const nameTop =
    column !== null
      ? Math.max(6, Math.round((frame.thickness - label) / 2))
      : spec.labelAt === 'far'
        ? Math.max(6, frame.thickness - farGuard - (stacked ? style.detailDrop : 0) - block)
        : style.nameTop
  out.nameAcross = nameTop

  const widthOf = (name: LaneLabelName): number =>
    swatchRoom(style) + ctx.measureText(name.text).width
  const runs: Array<readonly LaneLabelName[]> =
    rows === 1 ? [names] : names.map((name) => [name])
  const runWidth = (run: readonly LaneLabelName[]): number =>
    run.reduce((total, name) => total + widthOf(name), 0) + (run.length - 1) * NAME_GAP

  let lastEnd = near
  for (const [row, run] of runs.entries()) {
    const across = nameTop + row * style.nameLine
    const total = runWidth(run)
    want(total + (column?.pad ?? 0))
    let at = column === null ? near : Math.max(column.start, column.end - total)
    for (const name of run) {
      // The colour, immediately before the name it belongs to. Drawn on the
      // canvas rather than laid over it, so it is a legend rather than a
      // control: it survives into the exported figure, where a reader who never
      // saw the screen needs to know which line is which. What makes it
      // *clickable* is a transparent colour input positioned over it, from the
      // box handed back here.
      if (style.swatch > 0) {
        const low = across - style.swatch / 2
        const box = laneRect(frame, at, at + dir * style.swatch, low, low + style.swatch)
        ctx.save()
        ctx.strokeStyle = palette.halo
        ctx.lineWidth = 2
        ctx.strokeRect(...box)
        ctx.fillStyle = name.colour
        ctx.fillRect(...box)
        ctx.restore()
        out.swatches.push({ id: name.id, box })
        at += dir * swatchRoom(style)
      }
      // Each name in its own track's colour, which is the whole legend an
      // overlaid lane needs: the line is that colour and so is its name.
      ctx.fillStyle = names.length > 1 ? name.colour : palette.text
      laneText(ctx, frame, name.text, at, across, { halo: palette.halo })
      at += dir * (ctx.measureText(name.text).width + NAME_GAP)
    }
    if (row === runs.length - 1) lastEnd = at - dir * NAME_GAP
  }

  if (spec.detail === null) {
    ctx.restore()
    return out
  }

  ctx.font = style.rangeFont
  ctx.fillStyle = palette.text
  ctx.textAlign = 'left'
  const across = stacked ? nameTop + block + style.detailDrop : nameTop + block
  // The same slot the names gave up, so the range stays under the name it
  // belongs to rather than starting a handle's width to the side of it.
  const along = stacked ? (column === null ? near : column.start) : lastEnd

  if (spec.detail.kind === 'text') {
    const text = spec.detail.text
    if (text !== '') {
      const width = ctx.measureText(text).width
      const at = column !== null && stacked ? Math.max(column.start, column.end - width) : along
      if (column !== null && stacked) want(width + column.pad)
      laneText(ctx, frame, text, at, across, { halo: palette.halo })
    }
    ctx.restore()
    return out
  }

  // Each end written separately, so each end has a box of its own to point at.
  const min = formatLimit(spec.detail.min)
  const max = formatLimit(spec.detail.max)
  // The range goes wherever its names went, so the two stay one label — and in
  // the column it is right-aligned like them, with the lane's autoscale button
  // kept inside the column rather than pushed onto the data.
  const range = ctx.measureText(`${min} ${DASH} ${max}`).width
  const from =
    column !== null && stacked
      ? Math.max(column.start, column.end - style.autoSlot - range)
      : along
  if (column !== null && stacked) want(range + style.autoSlot + column.pad)
  // …but the click targets are recorded only where the box is clear of the
  // lane's own far border, which is the resize grip. On a short lane the two
  // overlap, and an overlap is worse than either alone: the canvas draws the
  // resize hairline, promising a drag, and the press opens a text box instead.
  // A lane too short to hold both keeps the gesture and gives up the caret — the
  // range is still drawn, and it is editable again the moment the lane is
  // dragged taller.
  const clear = across + style.hitHeight / 2 <= frame.thickness - style.grip
  let at = from
  for (const part of ['min', 'max'] as const) {
    const value = part === 'min' ? min : max
    const width = ctx.measureText(value).width
    laneText(ctx, frame, value, at, across, { halo: palette.halo })
    if (clear) {
      out.limits.push({
        part,
        value,
        box: laneRect(
          frame,
          at,
          at + dir * width,
          across - style.hitHeight / 2,
          across + style.hitHeight / 2,
        ),
      })
    }
    at += dir * width
    if (part === 'min') {
      laneText(ctx, frame, ` ${DASH} `, at, across, { halo: palette.halo })
      at += dir * ctx.measureText(` ${DASH} `).width
    }
  }
  // Where the lane's own autoscale button goes: immediately after the number it
  // hands back to the data. Recorded here for the same reason the limits are —
  // the button is placed against text this pass measured.
  if (clear && style.autoSlot > 0) {
    const spot = laneRect(
      frame,
      at + dir * AUTO_GAP,
      at + dir * (AUTO_GAP + style.autoSlot),
      across - style.autoSlot / 2,
      across + style.autoSlot / 2,
    )
    out.auto = { x: spot[0] + spot[2] / 2, y: spot[1] + spot[3] / 2 }
  }
  ctx.restore()
  return out
}

/**
 * Which end of a lane a value track's caption belongs at.
 *
 * The end farthest from the **baseline**, because the baseline is where the ink
 * starts: a coverage track fills from it outwards, so the opposite end is the
 * part of the lane that is usually empty and the only place a name can go
 * without being written across a peak.
 *
 * Which end that is depends on the edge *and* on the flip, and the two do not
 * agree. A bottom lane's zero is at its floor, so its name is at the top and a
 * flipped one moves to the floor. A right-hand lane's zero is at the edge
 * nearest the map and it grows outwards, so the empty end is the *far* one —
 * the opposite answer — and a flipped one moves back in. Deriving it from
 * `valueAcross` rather than writing the four cases down is what makes the label
 * and the picture incapable of disagreeing (§8.4).
 */
export function labelEndFor(frame: LaneFrame, limits: { min: number; max: number }, flip: boolean): 'near' | 'far' {
  const linear = normaliser(limits)
  const norm = flip ? (value: number) => 1 - linear(value) : linear
  const zero = limits.min <= 0 && limits.max >= 0 ? norm(0) : flip ? 1 : 0
  return valueAcross(frame, zero) > frame.thickness / 2 ? 'near' : 'far'
}

/** The chip plus the air between it and the name it belongs to. */
function swatchRoom(style: LaneLabelStyle): number {
  return style.swatch === 0 ? 0 : style.swatch + 5
}

/** Air between two names sharing a line. */
const NAME_GAP = 12

/** Air between the top of the range and the button that resets it. */
const AUTO_GAP = 5

/**
 * An en dash with a space either side, which is what a range reads as.
 *
 * Here rather than at the two places it is written, because the width measured
 * for the gap and the string drawn into it must be the same string — otherwise
 * the second limit's box is a couple of pixels off the number in it.
 */
const DASH = '–'
