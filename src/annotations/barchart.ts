/**
 * barChart and bigBarChart: a whole chart drawn inside one feature (§8.17).
 *
 * UCSC's format is BED6+5 — `chrom start end name score strand name2 expCount
 * expScores`, with an optional `_dataOffset` and `_dataLen` pointing into a
 * sample matrix this viewer does not read. What makes it worth its own module
 * is the ninth column: a comma-separated list of `expCount` numbers, one per
 * **category**, so a row is not an interval with a value on it but an interval
 * with a *vector* on it. Gene expression across fifty-four GTEx tissues is the
 * canonical one, and there is no way to draw it as a box.
 *
 * It is nonetheless a {@link FeatureSet} — §8.14's decision, restated for the
 * same reason and with the same force. `payload.kind === 'features'` is tested
 * at a dozen sites across the browser, the map lanes, the search box, the
 * export and the analysis inputs; a second payload shape breaks none of them
 * and makes every one of them *skip* the lane, silently, to be discovered one
 * call site at a time. So the vector rides on the set as one optional field
 * (`FeatureSet.bars`) and everything else about a barChart — the packing, the
 * hit test, the search, the export, the metaplot over its intervals — is the
 * code a peak set already uses.
 *
 * ## Where the category names come from
 *
 * **Not from the data.** The format carries the numbers and not their names:
 * `barChartBars` lives in the `track` line of a custom track and in the trackDb
 * stanza of a hub, and a bigBarChart dropped on its own arrives with neither.
 * So the `track` line is read where there is one, and where there is not the
 * categories are their own positions — `1` to `N` — and {@link BarChartBars}
 * says which of the two happened, so the legend can be honest about it and the
 * one colouring that reads a category name is withheld rather than invented.
 *
 * ## What this refuses to be clever about
 *
 * A file whose rows disagree with each other about `expCount` is a file whose
 * categories are not the same categories, and there is no honest chart to draw
 * for the rows that disagree. They keep their interval — the interval is not
 * the part that was wrong — lose their bars, and are counted in the lane's
 * summary, which is the §8.7 bargain for a truncated bigBed made again: a file
 * that says what it dropped is usable, one that does not is a lie about the
 * genome.
 */

import { FeatureBuilder, type BarChartSchema } from './featureset'
import { forEachRow, isInteger } from './parse'
import { DETAIL_SEP, type FeatureSet } from './types'

/**
 * The fewest categories a row can have and still be read as a chart.
 *
 * Two, and it is load-bearing rather than tasteful: it is what keeps a
 * narrowPeak out of {@link sniffBarChart}. Column 8 of a narrowPeak is a
 * q-value — one number, no comma — so a one-category rule would let `expCount 1`
 * against a single number match, and every MACS output in the world would open
 * as a bar chart of one bar. A one-category bar chart is also a bar, which is
 * what a bedGraph is for.
 */
export const BAR_MIN_CATEGORIES = 2

/**
 * The detail key holding the category a row's tallest bar belongs to.
 *
 * Written only where the file **names** its categories, and that is the whole
 * of the rule: `fields.ts` reads a key back out of the detail strings and
 * decides it is a ramp when its values parse as numbers, so on a file with
 * numbered categories this would become a viridis ramp over the order the
 * categories happen to be listed in — which is precisely the picture §8.12
 * exists to refuse. Named, it is the most useful colouring this lane has: one
 * colour per dominant tissue, over a whole chromosome, at a zoom where no
 * individual chart is legible.
 */
export const BAR_FIELD_TOP = 'top'

/** The detail key holding a row's total across every category. */
export const BAR_FIELD_TOTAL = 'total'

/** How many rows {@link sniffBarChart} checks before it is satisfied. */
const ENOUGH_ROWS = 4

