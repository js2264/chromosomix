/**
 * The text formats, parsed.
 *
 * Everything here runs in the annotations worker, never on the main thread: the
 * demo GTF is 9.5 MB over 41,566 lines, and a tenth of a second spent parsing it
 * is a tenth of a second of a frozen page.
 *
 * **Detection is by content, with the file name as a tiebreak** (spec §8.3). The
 * loop calls this app was built against are a `.tsv` with a header row, not a
 * headerless `.bedpe`; refusing them for their suffix would be pedantry, and
 * trusting the suffix over the columns is how a mislabelled file becomes a
 * silent misdrawing. So the columns decide, and the suffix only settles the two
 * cases the columns genuinely cannot — narrowPeak against BED9, broadPeak
 * against BED12.
 */

import { FeatureBuilder, PairBuilder } from './featureset'
import { DETAIL_SEP, type FeatureSet, type PairSet } from './types'

/** What the sniffer concluded a file is. */
export type TextFormat = 'gtf' | 'bed' | 'bedpe'

// ---------------------------------------------------------------------------
// Bytes to lines
// ---------------------------------------------------------------------------

/**
 * Decode a file to text, transparently un-gzipping one that is.
 *
 * Annotation files are shipped gzipped as often as not, and the two magic bytes
 * are a cheaper and more reliable test than the `.gz` suffix — a file saved from
 * a browser download often loses the suffix and keeps the compression.
 * `DecompressionStream` is the platform's own inflate, so this costs no bundle.
 */
export async function decodeAnnotationText(bytes: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await decodeAnnotationBytes(bytes))
}

/**
 * The same un-gzipping, stopping one step short of a string.
 *
 * A FASTA is read this way. Residues are ASCII by definition, so decoding one to
 * UTF-16 doubles a hundred megabytes in order to walk it once and throw it away
 * — and every byte of it is then re-encoded into the `Uint8Array` the sequence
 * store keeps. The text formats still go through {@link decodeAnnotationText},
 * because a GTF attribute really can be UTF-8 and its columns are strings.
 */
export async function decodeAnnotationBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!gzipped) return bytes
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This file is gzipped and this browser has no DecompressionStream to un-gzip it with. ' +
        'Decompress it and drop the plain text file.',
    )
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Call `visit` once per data line, split into columns.
 *
 * Comments (`#`), and the `track`/`browser` lines a UCSC-flavoured file carries,
 * are skipped. Tabs are the separator wherever the line has one; a file that
 * uses runs of spaces — which BED permits and some tools emit — falls back to
 * whitespace, decided per line so one stray space-separated row cannot
 * mis-split the rest of the file.
 *
 * Written as an index walk rather than `text.split('\n').map(...)`, because the
 * intermediate array for a 41,566-line file is 41,566 strings the parser reads
 * once and then drops.
 */
export function forEachRow(text: string, visit: (columns: string[], line: number) => void): void {
  let index = 0
  let line = 0
  const length = text.length
  while (index < length) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const raw = text.slice(index, stop)
    index = end + 1
    line++
    if (raw === '' || raw.charCodeAt(0) === 35) continue // '#'
    if (raw.startsWith('track ') || raw.startsWith('browser ')) continue
    visit(raw.includes('\t') ? raw.split('\t') : raw.trim().split(/\s+/), line)
  }
}

/** The first data row of a file, for the sniffer. `null` when there is none. */
function firstRow(text: string): string[] | null {
  let found: string[] | null = null
  forEachRow(text, (columns) => {
    found ??= columns
  })
  return found
}

export function isInteger(value: string | undefined): boolean {
  return value !== undefined && /^[+-]?\d+$/.test(value)
}

