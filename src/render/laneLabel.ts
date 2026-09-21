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
 * Both halves of the block are reported, for the same reason: the range is what
 * a reader reads the values against, and the **name** is what tells this lane
 * from the one under it. Neither should have to be corrected somewhere else.
 *
 * Orientation-agnostic, like everything else in this directory: every mark is
 * placed through {@link laneRect} and {@link laneText}, so a right-hand lane's
 * quarter turn is `render/lane.ts`'s business and not this module's (§8.4).
 */

import { laneIsHorizontal, laneRect, laneText, valueAcross, type LaneFrame } from './lane'
import { formatLimit, normaliser } from './tracks'
import { fmt } from '../units'

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
  /** How long the bar under a name is while its read is on its way, in pixels. */
  progressWidth: number
  /** …and how thick. */
  progressThickness: number
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

/** The ellipsis a cut name is joined with; `ui/vector.ts` can draw it into a PDF. */
export const NAME_CUT = '…'

/** Where a name is allowed to break: the punctuation experiments are named with. */
const BREAKS = /[ _.:/-]/

/**
 * How a case-change break is marked and ranked, in one number.
 *
 * Larger than any name anybody types, so `at + CASE_PENALTY` both tags the
 * candidate and sorts it after every punctuation break — and `at % CASE_PENALTY`
 * gets the index back. One array, one sort, and no parallel list of flags.
 */
const CASE_PENALTY = 100_000

/**
 * A name written into `width`, in at most `lines` lines.
 *
 * Three answers in order of preference, and the order is the whole design. A
 * name that fits is left alone. One that does not is **broken** — at the
 * separator nearest its middle whose two halves both fit, because
 * `Yeast_ChIP_Pol2-vs-input` breaks at a word and `YeastChIPPol2vsinput` has no
 * word to break at. One that will not fit even broken is **cut in the middle**,
 * `Yeast_…-input`, because the ends of an experiment's name are where the
 * information is: a run of tracks from one experiment share their beginnings,
 * and a truncation from the right leaves eight identical rows.
 *
 * `measure` is injected rather than a `ctx`, so the arithmetic is testable
 * without a canvas — and so the caller can subtract whatever the colour chip
 * takes from the first line's budget.
 */
export function fitName(
  measure: (text: string) => number,
  text: string,
  width: number,
  lines: number,
): string[] {
  if (text === '' || !(width > 0)) return [text]
  if (measure(text) <= width) return [text]

  if (lines >= 2) {
    const broken = breakInTwo(measure, text, width)
    if (broken !== null) return broken
  }
  return [cutMiddle(measure, text, width * lines)]
}

/**
 * Two lines that both fit, or `null`.
 *
 * The break nearest the middle rather than the last one that fits, because a
 * name split as `Yeast_ChIP_Pol2-vs-` / `input` is one line of name and one of
 * remainder; the reader is looking for two halves. A hard split between
 * characters is the fallback for a name with no separator in it at all.
 */
function breakInTwo(
  measure: (text: string) => number,
  text: string,
  width: number,
): [string, string] | null {
  const middle = text.length / 2
  // Punctuation before case, and only then nearest the middle. A separator is
  // where the *writer* said one part ends; a case change is this module's guess
  // at one, and `Yeast_Ch` / `IP_input` is what happens when the guess is
  // allowed to outrank the fact for being two characters better placed.
  const points: number[] = []
  for (let i = 1; i < text.length; i++) {
    if (BREAKS.test(text[i - 1])) points.push(i)
    else if (isLower(text[i - 1]) && isUpper(text[i])) points.push(i + CASE_PENALTY)
  }
  const rank = (at: number): number =>
    Math.abs((at % CASE_PENALTY) - middle) + (at >= CASE_PENALTY ? CASE_PENALTY : 0)
  points.sort((a, b) => rank(a) - rank(b))
  for (const point of points) {
    const at = point % CASE_PENALTY
    // The separator goes with the line it ends, not onto the next one, and it is
    // dropped rather than drawn: `Yeast_` over `ChIP_input` reads as a name that
    // was cut, which is what the ellipsis is for and this is not.
    const head = text.slice(0, at).replace(/[\s_.:/-]+$/, '')
    const tail = text.slice(at).trimStart()
    if (head === '' || tail === '') continue
    if (measure(head) <= width && measure(tail) <= width) return [head, tail]
  }
  // No separator worth breaking at. Split between characters, as far along as
  // the first line will take, and only where the remainder fits as well —
  // otherwise this is a name for the middle cut rather than for two lines.
  let at = 0
  while (at < text.length && measure(text.slice(0, at + 1)) <= width) at++
  if (at === 0 || at === text.length) return null
  const tail = text.slice(at)
  return measure(tail) <= width ? [text.slice(0, at), tail] : null
}

