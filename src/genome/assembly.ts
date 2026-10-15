/**
 * A genome, with no contact map behind it.
 *
 * Everything else in this app starts from a matrix: the axes are bins, the
 * coordinate model is arithmetic over `chrom_offset`, and a track is drawn
 * against the block that happens to be on screen. None of that needs to be true
 * to *browse* a genome, and requiring it meant a bigWig could not be looked at
 * without first finding a cooler of the same assembly to hang it on.
 *
 * So this is the other starting point: a list of sequences and their lengths,
 * from whatever named them — a `chrom.sizes`, a bigWig's header, or, failing
 * both, the largest coordinate a feature file mentions. From it comes one
 * {@link LocusAxis} over the whole genome laid end to end, which is the same
 * object the lanes beside a heatmap are already drawn through (§8.4). One
 * coordinate model, two entry points; the drawing code does not know which it
 * was reached by.
 */

import { LocusAxis, type LocusSegment } from '../render/locus'
import { parseRegionString } from '../metacooler/range'
import { NameIndex } from './naming'

/** One sequence, as every source of an assembly reports one. */
export interface Contig {
  name: string
  length: number
}

/** Where an assembly's lengths came from, which decides how far to trust them. */
export type AssemblyOrigin =
  | 'sizes'
  | 'bigwig'
  | 'bigbed'
  | 'fasta'
  | 'features'
  | 'cooler'
  // A BAM's `@SQ` table, which carries a length per reference and is therefore
  // exact — the same standing as a bigWig's header, and not the lower bound a
  // feature file gives (§8.13).
  | 'bam'
  // A VCF's `##contig=<ID=…,length=…>` block, which is a `chrom.sizes` written
  // inside the file: **declared**, not inferred, so it stands where a BAM's
  // `@SQ` table stands (§8.14). Its own member for the reason `bam` is one —
  // {@link lengthsAreExact} reads this and nothing else, so a VCF that reported
  // `features` would have the browser tell a reader its chromosomes end at
  // their last variant when the file says where they really end. A VCF that
  // declares no contigs is `features`, correctly, and gets the lower bound.
  | 'vcf'
  // A `.2bit`'s index, which carries every sequence's `dnaSize` in the file's
  // first kilobyte (§8.21). Exact, and exact *cheaply* — this is the one
  // sequence format whose assembly is known without reading a base, which is
  // what makes an 800 MB hg38 open as fast as a `chrom.sizes`. Its own member
  // rather than `fasta` because the Genome card says where lengths came from,
  // and "the sequences themselves" would be a lie about a read that never
  // touched them.
  | 'twobit'
  // A cytoBand whose bands tile every sequence from its first base (§8.22):
  // the last band ends where the chromosome does, which is how UCSC writes
  // every one and what makes the file a `chrom.sizes` with a picture on it.
  // Exact, and its own member for the reason `vcf` is one — the Genome card
  // says where lengths came from — and a cytoBand that does *not* tile its
  // sequences reports `features` and gets the lower bound.
  | 'cytoband'

export interface Assembly {
  /** What names it: the URI of the file its lengths were read from. */
  uri: string
  /** A short label for the crumb and the info card. */
  name: string
  contigs: Contig[]
  origin: AssemblyOrigin
  /** Total bases, which is the whole-genome domain. */
  total: number
}

/**
 * `true` when the lengths are the assembly's own rather than a lower bound.
 *
 * A feature file carries no lengths, so the only thing that can be said about a
 * chromosome is that it is at least as long as the last feature on it. That is
 * usable — every gesture works, every coordinate is right — but the right-hand
 * edge of each sequence is a guess, and the info card says so rather than
 * letting a reader measure a telomere against it.
 */
export function lengthsAreExact(assembly: Pick<Assembly, 'origin'>): boolean {
  return assembly.origin !== 'features'
}

