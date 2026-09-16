/**
 * UCSC's `genePred` family — `genePred`, `genePredExt` and `refFlat` — which is
 * how the gene models of half the assemblies in circulation are actually
 * distributed.
 *
 * ## Why this is not a nice-to-have
 *
 * It is measurable. The IGV store this app publishes drops **29 of IGV's 63
 * tracks** for exactly one reason, recorded in `docs/stores.md`: they are UCSC
 * `genePred` tables in a `.txt.gz`, "a format this viewer has no parser for".
 * Those 29 are not an odd corner of the catalogue — they are the *gene models*,
 * which is the first track anybody wants beside a sequence, and their absence is
 * why most of IGV's genomes open as a bare assembly. Every UCSC table download
 * (`refGene`, `ncbiRefSeq`, `knownGene`) is this format too, and so is the
 * `refFlat` that half the RNA-seq tooling in the world takes as its annotation
 * input.
 *
 * ## The layout, and the two columns in front of it
 *
 * A `genePred` is ten columns:
 *
 * ```
 * name  chrom  strand  txStart  txEnd  cdsStart  cdsEnd  exonCount  exonStarts  exonEnds
 * ```
 *
 * `genePredExt` appends five more (`score`, `name2`, two CDS status words and
 * the exon frames). `refFlat` puts a **gene symbol in front**, making eleven.
 * And any of the three, when it has come out of a UCSC MySQL table rather than
 * off the download server, carries a leading **`bin`** — the spatial index
 * column — making eleven, twelve or sixteen.
 *
 * So the same ten columns can start at column 0, 1 or 2, and the width alone
 * cannot say which: eleven columns is a `refFlat` *or* a binned `genePred`, and
 * telling them apart by asking whether the first column looks like a number is
 * the kind of guess that fails on the one gene in the file called `7SK`. What
 * this module does instead is *try* each offset and keep the one where the
 * layout actually holds — strand where a strand goes, integers where
 * coordinates go, and an exon count that agrees with the length of its own two
 * lists (§8.17's agreement test, which is the only kind of evidence in a
 * headerless text format that cannot arise by coincidence). See
 * {@link genePredOffset}.
 *
 * ## What it becomes
 *
 * A {@link FeatureSet} with exons and a coding span — the same thing
 * `parseGtf` produces, drawn by the same renderer as exons on a spine. The two
 * formats describe the same objects and differ only in how they spell them: a
 * GTF spreads a transcript over one line per exon and joins them by an
 * attribute, a genePred puts the whole transcript on one line with its exons as
 * two parallel lists. The lists are **absolute coordinates**, not BED12's
 * offsets from the feature start, which is the one arithmetic difference and the
 * one place a careless reuse of the BED path would have put every exon in the
 * wrong place.
 *
 * `name` and `id` follow the rule `FeatureSet` already states: `id` is the
 * accession the file is keyed by (`NM_001005484`) and `name` is the symbol a
 * reader looks for (`OR4F5`), which `refFlat` carries in front and
 * `genePredExt` carries as `name2`. Where the file gives no symbol the two are
 * equal, which is that field's documented way of saying so.
 */

import { FeatureBuilder } from './featureset'
import { forEachRow, isInteger } from './parse'
import { DETAIL_SEP, type FeatureSet } from './types'

/** The ten columns of a `genePred`, once whatever is in front of them is skipped. */
const GENEPRED_COLUMNS = 10

/** `genePredExt`'s `name2` — the gene symbol — measured from the same offset. */
const NAME2_AT = 11

/** `genePredExt`'s score column. */
const SCORE_AT = 10

/** How many rows {@link sniffGenePred} checks before it is satisfied. */
const ENOUGH_ROWS = 4

/** The names that say the format outright, IGV's `refGene.txt.gz` included. */
const GENEPRED_NAME = /(\.(genepred|genepredext|refflat)(\.txt)?(\.gz)?|refgene\.txt(\.gz)?)$/i

/**
 * Where the ten `genePred` columns begin in this row, or `-1`.
 *
 * Tried in order 0, 1, 2 and the *first* that holds wins, which is the right
 * bias: a plain `genePred` is the commonest of the three and a row that
 * validates at 0 cannot also validate at 1 — the column that would be `chrom`
 * at offset 1 is `strand` at offset 0, and a strand is not a contig with a
 * comma-separated exon list two places along.
 *
 * What "holds" means is the format's own agreement with itself:
 *
 * - `strand` is `+` or `-`. Not `.`: genePred has no unstranded row, and
 *   accepting one would let a BED6 whose name happened to sit where a contig
 *   goes through this door.
 * - `txStart`, `txEnd`, `cdsStart`, `cdsEnd` and `exonCount` are integers.
 * - the transcript is non-empty and the coding span sits inside it.
 * - **both exon lists split into exactly `exonCount` integers**, and the exons
 *   tile the transcript — the first starts at `txStart`, the last ends at
 *   `txEnd`. That is the test that does the work. Three numbers and two lists
 *   agreeing about a count *and* about the span they cover is a statement the
 *   file is making, and no BED, peak table or headed TSV makes it by accident.
 */
