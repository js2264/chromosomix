/**
 * The two lines' split (§7.6): a column of the Genomes table read as a factor of
 * exactly two levels, each genome put on the line of its level.
 *
 * **Two levels, or no split.** A column is offered when the genomes on screen
 * hold two values in it and no more — `step`'s 0 and 1, a `True` and a `False`,
 * a `kept` and a `dropped` — and every other column is listed with the reason it
 * cannot split them: one value, or how many. Nothing is binned or thresholded
 * into two: a completeness cut at 0.9 is a column the reader can add to the
 * table, and one invented here would be a reading nobody chose.
 *
 * **A genome with no value is left out**, of the picture and of the count, and
 * the caption says how many — an empty cell, `NaN`, or one of the words a table
 * writes for nothing (`NA`, `None`, `null`). `__unbinned__` is never a genome
 * on a line, as it is never a genome on the circle (§7.4).
 *
 * The levels are in order — numbers by value, words as text sorts them — and the
 * first is drawn on the top line unless the reader put the other there (`top`).
 */

import { UNBINNED_NAME } from '../constants'
import type { TablePayload } from '../worker/protocol'

/** One column of the Genomes table, as the `split by` select offers it. */
export interface SplitChoice {
  column: string
  /** Its two levels in order, or `null` where it cannot split the genomes. */
  levels: readonly [string, string] | null
  /** Why it cannot, in a few words — `one value`, `4 values`, `no values` — or `null` where it can. */
  reason: string | null
  /** How many genomes have no value in it. */
  missing: number
}

/** The genomes split by one column: which line each is on. */
export interface LineSplit {
  column: string
  /** The two levels, the top line's first. */
  levels: readonly [string, string]
  /** How many genomes are on each line, the top's first. */
  counts: readonly [number, number]
  /** How many have no value, and are on neither. */
  missing: number
  /** The line a genome is on: 0 the top, 1 the bottom, −1 neither — no value, or no such genome. */
  lineOf(genome: string): -1 | 0 | 1
}

/** The words a table writes for nothing, as a cell's whole text, in any case. */
const MISSING_WORDS = new Set(['', 'na', 'n/a', 'nan', 'none', 'null'])

/** A cell's level, as text — or `null` for a cell with no value. */
export function levelOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  const text = String(value).trim()
  return MISSING_WORDS.has(text.toLowerCase()) ? null : text
}

/**
 * Every column of the table as the `split by` select offers it, in the table's
 * order — the name, which is a genome's own and one level each, left out.
 * Counted over the genomes on display, `__unbinned__` not among them.
 */
export function splitChoices(table: TablePayload, display: ArrayLike<number> | null): SplitChoice[] {
  const rows = displayRows(table, display)
  const out: SplitChoice[] = []
  for (const column of table.columns) {
    if (column === 'name') continue
    const values = table.data[column]
    if (values === undefined) continue
    const { levels, missing } = levelsOf(values, rows)
    out.push(
      levels.length === 2
        ? { column, levels: [levels[0], levels[1]], reason: null, missing }
        : { column, levels: null, reason: refusalOf(levels.length), missing },
    )
  }
  return out
}

/**
 * The genomes split by `column`, its level `top` on the top line — the first in
 * order where `top` is absent or not one of its two — or `null` where the
 * column cannot split them.
 */
export function lineSplit(
  table: TablePayload,
  display: ArrayLike<number> | null,
  column: string,
  top?: string,
): LineSplit | null {
  const values = table.data[column]
  const names = table.data['name']
  if (values === undefined || !Array.isArray(names)) return null
  const rows = displayRows(table, display)
  const { levels, missing } = levelsOf(values, rows)
  if (levels.length !== 2) return null
  const ordered: readonly [string, string] = top === levels[1] ? [levels[1], levels[0]] : [levels[0], levels[1]]
  const line = new Map<string, 0 | 1>()
  const counts: [number, number] = [0, 0]
  for (const row of rows) {
    const level = levelOf(values[row])
    if (level === null) continue
    const side = level === ordered[0] ? 0 : 1
    line.set((names as string[])[row], side)
    counts[side]++
  }
  return {
    column,
    levels: ordered,
    counts,
    missing,
    lineOf: (genome) => line.get(genome) ?? -1,
  }
}

/** The rows on display: `display`'s, or every row where it is not given — `__unbinned__` never among them. */
function displayRows(table: TablePayload, display: ArrayLike<number> | null): number[] {
  const names = table.data['name']
  const rows = display === null ? Array.from({ length: table.length }, (_, row) => row) : Array.from(display)
  return Array.isArray(names) ? rows.filter((row) => (names as string[])[row] !== UNBINNED_NAME) : rows
}

/** A column's distinct levels over the rows, in order, and how many rows have none. */
function levelsOf(values: string[] | Float64Array, rows: readonly number[]): { levels: string[]; missing: number } {
  const seen = new Map<string, number>()
  let missing = 0
  // Numbers sort by value — and so does text that reads as numbers throughout,
  // `2` before `10`; anything else as text sorts.
  let numeric = true
  for (const row of rows) {
    const value = values[row]
    const level = levelOf(value)
    if (level === null) {
      missing++
      continue
    }
    if (!seen.has(level)) seen.set(level, typeof value === 'number' ? value : Number(level))
    if (typeof value !== 'number' && !Number.isFinite(Number(level))) numeric = false
  }
  const levels = [...seen.keys()]
  levels.sort((a, b) =>
    numeric ? (seen.get(a) ?? 0) - (seen.get(b) ?? 0) : a.localeCompare(b, undefined, { numeric: true }),
  )
  return { levels, missing }
}

function refusalOf(count: number): string {
  return count === 0 ? 'no values' : count === 1 ? 'one value' : `${count.toLocaleString('en-US')} values`
}
