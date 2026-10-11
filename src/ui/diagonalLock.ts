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
 * stepping along a genome on its diagonal means the next one on it too — and so
 * it is kept where *Refine on zoom* is, in `localStorage` and not the hash: a
 * link shares what is being looked at, and how the recipient likes to move
 * about in it is not that.
 */

const KEY = 'chromosomix:diagonal-lock'

let locked: boolean | null = null
const listeners = new Set<(on: boolean) => void>()

/** Whether the maps are held on their diagonal. Off until the reader asks. */
export function diagonalLocked(): boolean {
  if (locked === null) {
    try {
      locked = window.localStorage.getItem(KEY) === 'on'
    } catch {
      locked = false
    }
  }
  return locked
}

/** Lock or let go, store it, and tell every mounted map. */
export function setDiagonalLocked(on: boolean): void {
  locked = on
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* a browser that refuses storage still honours the choice for this session */
  }
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

/** Forget the stored choice, for a test that wants a reader who never pressed it. */
export function resetDiagonalLock(): void {
  locked = null
}