function isNumber(value: string | undefined): boolean {
  return value !== undefined && value !== '' && Number.isFinite(Number(value))
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

/**
 * What this file is, from its first data row.
 *
 * The three shapes are told apart by *where the integers are*, which is a
 * property of the format rather than of the naming convention:
 *
 * - BED-like: columns 2 and 3 are integers (`I  66  305  …`).
 * - GTF/GFF: columns 2 and 3 are words and 4 and 5 are integers
 *   (`IV  sgd  gene  8683  9756  …`).
 * - BEDPE-like: columns 2 and 3 are integers *and* column 4 is not, because it
 *   is a second contig name (`I  1000  2000  I  19000  20000  …`).
 *
 * A header row is recognised first and does not confuse any of this: a file
 * whose first row has a non-integer where an integer belongs is treated as
 * headed, and the header names are what decide.
 */
export function sniffFormat(text: string, fileName = ''): TextFormat {
  const header = readHeader(text)
  if (header !== null) {
    const names = header.map((name) => name.trim().toLowerCase())
    if (names.includes('chrom2') || names.includes('chr2') || names.includes('start2')) return 'bedpe'
    return 'bed'
  }
  const row = firstRow(text)
  if (row === null) {
    // Nothing to read: fall back to the name, which at least says what was meant.
    return /\.(gtf|gff3?)(\.gz)?$/i.test(fileName)
      ? 'gtf'
      : /\.(bedpe|pairs)(\.gz)?$/i.test(fileName)
        ? 'bedpe'
        : 'bed'
  }
  if (isInteger(row[1]) && isInteger(row[2])) {
    if (row.length >= 6 && !isInteger(row[3]) && isInteger(row[4]) && isInteger(row[5])) return 'bedpe'
    return 'bed'
  }
  if (row.length >= 8 && isInteger(row[3]) && isInteger(row[4])) return 'gtf'
  return 'bed'
}

/**
 * The header row's column names, or `null` for a headerless file.
 *
 * A header is the row that has a *word* where every data row has a number. That
 * is the whole test, and it is enough: no BED-family or GTF format has a
 * non-numeric second column, so a first row that does is not data.
 */
export function readHeader(text: string): string[] | null {
  const row = firstRow(text)
  if (row === null || row.length < 3) return null
  const looksNumeric = isInteger(row[1]) || isInteger(row[3])
  if (looksNumeric) return null
  return row
}

/** Index of the first header name that matches one of `candidates`, or `-1`. */
function columnOf(header: string[], candidates: string[]): number {
  const lower = header.map((name) => name.trim().toLowerCase())
  for (const candidate of candidates) {
    const at = lower.indexOf(candidate)
    if (at >= 0) return at
  }
  return -1
}

// ---------------------------------------------------------------------------
// BED family
// ---------------------------------------------------------------------------

/**
 * BED 3/4/5/6/9/12, narrowPeak, broadPeak and gappedPeak, plus any headed TSV
 * whose first three columns are a contig and a half-open span.
 *
 * `score` is what a colour or a height would be driven by, and the right column
 * for it differs: plain BED's column 5 is the 0–1000 display score, while
 * MACS's narrowPeak and broadPeak carry the number anyone actually wants —
 * `signalValue` — in column 7. So the peak formats take column 7 and say so in
 * the tooltip; everything else takes column 5.
 */
export function parseBed(text: string, fileName = ''): FeatureSet {
  const builder = new FeatureBuilder()
  const header = readHeader(text)
  const peak = peakFlavour(text, fileName)
  let skipped = 0
  let first = true

  forEachRow(text, (columns) => {
    if (first && header !== null) {
      first = false
      return
    }
    first = false
    if (columns.length < 3 || !isInteger(columns[1]) || !isInteger(columns[2])) {
      skipped++
      return
    }
    const contig = columns[0]
    const start = Number(columns[1])
    const end = Number(columns[2])
    const name = columns[3] !== undefined && columns[3] !== '.' ? columns[3] : ''
    const strand = strandOf(columns[5])
    const score = peak === null ? numberOr(columns[4]) : numberOr(columns[6])

    // BED12's blocks are the same sub-structure a GTF transcript has, expressed
    // as two comma-separated lists relative to the feature's own start.
    const exons = blocksOf(columns, start)
    const cds = thickOf(columns, peak !== null)

    builder.add(contig, start, end, {
      strand,
      score,
      name,
      detail: bedDetail(columns, peak),
      ...(exons === null ? {} : { exons }),
      ...(cds === null ? {} : { cds }),
    })
  })

  if (builder.length === 0 && skipped > 0) {
    throw new Error(
      `No usable rows: all ${skipped} lines failed the "contig, start, end" test that every ` +
        'BED-like format begins with.',
    )
  }
  return builder.finish()
}

/**
 * `narrow`, `broad`, or `null` for a plain BED.
 *
 * The **column count** is what settles most of this, because these formats are
 * fixed-width where BED is not: narrowPeak is exactly 10 columns, broadPeak
 * exactly 9, and BED12 exactly 12. Only nine columns is genuinely ambiguous —
 * BED9 and broadPeak agree on the count — and there the ninth column decides:
 * BED9's is an RGB triple, broadPeak's is a -log10 q-value. A comma proves the
 * first; a decimal point is what is left to distinguish the second, since BED9's
 * thickStart, thickEnd and `0`-for-black are all integers.
 *
 * An earlier version tested only "are columns 7 to 9 numeric", which is true of
 * a BED12 whose itemRgb is `0` — so `thickStart` was read as a signal value and
 * the coding span vanished from every gene in the file.
 */
function peakFlavour(text: string, fileName: string): 'narrow' | 'broad' | null {
  if (/\.narrowpeak(\.gz)?$/i.test(fileName)) return 'narrow'
  if (/\.(broad|gapped)peak(\.gz)?$/i.test(fileName)) return 'broad'
  const row = firstRow(text)
  if (row === null) return null
  if (row.length === 10 && isNumber(row[6]) && isNumber(row[7]) && isNumber(row[8])) {
    return isInteger(row[9]) ? 'narrow' : null
  }
  if (row.length !== 9) return null
  if (row[8] !== undefined && row[8].includes(',')) return null
  const fractional = [row[6], row[7], row[8]].some(
    (value) => value !== undefined && isNumber(value) && !isInteger(value),
  )
  return fractional ? 'broad' : null
}

function strandOf(value: string | undefined): number {
  return value === '+' ? 1 : value === '-' ? -1 : 0
}

function numberOr(value: string | undefined): number {
  return value === undefined || value === '' || value === '.' ? Number.NaN : Number(value)
}

/** BED12 blocks as flattened absolute `[start, end, …]`, or `null`. */
function blocksOf(columns: string[], start: number): number[] | null {
  if (columns.length < 12) return null
  const sizes = (columns[10] ?? '').split(',').filter((part) => part !== '')
  const offsets = (columns[11] ?? '').split(',').filter((part) => part !== '')
  if (sizes.length === 0 || sizes.length !== offsets.length) return null
  const out: number[] = []
  for (let i = 0; i < sizes.length; i++) {
    const from = start + Number(offsets[i])
    out.push(from, from + Number(sizes[i]))
  }
  return out
}

/** BED's thick span, which is the coding region. Absent on the peak formats. */
function thickOf(columns: string[], isPeak: boolean): [number, number] | null {
  if (isPeak || columns.length < 8) return null
  if (!isInteger(columns[6]) || !isInteger(columns[7])) return null
  const from = Number(columns[6])
  const to = Number(columns[7])
  return to > from ? [from, to] : null
}

/** The tooltip's extra lines for one BED row. */
function bedDetail(columns: string[], peak: 'narrow' | 'broad' | null): string {
  if (peak === null) {
    const score = columns[4]
    return score === undefined || score === '' || score === '.' ? '' : `score ${score}`
  }
  const parts = [
    `signal ${columns[6] ?? '—'}`,
    `-log10 p ${columns[7] ?? '—'}`,
    `-log10 q ${columns[8] ?? '—'}`,
  ]
  if (peak === 'narrow' && columns[9] !== undefined && columns[9] !== '-1') {
    parts.push(`summit +${columns[9]}`)
  }
  return parts.join(DETAIL_SEP)
}

// ---------------------------------------------------------------------------
// GTF and GFF
// ---------------------------------------------------------------------------

/** One transcript under construction, keyed by its id. */
interface Draft {
  contig: string
  start: number
  end: number
  strand: number
  geneId: string
  geneName: string
  biotype: string
  source: string
  exons: number[]
  cdsFrom: number
  cdsTo: number
}

/**
 * A gene model: one drawn feature per **transcript**, with its exons.
 *
 * Not per gene, and not per line. A GTF line is a fragment — this file has 7,419
 * exon lines and 7,071 transcript lines describing the same 7,071 things — and
 * drawing one glyph per line would stack five overlapping boxes on every gene.
 * Per transcript is what a genome browser draws and what the exon structure
 * belongs to.
 *
 * A transcript is assembled from whichever lines mention it, so the three
 * layouts in the wild all work: a file with `transcript` lines, a file with only
 * `exon` lines, and a file with neither (which falls back to `gene` lines drawn
 * as plain boxes).
 *
 * **Names and ids are two different facts and both are kept.** A gene has a
 * symbol a reader recognises (`LipL1`) and an accession a database does
 * (`PF3D7_1314600`), the file writes them under whichever pair of attribute
 * names its authors preferred, and which of the two is on screen should not
 * depend on that. So both are resolved here — see {@link geneIdOf} and
 * {@link GENE_NAME_KEYS} — the symbol is drawn and the accession is carried in
 * `id`, where the search box and the feature card both find it.
 */
export function parseGtf(text: string): FeatureSet {
  const drafts = new Map<string, Draft>()
  const geneNames = new Map<string, string>()
  const geneBiotypes = new Map<string, string>()
  const genes: Draft[] = []
  const gff3 = looksLikeGff3(text)

  forEachRow(text, (columns) => {
    if (columns.length < 8 || !isInteger(columns[3]) || !isInteger(columns[4])) return
    const contig = columns[0]
    const source = columns[1] ?? ''
    const feature = (columns[2] ?? '').toLowerCase()
    // GTF and GFF are 1-based and inclusive on both ends; everything downstream
    // of this line is 0-based half-open, as BED is.
    const start = Number(columns[3]) - 1
    const end = Number(columns[4])
    const strand = strandOf(columns[6])
    const attributes = parseAttributes(columns[8] ?? '', gff3)

    const isGene = isGeneRow(feature)
    const isTranscript = !isGene && isTranscriptRow(feature)
    const geneId = geneIdOf(attributes, gff3, isGene, isTranscript)
    const geneName = firstOf(attributes, GENE_NAME_KEYS)
    const biotype = attributes.get('gene_biotype') ?? attributes.get('gene_type') ?? ''

    if (isGene) {
      // Registered under *every* id a child could name it by — GTF's `gene_id`
      // and GFF3's own `ID` — because the two conventions are mixed inside one
      // file more often than not: the PlasmoDB gene line carries `ID`, its mRNA
      // points at that through `Parent`, and its exons point at the same string
      // through `gene_id`. Keying on one of them loses the other's children.
      for (const id of [geneId, attributes.get('id') ?? '']) {
        if (id === '') continue
        if (geneName !== '') geneNames.set(id, geneName)
        if (biotype !== '') geneBiotypes.set(id, biotype)
      }
      genes.push({
        contig,
        start,
        end,
        strand,
        geneId,
        geneName,
        biotype,
        source,
        exons: [],
        cdsFrom: -1,
        cdsTo: -1,
      })
      return
    }

    const key = transcriptKey(attributes, gff3, isTranscript)
    if (key === null) return
    let draft = drafts.get(key)
    if (draft === undefined) {
      draft = {
        contig,
        start,
        end,
        strand,
        geneId,
        geneName,
        biotype,
        source,
        exons: [],
        cdsFrom: -1,
        cdsTo: -1,
      }
      drafts.set(key, draft)
    }
    // A transcript's own line gives the span; an exon-only file has to grow it.
    if (isTranscript) {
      draft.start = start
      draft.end = end
    } else {
      if (start < draft.start) draft.start = start
      if (end > draft.end) draft.end = end
    }
    if (draft.geneId === '') draft.geneId = geneId
    if (draft.geneName === '') draft.geneName = geneName
    if (draft.biotype === '') draft.biotype = biotype
    if (feature === 'exon') draft.exons.push(start, end)
    if (feature === 'cds') {
      if (draft.cdsFrom < 0 || start < draft.cdsFrom) draft.cdsFrom = start
      if (end > draft.cdsTo) draft.cdsTo = end
    }
  })

  // Nothing with sub-structure: a bare gene list, or an annotation of features
  // this parser has no hierarchy for. Draw what is there.
  const rows = drafts.size > 0 ? [...drafts.values()] : genes
  if (rows.length === 0) {
    throw new Error(
      'No genes, transcripts or exons found. A GTF or GFF needs a feature column ' +
        '(column 3) naming at least one of them.',
    )
  }

  const builder = new FeatureBuilder()
  for (const draft of rows) {
    // The gene's own line wins over the transcript's. Where a file names both —
    // `Name=LipL1` on the gene, `Name=LipL1-1` on its mRNA — the gene's is the
    // one a reader searched for, and the transcript's suffix is a fact the
    // feature card can hold rather than one the map has to spell out.
    const fromGene = draft.geneId === '' ? '' : (geneNames.get(draft.geneId) ?? '')
    const geneName = fromGene !== '' ? fromGene : draft.geneName
    // `name === id` is how a nameless gene is spelled; see `FeatureSet.id`.
    const name = geneName !== '' ? geneName : draft.geneId
    const biotype = draft.biotype !== '' ? draft.biotype : (geneBiotypes.get(draft.geneId) ?? '')
    const detail = [
      biotype,
      draft.source === '' ? '' : `source ${draft.source}`,
      draft.exons.length > 0 ? `${draft.exons.length >> 1} exons` : '',
    ]
      .filter((part) => part !== '')
      .join(DETAIL_SEP)
    builder.add(draft.contig, draft.start, draft.end, {
      strand: draft.strand,
      name,
      id: draft.geneId,
      detail,
      ...(draft.exons.length > 0 ? { exons: draft.exons } : {}),
      ...(draft.cdsFrom >= 0 && draft.cdsTo > draft.cdsFrom
        ? { cds: [draft.cdsFrom, draft.cdsTo] as [number, number] }
        : {}),
    })
  }
  return builder.finish()
}

/**
 * Where a gene's **symbol** may be written, in order of preference.
 *
 * `gene_name` is GTF's and the one to believe when it is there. `Name` is
 * GFF3's, and it is last because a transcript line carries one too and it means
 * the transcript — which is exactly why the gene's own line is consulted first
 * when the row is resolved.
 */
const GENE_NAME_KEYS = ['gene_name', 'genename', 'gene_symbol', 'symbol', 'name']

/** …and its **accession**. `ID` is not here: see {@link geneIdOf} for why. */
const GENE_ID_KEYS = ['gene_id', 'geneid']

/** The first of these attributes the line carries, or `''`. */
function firstOf(attributes: Map<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = attributes.get(key)
    if (value !== undefined && value !== '') return value
  }
  return ''
}