/**
 * `true` when `incoming`'s lengths should be taken over `current`'s.
 *
 * The Genome card offers this in so many words — *"Drop a chrom.sizes or a
 * bigWig to replace them with the real ones"* — and for a long time only the
 * first half of that sentence was true: the lengths were adopted from a file
 * whose *name* looked like a sizes file, so a bigWig, a bigBed, a BAM, a FASTA
 * or a VCF with `##contig` lines came in as a track and left the browser's
 * invented edges exactly where they were, under a hint promising otherwise.
 * Every one of those files answers the question exactly, and the worker already
 * says so in the assembly's `origin`; this is the one rule that reads it.
 *
 * Two conditions, and both are about not going backwards:
 *
 * - the assembly on screen must be **inferred** — lengths rounded up from the
 *   last feature ({@link lengthsAreExact}) — because an exact one is already
 *   the answer and replacing it with another file's would let the second of two
 *   bigWigs, or a subset one, redraw a genome that was already right;
 * - the incoming one must be **exact**, so a second BED can never overwrite a
 *   bigWig's header, and a feature file's lower bound never replaces another's.
 *
 * An empty contig list is refused for the same reason: it is not a smaller
 * genome, it is a file that answered nothing, and adopting it would leave the
 * browser with no axis at all.
 *
 * Nothing here checks that the two files are the *same* genome, deliberately —
 * dropping a file on a browser is the reader saying it belongs to what is open,
 * which is the standing a dropped `chrom.sizes` has always been given, and a
 * name that matches nothing simply draws no track (§5.9).
 */
export function replacesLengths(
  current: Assembly,
  incoming: { origin: AssemblyOrigin; contigs: readonly Contig[] },
): boolean {
  if (lengthsAreExact(current)) return false
  if (incoming.contigs.length === 0) return false
  return lengthsAreExact(incoming)
}

/**
 * Parse a `chrom.sizes`: two whitespace-separated columns, name then length.
 *
 * Deliberately forgiving about *which* whitespace and about extra columns — a
 * `.genome` file, a `samtools faidx` `.fai` and a UCSC `chrom.sizes` are the
 * same two leading columns — and deliberately strict about the second one being
 * a positive integer, because a two-column file whose second column is not a
 * length is a BED with no end coordinate, and reading it as an assembly would
 * invent a genome out of a peak set.
 *
 * Comments and blank lines are skipped. A `track`/`browser` line is a UCSC
 * header and is skipped too.
 */
export function parseChromSizes(text: string): Contig[] {
  const out: Contig[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || /^(track|browser)\b/.test(line)) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) return []
    const length = Number(parts[1])
    if (!Number.isInteger(length) || length <= 0) return []
    // A duplicate name is a corrupt file, not a second sequence: every
    // coordinate here is looked up by name, so two rows called `chr1` would give
    // one of them no coordinates at all.
    if (seen.has(parts[0])) continue
    seen.add(parts[0])
    out.push({ name: parts[0], length })
  }
  return out
}

/**
 * `true` when text looks like a `chrom.sizes` rather than like a BED.
 *
 * The distinction is real and one line cannot always make it — `chr1 248956422`
 * is a legal sizes row and an illegal BED row, but `chr1 0 100` is a legal BED
 * row and an illegal sizes row. So the test is *every* row: two columns
 * throughout, second column a positive integer. A BED has three or more.
 *
 * A `samtools faidx` index is the one file that breaks that rule honestly: its
 * first two columns *are* a `chrom.sizes` and it has three more after them, so
 * by shape alone it is a five-column BED whose second column is a length. The
 * file name settles it, which is the same tiebreak `sniffFormat` uses for the
 * two cases its own columns cannot decide — narrowPeak against BED9, broadPeak
 * against BED12 — and for the same reason.
 */
export function looksLikeChromSizes(text: string, fileName = ''): boolean {
  const indexed = /\.fai$/i.test(fileName)
  let rows = 0
  for (const raw of text.split(/\r?\n/, 200)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || /^(track|browser)\b/.test(line)) continue
    const parts = line.split(/\s+/)
    if (indexed ? parts.length < 2 : parts.length !== 2) return false
    if (!/^\d+$/.test(parts[1]) || Number(parts[1]) <= 0) return false
    rows++
  }
  return rows > 0
}

/** Build the assembly, sorted the way a genome browser lists sequences. */
export function assemblyOf(options: {
  uri: string
  name: string
  contigs: Contig[]
  origin: AssemblyOrigin
}): Assembly {
  const contigs = options.contigs.filter((contig) => contig.length > 0)
  return {
    uri: options.uri,
    name: options.name,
    contigs,
    origin: options.origin,
    total: contigs.reduce((sum, contig) => sum + contig.length, 0),
  }
}

