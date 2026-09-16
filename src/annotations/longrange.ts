/**
 * The `longrange` interaction format — WashU's, read by UCSC as `longTabix` and
 * by Ensembl under the same name.
 *
 * One line is one end of one interaction:
 *
 * ```
 * chr1   1000   2000   chr1:19000-20000,3.5
 * ```
 *
 * — a BED3 and then the whole of the other end packed into a fourth column as
 * `chrom:start-end,score`. That fourth column is the entire format, and it is
 * also why a `longrange` file read as a BED is worse than useless: it is a lane
 * of BED4 boxes whose *names* are the coordinates of the arcs that should have
 * been drawn.
 *
 * ## Why it is here beside `interact`
 *
 * Because both are in the world and neither is going away. UCSC added
 * `longTabix` support first, for chromatin interaction data, and then built
 * `interact` to get curves, colours and named ends; the two have coexisted ever
 * since, and which one a given pipeline emits is a matter of what it was written
 * against. `annotations/interact.ts` makes the argument for why this viewer of
 * all viewers should read an interaction format; this is the same argument for
 * the other spelling of it, and it comes out in the same {@link PairSet}, drawn
 * by the same arcs.
 *
 * ## Each interaction is written twice, and that is the interesting part
 *
 * The format exists to be `bgzip`ped and `tabix`ed, and a tabix query returns
 * the lines whose *first three columns* overlap the query. So a file that
 * recorded an interaction only under its left end would be invisible to anybody
 * who asked about its right end — and the convention is therefore that both ends
 * are written, as two lines that are each other's mirror.
 *
 * Read naively that is a file of doubled arcs: every loop drawn twice, every
 * count double, every ranking wrong by a factor of two. So the reciprocal is
 * recognised and dropped — see {@link parseLongRange} — and the count is
 * reported as what the file *means* rather than as the number of lines in it. A
 * file written the other way, with each interaction once, is unaffected: nothing
 * is dropped that has not been seen before, in full, both ends and score.
 */

import { PairBuilder } from './featureset'
import { forEachRow, isInteger } from './parse'
import type { PairSet } from './types'

/**
 * The fourth column: `chrom:start-end,score`, or `chrom:start-end` with none.
 *
 * The score is optional in practice — plenty of files carry the coordinates
 * alone — and it is captured loosely (anything up to the end) rather than as a
 * number pattern, so that `1e-4` and `Inf` reach {@link Number} rather than
 * being refused by a regex that did not think of them.
 */
const FAR_END = /^([^\s:]+):(\d+)-(\d+)(?:,(.+))?$/

/** How many rows {@link sniffLongRange} checks before it is satisfied. */
const ENOUGH_ROWS = 4

/** A name that says the format outright. */
const LONGRANGE_NAME = /\.(longrange|longtabix)(\.(bed|txt))?(\.gz)?$/i

/**
 * Whether these lines are a `longrange`.
 *
 * Exactly four columns, an integer span in 2 and 3, and a fourth column that
 * parses as a far end. The fourth column is the whole test and it is a strong
 * one: `chr7:1200-1400,12` is not a name anybody's BED4 happens to carry, and
 * nothing else in the BED family packs a coordinate range into a column.
 *
 * Asked before `sniffSignal` and before `sniffFormat` for the reason every
 * sniffer in this application is: `sniffFormat`'s last line is `return 'bed'`,
 * so a format it has not been taught is drawn as a BED rather than refused.
 * It cannot capture a bedGraph on the way past — a bedGraph's fourth column is
 * a bare number, which has no colon in it.
 */
export function sniffLongRange(text: string, fileName = ''): boolean {
  const named = LONGRANGE_NAME.test(fileName)
  let rows = 0
  let index = 0
  const length = text.length
  while (index < length && rows < ENOUGH_ROWS) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop--
    const line = text.slice(index, stop)
    index = end + 1
    if (line === '' || line.charCodeAt(0) === 35) continue
    if (line.startsWith('track ') || line.startsWith('browser ')) continue
    const columns = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    // A named file still has to parse — the name waives shape tests elsewhere in
    // this app, and here there is only one test and it *is* the format.
    if (!named && columns.length !== 4) return false
    if (!isInteger(columns[1]) || !isInteger(columns[2])) return false
    if (columns[3] === undefined || !FAR_END.test(columns[3])) return false
    rows++
  }
  return rows > 0
}

