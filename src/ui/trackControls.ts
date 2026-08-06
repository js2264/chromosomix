/**
 * How tall a lane is, and the controls that answer that question in bulk.
 *
 * The floor used to be written three times and disagreed — fourteen in the
 * browser, twelve in the heatmap panel, ten in the lane stack — so a track
 * dragged to eleven pixels was legal on one surface and silently rounded on
 * another. There is one number here now, and one place that says what "give
 * every track the same height" means.
 *
 * The two bulk actions are one thought taken two ways. *Stretch* answers "use
 * the space I have"; *set* answers "I know what a track should look like" —
 * ninety pixels is where a yeast ATAC track starts showing the shape of a
 * promoter, and a reader who has learned that number wants it back after every
 * fit, on every file, without measuring a window. Each is also the way out of
 * the other.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import { button, el } from './dom'

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
 * A height to give every lane, and the button that gives it to them.
 *
 * The box holds a number and nothing else happens when it changes: typing is not
 * an instruction, and a store write per keystroke would restyle every track
 * eight times on the way to `120`. Enter and the button are the instruction,
 * which is also what makes the box a *remembered* number — it keeps what you
 * last applied, so the second file of the session is one press away from the
 * height you chose for the first.
 */
export function trackHeightField(apply: (px: number) => void): HTMLElement {
  const input = el('input', {
    class: 'input input-num',
    type: 'number',
    value: String(DEFAULT_TRACK_HEIGHT),
    title: `Height for every track, in pixels. ${LANE_MIN_SIZE} is the floor.`,
  })
  input.min = String(LANE_MIN_SIZE)
  input.max = String(LANE_MAX_SIZE)
  input.step = '10'
  const run = (): void => {
    const typed = Number(input.value)
    // An unreadable box is put back rather than obeyed: `Number('')` is 0, and
    // silently setting every lane to the minimum is not what an empty field
    // means.
    if (!Number.isFinite(typed) || typed <= 0) {
      input.value = String(DEFAULT_TRACK_HEIGHT)
      return
    }
    const size = laneSize(typed)
    input.value = String(size)
    apply(size)
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run()
  })
  return el(
    'div',
    { class: 'field field-block' },
    el('span', { class: 'field-label', text: 'track height' }),
    el(
      'div',
      { class: 'height-row' },
      input,
      button('set', run, {
        class: 'btn',
        title: 'Give every track the height in the box, whatever the window is doing',
      }),
    ),
  )
}