/**
 * `beginni…end` — as much of both ends as `width` will take.
 *
 * Grown from the two ends alternately so neither is favoured, and the head goes
 * first so an odd pixel lands at the beginning, which is where the eye starts.
 */
function cutMiddle(measure: (text: string) => number, text: string, width: number): string {
  let head = 0
  let tail = 0
  for (;;) {
    const grewHead = head + tail < text.length &&
      measure(`${text.slice(0, head + 1)}${NAME_CUT}${text.slice(text.length - tail)}`) <= width
    if (grewHead) head++
    const grewTail = head + tail < text.length &&
      measure(`${text.slice(0, head)}${NAME_CUT}${text.slice(text.length - tail - 1)}`) <= width
    if (grewTail) tail++
    if (!grewHead && !grewTail) break
  }
  if (head + tail >= text.length) return text
  return `${text.slice(0, head)}${NAME_CUT}${text.slice(text.length - tail)}`
}

const isLower = (ch: string): boolean => ch >= 'a' && ch <= 'z'
const isUpper = (ch: string): boolean => ch >= 'A' && ch <= 'Z'

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
  /**
   * How many lines one name may be written on. Absent keeps the single line.
   *
   * Only a column can afford a second line, which is why it lives here: over the
   * data a name is one line beside its own signal, and wrapping it there would
   * write the second line across the track.
   */
  nameLines?: number
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
  detail:
    | { kind: 'text'; text: string }
    | { kind: 'limits'; min: number; max: number }
    /**
     * A read on its way: a phrase and a bar. `total` is `0` where the host
     * would not say how much is coming, and the bar is then drawn half full
     * rather than empty — a bar at nought says nothing has happened, and
     * something has.
     */
    | { kind: 'progress'; text: string; done: number; total: number }
    | null
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
  /** How far the text ran *along* the lane — see {@link NameBox.along}. */
  along: number
}

/** One track's name on a lane, and the box it was drawn in. */
export interface NameBox {
  /** The entry the name belongs to, so a rename lands on the track it names. */
  id: string
  /** Exactly the text on screen, so an editor opens on what a reader sees. */
  text: string
  box: LabelBox
  /**
   * How far the text ran *along* the lane.
   *
   * Not `box[2]`: on a right-hand lane the text reads upward, so the box's width
   * is the hit height and its *height* is the text — and a caret sized from the
   * rectangle would be twelve pixels wide over a twelve-character name. The
   * extent in reading order is the one an input has to be as wide as, on either
   * edge, which is why it is reported rather than derived.
   */
  along: number
  /**
   * The font it was measured in.
   *
   * The two surfaces write their names at different sizes — twelve and semibold
   * in the browser, nine beside a map — and a caret that is not the size of the
   * text it stands on moves the figure the moment it opens, which is the one
   * thing measuring here rather than in the caller exists to prevent.
   */
  font: string
}

/**
 * The detail line for a lane whose read is on its way.
 *
 * "fetching 1.2 of 4.0 MB" where the host said how much, "fetching…" where it
 * did not, and the bar beside it either way. One function, so the browser
 * and the lanes beside a map cannot phrase the same wait two ways.
 */
