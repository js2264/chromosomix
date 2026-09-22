/**
 * How tall a lane is, and the controls that answer that question in bulk.
 *
 * The floor used to be written three times and disagreed — fourteen in the
 * browser, twelve in the heatmap panel, ten in the lane stack — so a track
 * dragged to eleven pixels was legal on one surface and silently rounded on
 * another. There is one number here now, and one place that says what "give
 * every track the same height" means.
 *
 * The three bulk actions are one thought taken three ways. *Stretch* answers
 * "use the space I have"; *shrink* answers "give it back, to the size I already
 * chose for one of these"; *set* answers "I know what a track should look
 * like" — ninety pixels is where a yeast ATAC track starts showing the shape of
 * a promoter, and a reader who has learned that number wants it back after
 * every fit, on every file, without measuring a window. Each is a way out of
 * the other two.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import { el } from './dom'
import { iconButton } from './icons'

/**
 * The smallest a lane may be dragged to; below this it is a line, not a track.
 *
 * Twelve, which is the middle of the three floors this replaces and the one the
 * side panel's own height box already enforced. A reader who had dragged a lane
 * to ten or eleven pixels finds it a pixel or two taller on their next reload;
 * that is the price of the three numbers becoming one, and it is paid once.
 */
export const LANE_MIN_SIZE = 12

/**
 * The tallest a lane may be dragged to.
 *
 * A lane taller than this is not a track any more — it is the whole window with
 * a profile in it — and beside a map it would push the plot off the screen.
 */
export const LANE_MAX_SIZE = 400

/**
 * The height the `set` button offers before anyone has typed one.
 *
 * See the floor above for where ninety comes from: it is about the height at
 * which a coverage track starts showing shape rather than presence.
 */
export const DEFAULT_TRACK_HEIGHT = 90

/** Clamp a height to what a lane may be. */
export function laneSize(px: number): number {
  return Math.max(LANE_MIN_SIZE, Math.min(LANE_MAX_SIZE, Math.round(px)))
}

/**
 * Give every drawn lane one height.
 *
 * A *lane* and not a track, so two tracks sharing one lane are set once between
 * them rather than twice — which would be the same assignment written twice.
 * The caller hands in the lanes because only the caller knows which entries the
 * surface is actually drawing, and in what grouping.
 */
export function setTrackHeight(
  store: AnnotationStore,
  lanes: ReadonlyArray<{ members: readonly AnnotationEntry[] }>,
  px: number,
): void {
  const size = laneSize(px)
  for (const lane of lanes) {
    for (const member of lane.members) store.restyle(member.id, { size })
  }
}

/**
 * The height that fills `room` with `count` lanes, **equally**.
 *
 * One button doing both halves of what a reader means by "tidy this up": every
 * lane the same height, and that height the one that fills the window. It used
 * to keep whatever proportions the stack was already in, on the reasoning that a
 * reader who made the gene model three times taller meant it — but a stack that
 * has been dragged about for ten minutes has no proportions worth preserving,
 * and preserving them meant the button could not answer the question actually
 * being asked, which is "make these the same".
 *
 * `null` when there is no room to share, so twenty tracks in a short window come
 * out unchanged rather than as twenty lines.
 */
export function heightThatFills(room: number, count: number): number | null {
  if (count <= 0 || !(room > 0)) return null
  const each = Math.floor(room / count)
  return each < LANE_MIN_SIZE ? LANE_MIN_SIZE : Math.min(each, LANE_MAX_SIZE)
}

/**
 * The height of the shortest lane in a stack — what "shrink" gives them all.
 *
 * The other way out of a stretch, and the reason it is *the shortest* rather
 * than the floor: a reader who has dragged one lane down to the height a peak
 * set wants has already said what "small" means here, and twelve pixels is a
 * number this module chose. Shrinking to a lane on screen is therefore a
 * decision the reader has made, applied to the rest; shrinking to the floor
 * would be this module making it for them, and it would be the same picture
 * whatever the stack.
 *
 * Measured over *lanes* for the same reason {@link setTrackHeight} writes over
 * them: two tracks overlaid in one lane are one height, and counting the pair
 * twice would let an overlay decide the answer by being two.
 *
 * `null` when there is nothing to measure, so a stack with no lanes is left
 * alone rather than resized to nothing.
 */
export function smallestLaneSize(
  lanes: ReadonlyArray<{ members: readonly AnnotationEntry[] }>,
): number | null {
  let smallest = Number.POSITIVE_INFINITY
  for (const lane of lanes) {
    for (const member of lane.members) {
      if (member.style.size < smallest) smallest = member.style.size
    }
  }
  return Number.isFinite(smallest) ? laneSize(smallest) : null
}

/**
 * The height every lane in a stack shares, or `null` when they differ.
 *
 * What a bulk control has to be able to say: `90` over a stack of 46-pixel
 * lanes is the box lying about the picture beside it, and there is no honest
 * single number for a stack that has been dragged about. Measured over *lanes*
 * for the reason {@link setTrackHeight} writes over them — two tracks overlaid
 * in one lane are one height.
 */
