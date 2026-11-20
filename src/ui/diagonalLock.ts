/**
 * Whether the maps are held on their diagonal (§7.2): Space, the button beside
 * the turn, and the palette's *Diagonal lock*.
 *
 * Locked, a map goes onto its diagonal at the zoom it is at and stays there:
 * a drag, a scroll, a pinch and the arrow keys all move it along the line, a
 * sideways scroll slides down it, and an Option-drag draws its box on it as
 * Option and Shift do (`render/heatmap.ts`). Unlocked, a sideways scroll is the
 * columns alone and every gesture goes where the hand does.
 *
 * One switch for every map on screen rather than one per map, for the reason
 * *Refine on zoom*'s is (`ui/refine.ts`): it is a way of reading, and a deck's
 * maps move as one (§16.2), so a lead held on its diagonal beside a companion
 * that was not would be dragged off it by its own neighbour. It outlives a
 * navigation — a step to the next sequence rebuilds the map, and the reader
 * stepping along a genome on its diagonal means the next one on it too — and
 * it is not in the hash: a link shares what is being looked at, and how the
 * recipient likes to move about in it is not that.
 *
 * **On, every time the app opens.** A contact map is read along its diagonal,
 * and a map that drifts off the line under a drag is the commonest way a reader
 * loses their place in one. It was off until pressed, and the press was kept in
 * `localStorage`, so a reader who let go once to look at a contact off the line
 * found every map unlocked in every later visit. A press that lets go now lasts
 * as long as the page — every map, every navigation — and the next visit starts
 * held again. The old key is cleared on the first read, so an unlock stored
 * before this cannot outlive it.
 */

/** Where the lock used to be kept (`'on'` / `'off'`); cleared on the first read. */
const STALE_KEY = 'chromosomix:diagonal-lock'

/** Held, until the reader lets go. */
export const DIAGONAL_LOCK_DEFAULT = true

let locked: boolean | null = null
const listeners = new Set<(on: boolean) => void>()

/** Whether the maps are held on their diagonal. On until the reader lets go. */
export function diagonalLocked(): boolean {
  if (locked === null) {
    locked = DIAGONAL_LOCK_DEFAULT
    try {
      window.localStorage.removeItem(STALE_KEY)
    } catch {
      /* nothing was kept where storage is refused */
    }
  }
  return locked
}

/** Lock or let go, for the life of the page, and tell every mounted map. */
export function setDiagonalLocked(on: boolean): void {
  locked = on
  for (const listener of [...listeners]) listener(on)
}

export function toggleDiagonalLock(): boolean {
  const next = !diagonalLocked()
  setDiagonalLocked(next)
  return next
}

/** Hear the lock taken and released; returns the unsubscribe. */
export function subscribeDiagonalLock(listener: (on: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Forget the reader's press, for a test that wants a reader who never pressed it. */
export function resetDiagonalLock(): void {
  locked = null
}