/**
 * The whole genome as one axis, sequences laid end to end.
 *
 * The unit is **one base pair**, and the segments are the contigs at their
 * cumulative offsets. That makes the browser's `Scale` a scale over base pairs
 * and every `LocusAxis` method mean what it says without translation:
 * `windows()` clips a view to per-contig queries, `unitToLocus` is the readout,
 * `locusToUnit` is where a feature is drawn.
 *
 * A base-pair unit rather than a bin one is what lets the whole thing be one
 * axis at every zoom: a genome browser has no bin size, and the resolution a
 * track is fetched at is decided per frame from the pixels available, which is
 * what `AnnotationLanes` already does for the lanes beside a map.
 */
/**
 * A bin size for a genome nothing has binned.
 *
 * A contact map brings its own — the resolution it was written at — and every
 * per-bin quantity in this application is laid out on that. A **browser session
 * has no map**, and used to report its bin size as `0`: a placeholder that was
 * safe for exactly as long as the assumption behind it held, which was that no
 * task producing a per-bin result could be run without a matrix. That stopped
 * being true the moment a task could be answered from the *sequence* — the motif
 * search reads a FASTA and a FASTA is present with or without a map — and a zero
 * bin size gives every contig zero bins, which is a lane that is permanently
 * empty rather than a lane that is wrong, so nothing reports it.
 *
 * So a genome with no map gets a bin size chosen from its own length. The target
 * is a bin *count*: enough that a whole-genome lane has more bins than a wide
 * screen has pixels, and few enough that the vector costs less than whatever
 * filled it. Snapped up to 1, 2 or 5 times a power of ten, which is the ladder
 * the rulers already step by — 2 kb reads as a decision where 1,732 bp reads as
 * an accident, even though the two are equally arbitrary.
 *
 * It is a *browsing* grid and never a claim about the data: nothing here was
 * measured at this resolution, and `AnalysisContext.hasMap` stays false, so the
 * tasks that genuinely need a matrix go on saying so.
 */
export function browsingBinsize(total: number): number {
  const TARGET_BINS = 20_000
  const SMALLEST = 100
  const wanted = Math.max(SMALLEST, total / TARGET_BINS)
  const decade = 10 ** Math.floor(Math.log10(wanted))
  for (const step of [1, 2, 5]) {
    if (decade * step >= wanted) return decade * step
  }
  return decade * 10
}

export function assemblyAxis(assembly: Assembly): LocusAxis {
  const segments: LocusSegment[] = []
  let at = 0
  for (const contig of assembly.contigs) {
    segments.push({
      contig: contig.name,
      unitStart: at,
      unitEnd: at + contig.length,
      bpStart: 0,
      bpPerUnit: 1,
      contigLength: contig.length,
    })
    at += contig.length
  }
  return new LocusAxis(segments)
}

/** A window of the genome, in the axis's own units. */
export interface LocusRange {
  contig: string
  start: number
  end: number
}

/**
 * Parse what someone typed into the locus box.
 *
 * Four shapes, in the order a genome browser accepts them:
 *
 * - `chrI` — the whole sequence;
 * - `chrI:1,000-2,000` — a window, 1-based inclusive as every genome browser
 *   writes one, converted to the half-open 0-based interval everything else
 *   here speaks;
 * - `chrI:1000` — a point, widened to a readable window around it;
 * - `*`, `all`, `genome` — the whole assembly.
 *
 * The name is matched **whole first**, because a sequence may legally be called
 * `NODE_1:2` — the same care `contigOf` takes for the same reason — and then
 * through {@link findContig}, which knows that half the world writes `chr1`,
 * a quarter writes `1`, and the rest write `01`, `I` or `NC_000001.11`, and
 * that none of them is going to stop (§5.9).
 */
