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
import type { AnnotationEntry } from '../annotations/types'
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

/**
 * {@link pickSets} over the session's rows: of its sequence tracks that are
 * ready, the file's own and the others — and none of either where no set names
 * any of the map's sequences, since then nothing is the file's.
 *
 * The one choice for the three things on the stage that read a sequence: this
 * corner plot, the evidence of the ends and gaps (§27.5) and the FASTA written
 * from the edit (§27.8). The last two took the first ready row, which with the
 * theoretical genome a strain was built to be loaded before the assembly's own
 * FASTA is a set naming none of the map's sequences: the telomeres were looked
 * for in it, and the edited sequence written from it as a file of `N`.
 */
export function sequenceSets(entries: readonly AnnotationEntry[]): { own: AnnotationEntry | null; others: AnnotationEntry[] } {
  const sets = entries
    .filter((entry) => entry.kind === 'sequence' && entry.status === 'ready')
    .map((entry) => ({ id: entry.id, matched: entry.overlap?.matched ?? 0, entry }))
  const { own, others } = pickSets(sets)
  return own === null ? { own: null, others: [] } : { own: own.entry, others: others.map((set) => set.entry) }
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

/** A stretch of one edited sequence, half-open, in bases: what is lit on either side of the link. */
export interface EditedStretch {
  sequence: string
  from: number
  to: number
}

/**
 * A stretch of the edited assembly as its span along the corner plot's x axis,
 * in bases — what is marked along the plot when it is hovered on the map;
 * `null` where the axis has no such sequence.
 */
export function spanAlong(axis: DotplotAxis, stretch: EditedStretch): [number, number] | null {
  let start = 0
  for (let i = 0; i < axis.names.length; i++) {
    if (axis.names[i] === stretch.sequence) {
      const length = axis.lengths[i]
      const from = Math.max(0, Math.min(length, stretch.from))
      const to = Math.max(0, Math.min(length, stretch.to))
      return to > from ? [start + from, start + to] : null
    }
    start += axis.lengths[i]
  }
  return null
}

/** The lines with any of their extent along x inside a span: those lit for a stretch hovered on the map. */
export function linesOver(lines: DotplotLines, span: readonly [number, number]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.x0.length; i++) if (lines.x1[i] > span[0] && lines.x0[i] < span[1]) out.push(i)
  return out
}

/**
 * The stretch of the edited assembly a line lies along — what is lit on the
 * map when it is hovered in the plot; `null` for no line. A line never crosses
 * from one sequence to the next: it was cut where its piece ends.
 */
export function stretchOfLine(lines: EditedLines, i: number): EditedStretch | null {
  if (!(i >= 0 && i < lines.x0.length)) return null
  let start = 0
  for (let k = 0; k < lines.x.names.length; k++) {
    const end = start + lines.x.lengths[k]
    if (lines.x0[i] < end) return { sequence: lines.x.names[k], from: lines.x0[i] - start, to: Math.min(end, lines.x1[i]) - start }
    start = end
  }
  return null
}

/** The corner plot's side, in CSS pixels: the least it is ever drawn at, and the most it takes by itself. */
export const LEAST_SIDE = 120
export const FIRST_SIDE = 220

/**
 * The corner plot's side over a map of `mapSize` pixels: the side the reader
 * gave it with its grip, or by itself a third of the map up to
 * {@link FIRST_SIDE}; never less than {@link LEAST_SIDE}, nor so large that
 * the plot and its `chrome` — the picker over it and the caption under it —
 * leave the map.
 */
export function cornerSide(mapSize: number, chosen: number | null, chrome: number): number {
  const most = Math.max(LEAST_SIDE, Math.floor(mapSize - 16 - chrome))
  const side = chosen ?? Math.min(FIRST_SIDE, mapSize * 0.32)
  return Math.round(Math.max(LEAST_SIDE, Math.min(most, side)))
}

/**
 * The side a grip on the plot's lower-left corner gives it, moved `(dx, dy)`
 * from a press at side `start`: the plot hangs from its upper-right corner, so
 * left and down grow it, and a hand along the diagonal moves the corner with it.
 */
export function grippedSide(start: number, dx: number, dy: number): number {
  return start + (dy - dx) / 2
}