export function genePredOffset(columns: string[]): number {
  for (const offset of [0, 1, 2]) {
    if (columns.length < offset + GENEPRED_COLUMNS) continue
    if (holdsAt(columns, offset)) return offset
  }
  return -1
}

function holdsAt(columns: string[], at: number): boolean {
  const strand = columns[at + 2]
  if (strand !== '+' && strand !== '-') return false
  for (const step of [3, 4, 5, 6, 7]) {
    if (!isInteger(columns[at + step])) return false
  }
  const txStart = Number(columns[at + 3])
  const txEnd = Number(columns[at + 4])
  const cdsStart = Number(columns[at + 5])
  const cdsEnd = Number(columns[at + 6])
  const exonCount = Number(columns[at + 7])
  if (!(txEnd > txStart) || exonCount < 1) return false
  // A non-coding transcript writes `cdsStart == cdsEnd`, conventionally at
  // `txEnd`, so the span may be empty — but it may not be outside the gene.
  if (cdsStart < txStart || cdsEnd > txEnd || cdsEnd < cdsStart) return false
  const starts = listOf(columns[at + 8])
  const ends = listOf(columns[at + 9])
  if (starts === null || ends === null) return false
  if (starts.length !== exonCount || ends.length !== exonCount) return false
  if (starts[0] !== txStart || ends[exonCount - 1] !== txEnd) return false
  for (let i = 0; i < exonCount; i++) {
    if (ends[i] < starts[i]) return false
    if (i > 0 && starts[i] < ends[i - 1]) return false
  }
  return true
}

/** A comma-separated list of whole numbers, or `null` when it is not one. */
function listOf(value: string | undefined): number[] | null {
  if (value === undefined || value === '') return null
  const parts = value.split(',').filter((part) => part !== '')
  if (parts.length === 0) return null
  const out: number[] = []
  for (const part of parts) {
    if (!isInteger(part)) return null
    const number = Number(part)
    if (number < 0) return null
    out.push(number)
  }
  return out
}

/**
 * Whether these lines are a `genePred`, a `genePredExt` or a `refFlat`.
 *
 * One question — does {@link genePredOffset} find an offset — asked of the first
 * few rows, and they must agree on the answer. Rows that disagree are a file
 * whose shape changes part-way through, which is not this format however many
 * of its lines look like it.
 *
 * Asked before `sniffFormat` and after the signal and interaction sniffers, in
 * the one place it can go: `sniffFormat` sends a ten-column genePred to `'gtf'`
 * (its columns 4 and 5 are integers and it is at least eight wide) and an
 * eleven-column `refFlat` to `'bed'`, where every row fails the contig/start/end
 * test and the whole file is refused with a message about BED. Neither is
 * recoverable further down.
 */
export function sniffGenePred(text: string, fileName = ''): boolean {
  const named = GENEPRED_NAME.test(fileName)
  let rows = 0
  let index = 0
  const length = text.length
  let offset = -1
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
    const at = genePredOffset(columns)
    if (at < 0) return false
    // One layout for the file. A row that validates at a different offset from
    // the row above it is a coincidence rather than a format — except on a
    // named file, where the reader has already said what this is.
    if (offset >= 0 && at !== offset && !named) return false
    offset = at
    rows++
  }
  return rows > 0
}

/**
 * A `genePred`, `genePredExt` or `refFlat` file, as the transcripts it holds.
 *
 * The offset is decided **per row** rather than once for the file, which sounds
 * lax and is the opposite: {@link genePredOffset} is a test the row either
 * passes or does not, so a row read at an offset is a row whose exon lists
 * agreed with its own exon count at that offset. What per-row buys is the
 * concatenated file — `cat refGene.txt ncbiRefSeq.txt`, which people make — and
 * the UCSC dump whose `bin` column is present on some tables and not others.
 * A row that validates nowhere is skipped and counted, never guessed at.
 */
export function parseGenePred(text: string): FeatureSet {
  const builder = new FeatureBuilder()
  let skipped = 0
  let coding = 0

  forEachRow(text, (columns) => {
    const at = genePredOffset(columns)
    if (at < 0) {
      skipped++
      return
    }
    const txStart = Number(columns[at + 3])
    const txEnd = Number(columns[at + 4])
    const cdsStart = Number(columns[at + 5])
    const cdsEnd = Number(columns[at + 6])
    const starts = listOf(columns[at + 8]) ?? []
    const ends = listOf(columns[at + 9]) ?? []

    // Absolute already — this is the one line that would have been wrong had
    // the BED12 path been reused, whose two lists are a size and an offset from
    // the feature's own start.
    const exons: number[] = []
    for (let i = 0; i < starts.length; i++) exons.push(starts[i], ends[i])

    const accession = nameOr(columns[at])
    const symbol = symbolOf(columns, at)
    if (cdsEnd > cdsStart) coding++

    builder.add(columns[at + 1] ?? '', txStart, txEnd, {
      strand: columns[at + 2] === '+' ? 1 : -1,
      score: at + SCORE_AT < columns.length && isInteger(columns[at + SCORE_AT])
        ? Number(columns[at + SCORE_AT])
        : Number.NaN,
      // The symbol where the file gives one, the accession where it does not —
      // and `id` is the accession either way, so `name === id` says "no symbol"
      // exactly as `FeatureSet` documents.
      name: symbol === '' ? accession : symbol,
      id: accession,
      detail: detailOf(columns, at, symbol, accession, starts.length),
      ...(exons.length === 0 ? {} : { exons }),
      ...(cdsEnd > cdsStart ? { cds: [cdsStart, cdsEnd] as [number, number] } : {}),
    })
  })

  if (builder.length === 0) {
    throw new Error(
      `No usable rows: all ${skipped} lines failed the genePred test — a name, a contig, a strand, ` +
        'four coordinates, an exon count and two comma-separated lists of that length.',
    )
  }
  const set = builder.finish()
  codingOf.set(set, coding)
  return set
}