export function parseLocus(
  text: string,
  assembly: Assembly,
): LocusRange | 'whole' | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (/^(\*|all|genome|whole)$/i.test(trimmed)) return 'whole'

  const whole = findContig(assembly, trimmed)
  if (whole !== null) return { contig: whole.name, start: 0, end: whole.length }

  const colon = trimmed.lastIndexOf(':')
  if (colon < 0) return null
  const contig = findContig(assembly, trimmed.slice(0, colon))
  if (contig === null) return null

  const span = trimmed.slice(colon + 1).replace(/[, _]/g, '')
  const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(span)
  if (range !== null) {
    // 1-based inclusive in, 0-based half-open out. `start - 1` is the whole of
    // the conversion, and getting it wrong shifts every view by one base in a
    // way nothing on screen would show.
    const start = Math.max(0, Number(range[1]) - 1)
    const end = Math.min(contig.length, Number(range[2]))
    if (!(end > start)) return null
    return { contig: contig.name, start, end }
  }

  if (/^\d+$/.test(span)) {
    // Clamped *before* the window is built, not after. A position past the end
    // of the sequence — one mistyped digit is enough — would otherwise produce
    // `start > end`, which `Scale.setDomain` refuses with a `RangeError`: from
    // the locus box that is an uncaught throw, and from a link it is a throw
    // inside the view's constructor and a blank page.
    const at = Math.min(Math.max(0, Number(span) - 1), Math.max(0, contig.length - 1))
    const half = Math.max(500, Math.round(contig.length / 200))
    const start = Math.max(0, at - half)
    const end = Math.min(contig.length, Math.max(at + half, start + 1))
    return { contig: contig.name, start, end }
  }
  return null
}

/**
 * Find a sequence by the name someone typed.
 *
 * Exact, then case-insensitive, then every convention the world writes a
 * chromosome in: `chr1`, `1`, `01`, `I`, `NC_000001.11` and `chrM`, `MT`,
 * `MtDNA` are each one sequence under several spellings, and {@link NameIndex}
 * is where the argument for that lives (§5.9). The ladder is ordered so that a
 * genuine name always wins over an interpreted one — a file that really does
 * contain both `1` and `chr1` resolves each to itself — and the ladder itself
 * is `NameIndex.find`'s, so the locus box, a companion panel and a dropped
 * track all agree about what a name means.
 *
 * The index is held against the contig array's own identity rather than built
 * per call, and that is not an optimisation to skip: the locus box calls this on
 * **every keystroke**, and a keystroke mid-word is a miss — which is precisely
 * the path that reaches the index instead of short-circuiting on an exact name.
 * Rebuilt each time it costs 24 ms at five thousand sequences and most of a
 * second at a hundred and fifty thousand, which is a box that stops taking
 * input. An assembly's contigs are never mutated after it is built, which is
 * what makes holding one safe (see {@link NameIndex.for}).
 */
export function findContig(assembly: Assembly, name: string): Contig | null {
  const wanted = name.trim()
  if (wanted === '') return null
  const exact = assembly.contigs.find((contig) => contig.name === wanted)
  if (exact !== undefined) return exact
  const match = NameIndex.for(assembly.contigs).find(wanted)
  if (match === null) return null
  return assembly.contigs.find((contig) => contig.name === match.name) ?? null
}

/**
 * A window as the locus box writes it: `chrI:1,001-2,000`, 1-based inclusive.
 *
 * The inverse of {@link parseLocus}, and required to be: what the box shows has
 * to be what the box would accept, or copying the coordinate out of one view and
 * into another moves it by a base.
 */
export function formatLocus(range: LocusRange): string {
  return `${range.contig}:${(range.start + 1).toLocaleString('en-US')}-${range.end.toLocaleString('en-US')}`
}

/**
 * A single base or bin start as the reader reads it: `IV:1,162,001`.
 *
 * The one-base half of {@link formatLocus}, for the readouts that name a
 * position rather than a window — the bin under the pointer, the base a
 * context menu was opened on — so they add the one and group the digits the
 * same way the window beside them does.
 */
export function formatPosition(contig: string, bp0: number): string {
  return `${contig}:${baseLabel(bp0)}`
}

/**
 * A single base without the sequence it is on: `1,162,001`.
 *
 * {@link formatPosition} minus the name, on {@link windowLabel}'s terms and for
 * its reason: a surface that has already said the sequence one line up — the
 * map's tooltip, whose first line is the contig and whose second is where in it
 * — would otherwise print the name twice in one card. That tooltip used to add
 * the one itself and group the digits by the reader's locale, so in a German
 * browser it read `1.162.001` while every other coordinate on the screen was
 * grouped with commas; the one and the grouping are this file's to write,
 * wherever the name goes.
 */
