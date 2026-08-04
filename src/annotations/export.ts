/**
 * Hand-drawn marks, written out in the formats this app reads back.
 *
 * A mark is a coordinate the reader chose, and a coordinate is worth more than
 * the session it was chosen in: it goes in a figure legend, into a colleague's
 * copy of the same file, into the next run's overlay card. So the two kinds go
 * out as the two standard files that mean the same things — a point on the
 * genome is BED, a pair of points is BEDPE — rather than as a private JSON that
 * only this page could open.
 *
 * They round-trip: `annotations/parse.ts` sniffs and reads both, so marks saved
 * here come back as an overlay drawn on the map. That is the test worth having,
 * and `manual-export.test.ts` is exactly it.
 *
 * A mark names one base, so the interval written is `[bp, bp + 1)` — BED is
 * half-open, and a zero-length feature is the one thing readers disagree about.
 */

import type { ManualArrowhead, ManualLine, ManualMark } from './manual'

/** What a set of marks can be written as. */
export type MarkFormat = 'bed' | 'bedpe'

/** The kind each format carries: a line is a point, an arrowhead is a pair. */
export function marksFor(marks: readonly ManualMark[], format: MarkFormat): ManualMark[] {
  const kind = format === 'bed' ? 'line' : 'arrowhead'
  return marks.filter((mark) => mark.kind === kind)
}

/**
 * The file, as text. Empty in, header only — a file with no rows is a legal BED
 * and a clearer answer than a download that does not happen.
 *
 * The comment line is provenance, and it is a comment for a reason: `#` is
 * skipped by this app's own reader and by bedtools, so it costs the file
 * nothing to carry where it came from.
 */
export function formatMarks(
  marks: readonly ManualMark[],
  format: MarkFormat,
  context: { file?: string; created?: string } = {},
): string {
  const from = context.file === undefined ? '' : ` from ${context.file}`
  const when = context.created === undefined ? '' : ` on ${context.created}`
  const rows =
    format === 'bed'
      ? marksFor(marks, 'bed').map((mark) => bedRow(mark as ManualLine))
      : marksFor(marks, 'bedpe').map((mark) => bedpeRow(mark as ManualArrowhead))
  return [`# metacooler manual annotations${from}${when}`, ...rows, ''].join('\n')
}

/**
 * `chrom  start  end  name  score  strand`.
 *
 * The name is the axis the line draws on — `vertical`, `horizontal`, `both` —
 * because that is the only thing about a line that is not its coordinate, and
 * losing it would make every re-import a `both`. Column 4 is free text in BED
 * and this is what it is for.
 */
function bedRow(line: ManualLine): string {
  const start = Math.max(0, Math.round(line.at.bp))
  return [line.at.contig, start, start + 1, line.axis, 0, '.'].join('\t')
}

/** `chrom1 start1 end1 chrom2 start2 end2 name score strand1 strand2`. */
function bedpeRow(mark: ManualArrowhead): string {
  const a = Math.max(0, Math.round(mark.a.bp))
  const b = Math.max(0, Math.round(mark.b.bp))
  return [mark.a.contig, a, a + 1, mark.b.contig, b, b + 1, mark.id, 0, '.', '.'].join('\t')
}