export function commonLaneSize(
  lanes: ReadonlyArray<{ members: readonly AnnotationEntry[] }>,
): number | null {
  let held: number | null = null
  for (const lane of lanes) {
    for (const member of lane.members) {
      const size = laneSize(member.style.size)
      if (held === null) held = size
      else if (held !== size) return null
    }
  }
  return held
}

/**
 * The middle height in a stack — where a press starts when they disagree.
 *
 * Not the floor and not the last number typed: a reader nudging *down* from a
 * stack of 46-pixel lanes means a bit less than 46, and starting from either of
 * the other two answers is a jump they did not ask for.
 */
export function medianLaneSize(
  lanes: ReadonlyArray<{ members: readonly AnnotationEntry[] }>,
): number | null {
  const sizes: number[] = []
  for (const lane of lanes) {
    for (const member of lane.members) sizes.push(laneSize(member.style.size))
  }
  if (sizes.length === 0) return null
  sizes.sort((a, b) => a - b)
  const middle = Math.floor(sizes.length / 2)
  return sizes.length % 2 === 1 ? sizes[middle] : laneSize((sizes[middle - 1] + sizes[middle]) / 2)
}

/** What {@link stepperField} needs to know about the number it is showing. */
export interface StepperSpec {
  /** The word above the row. */
  label: string
  /** On the box, and on each button after "smaller"/"larger". */
  title: string
  /**
   * The unit, printed after the box: `px`, `%`.
   *
   * A number with no unit beside a number that has one reads as two different
   * kinds of control — which is what `text size ▼ 135% ▲` beside
   * `transparency ▼ 0 ▲` was, two percentages where only one said so.
   */
  unit?: string
  /** One press. */
  step: number
  min: number
  max: number
  /**
   * What the box should read right now, or `null` for **blank**.
   *
   * Blank is the honest answer where the thing this sets has no one value —
   * lanes of three different heights — and it is why `null` does not mean
   * "leave it alone": a box left showing the last number applied is a box
   * claiming the stack is that height (§26.6).
   */
  read(): number | null
  /**
   * Where a press starts while the box is blank.
   *
   * Optional, and only for a control whose value can disagree with itself:
   * nudging from an empty box would otherwise start at the minimum, so a press
   * of *less* on a stack of 46-pixel lanes made every one of them 13.
   */
  start?(): number | null
  /** What a press or a committed edit means. Already clamped and rounded. */
  apply(value: number): void
  /**
   * Tell the box when the number changed behind its back, if it can.
   *
   * Optional, because not every number has anybody else who can move it. Where
   * one does — the opacity lives in the annotation store, and a single row's
   * own settings write the same field — a box that did not listen would
   * show the value it last applied rather than the value in force.
   */
  subscribe?(onChange: () => void): () => void
}

/**
 * A number with a button either side of it: `−  90  +`.
 *
 * The shape the text-size control already had, made shared. Two things about a
 * picture — how tall the tracks are and how far through them you can see — are
 * adjusted the same way: you look at the *picture*, not at the control, and you
 * want it a bit more or a bit less, repeatedly, until it is right. A bare number
 * box asks for a value nobody has in mind, and answers a press of the arrow keys
 * with the browser's own spinner, which is four pixels tall and appears on
 * hover.
 *
 * The box stays editable, which the text-size readout is not, because these two
 * numbers *do* have values people have in mind — ninety pixels is where a yeast
 * ATAC track starts showing the shape of a promoter — and typing one beats
 * pressing a button nine times. Committed on `change`, which covers both Enter
 * and leaving the field, so there is no third control to say "now do it".
 *
 * Nothing is written per keystroke: a store write on the way to `120` would
 * restyle every track four times, at `1`, `12` and `120`.
 */
