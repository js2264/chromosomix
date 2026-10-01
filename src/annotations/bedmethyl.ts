/**
 * `bedMethyl` and `bigMethyl`: base-resolution modification calls, as the
 * quantitative lane they are.
 *
 * ## Why this one, in this application
 *
 * The human-epigenetics case is the obvious one and it is not the strongest.
 * The strongest is **metagenomic**: bacterial methylation — 6mA, 4mC, 5mC — is
 * strain-specific and is used to *bin contigs*, which is the question this
 * viewer's MAG layer exists to answer. A `modkit pileup` over an ONT or PacBio
 * assembly is one `bedMethyl` and it belongs beside the contact map, not in a
 * second window.
 *
 * It is also the format long-read tooling emits by default — `modkit` writes it,
 * `nanopolish`/`f5c` and the ENCODE WGBS pipelines write the older BED9+2
 * spelling of it — so this is the file people already have.
 *
 * ## The layout
 *
 * BED9, then the measurement:
 *
 * ```
 * chrom start end code score strand thickStart thickEnd rgb  Nvalid  percent [Nmod Ncanon …]
 * ```
 *
 * Column 10 is the read depth the call rests on and column 11 is the percentage
 * modified. `modkit` appends seven more counts; ENCODE's older files stop at
 * eleven. Both are read here, because the eleventh column is the whole point and
 * everything past it is provenance.
 *
 * ## Why it becomes a track and not a feature set
 *
 * A methylation call is a **number at a place**, which is what
 * `annotations/signal.ts` says a bedGraph is, and the consequence is the same:
 * it becomes a `kind: 'track'` whose data stays in the worker and is sampled per
 * view (§8.2), so it arrives with a range, a ceiling, an autoscale, a colour and
 * the ⌘-scroll, none of which had to be written again. Read as the BED9 it
 * begins with — which is what happened before this module — it was a lane of
 * grey boxes, one per cytosine, with the percentage never mentioned: the
 * `annotations/signal.ts` failure exactly, on a file where the boxes are a
 * single base wide and there are eighty million of them.
 *
 * ## The one thing it refuses to invent
 *
 * A `bedMethyl` may hold **more than one modification** over the same bases —
 * `m` and `h` at every CpG is the standard output of a 5mC/5hmC model — and
 * those are two measurements, not one. There is one lane per loaded file, so
 * this draws the **most abundant code** and says, under the lane's label, which
 * codes were in the file and how many rows each had. That is §8.7's bargain for
 * a truncated bigBed made again: a file that says what it dropped is usable, one
 * that does not is a lie about the genome. Averaging them, or laying them over
 * each other in one lane, would produce a number that is not in the file and is
 * not a methylation level of anything.
 *
 * Strands are **not** collapsed, and do not need to be: a `bedMethyl` row is one
 * base, and the two cytosines of a CpG are at consecutive positions on opposite
 * strands. They are two calls at two coordinates, so they sit side by side in
 * one lane with nothing overlapping and nothing averaged. A file written with
 * `--combine-strands` has already made that choice and arrives as one call per
 * site.
 */

import { ContigBuilder, finishSet, type SignalSet } from './signal'
import { isInteger } from './parse'
import { modName } from './bam/basemods'

/** The fewest columns a `bedMethyl` can have: BED9, coverage, percentage. */
const BEDMETHYL_COLUMNS = 11

/** Where the read depth and the percentage live, counting from zero. */
const COVERAGE_AT = 9
const PERCENT_AT = 10

/** How many rows {@link sniffBedMethyl} checks before it is satisfied. */
const ENOUGH_ROWS = 4

/** A name that says the format outright. */
const BEDMETHYL_NAME = /\.(bedmethyl|bigmethyl|bed ?methyl)(\.gz)?$/i

/** One modification code's share of the file. */
export interface ModCount {
  code: string
  /** `5mC` where SAMtags §1.7 names the code (`bam/basemods.ts`), the code itself otherwise. */
  label: string
  rows: number
}

