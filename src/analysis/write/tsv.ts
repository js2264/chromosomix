/**
 * Every analysis output, as a table anyone can open.
 *
 * TSV is offered beside every other export §18.7 names, and of all of them it is
 * the important one: **it is what makes a number in a published figure checkable
 * by the person reading the figure.** A bigWig is what a genome browser opens, a
 * BED is what bedtools takes, a PDF is what goes in the manuscript — but none of
 * those lets a reader put the figure's third boundary next to the number it was
 * drawn from and see that they agree. A tab-separated table does, in a
 * spreadsheet, in `awk`, in R, on a machine that has never heard of this app.
 *
 * That claim only holds if the file says where it came from, so every one of
 * them opens with the provenance §18.4 requires — task, version, every
 * parameter, the framing, the file, the build. The lines are `#`-prefixed for
 * exactly the reason `annotations/export.ts` gives for the same line above a BED:
 * this app's own parsers skip a `#` line and so does bedtools, so the provenance
 * costs the file nothing and travels wherever the file does.
 *
 * Two rules run through the whole writer and both are about a reader downstream
 * rather than about us:
 *
 * - **A missing value is an empty cell, never the text `NaN`.** Every reader
 *   worth having treats an empty cell as missing; most treat `NaN` in a numeric
 *   column as a parse failure, and the ones that do not turn it into zero. The
 *   `NaN`-means-no-value convention this codebase keeps end to end (§18.5) is
 *   only preserved across the file boundary by writing nothing at all.
 * - **No exponent notation.** These numbers are read by a human in a
 *   spreadsheet, and `1.234e-5` in a column of contact counts is a cell that gets
 *   sorted as text. At most six significant digits, always in plain decimal.
 */

import type {
  CurveOutput,
  IntervalsOutput,
  MatrixOutput,
  ParamValue,
  ProfileOutput,
  Provenance,
  TableOutput,
  TaskOutput,
} from '../types'
import type { FeatureSet, PairSet } from '../../annotations/types'
import { exportBaseName } from '../../ui/export'

/** Six is what survives a float32 round trip and still fits a spreadsheet cell. */
const SIGNIFICANT_DIGITS = 6

/** `toFixed` throws past a hundred places, and nothing here needs one. */
const MAX_DECIMALS = 100

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * One number, as a human reads it.
 *
 * Non-finite goes out empty — `NaN` because it means *no value here*, and the
 * infinities because a ratio whose denominator was zero is not a measurement
 * either, and writing `Infinity` into a numeric column breaks the same readers
 * `NaN` does.
 *
 * An integer keeps no decimal point: a bin index, a feature count and a base
 * pair are whole things, and `120000.000000` invites the reader to wonder what
 * the zeroes are hiding. Everything else is rounded to
 * {@link SIGNIFICANT_DIGITS} and printed fixed-point, so the column sorts as a
 * number in every tool that opens it.
 */
export function tsvNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  // `String` reaches for the exponent at 1e21 even for whole numbers, so the
  // integer case is spelled out rather than left to the default conversion.
  if (Number.isInteger(value)) return Math.abs(value) < 1e21 ? String(value) : value.toFixed(0)
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const decimals = Math.min(MAX_DECIMALS, Math.max(0, SIGNIFICANT_DIGITS - 1 - magnitude))
  return trimZeros(value.toFixed(decimals))
}

/** A number to a stated number of places — a table column, a printed statistic. */
function fixed(value: number, digits: number | undefined): string {
  if (!Number.isFinite(value)) return ''
  if (digits === undefined) return tsvNumber(Math.round(value))
  return trimZeros(value.toFixed(Math.min(MAX_DECIMALS, Math.max(0, digits))))
}

/** `1.500000` is six digits of nothing; `1.5` is the same number. */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/**
 * Text, with the two characters that would end the cell or the row taken out.
 *
 * A GTF attribute string or a feature name can contain anything, and a tab
 * inside a cell does not corrupt the file visibly — it shifts every column after
 * it by one, silently, for that row only. Quoting would be the other answer and
 * is worse here: TSV has no agreed quoting rule, so half the readers would show
 * the quotes.
 */
