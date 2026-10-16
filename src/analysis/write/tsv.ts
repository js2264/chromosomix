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
/**
 * One sequence's intervals — the shape `BigWigSpans` and `BedGraphSpans` take.
 *
 * Structural rather than imported, so this module goes on depending on nothing
 * but its own types: the three writers are handed one object by one caller, and
 * what makes them agree is that caller rather than a shared declaration.
 */
export interface TsvSpans {
  contig: string
  starts: ArrayLike<number>
  ends: ArrayLike<number>
  values: ArrayLike<number>
}

export function tsvNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  // `String` reaches for the exponent at 1e21 even for whole numbers, so the
  // integer case is spelled out rather than left to the default conversion.
  if (Number.isInteger(value)) return Math.abs(value) < 1e21 ? String(value) : value.toFixed(0)
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const decimals = Math.min(MAX_DECIMALS, Math.max(0, SIGNIFICANT_DIGITS - 1 - magnitude))
  return trimZeros(value.toFixed(decimals))
}

/**
 * A number to a stated number of places — a table column, a printed statistic.
 *
 * `small` is a column's `scientific`: a value too small for its places is
 * written with an exponent rather than as zero, as the drawer draws it. A P of
 * 10⁻²³ written `0` is a claim the test never made, and a script reading the
 * file has no way to tell it from a P that really was.
 */
function fixed(value: number, digits: number | undefined, small = false): string {
  if (!Number.isFinite(value)) return ''
  if (digits === undefined) return tsvNumber(Math.round(value))
  if (small && value !== 0 && Math.abs(value) < 10 ** -digits) return withExponent(value)
  return trimZeros(value.toFixed(Math.min(MAX_DECIMALS, Math.max(0, digits))))
}

/** `6.53e-23`: the drawer's spelling, at the precision a file keeps. */
function withExponent(value: number): string {
  const [mantissa, exponent] = value.toExponential(SIGNIFICANT_DIGITS - 1).split('e')
  return `${trimZeros(mantissa)}e${exponent}`
}

/**
 * `1.500000` is six digits of nothing; `1.5` is the same number.
 *
 * The trailing zeros, and the point if nothing is left after it — what
 * `/\.?0+$/` removes, scanned for by hand: this runs on every number of every
 * table, and a heatmap is millions of them.
 */