export interface BedMethylResult {
  /** The percentages of {@link BedMethylResult.drawn}, as a track. */
  signal: SignalSet
  /** Every code the file held, most rows first. */
  codes: ModCount[]
  /** The code whose calls the signal holds. */
  drawn: string
  /** Mean read depth over the drawn rows, for the summary line. */
  meanCoverage: number
}

/**
 * Whether these lines are a `bedMethyl`.
 *
 * Four tests, and the fourth is the one nothing else passes.
 *
 * **Width**: at least eleven columns, because the eleventh is the measurement.
 *
 * **Types**: an integer span, a strand, an integer depth in column 10 and a
 * finite percentage in column 11.
 *
 * **Range**: the percentage is between 0 and 100. A column that runs past 100 is
 * not a percentage and this is not the format.
 *
 * **One base per row.** A `bedMethyl` row is a single modified base, so
 * `end === start + 1`, and that is what separates this from any BED9+2 whose
 * tenth and eleventh columns happen to be a count and a fraction. No peak
 * caller in the world emits one-base intervals by the million.
 *
 * All four are waived for a file *named* `.bedMethyl`, on the rule this app
 * applies everywhere: a reader who named the format has answered the question.
 * Asked before `sniffSignal` and `sniffFormat`, because both would take it —
 * `sniffFormat` silently, as a BED9 whose boxes are one base wide.
 */
export function sniffBedMethyl(text: string, fileName = ''): boolean {
  const named = BEDMETHYL_NAME.test(fileName)
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
    if (!looksLikeBedMethyl(columns, named)) return false
    rows++
  }
  return rows > 0
}

function looksLikeBedMethyl(columns: string[], named: boolean): boolean {
  if (columns.length < BEDMETHYL_COLUMNS) return false
  if (!isInteger(columns[1]) || !isInteger(columns[2])) return false
  const percent = Number(columns[PERCENT_AT])
  if (columns[PERCENT_AT] === '' || !Number.isFinite(percent)) return false
  if (named) return true
  if (!isInteger(columns[COVERAGE_AT]) || Number(columns[COVERAGE_AT]) < 0) return false
  if (percent < 0 || percent > 100) return false
  const strand = columns[5]
  if (strand !== '+' && strand !== '-' && strand !== '.') return false
  return Number(columns[2]) - Number(columns[1]) === 1
}

/**
 * A `bedMethyl`, as the percentages of its most abundant modification.
 *
 * Two passes rather than one, and the second is why: which code to draw cannot
 * be known until every row has been counted, and building a track per code so
 * that all but one can be thrown away is eighty million intervals of work for a
 * file whose answer is usually *there is only one code*. So the first pass
 * counts codes, and the second builds the one track.
 *
 * A row whose percentage is not a number, or whose depth is zero, is skipped:
 * a call resting on no reads is not a measurement, and drawing it as `0 %`
 * would put a floor of confident zeroes under every uncovered base in the
 * genome. That is the same refusal `annotations/barchart.ts` makes for a row
 * whose chart disagrees with the file.
 */
