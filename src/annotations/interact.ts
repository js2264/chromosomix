/**
 * UCSC's `interact` and `bigInteract`: two places joined, in the one format a
 * genome browser has for saying so.
 *
 * ## Why this app of all apps should read it
 *
 * Everything else in this viewer draws a measurement *along* a genome. A
 * contact map draws a measurement *between two points of one*, and so does this
 * — which makes `interact` the only format UCSC has that is about the thing the
 * rest of this application is about. A ChIA-PET loop set, a promoter–enhancer
 * call, a set of SNP→gene assignments: all of them arrive in this format or in
 * `longrange`, and all of them are the annotation a reader most wants drawn
 * *over* a Hi-C map, because agreeing or disagreeing with the map is the whole
 * question.
 *
 * ## What it becomes
 *
 * A {@link PairSet}, which is what a bedpe becomes, which means it is drawn by
 * code that already exists: arcs across the matrix on the overlay card (§8.1),
 * and a lane of arcs of its own in the map-less 1D browser. Not one line of
 * renderer was written for this format, and that is the argument for the shape
 * rather than an accident of it — `interact` and `bedpe` differ in *spelling*
 * and in nothing a picture can see.
 *
 * Trans interactions come through intact, because a `PairSet` holds a contig
 * per end rather than one per row. UCSC draws the far end of one as a labelled
 * vertical bar, having only a single axis to draw it on; on a contact map it is
 * an ordinary off-diagonal arc, which is the more honest picture and costs
 * nothing to make.
 *
 * ## What it was doing before this module existed
 *
 * Two things, both silent, and the second is the worse.
 *
 * An `interact` whose `value` column is fractional — UCSC's own examples write
 * `5.000000` — fell through `sniffFormat` to `'bed'`, and was drawn as **one
 * box spanning both anchors and the gap between them**: a 19 kb "feature" made
 * of two 1 kb ends and the 17 kb of nothing between, with the ten columns
 * naming the ends never mentioned.
 *
 * An `interact` whose `value` happens to be written as a whole number matched
 * `sniffFormat`'s bedpe test — column 3 not an integer, columns 4 and 5
 * integers — and was read as a **bedpe**, which put the interaction's *name* in
 * the second contig and its 0–1000 *score* in the second start. Arcs, drawn
 * confidently, between coordinates that were never in the file. That is the
 * failure mode §8.17 and `annotations/signal.ts` were each written against, met
 * a third time, and it is why the sniffer here is asked before the BED one.
 */

import { PairBuilder } from './featureset'
import { forEachRow, isInteger } from './parse'
import { DETAIL_SEP, type PairSet } from './types'

/**
 * The column count the format fixes.
 *
 * BED5+13, and the `+13` is not optional the way a BED's tail is: every one of
 * the thirteen is required by the spec and by `bigInteract`'s autoSql, and the
 * last of them is what the two anchors are read out of. A file with seventeen
 * columns is not an interact missing its target strand, it is something else.
 */
const INTERACT_COLUMNS = 18

/** How many rows {@link sniffInteract} checks before it is satisfied. */
const ENOUGH_ROWS = 4

/** A name that says the format, which waives the tests a name has answered. */
const INTERACT_NAME = /\.(biginteract|interact)(\.gz)?$/i

function isNumber(value: string | undefined): boolean {
  return value !== undefined && value !== '' && Number.isFinite(Number(value))
}

/** `+`, `-`, or `.` — the three things a strand column may hold. */
function isStrand(value: string | undefined): boolean {
  return value === '+' || value === '-' || value === '.' || value === ''
}