export function stepperField(spec: StepperSpec): HTMLElement {
  const input = el('input', {
    class: 'input input-num input-step',
    type: 'number',
    title: spec.title,
  })
  input.min = String(spec.min)
  input.max = String(spec.max)
  input.step = String(spec.step)

  const clamp = (value: number): number =>
    Math.max(spec.min, Math.min(spec.max, Math.round(value)))

  /** Put the current value in the box — unless the caret is in it. */
  const sync = (): void => {
    if (input === document.activeElement) return
    const value = spec.read()
    input.value = value === null ? '' : String(clamp(value))
  }

  const commit = (): void => {
    // An unreadable box is put back rather than obeyed — and the test is on the
    // *string*, not on `Number(input.value)`, because `Number('')` is 0 and 0 is
    // finite. A `type="number"` box reports an empty string for a cleared box
    // *and* for everything it could not parse (`abc`, `1e`, `--`), so the guard
    // this replaces never fired once: clearing the track-height box committed
    // `clamp(0)` and collapsed every lane in the stack to the twelve-pixel
    // floor, which is precisely what the comment said it prevented. Same form
    // as `ui/ClipRange.ts`, which learnt it the same way.
    const raw = input.value.trim()
    const typed = raw === '' ? Number.NaN : Number(raw)
    if (!Number.isFinite(typed)) {
      // Written straight into the box rather than through {@link sync}, which
      // leaves a focused box alone. `change` fires on Enter with the caret still
      // in it, so refusing through the guard would be a refusal the reader
      // cannot see for the one way of committing that does not move the focus.
      const held = spec.read()
      if (held !== null) input.value = String(clamp(held))
      return
    }
    const value = clamp(typed)
    input.value = String(value)
    spec.apply(value)
  }
  input.addEventListener('change', commit)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit()
  })

  // From the *box*, not from a remembered number: the two disagree the moment
  // anything else moves the value — a stretch, a drag on a lane's border — and
  // stepping from the stale one would undo that first.
  const nudge = (delta: number): void => {
    const now = spec.read() ?? spec.start?.() ?? Number(input.value)
    const next = clamp((Number.isFinite(now) ? now : spec.min) + delta * spec.step)
    input.value = String(next)
    spec.apply(next)
  }

  const down = iconButton('chevron-down', `Less — ${spec.title}`, () => nudge(-1), {
    class: 'btn btn-icon',
    size: 15,
  })
  const up = iconButton('chevron-up', `More — ${spec.title}`, () => nudge(1), {
    class: 'btn btn-icon',
    size: 15,
  })

  sync()
  const row = el(
    'div',
    { class: 'field field-block field-stepper' },
    el('span', { class: 'field-label', text: spec.label }),
    el(
      'div',
      { class: 'plot-icon-row' },
      down,
      input,
      up,
      ...(spec.unit === undefined ? [] : [el('span', { class: 'clip-note field-unit', text: spec.unit })]),
    ),
  )
  // The source outlives this control — a card is rebuilt on every navigation and
  // nothing hands the outgoing one a teardown — so the listener retires itself
  // the first time it is spoken to after leaving the document.
  const off = spec.subscribe?.(() => {
    if (!row.isConnected) {
      off?.()
      return
    }
    sync()
  })
  return row
}

/**
 * Two fields side by side, where each is narrow enough to share a line.
 *
 * Not a general layout: it exists because text size and opacity are one
 * question asked twice — how legible is this picture — and a column that put
 * them on two lines separated by a track-height box read as three unrelated
 * settings. Two is the limit; a third would give each of them a box four digits
 * cannot fit in.
 */
export function fieldPair(left: HTMLElement, right: HTMLElement): HTMLElement {
  return el('div', { class: 'field-pair' }, left, right)
}

/**
 * A height to give every lane, as a stepper.
 *
 * A pixel a press. The old box stepped by ten with a `set` button beside it,
 * which is the right granularity for *choosing* a height and the wrong one for
 * *adjusting* the one you have: the last twenty pixels of fitting four tracks
 * into a window are found one at a time, and ten was a jump straight past them.
 * Typing still works, and typing is how ninety is reached in one gesture.
 */
export function trackHeightField(
  apply: (px: number) => void,
  source?: {
    /** The lanes on screen, for the number the box shows. */
    lanes(): ReadonlyArray<{ members: readonly AnnotationEntry[] }>
    /** Told when a lane is resized behind the box's back. */
    subscribe(onChange: () => void): () => void
  },
): HTMLElement {
  // **Read from the lanes**, not from what this box last wrote. It used to keep
  // the number it had applied, on the argument that nothing else writes "the
  // height every track would be given" — but three controls two rows above it
  // do: stretch rewrites every lane, shrink levels them down, a group levels
  // its members, and a lane border drags. So the box read `90` over lanes that
  // were plainly 46 px, and a press of *down* made a 46-pixel track taller.
  // Blank where they disagree, because there is no true single number then, and
  // a press starts from the middle one rather than from the floor.
  //
  // `held` survives as the fallback: with no lanes at all there is nothing to
  // read, and the second file of a session is one press away from the height
  // chosen for the first.
  let held = DEFAULT_TRACK_HEIGHT
  const lanes = (): ReadonlyArray<{ members: readonly AnnotationEntry[] }> => source?.lanes() ?? []
  return stepperField({
    label: 'track height',
    title: `Height for every track, in pixels. ${LANE_MIN_SIZE} is the floor.`,
    unit: 'px',
    step: 1,
    min: LANE_MIN_SIZE,
    max: LANE_MAX_SIZE,
    read: () => (lanes().length === 0 ? held : commonLaneSize(lanes())),
    start: () => medianLaneSize(lanes()) ?? held,
    apply: (value) => {
      held = laneSize(value)
      apply(held)
    },
    subscribe: source === undefined ? undefined : (onChange) => source.subscribe(onChange),
  })
}
