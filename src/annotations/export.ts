/**
 * Hand-drawn marks, written out in the formats this app reads back.
 *
 * A mark is a coordinate the reader chose, and a coordinate is worth more than
 * the session it was chosen in: it goes in a figure legend, into a colleague's
 * copy of the same file, into the next run's overlay card. So the kinds go out
 * as the two standard files that mean the same things — a point on the genome is
 * BED, anything naming two places at once is BEDPE — rather than as a private
 * JSON that only this page could open.
 *
 * They round-trip: `annotations/parse.ts` sniffs and reads both, so marks saved
 * here come back as an overlay drawn on the map. That is the test worth having,
 * and `manual-export.test.ts` is exactly it.
 *
 * A mark names one base, so the interval written is `[bp, bp + 1)` — BED is
 * half-open, and a zero-length feature is the one thing readers disagree about.
 */

import type { ManualArrowhead, ManualLine, ManualMark, ManualRect, ManualSpan } from './manual'
import type { AnnotationPayload, BarChartBars } from './types'

/** What a set of marks can be written as. */
export type MarkFormat = 'bed' | 'bedpe'

/**
 * The kinds each format carries: a line is a point on the genome, and both an
 * arrowhead and a rectangle are a pair of places — one anchor per axis.
 *
 * The two go in one file rather than two because they are one thing to BEDPE and
 * to everything that reads it: an arrowhead's anchors happen to be a single base
 * wide and a rectangle's are as wide as the reader drew them, which is a
 * property of the row and not a format. Splitting them would hand out two files
 * whose only difference is a number in a column.
 */