/**
 * Whether these lines are an `interact`.
 *
 * Three tests, and the third is the one that cannot be passed by accident.
 *
 * **The width.** Exactly eighteen columns. On its own that is weak — a headed
 * peak table can be any width — which is why it is only the gate.
 *
 * **The types.** Columns 2, 3, 10, 11, 15 and 16 are integers, column 5 is an
 * integer score, column 6 is a finite number, and columns 13 and 18 are
 * strands. Note what is *not* tested: that columns 9 and 14 are non-numeric.
 * An Ensembl contig is called `1`, and a test that assumed a contig name cannot
 * look like a number would refuse every interact written against an Ensembl
 * assembly — which is the same mistake `sniffFormat`'s bedpe rule makes and the
 * reason this sniffer has to run in front of it.
 *
 * **The agreement.** `chromStart`/`chromEnd` are documented as the bounds of the
 * whole interaction, so every anchor that sits on `chrom` must sit inside them.
 * That is a statement the file is making about itself — a count agreeing with a
 * list, in §8.17's sense — and three unrelated columns do not satisfy it by
 * coincidence. It is also what keeps this sniffer off a BED12: a BED12's
 * columns 10 to 12 are a block count and two lists, which are not two spans
 * inside the feature.
 *
 * A file *named* `.interact` or `.bigInteract` skips the strand and width tests,
 * exactly as `peakFlavour` skips its shape tests for a `.narrowPeak`: a reader
 * who has named the format has already answered the question being asked.
 */
export function sniffInteract(text: string, fileName = ''): boolean {
  const named = INTERACT_NAME.test(fileName)
  let rows = 0
  let index = 0
  const length = text.length
  // Walked rather than split, for `sniffBarChart`'s reason: this runs over every
  // dropped file before anything knows what it is, and four rows settle it.
  while (index < length && rows < ENOUGH_ROWS) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const line = text.slice(index, stop)
    index = end + 1
    // The same three steps `forEachRow` takes, so the sniffer and the parser
    // agree about which lines are data.
    if (line === '' || line.charCodeAt(0) === 35) continue
    if (line.startsWith('track ') || line.startsWith('browser ')) continue
    const columns = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    if (!looksLikeInteract(columns, named)) return false
    rows++
  }
  return rows > 0
}

function looksLikeInteract(columns: string[], named: boolean): boolean {
  if (named ? columns.length < INTERACT_COLUMNS : columns.length !== INTERACT_COLUMNS) return false
  for (const at of [1, 2, 9, 10, 14, 15]) {
    if (!isInteger(columns[at])) return false
  }
  if (!isInteger(columns[4])) return false
  if (!isNumber(columns[5])) return false
  if (!named && !(isStrand(columns[12]) && isStrand(columns[17]))) return false
  return named || anchorsAgree(columns)
}

/**
 * Whether the bounding span really bounds whichever anchors share its contig.
 *
 * Only the ends on `chrom` are checked. A trans interaction's far end is on
 * another sequence entirely and has no business being inside a span measured on
 * this one — testing it would refuse exactly the rows this format exists to
 * carry.
 */
function anchorsAgree(columns: string[]): boolean {
  const chrom = columns[0]
  const from = Number(columns[1])
  const to = Number(columns[2])
  if (!(to > from)) return false
  let seen = false
  for (const [contigAt, startAt, endAt] of [
    [8, 9, 10],
    [13, 14, 15],
  ]) {
    if (columns[contigAt] !== chrom) continue
    seen = true
    if (Number(columns[startAt]) < from || Number(columns[endAt]) > to) return false
  }
  // A row naming `chrom` at neither end is not an interact row: the format's
  // first column is one of the two ends by construction.
  return seen
}

/**
 * An `interact` file, as the pairs it is.
 *
 * `score` is taken from **`value`** and not from the 0–1000 column beside it.
 * The 0–1000 is a display score — UCSC's own scaling of whatever the file is
 * really about, clamped and rounded so a shade of grey can be picked from it —
 * and this viewer has its own scales to do that with. `value` is the number the
 * pipeline computed, so `value` is what a reader ranking arcs, exporting them
 * or reading one off a tooltip wants. The display score is kept in the detail,
 * where a reader can see the two disagree if they do.
 *
 * `chromStart` and `chromEnd` are dropped, and that is not a loss: they are the
 * bounds of the two anchors, which the `PairSet` holds exactly.
 */