export function progressDetail(pending: { done: number; total: number }): {
  kind: 'progress'
  text: string
  done: number
  total: number
} {
  const text =
    pending.total > 0
      ? `fetching ${fmt.bytes(pending.done)} of ${fmt.bytes(pending.total)}`
      : pending.done > 0
        ? `fetching… ${fmt.bytes(pending.done)}`
        : 'fetching…'
  return { kind: 'progress', text, done: pending.done, total: pending.total }
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
  /**
   * Every name drawn, with the box it was measured into.
   *
   * Given up on a short lane for exactly the reason {@link limits} is: the name
   * is still drawn, only the caret is withheld, and it comes back the moment the
   * lane is dragged clear of its own resize border.
   */
  names: NameBox[]
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
    names: [],
    auto: null,
    nameAcross: style.nameTop,
    wanted: 0,
  }
  if (names.length === 0) return out

  // Which way the text advances along the axis, which is a fact about the axis
  // rather than about the side of the map the lane is on: a horizontal lane
  // reads left to right, above the map and below it alike, and a vertical one
  // turns a quarter turn anticlockwise and reads *upward*, so every run after
  // the first starts at a smaller `along`.
  const horizontal = laneIsHorizontal(frame.orientation)
  const dir = horizontal ? 1 : -1
  const near = horizontal ? frame.alongFrom + style.inset : frame.alongTo - style.inset
  const want = (width: number): void => {
    if (width > out.wanted) out.wanted = width
  }
  /**
   * Whether a click target on this line would clear the lane's resize border.
   *
   * The one rule both the names and the limits answer to, written once: an
   * overlap is worse than either mark alone, because the canvas draws the resize
   * hairline — promising a drag — and the press opens a text box instead. A lane
   * too short for both keeps the gesture and gives up the caret.
   */
  const clearOfGrip = (across: number): boolean =>
    across + style.hitHeight / 2 <= frame.thickness - style.grip

  ctx.save()
  ctx.font = style.nameFont
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  // In the column, one name per line — because the column is as wide as the
  // widest of them, and two names side by side would make it as wide as both.
  // Only where the lane has the height for it; a short overlay lane keeps the
  // single row it has always had, and the column simply widens to fit.
  const perName =
    column !== null && frame.thickness >= style.nameTop + names.length * style.nameLine + 6

  const widthOf = (name: LaneLabelName): number =>
    swatchRoom(style) + ctx.measureText(name.text).width
  const runs: Array<readonly LaneLabelName[]> =
    perName ? names.map((name) => [name]) : [names]
  const runWidth = (run: readonly LaneLabelName[]): number =>
    run.reduce((total, name) => total + widthOf(name), 0) + (run.length - 1) * NAME_GAP

  /**
   * The lines each run is written on, once the column has had its say.
   *
   * A name too long for the column is broken or cut rather than run out over the
   * data — but only in a *column*, and only when one name has a row to itself:
   * with two names sharing a row there is no line to continue onto, and over the
   * data the block simply starts at the lane's near end as it always has.
   *
   * How many lines are affordable is a question about the lane's height, and it
   * is asked twice: a name is offered two lines, and if the block that produces
   * would not fit the lane it is re-fitted onto one. A lane dragged short loses
   * the *layout* rather than the fact, which is the rule the range below already
   * follows.
   */
  const fitRun = (run: readonly LaneLabelName[], lines: number): string[] =>
    column === null || !perName || run.length !== 1
      ? [run.map((name) => name.text).join('')]
      : fitName(
          (text) => ctx.measureText(text).width,
          run[0].text,
          column.end - column.start - swatchRoom(style),
          lines,
        )
  const maxLines = column?.nameLines ?? 1
  let plan = runs.map((run) => (maxLines > 1 ? fitRun(run, maxLines) : [null]))
  const linesIn = (rows: Array<Array<string | null>>): number =>
    rows.reduce((total, row) => total + row.length, 0)
  if (frame.thickness < style.nameTop + linesIn(plan) * style.nameLine + 6) {
    plan = runs.map((run) => (maxLines > 1 ? fitRun(run, 1) : [null]))
  }

  const rows = linesIn(plan)
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

  let lastEnd = near
  let line = 0
  for (const [index, run] of runs.entries()) {
    const cut = plan[index]
    // The *natural* width, unwrapped, whatever was drawn. This is what makes the
    // column's measure-then-apply loop safe: `BrowserView.wantGutter` is a frame
    // behind, and its only proof against oscillating is that a name's width does
    // not depend on where the name is drawn. Reporting a wrapped width would
    // shrink the column, un-wrap the name, grow the column, wrap it again.
    want(runWidth(run) + (column?.pad ?? 0))
    for (const [part, text] of cut.entries()) {
      const across = nameTop + line * style.nameLine
      line++
      // Only the first line of a name carries its chip; a continuation is the
      // same name, and a second chip would read as a second track.
      const first = part === 0
      const drawn: Array<{ name: LaneLabelName; text: string }> =
        text === null ? run.map((name) => ({ name, text: name.text })) : [{ name: run[0], text }]
      const total =
        drawn.reduce((sum, item) => sum + ctx.measureText(item.text).width, 0) +
        (first ? drawn.length * swatchRoom(style) : 0) +
        (drawn.length - 1) * NAME_GAP
      let at = column === null ? near : Math.max(column.start, column.end - total)
      for (const item of drawn) {
        // The colour, immediately before the name it belongs to. Drawn on the
        // canvas rather than laid over it, so it is a legend rather than a
        // control: it survives into the exported figure, where a reader who never
        // saw the screen needs to know which line is which. What makes it
        // *clickable* is a transparent colour input positioned over it, from the
        // box handed back here.
        if (style.swatch > 0 && first) {
          const low = across - style.swatch / 2
          const box = laneRect(frame, at, at + dir * style.swatch, low, low + style.swatch)
          ctx.save()
          ctx.strokeStyle = palette.halo
          ctx.lineWidth = 2
          ctx.strokeRect(...box)
          ctx.fillStyle = item.name.colour
          ctx.fillRect(...box)
          ctx.restore()
          out.swatches.push({ id: item.name.id, box })
          at += dir * swatchRoom(style)
        }
        // Each name in its own track's colour, which is the whole legend an
        // overlaid lane needs: the line is that colour and so is its name.
        ctx.fillStyle = names.length > 1 ? item.name.colour : palette.text
        laneText(ctx, frame, item.text, at, across, { halo: palette.halo })
        const width = ctx.measureText(item.text).width
        // Measured in the pass that drew it, for the reason the limits are: a name
        // is the other thing on a lane a reader changes, and it should be changed
        // where it is read. One box per name and not one per lane — an overlaid
        // lane draws several, each its own track's, which is what keeps a rename
        // on the track that was pointed at.
        //
        // The box carries the *whole* name however little of it was drawn: a
        // caret over `Yeast_…-input` opens on the name, not on the cut, or the
        // first Enter would commit the ellipsis.
        if (clearOfGrip(across)) {
          out.names.push({
            id: item.name.id,
            text: item.name.text,
            along: Math.max(...cut.map((part2) => ctx.measureText(part2 ?? item.text).width)),
            font: style.nameFont,
            box: laneRect(
              frame,
              at,
              at + dir * width,
              across - style.hitHeight / 2,
              across + style.hitHeight / 2,
            ),
          })
        }
        at += dir * (width + NAME_GAP)
      }
      if (index === runs.length - 1 && part === cut.length - 1) lastEnd = at - dir * NAME_GAP
    }
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
  // belongs to rather than starting a handle's width to the side of it — and a
  // gap after the name when it goes *beside* one instead, which a thin lane
  // makes the ordinary case (§18.11): flush against it, `80 kb` and `-1.46` are
  // read as one mangled word.
  const along = stacked ? (column === null ? near : column.start) : lastEnd + dir * NAME_GAP

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

  if (spec.detail.kind === 'progress') {
    // The phrase where a note goes, and the bar after it along the lane: a
    // short rule in the lane's own text colour, filled to the fraction read.
    const text = spec.detail.text
    const textWidth = text === '' ? 0 : ctx.measureText(text).width
    const bar = style.progressWidth
    const gap = text === '' ? 0 : NAME_GAP
    const whole = textWidth + gap + bar
    const at = column !== null && stacked ? Math.max(column.start, column.end - whole) : along
    if (column !== null && stacked) want(whole + column.pad)
    if (text !== '') laneText(ctx, frame, text, at, across, { halo: palette.halo })
    const fraction =
      spec.detail.total > 0 ? Math.max(0, Math.min(1, spec.detail.done / spec.detail.total)) : 0.5
    const barFrom = at + dir * (textWidth + gap)
    const barTo = barFrom + dir * bar
    const thick = Math.max(2, style.progressThickness)
    // Centred on the text's baseline band: the bar sits where the letters'
    // x-height is, so it reads as part of the same line.
    const top = across - thick - 1
    ctx.fillStyle = palette.halo
    ctx.fillRect(...laneRect(frame, barFrom, barTo, top, top + thick))
    ctx.fillStyle = palette.text
    ctx.fillRect(...laneRect(frame, barFrom, barFrom + dir * bar * fraction, top, top + thick))
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
  // lane's own far border, which is the resize grip — see `clearOfGrip`, which
  // the names answer to as well.
  const clear = clearOfGrip(across)
  let at = from
  for (const part of ['min', 'max'] as const) {
    const value = part === 'min' ? min : max
    const width = ctx.measureText(value).width
    laneText(ctx, frame, value, at, across, { halo: palette.halo })
    if (clear) {
      out.limits.push({
        part,
        value,
        along: width,
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
