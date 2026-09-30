/**
 * The reference editor's corner dot plot (SPECS §27.3, §28), as arithmetic:
 * the streaks between the file's own sequence and another reference, found
 * once, and drawn **through the edit as it stands** — every streak re-placed
 * on the edited assembly's axis wherever the pieces it falls in went, turned
 * with them, and cut where an edit cut them — so that each step shows at once
 * whether the assembly is coming to read as the other reference does. Nothing
 * is found again: an edit moves the lines, it does not make new ones.
 *
 * Tested without a canvas; `LiveDotplot.ts` draws it in the stage's corner.
 */

import type { DotplotStreaks } from '../analysis/types'
import type { DotplotAxis, DotplotLines } from '../dotplot/view'
import type { EditedAssembly } from '../genome/edit'

/** A streak on one original sequence of the file, the other reference's side along its concatenated axis. */
export interface OriginalStreak {
  /** The file's sequence it lies on, and its extent there, half-open. */
  sequence: string
  from: number
  to: number
  /** Its extent along the other reference, half-open, in bases along that set's concatenated axis. */
  y0: number
  y1: number
  strand: 1 | -1
  anchors: number
}

/** The streaks found between the file's sequence and another reference, by the file's own sequences. */
export interface FoundStreaks {
  streaks: OriginalStreak[]
  /** The other reference along y: its sequences and their lengths. */
  y: DotplotAxis & { label: string }
  /** The file's sequence set's name, for the caption. */
  xLabel: string
}

/**
 * Of the session's sequence sets, the file's own — the one that names the most
 * of the map's sequences, `matched` — and the others it could be set against.
 */
export function pickSets<T extends { id: string; matched: number }>(sets: readonly T[]): { own: T | null; others: T[] } {
  let own: T | null = null
  for (const set of sets) if (set.matched > 0 && (own === null || set.matched > own.matched)) own = set
  return { own, others: sets.filter((set) => set !== own) }
}

/** A dot plot's streaks, found along the file's sequence set, as streaks of its own sequences. */
export function foundFrom(streaks: DotplotStreaks): FoundStreaks {
  const offsets = [0]
  for (const length of streaks.x.lengths) offsets.push(offsets[offsets.length - 1] + length)
  const out: OriginalStreak[] = []
  for (let i = 0; i < streaks.x0.length; i++) {
    // The sequence the streak starts in; a streak never crosses from one to the next.
    let k = 0
    while (k + 1 < streaks.x.names.length && offsets[k + 1] <= streaks.x0[i]) k++
    out.push({
      sequence: streaks.x.names[k],
      from: streaks.x0[i] - offsets[k],
      to: streaks.x1[i] - offsets[k],
      y0: streaks.y0[i],
      y1: streaks.y1[i],
      strand: streaks.strand[i] === -1 ? -1 : 1,
      anchors: streaks.anchors[i],
    })
  }
  return { streaks: out, y: streaks.y, xLabel: streaks.x.label }
}

/** Lines through an edit, and the edited assembly's axis they are drawn along. */
export interface EditedLines extends DotplotLines {
  x: DotplotAxis
  /** The anchors of the streak each line is part of. */
  anchors: number[]
}

/**
 * The streaks through an edit: each cut into the pieces of the edited assembly
 * it falls in, each part placed where its piece went along the edited axis —
 * turned where the piece is — its other side the matching share of its extent
 * along the reference. What was set aside is not drawn.
 */
export function throughEdit(found: FoundStreaks, assembly: EditedAssembly): EditedLines {
  const names = assembly.sequences.map((sequence) => sequence.name)
  const lengths = names.map((name) => assembly.lengthOf(name) ?? 0)
  const start = new Map<string, number>()
  let total = 0
  names.forEach((name, i) => {
    start.set(name, total)
    total += lengths[i]
  })
  const x0: number[] = []
  const x1: number[] = []
  const y0: number[] = []
  const y1: number[] = []
  const strand: number[] = []
  const anchors: number[] = []
  for (const streak of found.streaks) {
    const span = streak.to - streak.from
    if (!(span > 0)) continue
    for (const landing of assembly.landings(streak.sequence)) {
      const piece = landing.piece
      const lo = Math.max(streak.from, piece.start)
      const hi = Math.min(streak.to, piece.end)
      if (!(hi > lo)) continue
      const base = start.get(landing.sequence)
      if (base === undefined) continue
      // The share of the streak this part is, and the matching share along y:
      // down its diagonal the same way round, up it the other.
      const t0 = (lo - streak.from) / span
      const t1 = (hi - streak.from) / span
      const dy = streak.y1 - streak.y0
      const ya = streak.strand === 1 ? streak.y0 + t0 * dy : streak.y1 - t1 * dy
      const yb = streak.strand === 1 ? streak.y0 + t1 * dy : streak.y1 - t0 * dy
      const forward = piece.strand === 1
      const ea = forward ? landing.offset + (lo - piece.start) : landing.offset + (piece.end - hi)
      const eb = forward ? landing.offset + (hi - piece.start) : landing.offset + (piece.end - lo)
      x0.push(base + ea)
      x1.push(base + eb)
      y0.push(ya)
      y1.push(yb)
      strand.push(forward ? streak.strand : -streak.strand)
      anchors.push(streak.anchors)
    }
  }
  return { x: { names, lengths }, x0, x1, y0, y1, strand, anchors }
}