/**
 * Which gene this line is about.
 *
 * `gene_id` first, because a line that says so is not guessing. After that the
 * answer depends on what kind of line this is, and that is the whole reason
 * `ID` is not simply added to {@link GENE_ID_KEYS}: on a gene line `ID` *is* the
 * gene, and on a transcript line it is the transcript, so a rule that read it
 * everywhere would file every mRNA under a gene of its own and no two
 * transcripts of one gene would ever meet.
 *
 * A GFF3 transcript points at its gene through `Parent`, which is the same
 * string from the other end of the relationship. Its exons point at the
 * transcript instead, so they are left to contribute whatever `gene_id` they
 * carry (VEuPathDB writes one) and nothing otherwise.
 */
function geneIdOf(
  attributes: Map<string, string>,
  gff3: boolean,
  isGene: boolean,
  isTranscript: boolean,
): string {
  const explicit = firstOf(attributes, GENE_ID_KEYS)
  if (explicit !== '') return explicit
  if (isGene) return attributes.get('id') ?? ''
  if (!gff3 || !isTranscript) return ''
  const parent = attributes.get('parent') ?? ''
  return parent === '' ? '' : parent.split(',')[0]
}

/**
 * Whether this line describes a **gene**.
 *
 * `gene` is what GTF writes, and what GFF3 writes about half the time. The
 * Sequence Ontology's more specific terms are the other half —
 * `protein_coding_gene`, `ncRNA_gene`, `pseudogene`,
 * `transposable_element_gene` — and every one of them ends in the word. Matching
 * only the bare term read a PlasmoDB GFF as a file with no genes in it at all,
 * so every symbol in it was skipped and 6,193 transcripts were drawn wearing
 * their systematic ids.
 */