/**
 * Whether these lines are a barChart.
 *
 * Two tests, and the second is the one that does the work.
 *
 * **The agreement**: column 8 is an integer `N` of at least
 * {@link BAR_MIN_CATEGORIES}, and column 9 splits into exactly `N` finite
 * numbers. Nothing in the BED family agrees with itself that way by accident —
 * a count and a list whose length is that count is a statement, not a
 * coincidence — and it is what a barChart's whole meaning rests on.
 *
 * **The name**: column 7 must not be an integer. That is the one test that
 * separates this from BED9, BED12 and gappedPeak, which put `thickStart` in
 * column 7 and `thickEnd` + `itemRgb` in columns 8 and 9 — an integer followed
 * by three comma-separated integers, which is the agreement above whenever
 * `thickEnd` happens to equal 3. A barChart's column 7 is `name2`, an
 * alternative name for the item, and a name is not a coordinate. Waived when
 * the file is *called* a barChart, exactly as `peakFlavour` waives its
 * shape tests for a file called a narrowPeak: a reader who has named the format
 * has answered the question the shape test was asking.
 *
 * Asked before `sniffFormat`, because `sniffFormat`'s last line is
 * `return 'bed'` — so a format it has not been taught is not refused, it is
 * silently parsed as a BED, and a barChart read as a BED is a lane of boxes
 * whose chart column was never mentioned.
 */
export function sniffBarChart(text: string, fileName = ''): boolean {
  const named = /\.(bigbarchart|barchart)(\.gz)?$/i.test(fileName)
  let rows = 0
  let index = 0
  const length = text.length
  // Walked here rather than through `forEachRow`, and for the reason `sniffVcf`
  // walks its own lines: this runs on every dropped file *before* anything
  // knows what it is, and `forEachRow` has no way to stop. On a half-gigabyte
  // BAM-adjacent text file that is a full split of every line to answer a
  // question four rows settle.
  while (index < length && rows < ENOUGH_ROWS) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const line = text.slice(index, stop)
    index = end + 1
    // The same three `forEachRow` steps over, so the sniffer and the parser
    // agree about which lines are data.
    if (line === '' || line.charCodeAt(0) === 35) continue
    if (line.startsWith('track ') || line.startsWith('browser ')) continue
    const columns = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    if (!looksLikeBarChart(columns, named)) return false
    rows++
  }
  return rows > 0
}

/** One row's shape, as {@link sniffBarChart} tests it. */
function looksLikeBarChart(columns: string[], named: boolean): boolean {
  if (columns.length < 9) return false
  if (!isInteger(columns[1]) || !isInteger(columns[2])) return false
  // `name2` against `thickStart` — see {@link sniffBarChart}.
  if (!named && isInteger(columns[6])) return false
  return countOf(columns) > 0
}

/**
 * How many categories a row states and delivers, or `0` where the two disagree.
 *
 * The agreement *is* the test, so it is one function and both callers use it:
 * the sniffer asks whether the row has it and the parser asks what it was.
 */
function countOf(columns: string[]): number {
  const count = Number(columns[7])
  if (!isInteger(columns[7]) || count < BAR_MIN_CATEGORIES) return 0
  return valuesOf(columns[8] ?? '').length === count ? count : 0
}

/**
 * A `expScores` list as numbers.
 *
 * A trailing comma is tolerated because UCSC's own comma lists carry one — a
 * BED12's `blockSizes` is written `10,20,30,` — and a list that ends in a
 * separator has the same number of items either way. Anything that is not a
 * finite number ends the read and yields nothing, so a malformed list is *no
 * chart* rather than a chart with a zero in it.
 */
function valuesOf(field: string): number[] {
  const trimmed = field.trim()
  if (trimmed === '') return []
  const parts = trimmed.split(',')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  const out: number[] = []
  for (const part of parts) {
    const value = Number(part)
    if (part.trim() === '' || !Number.isFinite(value)) return []
    out.push(value)
  }
  return out
}

/**
 * Read a barChart into intervals with a chart on each.
 *
 * The `track` line is read for the categories' names, colours and units; every
 * data row is read the way a BED6 is read, plus the vector. {@link forEachRow}
 * already steps over `track` and `browser` lines, so the settings are found by
 * a separate walk of the head of the file rather than by teaching the row
 * walker about them — the same arrangement `parseVcf` makes for `##` lines.
 */