/**
 * The symbol, from wherever this row keeps one.
 *
 * Two places and they are mutually exclusive in practice: `refFlat` puts it in
 * the column *before* the ten (so at `offset - 1`, and only when that column is
 * not the `bin` index), and `genePredExt` puts it *after* them as `name2`.
 * A binned `genePred` has neither, and its leading column is a number this must
 * not mistake for a gene called `585`.
 */
function symbolOf(columns: string[], at: number): string {
  const trailing = columns[at + NAME2_AT]
  if (trailing !== undefined && trailing !== '' && trailing !== '.') return trailing
  if (at === 0) return ''
  const leading = columns[at - 1]
  if (leading === undefined || leading === '' || leading === '.') return ''
  // At offset 1 the leading column is a `bin` or a symbol; at offset 2 it is a
  // symbol and the one before it is the bin. A bin is always an integer and a
  // gene symbol essentially never is — and where it is, the cost is a row whose
  // display name falls back to its accession, which is the safe direction.
  return isInteger(leading) ? '' : leading
}

/** The tooltip's extra lines for one transcript. */
function detailOf(
  columns: string[],
  at: number,
  symbol: string,
  accession: string,
  exons: number,
): string {
  const parts = [`${exons} exon${exons === 1 ? '' : 's'}`]
  if (symbol !== '' && symbol !== accession) parts.push(`gene ${symbol}`)
  const status = columns[at + 12]
  const statusEnd = columns[at + 13]
  // `cmpl`/`incmpl`/`none` — whether the CDS is complete at each end, which is
  // the one thing genePredExt carries that a GTF does not and is worth knowing
  // before anybody believes a start codon.
  if (status !== undefined && /^(cmpl|incmpl|none|unk)$/.test(status)) {
    parts.push(`cds ${status}/${statusEnd ?? '?'}`)
  }
  return parts.join(DETAIL_SEP)
}

function nameOr(value: string | undefined): string {
  return value === undefined || value === '.' ? '' : value
}

/**
 * How many of a file's transcripts have a coding span.
 *
 * A `WeakMap` beside the set, for `annotations/longrange.ts`'s reason: it is one
 * number that only the summary reads, and a `FeatureSet` is a transfer budget
 * of typed arrays rather than a place to put facts about the read.
 */
const codingOf = new WeakMap<FeatureSet, number>()

/**
 * Whether a bigBed's autoSql declares a `bigGenePred`.
 *
 * Unlike the three schemas `annotations/interact.ts` and
 * `annotations/bedmethyl.ts` ask about, this one is **not** a correctness fix:
 * a `bigGenePred`'s first twelve columns really are a BED12, so §8.7's "read it
 * as the BED it holds" already draws its exons and its coding span in the right
 * places. What knowing the schema buys is the *kind*: a gene model rather than
 * a peak set, which is what decides the glyph, the search box's behaviour and
 * the line under the lane's label. The rows still go through `parseBed`,
 * because they are a BED12 and there is no second parser to keep in step.
 *
 * `cdsStartStat` and `exonFrames` are `bigGenePred`'s own, and neither appears
 * in the BED12-shaped schemas it sits beside — `bigPsl` and `bigChain` carry
 * alignment columns, not CDS status words.
 */
export function isGenePredSchema(autoSql: string): boolean {
  return /\bcdsStartStat\b/.test(autoSql) && /\bexonFrames\b/.test(autoSql)
}

/**
 * The line under a genePred lane's label.
 *
 * Transcripts and exons, as a GTF reports — the two files describe the same
 * objects, so a reader comparing a `refGene.txt.gz` against the GENCODE GTF
 * beside it should be reading the same two numbers — and then how many of them
 * code, because a `refFlat` of a transcriptome is mostly non-coding and a lane
 * drawn with no thick spans in it is otherwise a puzzle.
 */
export function genePredSummary(set: FeatureSet): string {
  const exons = set.exonStart.length
  const parts = [
    `${set.length.toLocaleString()} transcript${set.length === 1 ? '' : 's'}`,
    `${exons.toLocaleString()} exons`,
  ]
  const coding = codingOf.get(set)
  if (coding !== undefined && coding < set.length) {
    parts.push(`${coding.toLocaleString()} coding`)
  }
  return parts.join(' · ')
}