function isGeneRow(feature: string): boolean {
  return feature.endsWith('gene')
}

/**
 * Whether this line describes a **transcript** — the thing a glyph is drawn for.
 *
 * `transcript` and `mRNA` were the two this knew. Everything a genome writes its
 * non-coding genes with is one in exactly the same sense — `ncRNA`, `tRNA`,
 * `rRNA`, `snoRNA`, `lnc_RNA` — and so is a `pseudogenic_transcript`. Left out,
 * each of those was read as somebody's *child* and keyed by its `Parent`, which
 * is the gene, while its own exons were keyed by their `Parent`, which is it:
 * two drafts for one transcript, one of them a nameless box with no exons in it.
 */
function isTranscriptRow(feature: string): boolean {
  return feature === 'transcript' || feature.endsWith('_transcript') || feature.endsWith('rna')
}

/**
 * Which id groups a line into a transcript.
 *
 * GTF says `transcript_id`. GFF3 says the child's `Parent` and the transcript's
 * own `ID`, which are the same string seen from the two ends of the
 * relationship. A line with neither is one this parser cannot place, and it is
 * skipped rather than guessed at.
 */
function transcriptKey(
  attributes: Map<string, string>,
  gff3: boolean,
  isTranscript: boolean,
): string | null {
  const explicit = attributes.get('transcript_id')
  if (explicit !== undefined && explicit !== '') return explicit
  if (!gff3) return null
  if (isTranscript) return attributes.get('id') ?? null
  const parent = attributes.get('parent')
  return parent === undefined || parent === '' ? null : parent.split(',')[0]
}