export function parseBarChart(text: string, fileName = ''): FeatureSet {
  const settings = settingsOf(text)
  const builder = new FeatureBuilder()
  const declared = wordsOf(settings['barchartbars'])
  let width = declared.length
  let skipped = 0
  let unplaced = 0

  forEachRow(text, (columns) => {
    if (columns.length < 3 || !isInteger(columns[1]) || !isInteger(columns[2])) {
      skipped++
      return
    }
    const count = countOf(columns)
    // The first row that carries a chart decides how wide the file is, where the
    // `track` line has not already said. One of the two has to, and the labels
    // go first because they are what the legend draws: a file that names six
    // categories and writes seven numbers has said two things, and the names
    // are the one a reader can see is wrong.
    if (width === 0 && count > 0) width = count
    const values = count === width && count > 0 ? valuesOf(columns[8] ?? '') : null
    if (values === null) unplaced++
    const start = Number(columns[1])
    const end = Number(columns[2])
    // `name2` is the human name and column 4 is the accession behind it —
    // GTEx writes `ENSG00000160072.19` in one and `ATAD3B` in the other — which
    // is exactly the split `FeatureSet` already keeps for a GTF. So the symbol
    // is what the lane writes on the glyph and the accession is what the search
    // box finds, for free, and `name === id` still spells "the file gave no
    // symbol" on a file that fills only column 4.
    const accession = valueOrEmpty(columns[3])
    const symbol = valueOrEmpty(columns[6])
    builder.add(columns[0], start, end, {
      strand: strandOf(columns[5]),
      score: scoreOf(columns[4]),
      name: symbol === '' ? accession : symbol,
      id: accession,
      detail: detailOf(values, declared),
      ...(values === null ? {} : { bars: values }),
    })
  })

  if (builder.length === 0 && skipped > 0) {
    throw new Error(
      `No usable rows: all ${skipped} lines failed the "contig, start, end" test that every ` +
        'BED-like format begins with.',
    )
  }
  if (width === 0) {
    throw new Error(
      `No row of ${fileName === '' ? 'this file' : fileName} carries a category count and a ` +
        'matching list of values, which is the whole of what makes a barChart one.',
    )
  }
  return builder.finish(schemaOf(settings, declared, width, unplaced))
}

/** The file-level half of {@link BarChartBars}, before any value is read. */
function schemaOf(
  settings: Record<string, string>,
  declared: string[],
  width: number,
  unplaced: number,
): BarChartSchema {
  return {
    // Positions where the file names nothing, which is every bigBarChart that
    // arrives without its hub. `named` is what stops them being read as names.
    labels: declared.length === width ? declared : positions(width),
    named: declared.length === width,
    colours: coloursOf(wordsOf(settings['barchartcolors']), width),
    unit: settings['barchartunit'] ?? '',
    label: settings['barchartlabel'] ?? '',
    metric: settings['barchartmetric'] ?? '',
    limit: Number(settings['maxlimit'] ?? Number.NaN),
    unplaced,
  }
}

/** `1`, `2`, … `N`, for a file that names none of its categories. */
function positions(width: number): string[] {
  const out: string[] = []
  for (let at = 0; at < width; at++) out.push(String(at + 1))
  return out
}

/**
 * `barChartColors`, kept only when it has exactly one colour per category.
 *
 * A partial list is refused outright rather than padded from the palette: half
 * the lane in the file's colours and half in ours is a legend where the same
 * ink means two things, and the file has already failed to say what it meant.
 */
function coloursOf(words: string[], width: number): string[] {
  return words.length === width ? words : []
}

/**
 * What a click and a hover read, and what the colour picker offers (§8.16).
 *
 * Two parts, and each earns its place by being a *column* rather than a number
 * in prose. `total` is the row's whole vector summed, which is the one number a
 * reader would rank genes by and the one a ramp can be drawn from. `top` is the
 * category the tallest bar belongs to, which is the categorical colouring this
 * lane exists to want — and it is written only where the categories have names,
 * for the reason {@link BAR_FIELD_TOP} gives.
 */
function detailOf(values: number[] | null, declared: string[]): string {
  if (values === null || values.length === 0) return ''
  let total = 0
  let best = 0
  for (let at = 0; at < values.length; at++) {
    total += values[at]
    if (values[at] > values[best]) best = at
  }
  const parts = [`${BAR_FIELD_TOTAL} ${round(total)}`]
  if (declared.length === values.length) parts.unshift(`${BAR_FIELD_TOP} ${declared[best]}`)
  return parts.join(DETAIL_SEP)
}