function trimZeros(text: string): string {
  if (text.indexOf('.') < 0) return text
  let end = text.length
  while (text.charCodeAt(end - 1) === 48) end--
  if (end === text.length) return text
  if (text.charCodeAt(end - 1) === 46) end--
  return text.slice(0, end)
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

/** Rows a {@link RowBlocks} joins at a time. */
const ROWS_PER_BLOCK = 4096

/**
 * Rows gathered into a list of lines a block at a time.
 *
 * A profile is a row per bin of the file — a quarter of a million at 10 kb on a
 * mammal, for each of a task's tracks and in each of two formats — and held as
 * rows to the end, every one of them lived long enough for the collector to
 * move it out of its young space and then mark it again and again, which was a
 * larger share of writing a coverage run than formatting its numbers. Joined a
 * block at a time as they are made, the rows die young and the list holds one
 * string for every four thousand rows. Each block is its rows joined by the `\n`
 * the list is joined by in turn (`document`, or a bedGraph's own join), so the
 * text is the same.
 */
export class RowBlocks {
  private readonly block: string[] = []

  constructor(private readonly into: string[]) {}

  push(line: string): void {
    this.block.push(line)
    if (this.block.length === ROWS_PER_BLOCK) this.flush()
  }

  /** What is left, onto the list; call once the last row is pushed. */
  flush(): void {
    if (this.block.length === 0) return
    this.into.push(this.block.join('\n'))
    this.block.length = 0
  }
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
    `# chromosomix ${cell(provenance.app)}`,
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
  // One template a row rather than four cells joined: a profile is a row per
  // bin of the file, a quarter of a million at 10 kb on a mammal, and the cells
  // are the same strings either way.
  const { binsize, values } = output
  const rows = new RowBlocks(lines)
  for (let i = 0; i < values.length; i++) {
    const bin = from + i
    const start = bin * binsize
    rows.push(`${bin}\t${start}\t${start + binsize}\t${tsvNumber(values[i])}`)
  }
  rows.flush()
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
 *
 * **Where the abscissa is a list, the `x` column holds its names** rather than
 * the indices the figure plots them at (`CurveOutput.xTicks`). The whole claim
 * of this file is that a reader can put a bar next to the number it was drawn
 * from; a column of `0, 1, 2` beside two columns of fractions asks them to count
 * bars on the picture to find out which sequence the third row is, which is the
 * matrix writer's own argument for putting the ticks down the left edge.
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

  const names = output.xTicks
  for (let i = 0; i < rows; i++) {
    // The name where the list has one and the number otherwise, rather than a
    // blank: a list shorter than the series it names is a bug in the task, and
    // the honest thing to write for a point it does not reach is where the
    // figure put it.
    const at = names?.[i]
    const cells = [
      at !== undefined ? cell(at) : i < grid.length ? tsvNumber(grid[i]) : '',
    ]
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

  // The profiles drawn along the two edges (§18.8), as a **second block** under
  // the matrix rather than as a row and a column of it. A pileup with track
  // aggregates is two measurements in different units — contacts and signal —
  // and a spreadsheet that read them as one rectangle would average them
  // together. Left out entirely, which is what shipped, the lines a reader is
  // looking at are the one thing in the figure with no numbers behind it.
  const profiles = [
    ...(output.margins?.top ?? []).map((profile) => ['top', profile] as const),
    ...(output.margins?.right ?? []).map((profile) => ['right', profile] as const),
  ]
  if (profiles.length > 0) {
    const widest = Math.max(...profiles.map(([, profile]) => profile.values.length))
    lines.push('')
    lines.push('# aggregate profiles along the edges: top runs along x, right runs down y')
    lines.push(row(['edge', 'track', ...Array.from({ length: widest }, (_, i) => String(i))]))
    for (const [edge, profile] of profiles) {
      const cells = [edge, cell(profile.name)]
      for (const value of profile.values) cells.push(tsvNumber(value))
      lines.push(row(cells))
    }
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
    // A start is written as it is held, 0-based, which is how a BED-shaped
    // table is read back (§8.3) — and said to be, since the table it came from
    // printed it 1-based (`TableColumn.coordinate`).
    `# columns: ${output.columns
      .map((column) => `${cell(column.label)}${column.coordinate === 'start' ? ' (0-based)' : ''}`)
      .join(', ')}`,
    row(output.columns.map((column) => cell(column.key))),
  ]
  for (const record of output.rows) {
    lines.push(
      row(
        output.columns.map((column) => {
          const value = record[column.key]
          if (value === undefined || value === null) return ''
          if (typeof value === 'number')
            return column.kind === 'number'
              ? fixed(value, column.digits, column.scientific === true)
              : tsvNumber(value)
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

/**
 * `chrom  start  end  value` — a track that is on no grid, as a table.
 *
 * Its own function rather than a `ProfileOutput` with a made-up bin size,
 * because the two are different things and pretending otherwise is what the
 * export of a derived track used to do. {@link profileToTsv} writes `bin`
 * first, which is meaningful only where there is a grid and every row sits on
 * it; these rows sit where the data does.
 *
 * The empty rows {@link profileToTsv} keeps are not kept here, and that is the
 * same decision rather than a different one. A profile has a value *per bin*, so
 * a missing bin is a hole in a sequence a reader can see the shape of; a
 * comparison of two tracks is defined only where both operands say something,
 * so there is no row to leave blank — the intervals between are not empty
 * readings, they are places the question was not asked.
 *
 * `contigs` orders the file, exactly as it orders the other two writers, so the
 * three agree line for line and a reader can diff them.
 */
export function spansToTsv(
  label: string,
  unit: string,
  spans: readonly TsvSpans[],
  contigs: ReadonlyArray<{ name: string; length: number }>,
  provenance: Provenance,
): string {
  const lines = [
    ...provenanceLines(provenance),
    `# output: ${cell(label)}${unit === '' ? '' : ` (${cell(unit)})`}`,
    row(['chrom', 'start', 'end', 'value']),
  ]
  const byContig = new Map<string, TsvSpans[]>()
  for (const span of spans) {
    const held = byContig.get(span.contig)
    if (held === undefined) byContig.set(span.contig, [span])
    else held.push(span)
  }
  for (const contig of contigs) {
    const here = byContig.get(contig.name)
    if (here === undefined) continue
    const items: Array<[number, number, number]> = []
    for (const span of here) {
      for (let at = 0; at < span.starts.length; at += 1) {
        const value = span.values[at]
        if (!Number.isFinite(value)) continue
        const start = Math.max(0, span.starts[at])
        const end = Math.min(contig.length, span.ends[at])
        if (end > start) items.push([start, end, value])
      }
    }
    items.sort((one, two) => one[0] - two[0])
    for (const [start, end, value] of items) {
      lines.push(row([cell(contig.name), String(start), String(end), tsvNumber(value)]))
    }
  }
  return document(lines)
}

/** One output, with its provenance above it, as the text of a `.tsv`. */
export function outputToTsv(output: TaskOutput, provenance: Provenance): string {
  return document([...provenanceLines(provenance), ...outputLines(output)])
}

/**
 * An output drawn **across several maps** — the drawer's all-maps tab (§18.7):
 * a stacked table, an overlay of every map's curves — with every map's
 * provenance above it.
 *
 * One block per map, in the order the rows name them, each opened by the name
 * the map column uses and indented under it. A stacked table has no single
 * provenance, and one printed for the first map would be a claim about the
 * other seven that is not true — they are other files, and they may have been
 * run at other times with other settings.
 */
export function combinedToTsv(
  output: TaskOutput,
  maps: ReadonlyArray<{ label: string; provenance: Provenance }>,
): string {
  return document([...combinedProvenanceLines(maps), ...outputLines(output)])
}

/**
 * Every map's provenance, as the head of an export across several maps and as
 * what *copy provenance* puts on the clipboard there: the build once, then one
 * indented block per map, opened by its name.
 */
export function combinedProvenanceLines(
  maps: ReadonlyArray<{ label: string; provenance: Provenance }>,
): string[] {
  const head: string[] = []
  const app = maps[0]?.provenance.app
  if (app !== undefined) head.push(`# chromosomix ${cell(app)}`)
  head.push(`# maps: ${tsvNumber(maps.length)}`)
  for (const map of maps) {
    head.push(`# map: ${cell(map.label)}`)
    // Everything but the build, which is the file's and said once above.
    for (const line of provenanceLines(map.provenance).slice(1)) head.push(`#   ${line.slice(2)}`)
  }
  return head
}

function outputLines(output: TaskOutput): string[] {
  switch (output.kind) {
    case 'profile':
      return profileToTsv(output)
    case 'curve':
      return curveToTsv(output)
    case 'matrix':
      return matrixToTsv(output)
    case 'table':
      return tableToTsv(output)
    case 'intervals':
      return intervalsToTsv(output)
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