/** GFF3 writes `key=value`; GTF writes `key "value"`. One `=` before a `"` decides. */
function looksLikeGff3(text: string): boolean {
  const row = firstRow(text)
  const attributes = row?.[8]
  if (attributes === undefined) return false
  const equals = attributes.indexOf('=')
  const quote = attributes.indexOf('"')
  return equals >= 0 && (quote < 0 || equals < quote)
}

/**
 * The attribute column, as a lower-cased map.
 *
 * Lower-cased keys because the two conventions disagree on case for the same
 * concept (`ID` against `gene_id`), and because a lookup that has to try three
 * spellings of one name is a bug waiting for the fourth.
 */
function parseAttributes(column: string, gff3: boolean): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of column.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    if (gff3) {
      const at = trimmed.indexOf('=')
      if (at < 0) continue
      out.set(trimmed.slice(0, at).toLowerCase(), decodeGff(trimmed.slice(at + 1)))
      continue
    }
    const at = trimmed.indexOf(' ')
    if (at < 0) continue
    const value = trimmed.slice(at + 1).trim()
    out.set(
      trimmed.slice(0, at).toLowerCase(),
      value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value,
    )
  }
  return out
}

/** GFF3 percent-encodes `;`, `=` and `,` inside values. */
function decodeGff(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// BEDPE
// ---------------------------------------------------------------------------

/**
 * Paired intervals: a headerless BEDPE, or a headed TSV naming its columns.
 *
 * Both are common and neither is more correct. The headed form is what the loop
 * callers this app was built against emit — `chrom1 start1 end1 chrom2 start2
 * end2 bin1 bin2 kernel_id … score pvalue qvalue` — and its extra columns are
 * kept for the tooltip rather than discarded, because "which kernel called this
 * loop, and at what q-value" is exactly what a reader asks of a loop.
 */
export function parseBedpe(text: string): PairSet {
  const header = readHeader(text)
  const builder = new PairBuilder()

  const at =
    header === null
      ? { c1: 0, s1: 1, e1: 2, c2: 3, s2: 4, e2: 5, name: 6, score: 7 }
      : {
          c1: columnOf(header, ['chrom1', 'chr1', 'chrom_1']),
          s1: columnOf(header, ['start1', 'x1', 'start_1']),
          e1: columnOf(header, ['end1', 'x2', 'end_1']),
          c2: columnOf(header, ['chrom2', 'chr2', 'chrom_2']),
          s2: columnOf(header, ['start2', 'y1', 'start_2']),
          e2: columnOf(header, ['end2', 'y2', 'end_2']),
          name: columnOf(header, ['name', 'id', 'label']),
          score: columnOf(header, ['score', 'value', 'obs/exp', 'count']),
        }

  if (at.c1 < 0 || at.s1 < 0 || at.e1 < 0 || at.c2 < 0 || at.s2 < 0 || at.e2 < 0) {
    throw new Error(
      'This looks like a paired file but its header does not name all six coordinate ' +
        'columns. Expected chrom1, start1, end1, chrom2, start2 and end2.',
    )
  }

  // The columns worth quoting are whatever is left over, and which those are is
  // a property of the file rather than of the format — so they are discovered
  // rather than listed. Coordinates are already on screen; a p-value is not.
  const extras =
    header === null
      ? []
      : header
          .map((name, index) => ({ name: name.trim(), index }))
          .filter(
            (column) =>
              column.name !== '' &&
              ![at.c1, at.s1, at.e1, at.c2, at.s2, at.e2, at.name].includes(column.index),
          )

  let first = true
  let skipped = 0
  forEachRow(text, (columns) => {
    if (first && header !== null) {
      first = false
      return
    }
    first = false
    if (!isInteger(columns[at.s1]) || !isInteger(columns[at.e1])) {
      skipped++
      return
    }
    if (!isInteger(columns[at.s2]) || !isInteger(columns[at.e2])) {
      skipped++
      return
    }
    const detail = extras
      .map((column) => {
        const value = columns[column.index]
        return value === undefined || value === '' ? '' : `${column.name} ${value}`
      })
      .filter((part) => part !== '')
      .join(' · ')
    builder.add(
      columns[at.c1],
      Number(columns[at.s1]),
      Number(columns[at.e1]),
      columns[at.c2],
      Number(columns[at.s2]),
      Number(columns[at.e2]),
      {
        score: at.score < 0 ? Number.NaN : numberOr(columns[at.score]),
        name: at.name < 0 ? '' : (columns[at.name] ?? ''),
        detail,
      },
    )
  })

  if (builder.length === 0) {
    throw new Error(
      skipped > 0
        ? `No usable rows: all ${skipped} lines were missing one of the six coordinates.`
        : 'No rows found.',
    )
  }
  return builder.finish()
}