function cell(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ')
}

function row(cells: readonly string[]): string {
  return cells.join('\t')
}

/** Lines to a file: newline endings, exactly one at the end. */
function document(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** One parameter value, in the syntax it was typed in. */
function paramText(value: ParamValue): string {
  if (value === null) return ''
  if (typeof value === 'number') return tsvNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.join(',')
  return String(value)
}

/**
 * The header every export in this module opens with.
 *
 * Ordered from the widest fact to the narrowest — which build, which file, which
 * task, which view, which settings — because that is the order somebody holding
 * an unfamiliar file asks the questions in. The parameters come last and one per
 * line rather than joined, since a task with a dozen of them would otherwise
 * produce a line nothing can read without horizontal scrolling, and a parameter
 * nobody reads is provenance that is present and useless.
 */
export function provenanceLines(provenance: Provenance): string[] {
  const { framing, params } = provenance
  const lines = [
    `# metacooler ${cell(provenance.app)}`,
    `# created: ${cell(provenance.createdAt)}`,
    `# file: ${cell(framing.uri)}`,
    `# task: ${cell(provenance.task)} v${tsvNumber(provenance.taskVersion)}`,
    `# framing: ${cell(framing.label)}`,
  ]
  // Sorted by key, so two runs of one task diff line for line whichever order
  // the form happened to build its parameter object in.
  for (const key of Object.keys(params).sort()) {
    lines.push(`# param ${cell(key)}: ${cell(paramText(params[key]))}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// The five kinds
// ---------------------------------------------------------------------------

/**
 * `bin  start  end  value` — one row per bin, whether or not the bin has a value.
 *
 * The empty rows are kept rather than skipped, which is the opposite of what the
 * bigWig writer does with the same vector (§18.7). A bigWig is read by tools that
 * understand a gap; a spreadsheet is read by a person, and a profile whose rows
 * jump from bin 40 to bin 57 with no explanation looks like a truncated file
 * rather than like sixteen filtered bins.
 */
function profileToTsv(output: ProfileOutput): string[] {
  const [from] = output.extent
  const lines = [
    `# output: ${cell(output.label)}${output.unit === '' ? '' : ` (${cell(output.unit)})`}`,
    `# binsize: ${tsvNumber(output.binsize)}`,
    row(['bin', 'start', 'end', 'value']),
  ]
  for (let i = 0; i < output.values.length; i++) {
    const bin = from + i
    const start = bin * output.binsize
    lines.push(
      row([
        String(bin),
        String(start),
        String(start + output.binsize),
        tsvNumber(output.values[i]),
      ]),
    )
  }
  return lines
}

/**
 * The series side by side, sharing one `x` column.
 *
 * Wide rather than long — `x, series, series_low, series_high` — because the
 * question a curve export answers is *do these two lines differ here*, and that
 * is a subtraction of two adjacent columns in a spreadsheet against a pivot
 * table over a long file. A band contributes its two columns only where it
 * exists, since a P(s) has none and three columns of copies of `y` would be a
 * lie about what was computed — which is the reason `CurveSeries.low` is
 * optional rather than filled with copies in the first place.
 *
 * Series of different lengths are padded with empty cells rather than truncated
 * to the shortest: an expected curve out to a whole chromosome beside a metaplot
 * over a flank is an ordinary pairing, and dropping the tail of the longer one
 * would silently discard the part the reader zoomed in on. The `x` column is
 * taken from the longest series so that no row lacks one — the series in a single
 * output share their grid by construction, and where a future task breaks that
 * assumption it wants two outputs rather than a second `x` column here.
 */
function curveToTsv(output: CurveOutput): string[] {
  const lines = [
    `# output: ${cell(output.label)}`,
    `# x: ${cell(output.xLabel)}  y: ${cell(output.yLabel)}`,
  ]
  const header = [cell(output.xLabel) === '' ? 'x' : cell(output.xLabel)]
  let rows = 0
  let grid: Float64Array = new Float64Array(0)
  for (const series of output.series) {
    const name = cell(series.name)
    header.push(name)
    if (series.low !== undefined && series.high !== undefined)
      header.push(`${name}_low`, `${name}_high`)
    if (series.y.length > rows) {
      rows = series.y.length
      grid = series.x
    }
    if (series.n !== undefined) lines.push(`# n ${name}: ${tsvNumber(series.n)}`)
  }
  lines.push(row(header))

  for (let i = 0; i < rows; i++) {
    const cells = [i < grid.length ? tsvNumber(grid[i]) : '']
    for (const series of output.series) {
      const present = i < series.y.length
      cells.push(present ? tsvNumber(series.y[i]) : '')
      if (series.low !== undefined && series.high !== undefined) {
        cells.push(
          present ? tsvNumber(series.low[i]) : '',
          present ? tsvNumber(series.high[i]) : '',
        )
      }
    }
    lines.push(row(cells))
  }
  return lines
}

/**
 * The grid as a grid, with its ticks along the top and down the left.
 *
 * The printed statistics — a P2LL, an AA/BB strength — go in `#` lines above the
 * table rather than in cells beside it, because they are of the whole matrix and
 * a spreadsheet that reads them as part of the rectangle gets a stray column in
 * every calculation over it. Where an axis has no ticks the index is written
 * instead: a bare grid of numbers with no way to say which row is which is a
 * picture, not a table.
 *
 * **There are two kinds of tick and only one of them is a column heading.** A
 * `MatrixOutput` whose tick list is as long as its axis is naming its cells —
 * a genome per column on a MAG network, a track per column on a correlation —
 * and each label belongs over its own column. A shorter list is a *position*
 * along a continuous axis, drawn evenly spaced across the picture: the scaled
 * pileup's units of the feature, where five labels describe forty-one columns.
 * Written into the header those five would sit over the first five columns and
 * the rest would be indices, which is a table stating something untrue about
 * where the axis is. So a positional list goes into a `#` line saying what it
 * is, and the columns keep their indices.
 */
function matrixToTsv(output: MatrixOutput): string[] {
  const lines = [
    `# output: ${cell(output.label)}`,
    `# x: ${cell(output.xLabel)}  y: ${cell(output.yLabel)}`,
  ]
  for (const stat of output.stats ?? []) {
    lines.push(`# ${cell(stat.label)}: ${fixed(stat.value, stat.digits ?? 4)}`)
  }

  const perCell = (ticks: readonly string[], count: number): boolean =>
    ticks.length === count && count > 0
  for (const [axis, ticks, count] of [
    ['x', output.xTicks, output.ncols],
    ['y', output.yTicks, output.nrows],
  ] as const) {
    if (ticks.length === 0 || perCell(ticks, count)) continue
    lines.push(`# ${axis} ticks, evenly spaced across the axis: ${ticks.map(cell).join(', ')}`)
  }

  const label = (ticks: readonly string[], index: number, count: number): string =>
    perCell(ticks, count) ? cell(ticks[index]) : String(index)

  const header = [cell(output.yLabel)]
  for (let col = 0; col < output.ncols; col++) header.push(label(output.xTicks, col, output.ncols))
  lines.push(row(header))

  for (let r = 0; r < output.nrows; r++) {
    const cells = [label(output.yTicks, r, output.nrows)]
    for (let c = 0; c < output.ncols; c++)
      cells.push(tsvNumber(output.values[r * output.ncols + c]))
    lines.push(row(cells))
  }
  return lines
}

/**
 * The table as the drawer shows it, keyed rather than labelled.
 *
 * The header carries `TableColumn.key` and the labels go in a `#` line above it,
 * because a label is prose that changes when somebody rewords the UI while a key
 * is the stable name §18.2 requires of everything else — and a script somebody
 * wrote against last month's export should keep working.
 */
function tableToTsv(output: TableOutput): string[] {
  const lines = [
    `# output: ${cell(output.label)}`,
    `# columns: ${output.columns.map((column) => cell(column.label)).join(', ')}`,
    row(output.columns.map((column) => cell(column.key))),
  ]
  for (const record of output.rows) {
    lines.push(
      row(
        output.columns.map((column) => {
          const value = record[column.key]
          if (value === undefined || value === null) return ''
          if (typeof value === 'number')
            return column.kind === 'number' ? fixed(value, column.digits) : tsvNumber(value)
          return cell(value)
        }),
      ),
    )
  }
  return lines
}

/** `+1`, `-1` and "the format said nothing", in the three characters BED uses. */
function strandChar(strand: number): string {
  return strand > 0 ? '+' : strand < 0 ? '-' : '.'
}

/**
 * Called intervals in their BED and BEDPE column order.
 *
 * `annotations/export.ts` is the real BED writer and stays the real BED writer:
 * what it produces round-trips through this app's own parser and through
 * bedtools, and an interval output is offered as that file first. This is the
 * *tabular view of the same rows* — the same coordinates, with the header line
 * and the provenance a spreadsheet wants and a BED consumer would choke on — and
 * it is not a second implementation of the format nor a replacement for one.
 */
function intervalsToTsv(output: IntervalsOutput): string[] {
  const lines = [`# output: ${cell(output.label)}`]
  if (output.payload.kind === 'features') {
    const set: FeatureSet = output.payload.data
    lines.push(row(['chrom', 'start', 'end', 'name', 'score', 'strand', 'detail']))
    for (let i = 0; i < set.length; i++) {
      lines.push(
        row([
          cell(set.contigs[set.contig[i]] ?? ''),
          String(set.start[i]),
          String(set.end[i]),
          cell(set.name[i] ?? ''),
          tsvNumber(set.score[i]),
          strandChar(set.strand[i]),
          cell(set.detail[i] ?? ''),
        ]),
      )
    }
    return lines
  }

  const set: PairSet = output.payload.data
  lines.push(
    row(['chrom1', 'start1', 'end1', 'chrom2', 'start2', 'end2', 'name', 'score', 'detail']),
  )
  for (let i = 0; i < set.length; i++) {
    lines.push(
      row([
        cell(set.contigs[set.contig1[i]] ?? ''),
        String(set.start1[i]),
        String(set.end1[i]),
        cell(set.contigs[set.contig2[i]] ?? ''),
        String(set.start2[i]),
        String(set.end2[i]),
        cell(set.name[i] ?? ''),
        tsvNumber(set.score[i]),
        cell(set.detail[i] ?? ''),
      ]),
    )
  }
  return lines
}

/** One output, with its provenance above it, as the text of a `.tsv`. */
export function outputToTsv(output: TaskOutput, provenance: Provenance): string {
  const head = provenanceLines(provenance)
  switch (output.kind) {
    case 'profile':
      return document([...head, ...profileToTsv(output)])
    case 'curve':
      return document([...head, ...curveToTsv(output)])
    case 'matrix':
      return document([...head, ...matrixToTsv(output)])
    case 'table':
      return document([...head, ...tableToTsv(output)])
    case 'intervals':
      return document([...head, ...intervalsToTsv(output)])
  }
}

// ---------------------------------------------------------------------------
// The name it is saved under
// ---------------------------------------------------------------------------

/**
 * `insulation_w10-chrIV-20260808-145233.tsv`.
 *
 * Three parts: what was run, which of its outputs this is, and when — so a
 * directory of exports from an afternoon of parameter sweeps sorts by task and
 * then by time, and no run overwrites another.
 *
 * Sanitised through `exportBaseName`, imported rather than reimplemented: the
 * rule about which characters a filesystem objects to is one rule, and a second
 * copy of it is the copy that forgets the `×` a genome × genome view puts in its
 * title. The output segment is dropped where a task has one output that shares
 * the base's name, since `insulation-insulation-…` says nothing twice.
 */
export function tsvName(base: string, output: TaskOutput, stamp: string): string {
  const stem = exportBaseName(base)
  const id = output.id === '' ? '' : exportBaseName(output.id)
  const parts = id === '' || id === stem ? [stem] : [stem, id]
  return `${[...parts, stamp].join('-')}.tsv`
}