export function baseLabel(bp0: number): string {
  return (bp0 + 1).toLocaleString('en-US')
}

/**
 * A state or hash region string, as the reader reads it.
 *
 * The state carries cooler's grammar — `IV:1000000-1400000`, 0-based and
 * half-open, because that is what `metacooler show --range` takes and what a
 * link has to keep meaning. Nobody reads that: what is shown is
 * {@link formatLocus} of it, `IV:1,000,001-1,400,000`, and a bare name — a
 * sequence, a genome — is shown as itself. A string the tokenizer would refuse
 * comes back unchanged, so a refusal is still about what was typed.
 */
export function regionLabel(region: string): string {
  const parsed = splitRegion(region)
  if (parsed === null) return region
  const [contig, start, end] = parsed
  if (start === null) return region
  if (end === null) return `${contig}:${(start + 1).toLocaleString('en-US')}-`
  return formatLocus({ contig, start, end })
}

/**
 * The window of a region string, without the sequence it is on:
 * `1,000,001-1,400,000`.
 *
 * {@link regionLabel} minus the name, for the one surface that has already said
 * the name: the breadcrumb's last crumb hangs under the sequence's own crumb,
 * and printing the whole locus there put `IV` twice in one row and the same
 * string three times on one screen (§5.5). Nowhere else may use it — a
 * coordinate with no sequence on it is not a locus, and it is legible only
 * directly under the crumb that names one. A region with no coordinates, or one
 * the tokenizer refuses, falls back to {@link regionLabel} so the crumb still
 * says something true.
 */
export function windowLabel(region: string): string {
  const parsed = splitRegion(region)
  if (parsed === null) return regionLabel(region)
  const [, start, end] = parsed
  if (start === null || end === null) return regionLabel(region)
  return `${(start + 1).toLocaleString('en-US')}-${end.toLocaleString('en-US')}`
}

/**
 * What a reader typed into a map or table locus box, as the region string the
 * parser takes.
 *
 * The box shows 1-based inclusive coordinates ({@link regionLabel}), so what is
 * typed into it is read the same way — pressing Enter on the value the box shows
 * must change nothing, and a locus pasted from IGV or UCSC, or copied off this
 * app's own map, must land on the bases it names. The start loses one and the
 * end stays, which is the whole of the inclusive-to-half-open conversion. Every
 * spelling `metacooler/range.ts` accepts is accepted here — commas, `kb` and
 * `Mb`, spaces, a second coordinate omitted — plus the en dash and `..`, which
 * other browsers write and the tokenizer does not take. A bare name or a genome
 * name has no coordinates and passes through; so does anything the tokenizer
 * refuses, so that the parser's own wording is what the reader sees.
 */
export function typedLocusToRegion(text: string): string {
  const typed = text.trim()
  const parsed = splitRegion(typed)
  if (parsed === null) return typed
  const [contig, start, end] = parsed
  if (start === null) return typed
  const from = typedPosition(start)
  return end === null ? `${contig}:${from}-` : `${contig}:${from}-${end}`
}

/**
 * Two windows typed as one box's worth — rows, then columns — as the two region
 * strings a block of two windows is (§5.4); one window as one.
 *
 * A trans block is a picture this app has always drawn, of `region` and
 * `region2`, reached by clicking an off-diagonal cell or drawing a box off the
 * diagonal — and a box could not ask for it. What was typed after the first
 * window was dropped without a word, because the tokenizer stops reading at the
 * end coordinate: `chr1:1,000-2,000 chr2:3,000-4,000` opened chr1 alone. The two
 * windows are now read apart when they are separated by `×` (what the title
 * over such a block writes, so the box shows it and Enter on it moves nothing),
 * by `|`, by an `x` standing on its own, or by a space before a second
 * `name:` — and each through {@link typedLocusToRegion}, so each takes every
 * spelling a single window does. Two bare names need a mark between them: a
 * space alone would split a name with one in it.
 */
export function typedLociToRegions(text: string): { region: string; region2?: string } {
  const halves = splitTypedPair(text.trim())
  if (halves === null) return { region: typedLocusToRegion(text) }
  return { region: typedLocusToRegion(halves[0]), region2: typedLocusToRegion(halves[1]) }
}