/**
 * A `longrange` file, as the pairs it is, with the reciprocal lines folded in.
 *
 * The key an interaction is remembered under is its **two ends in a fixed
 * order**, so that `A→B` and `B→A` collide. Ordering by contig name and then by
 * start is enough and is stable: a mirror pair differs only in which end was
 * written first, and sorting the two ends makes that difference disappear
 * without needing to know the contig order of an assembly nobody has loaded yet.
 *
 * The **score is part of the key**, which is the one non-obvious part. Two
 * interactions between the same two windows with different scores are two
 * interactions — a file may legitimately carry a loop call and a distinct
 * measurement over the same anchors — and collapsing them because their
 * coordinates match would silently delete data. A mirror pair, by construction,
 * agrees about the score; so keying on it drops exactly the duplicates the
 * format's own convention creates and nothing else.
 */
export function parseLongRange(text: string): PairSet {
  const builder = new PairBuilder()
  const seen = new Set<string>()
  let skipped = 0
  let mirrored = 0

  forEachRow(text, (columns) => {
    if (columns.length < 4 || !isInteger(columns[1]) || !isInteger(columns[2])) {
      skipped++
      return
    }
    const far = FAR_END.exec(columns[3] ?? '')
    if (far === null) {
      skipped++
      return
    }
    const near = {
      contig: columns[0] ?? '',
      start: Number(columns[1]),
      end: Number(columns[2]),
    }
    const other = { contig: far[1], start: Number(far[2]), end: Number(far[3]) }
    const score = far[4] === undefined || far[4] === '' ? Number.NaN : Number(far[4])

    // Ends in a fixed order, so a line and its mirror make the same key.
    const [first, second] =
      near.contig < other.contig || (near.contig === other.contig && near.start <= other.start)
        ? [near, other]
        : [other, near]
    const key = `${first.contig}:${first.start}-${first.end}|${second.contig}:${second.start}-${second.end}|${far[4] ?? ''}`
    if (seen.has(key)) {
      mirrored++
      return
    }
    seen.add(key)

    builder.add(near.contig, near.start, near.end, other.contig, other.start, other.end, {
      score,
      detail: Number.isFinite(score) ? `score ${far[4]}` : '',
    })
  })

  if (builder.length === 0) {
    throw new Error(
      `No usable rows: all ${skipped} lines failed the "contig, start, end, chrom:start-end,score" ` +
        'test a longrange file is made of.',
    )
  }
  const set = builder.finish()
  // Carried out of the parse rather than recomputed, because "how many lines
  // were a mirror of another" is a fact about the *read*: two identical
  // interactions and one written twice are the same set afterwards.
  mirroredCounts.set(set, mirrored)
  return set
}

/**
 * How many lines of the file were the reciprocal of one already read.
 *
 * A side table rather than a field on {@link PairSet}, because a `PairSet`
 * crosses the worker boundary by transfer and every field on it is a typed
 * array or a string list that the renderers walk. One number that only the
 * summary line reads does not belong in that budget, and a `WeakMap` keyed on
 * the set keeps it exactly as long as the set is alive on this side.
 */
const mirroredCounts = new WeakMap<PairSet, number>()

/**
 * The line under a `longrange` lane's label.
 *
 * It says what was folded, because a reader who counted the lines of their file
 * and got twice this number deserves to find the reason here rather than
 * conclude the viewer dropped half of them.
 */
export function longRangeSummary(set: PairSet): string {
  const parts = [`${set.length.toLocaleString()} interaction${set.length === 1 ? '' : 's'}`]
  const mirrored = mirroredCounts.get(set) ?? 0
  if (mirrored > 0) parts.push(`${mirrored.toLocaleString()} reciprocal lines folded in`)
  let trans = 0
  for (let i = 0; i < set.length; i++) {
    if (set.contig1[i] !== set.contig2[i]) trans++
  }
  if (trans > 0) parts.push(`${trans.toLocaleString()} between sequences`)
  return parts.join(' · ')
}