export function parseInteract(text: string): PairSet {
  const builder = new PairBuilder()
  let skipped = 0

  forEachRow(text, (columns) => {
    if (columns.length < INTERACT_COLUMNS) {
      skipped++
      return
    }
    const sourceStart = columns[9]
    const sourceEnd = columns[10]
    const targetStart = columns[14]
    const targetEnd = columns[15]
    if (
      !isInteger(sourceStart) ||
      !isInteger(sourceEnd) ||
      !isInteger(targetStart) ||
      !isInteger(targetEnd)
    ) {
      skipped++
      return
    }
    const sourceName = nameOr(columns[11])
    const targetName = nameOr(columns[16])
    builder.add(
      columns[8] ?? '',
      Number(sourceStart),
      Number(sourceEnd),
      columns[13] ?? '',
      Number(targetStart),
      Number(targetEnd),
      {
        score: numberOr(columns[5]),
        // The interaction's own name where it has one, and the two ends joined
        // where it does not — which is what UCSC's own `rs6796502/PCCB` naming
        // convention is spelling by hand.
        name: nameOr(columns[3]) || joined(sourceName, targetName),
        detail: detailOf(columns, sourceName, targetName),
      },
    )
  })

  if (builder.length === 0) {
    throw new Error(
      `No usable rows: all ${skipped} lines failed the eighteen-column test an interact file ` +
        'is made of. UCSC writes BED5+13 — chrom, start, end, name, score, value, exp, colour, ' +
        'then the source and target triples and their strands.',
    )
  }
  return builder.finish()
}

/** The tooltip's extra lines for one interaction. */
function detailOf(columns: string[], sourceName: string, targetName: string): string {
  const parts: string[] = []
  const experiment = nameOr(columns[6])
  if (experiment !== '') parts.push(`exp ${experiment}`)
  const display = columns[4]
  if (display !== undefined && display !== '' && display !== '0') parts.push(`score ${display}`)
  // Named ends are what makes a directional interaction readable — *this*
  // promoter, from *that* enhancer — and the arrow is the format's own
  // direction, which a `PairSet` has nowhere else to put.
  if (sourceName !== '' || targetName !== '') {
    parts.push(`${sourceName || '?'} → ${targetName || '?'}`)
  }
  const strands = `${strandOr(columns[12])}${strandOr(columns[17])}`
  if (strands !== '..') parts.push(`strands ${strands}`)
  return parts.join(DETAIL_SEP)
}

function joined(source: string, target: string): string {
  if (source === '' && target === '') return ''
  return `${source || '?'}/${target || '?'}`
}

function nameOr(value: string | undefined): string {
  return value === undefined || value === '.' ? '' : value
}

function strandOr(value: string | undefined): string {
  return value === '+' || value === '-' ? value : '.'
}

function numberOr(value: string | undefined): number {
  return value === undefined || value === '' || value === '.' ? Number.NaN : Number(value)
}

/**
 * Whether a bigBed's autoSql declares an `interact`.
 *
 * `isBarChartSchema`'s argument, for the second format to need it: a
 * `bigInteract` *is* a bigBed — same magic, same R-tree, same rows — and what
 * tells one apart is the schema it was written with, which bbi hands back from
 * a header this loader has already read. Asking the file's own declaration is a
 * tier better than guessing from column shapes, and here it is more than a
 * nicety: the whole of §8.7's "read it as the BED it holds" is *right* for
 * bigGenePred, bigPsl and bigNarrowPeak, whose first twelve columns are a BED12,
 * and *wrong* for this one, whose payload starts at column 9.
 *
 * Both names are required. `sourceChrom` alone would also match a schema that
 * merely records where a feature came from; `targetChrom` beside it is the
 * statement that a row joins two places.
 */
export function isInteractSchema(autoSql: string): boolean {
  return /\bsourceChrom\b/.test(autoSql) && /\btargetChrom\b/.test(autoSql)
}

/**
 * The line under an interact lane's label.
 *
 * Trans interactions are counted separately, because on a contact map they are
 * the ones that will be off the square a reader is looking at — a file that is
 * a thousand cis arcs and four trans ones should say so rather than let the
 * four be discovered by accident.
 */
export function interactSummary(set: PairSet): string {
  let trans = 0
  for (let i = 0; i < set.length; i++) {
    if (set.contig1[i] !== set.contig2[i]) trans++
  }
  const parts = [`${set.length.toLocaleString()} interaction${set.length === 1 ? '' : 's'}`]
  if (trans > 0) parts.push(`${trans.toLocaleString()} between sequences`)
  return parts.join(' · ')
}