/** Enough digits to tell two rows apart, and few enough to read in a tooltip. */
function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function valueOrEmpty(value: string | undefined): string {
  return value === undefined || value === '.' ? '' : value
}

function strandOf(value: string | undefined): number {
  return value === '+' ? 1 : value === '-' ? -1 : 0
}

/** BED's column 5. `.` is *not recorded* and stays `NaN` rather than becoming 0. */
function scoreOf(value: string | undefined): number {
  return value === undefined || value === '' || value === '.' ? Number.NaN : Number(value)
}

// ---------------------------------------------------------------------------
// The track line
// ---------------------------------------------------------------------------

/**
 * How far into a file a `track` line is looked for.
 *
 * It is the first line of a custom track by convention and by UCSC's own
 * requirement, but a concatenated or re-sorted file can put comments above it.
 * Bounded rather than unbounded because this runs over the whole text of a
 * file that may be hundreds of megabytes, and a `track` line a thousand lines
 * in is not a track line, it is a word in a data column.
 */
const TRACK_LINE_LIMIT = 100

/**
 * The `track` line's settings, lower-cased by key.
 *
 * `track type=bigBarChart barChartBars="liver kidney lung" barChartUnit=TPM`
 * is the shape, and the quoting is what makes it worth a parser: the interesting
 * values are lists whose separator is the space that also separates the
 * settings. Keys are lower-cased because UCSC's own documentation, hubs and
 * examples disagree with each other about the case of `barChartColors`, and a
 * reader who typed `barchartbars` has said what they meant.
 */
function settingsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let index = 0
  let seen = 0
  const length = text.length
  while (index < length && seen < TRACK_LINE_LIMIT) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop--
    const line = text.slice(index, stop)
    index = end + 1
    seen++
    if (line === '' || line.charCodeAt(0) === 35) continue
    if (!line.startsWith('track ')) {
      // The first thing that is neither blank, a comment nor the track line is
      // data, and there is no track line above data.
      if (!line.startsWith('browser ')) break
      continue
    }
    for (const [, key, quoted, bare] of line.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) {
      out[key.toLowerCase()] = quoted ?? bare ?? ''
    }
    break
  }
  return out
}

/** A space-separated setting as its words, or an empty list for an absent one. */
function wordsOf(value: string | undefined): string[] {
  if (value === undefined) return []
  const trimmed = value.trim()
  return trimmed === '' ? [] : trimmed.split(/[\s,]+/)
}

// ---------------------------------------------------------------------------
// bigBarChart
// ---------------------------------------------------------------------------

/**
 * Whether a bigBed's autoSql declares a barChart.
 *
 * A bigBarChart *is* a bigBed — same magic number, same R-tree, same rows — and
 * the only thing that distinguishes one is the schema it was written with. bbi
 * hands that back as the `autoSql` string in the header, so the question is
 * asked of the file's own declaration rather than guessed from its column
 * shapes, which is a tier better than anything the text sniffer can do and is
 * the reason §8.7's "read it as the BED it holds" needed no exception before
 * this one.
 *
 * Both field names are required. `expCount` alone appears in `expRatio` and in
 * the older microarray schemas, whose ninth column is a different thing.
 */
export function isBarChartSchema(autoSql: string): boolean {
  return /\bexpCount\b/.test(autoSql) && /\bexpScores\b/.test(autoSql)
}

// ---------------------------------------------------------------------------
// The summary line
// ---------------------------------------------------------------------------

/**
 * The line under a barChart lane's label: what it holds and what it lost.
 *
 * The unplaced rows are counted at parse time rather than scanned for here,
 * because "how many rows disagreed with the file about its own categories" is a
 * fact about the *read* and not about the set: a row with no chart and a row
 * whose chart is all zeroes are the same array afterwards.
 */
export function barChartSummary(set: FeatureSet): string {
  const bars = set.bars
  const features = `${set.length.toLocaleString()} feature${set.length === 1 ? '' : 's'}`
  if (bars === undefined) return features
  const what = bars.label === '' ? 'categories' : bars.label.toLowerCase()
  const parts = [features, `${bars.labels.length} ${what}`]
  if (bars.unplaced > 0) {
    parts.push(`${bars.unplaced.toLocaleString()} with no chart`)
  }
  return parts.join(' · ')
}
