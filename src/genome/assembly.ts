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

/** One sequence, as every source of an assembly reports one. */
export interface Contig {
  name: string
  length: number
}

/** Where an assembly's lengths came from, which decides how far to trust them. */
export type AssemblyOrigin = 'sizes' | 'bigwig' | 'bigbed' | 'features' | 'cooler'

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
export function lengthsAreExact(assembly: Assembly): boolean {
  return assembly.origin !== 'features'
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
 * case-insensitively with and without a `chr` prefix, because half the world
 * writes `chr1` and the other half writes `1` and neither is going to stop.
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
    const at = Math.max(0, Number(span) - 1)
    const half = Math.max(500, Math.round(contig.length / 200))
    return {
      contig: contig.name,
      start: Math.max(0, at - half),
      end: Math.min(contig.length, at + half),
    }
  }
  return null
}

/**
 * Find a sequence by the name someone typed.
 *
 * Exact, then case-insensitive, then with a `chr` prefix added or removed. The
 * ladder is ordered so that a genuine name always wins over a lenient match:
 * a file that really does contain both `1` and `chr1` resolves each to itself.
 */
export function findContig(assembly: Assembly, name: string): Contig | null {
  const wanted = name.trim()
  if (wanted === '') return null
  const exact = assembly.contigs.find((contig) => contig.name === wanted)
  if (exact !== undefined) return exact
  const lower = wanted.toLowerCase()
  const insensitive = assembly.contigs.find((contig) => contig.name.toLowerCase() === lower)
  if (insensitive !== undefined) return insensitive
  const other = lower.startsWith('chr') ? lower.slice(3) : `chr${lower}`
  return assembly.contigs.find((contig) => contig.name.toLowerCase() === other) ?? null
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