/**
 * A block of two windows as a reader reads it: `IV:1,000,001-1,400,000 ×
 * V:1-200,000`, which is also what {@link typedLociToRegions} reads back.
 */
export function pairLabel(region: string, region2: string): string {
  return `${regionLabel(region)} × ${regionLabel(region2)}`
}

/** The two halves of a typed pair, or `null` for one window. */
function splitTypedPair(typed: string): [string, string] | null {
  const at = pairMark(typed)
  if (at === null) return null
  const first = typed.slice(0, at.index).trim()
  const second = typed.slice(at.index + at.length).trim()
  return first === '' || second === '' ? null : [first, second]
}

/** Where a typed pair divides, and how wide the divide is. */
function pairMark(typed: string): { index: number; length: number } | null {
  // `×`, or an `x` with a space on both sides — `chrX` is a name.
  const cross = /\s*×\s*|\s+[xX]\s+/.exec(typed)
  if (cross !== null) return { index: cross.index, length: cross[0].length }
  // `|`, after a window with coordinates only: a sequence name may hold a pipe
  // of its own — NCBI's older `gi|…|ref|…|` names do — and a bare name before
  // one is that name.
  const pipe = typed.indexOf('|')
  if (pipe > 0 && typed.slice(0, pipe).includes(':')) return { index: pipe, length: 1 }
  // A space before a second window's `name:`. Not before a number, so a window
  // typed with a space in it, `IV:1,000 - 20,000`, stays one window.
  const space = /\s+(?=[^\s:×|]+:)/.exec(typed)
  return space === null ? null : { index: space.index, length: space[0].length }
}

/**
 * A base a reader typed, 1-based as they write it, as the 0-based coordinate
 * everything here speaks: `1,162,001` is `1162000`.
 *
 * The start of {@link typedLocusToRegion}'s conversion, for the boxes whose
 * grammar is not a region string — a bookmark typed as a single position, a
 * hand-drawn mark whose sequence may carry a colon of its own — and which read
 * the numbers themselves. They used to take them as written, 0-based, which
 * made them the boxes in the app where a locus pasted from IGV or a paper
 * landed one base to the right of the place it names; the one subtraction is
 * written here so that no box writes it again. Never below the first base, as a
 * locus box never is.
 */
export function typedPosition(base: number): number {
  return Math.max(0, base - 1)
}

/**
 * `[name, start, end]` of a region string, or `null` where the tokenizer would
 * refuse it — the caller then hands the string on untouched.
 *
 * `reversed`, because a window across a circle's origin runs backwards
 * (§8.15) and is a legal thing to show and to type. Only the coordinate half
 * is normalised: a name may legally contain `..`.
 */
function splitRegion(text: string): [string, number | null, number | null] | null {
  const colon = text.indexOf(':')
  if (colon < 0) return [text, null, null]
  const suffix = text.slice(colon + 1).replace(/–|\.\./g, '-')
  try {
    return parseRegionString(`${text.slice(0, colon)}:${suffix}`, { reversed: true })
  } catch {
    return null
  }
}

/** The genome-wide unit interval a locus covers, or `null` for an unknown name. */
export function rangeToUnits(
  assembly: Assembly,
  range: LocusRange,
): [number, number] | null {
  let at = 0
  for (const contig of assembly.contigs) {
    if (contig.name === range.contig) {
      return [at + Math.max(0, range.start), at + Math.min(contig.length, range.end)]
    }
    at += contig.length
  }
  return null
}

/** The locus a genome-wide unit interval covers, clipped to one sequence. */
export function unitsToRange(assembly: Assembly, units: [number, number]): LocusRange | null {
  let at = 0
  for (const contig of assembly.contigs) {
    const end = at + contig.length
    // The *midpoint* decides which sequence a view belongs to, so a window
    // spanning a boundary is named by the sequence most of it is on rather than
    // by whichever end happens to be first.
    const middle = (units[0] + units[1]) / 2
    if (middle < end || end === at) {
      return {
        contig: contig.name,
        start: Math.max(0, Math.round(units[0] - at)),
        end: Math.min(contig.length, Math.round(units[1] - at)),
      }
    }
    at = end
  }
  return null
}