export function marksFor(marks: readonly ManualMark[], format: MarkFormat): ManualMark[] {
  return marks.filter((mark) => (mark.kind === 'line') === (format === 'bed'))
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
      : marksFor(marks, 'bedpe').map((mark) => bedpeRow(mark as ManualArrowhead | ManualRect))
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

/**
 * `chrom1 start1 end1 chrom2 start2 end2 name score strand1 strand2`.
 *
 * An arrowhead's two anchors are the one base each names; a rectangle's are the
 * two stretches it was drawn across, which is what BEDPE's six coordinate
 * columns are *for* — the row is the box, not a summary of it.
 */
function bedpeRow(mark: ManualArrowhead | ManualRect): string {
  const [one, two] =
    mark.kind === 'rect'
      ? [spanColumns(mark.a), spanColumns(mark.b)]
      : [pointColumns(mark.a.contig, mark.a.bp), pointColumns(mark.b.contig, mark.b.bp)]
  return [...one, ...two, mark.id, 0, '.', '.'].join('\t')
}

/** One base, half-open. */
function pointColumns(contig: string, bp: number): [string, number, number] {
  const start = Math.max(0, Math.round(bp))
  return [contig, start, start + 1]
}

/**
 * One stretch, half-open and never empty: a box drawn inside a single bin has
 * `from === to`, and `chr 100 100` is a row half the tools in this field drop.
 */
function spanColumns(span: ManualSpan): [string, number, number] {
  const start = Math.max(0, Math.round(span.from))
  return [span.contig, start, Math.max(start + 1, Math.round(span.to))]
}

// ---------------------------------------------------------------------------
// Computed interval sets
// ---------------------------------------------------------------------------

/**
 * A `FeatureSet` or `PairSet` as BED or BEDPE — the same two formats, one writer.
 *
 * §18 calls intervals: insulation's boundaries, CID's domains. Those are exactly
 * the coordinates a reader takes away, and the file they take them away in has to
 * be the one bedtools reads and this app reads back, not a tabular view of it.
 * The TSV beside it (`analysis/write/tsv.ts`) carries the provenance a
 * spreadsheet wants and a BED consumer would choke on; this is the file.
 *
 * Written here rather than in `analysis/write/` because it is the *same* writer
 * the hand-drawn marks use, and two BED writers in one repository is two
 * conventions about half-open ends waiting to diverge. What varies between the
 * two callers is the row, and only the row.
 *
 * A missing name becomes `.`, which is BED's own placeholder — an empty column 4
 * makes a five-column line that a strict parser reads as a four-column one with a
 * blank score, and the strand then lands in the wrong place.
 */
export function formatIntervals(
  payload: AnnotationPayload,
  context: { label?: string; file?: string; created?: string } = {},
): string {
  const what = context.label === undefined ? 'intervals' : context.label
  const from = context.file === undefined ? '' : ` from ${context.file}`
  const when = context.created === undefined ? '' : ` on ${context.created}`
  const head = `# metacooler ${what}${from}${when}`

  if (payload.kind === 'pairs') {
    const set = payload.data
    const rows: string[] = []
    for (let i = 0; i < set.length; i++) {
      rows.push(
        [
          set.contigs[set.contig1[i]] ?? '.',
          set.start1[i],
          set.end1[i],
          set.contigs[set.contig2[i]] ?? '.',
          set.start2[i],
          set.end2[i],
          nameOr(set.name[i], i),
          scoreOf(set.score[i]),
          '.',
          '.',
        ].join('\t'),
      )
    }
    return [head, ...rows, ''].join('\n')
  }

  const set = payload.data
  // A barChart is written back as a barChart (§8.17). BED6 would be a lossy
  // export that looks like a complete one: the coordinates would all be there
  // and the thing the file is *about* would not, and nothing in the output
  // would say so. The `track` line goes with it, so what lands opens as the
  // same lane here and as the same custom track at UCSC.
  const bars = set.bars
  const rows: string[] = []
  for (let i = 0; i < set.length; i++) {
    // A row that kept its interval and lost its chart goes out as the BED6 it
    // now is, rather than as a chart of zeroes it never had.
    const values = bars === undefined ? null : valuesOf(bars, i)
    const columns = [
      set.contigs[set.contig[i]] ?? '.',
      set.start[i],
      set.end[i],
      // Where the row gets a `name2` column, column 4 is the accession and the
      // symbol goes there — the same split the parser made on the way in
      // (§8.17). Where it does not, a BED6's one name is the display name, so
      // the symbol stays in column 4 rather than being dropped for want of a
      // column to put it in.
      nameOr(values === null ? set.name[i] : set.id[i] || set.name[i], i),
      scoreOf(set.score[i]),
      strandChar(set.strand[i]),
    ]
    if (values !== null) columns.push(nameOr(set.name[i], i), values.length, values.join(','))
    rows.push(columns.join('\t'))
  }
  return [head, ...(bars === undefined ? [] : [trackLineOf(bars)]), ...rows, ''].join('\n')
}

/** Feature `at`'s whole vector, or `null` where it carries no chart. */
function valuesOf(bars: BarChartBars, at: number): string[] | null {
  const width = bars.labels.length
  const out: string[] = []
  for (let c = 0; c < width; c++) {
    const value = bars.values[at * width + c]
    if (!Number.isFinite(value)) return null
    out.push(compact(value))
  }
  return out
}

/**
 * A stored value as the shortest string that reads back as the same number.
 *
 * `String(3.2)` on a `Float32Array` cell is `3.200000047683716`, because that is
 * genuinely the number in the cell — but it is the number a *float* holds, not
 * the number the file wrote, and a round trip that turned every value in a
 * GTEx track into seventeen digits would triple the file to say nothing. Seven
 * significant digits is exactly what a `Float32` carries, so this is the
 * shortest form that loses nothing.
 */
function compact(value: number): string {
  return String(Number(value.toPrecision(7)))
}

/**
 * The `track` line a barChart export carries, naming what the numbers are.
 *
 * Without it the categories are positions again on the way back in, which is
 * the one thing a round trip must not lose — and `barChartBars` is where this
 * format keeps them, so writing them anywhere else would be inventing a
 * convention. Only the settings the file actually had: a `barChartUnit=` with
 * nothing after it is a claim that the unit is the empty string.
 */
function trackLineOf(bars: BarChartBars): string {
  const parts = ['track type=barChart']
  if (bars.named) parts.push(`barChartBars="${bars.labels.join(' ')}"`)
  if (bars.colours.length === bars.labels.length) {
    parts.push(`barChartColors="${bars.colours.join(' ')}"`)
  }
  if (bars.label !== '') parts.push(`barChartLabel="${bars.label}"`)
  if (bars.metric !== '') parts.push(`barChartMetric="${bars.metric}"`)
  if (bars.unit !== '') parts.push(`barChartUnit="${bars.unit}"`)
  parts.push(`maxLimit=${compact(bars.max)}`)
  return parts.join(' ')
}

function nameOr(name: string | undefined, index: number): string {
  const trimmed = (name ?? '').trim()
  // Numbered rather than left as `.`, because a called boundary is a *thing* a
  // reader points at in a review, and "row 412" is only findable if the file
  // says 412 somewhere.
  return trimmed === '' ? `region_${index + 1}` : trimmed.replace(/\s+/g, '_')
}

/**
 * BED's score column.
 *
 * **Not clamped to BED's nominal 0–1000.** A boundary's prominence is a real
 * number on whatever scale the call was made on, bedtools does not enforce the
 * range, and rescaling it here would throw away the number a reader is going to
 * filter on. A missing score is `0`, which is what the column means when a
 * format carries none.
 *
 * Printed to six significant figures and trimmed, which is not cosmetic: a
 * `FeatureSet` holds its scores in a `Float32Array`, so a prominence entered as
 * `0.83` comes back as `0.8299999833106995` and `String()` would write all
 * seventeen digits of it into every row. Six figures is more than float32
 * carries, so nothing is lost and the file is readable. The same rule
 * `analysis/write/tsv.ts` uses, deliberately not shared with it: that function
 * writes an empty cell for a missing value where this one writes `0`, and a
 * helper with a flag for the difference would be a helper nobody could read at
 * either call site.
 */
function scoreOf(score: number): string {
  if (!Number.isFinite(score)) return '0'
  if (Number.isInteger(score) && Math.abs(score) < 1e21) return String(score)
  const magnitude = Math.floor(Math.log10(Math.abs(score)))
  const decimals = Math.min(100, Math.max(0, 6 - 1 - magnitude))
  const text = score.toFixed(decimals)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

function strandChar(strand: number): string {
  return strand > 0 ? '+' : strand < 0 ? '-' : '.'
}