export function parseBedMethyl(text: string): BedMethylResult {
  const tally = new Map<string, number>()
  forEachDataRow(text, (columns) => {
    if (columns.length < BEDMETHYL_COLUMNS) return
    if (!isInteger(columns[1]) || !isInteger(columns[2])) return
    const code = codeOf(columns[3])
    tally.set(code, (tally.get(code) ?? 0) + 1)
  })

  const codes: ModCount[] = [...tally.entries()]
    .map(([code, rows]) => ({ code, label: modName(code), rows }))
    .sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code))
  if (codes.length === 0) {
    throw new Error('This looks like a bedMethyl but holds no usable rows.')
  }
  const drawn = codes[0].code

  const builders = new Map<string, ContigBuilder>()
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let length = 0
  let depth = 0
  forEachDataRow(text, (columns) => {
    if (columns.length < BEDMETHYL_COLUMNS) return
    if (!isInteger(columns[1]) || !isInteger(columns[2])) return
    if (codeOf(columns[3]) !== drawn) return
    const start = Number(columns[1])
    const end = Number(columns[2])
    if (end <= start) return
    const percent = Number(columns[PERCENT_AT])
    if (!Number.isFinite(percent)) return
    const coverage = isInteger(columns[COVERAGE_AT]) ? Number(columns[COVERAGE_AT]) : 0
    // No reads, no measurement. See the header.
    if (coverage <= 0) return
    const contig = columns[0] ?? ''
    let builder = builders.get(contig)
    if (builder === undefined) {
      builder = new ContigBuilder(contig)
      builders.set(contig, builder)
    }
    builder.push(start, end, percent)
    length++
    depth += coverage
    if (percent < min) min = percent
    if (percent > max) max = percent
  })

  if (length === 0) {
    throw new Error(
      'This looks like a bedMethyl but every row rests on zero reads, so there is no ' +
        'measurement to draw.',
    )
  }
  return {
    signal: finishSet(builders, length, min, max),
    codes,
    drawn,
    meanCoverage: depth / length,
  }
}

/** The modification code, normalised so an absent one is not its own category. */
function codeOf(value: string | undefined): string {
  return value === undefined || value === '' || value === '.' ? '?' : value
}

/**
 * The data rows, with the three skips the rest of this module's neighbours take.
 *
 * Its own walk rather than `parse.ts`'s `forEachRow` because this is called
 * twice over the same text and wants no line numbers; sharing the other would
 * mean either exporting a second variant of it or paying for a counter that
 * nothing here reads.
 */
function forEachDataRow(text: string, visit: (columns: string[]) => void): void {
  for (const raw of text.split('\n')) {
    let line = raw
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '' || line.charCodeAt(0) === 35) continue
    if (line.startsWith('track ') || line.startsWith('browser ')) continue
    visit(line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/))
  }
}

/**
 * Whether a bigBed's autoSql declares a `bedMethyl`.
 *
 * `isBarChartSchema`'s argument for the third time, and this is the format that
 * most needs it: a `bigMethyl`'s first nine columns *are* a valid BED9, so
 * §8.7's "read it as the BED it holds" produces a lane that looks entirely
 * correct — one box per cytosine, in the file's own colours — and is missing the
 * only column anybody opened the file for.
 *
 * UCSC's schema calls them `validCov` and `percentMod` (older writers:
 * `coverage` and `percentMeth`), so both spellings are accepted; either name
 * beside a `BED9` is the statement that the row carries a modification call.
 */
export function isBedMethylSchema(autoSql: string): boolean {
  return (
    /\b(percentMod|percentMeth|fractionModified)\b/.test(autoSql) &&
    /\b(validCov|coverage|Nvalid_cov)\b/.test(autoSql)
  )
}

/**
 * The line under a `bedMethyl` lane's label.
 *
 * It names the modification being drawn, the depth behind it, and — the part
 * that matters — **every code that was in the file and is not on screen**. A
 * reader who pileup'd 5mC and 5hmC together and sees one lane needs to find out
 * here, not by noticing that a number looks low.
 */
export function bedMethylSummary(result: BedMethylResult): string {
  const drawn = result.codes.find((code) => code.code === result.drawn)
  const parts = [
    `${result.signal.length.toLocaleString()} ${drawn?.label ?? result.drawn} calls`,
    `${result.meanCoverage.toFixed(1)}× mean depth`,
  ]
  const others = result.codes.filter((code) => code.code !== result.drawn)
  if (others.length > 0) {
    parts.push(
      `not drawn: ${others.map((code) => `${code.label} (${code.rows.toLocaleString()})`).join(', ')}`,
    )
  }
  return parts.join(' · ')
}
