/**
 * How far the reader got through the guided tutorial (§30), kept in this browser.
 *
 * A **preference** in the persistence tiers' sense rather than a fact about a
 * file or a tab: it is about the reader, it outlives a reload and a closed
 * window, and it is worth exactly as much on the next file as on this one. So
 * it is `localStorage` under the app's prefix, and the stored-data dialog counts
 * it among the settings without being told to (`state/stored.ts`'s prefix rule).
 *
 * Its own module rather than a corner of the tour's, because the one surface
 * that reads it on every visit — *About*, which offers to resume — must not
 * have to load the tour to ask a yes-or-no question about it. The tour itself
 * is a chunk of its own, fetched when it is played (`app/App.ts`).
 *
 * The step is kept **by id and by position**. The id is what a resume lands on,
 * and survives a later build that adds a step before it; the position and the
 * total are only what *About* prints — *resume at step 12 of 35* — and are
 * never used to find the step.
 */

/** The key, under the prefix every key this app writes begins with. */
export const TOUR_KEY = 'chromosomix:tour'

export interface TourProgress {
  /** The step the reader was on when they left, by its id. */
  step: string
  /** Its position, from 0, as the build that wrote it numbered the steps. */
  index: number
  /** How many steps that build's tutorial had. */
  total: number
  /** Whether they reached the last step and pressed *finish*. */
  finished: boolean
}

/** What was kept, or `null` for a reader who has never started — or a value nobody wrote. */
export function readTourProgress(): TourProgress | null {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(TOUR_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<TourProgress>
    if (
      typeof value.step !== 'string' ||
      typeof value.index !== 'number' ||
      typeof value.total !== 'number' ||
      typeof value.finished !== 'boolean'
    ) {
      return null
    }
    return { step: value.step, index: value.index, total: value.total, finished: value.finished }
  } catch {
    return null
  }
}

export function writeTourProgress(progress: TourProgress): void {
  try {
    window.localStorage.setItem(TOUR_KEY, JSON.stringify(progress))
  } catch {
    // A browser that refuses storage still runs the tutorial; it only cannot
    // offer to resume it after a reload, which is the honest consequence.
  }
}
