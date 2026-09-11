/**
 * The `.pairs` header, which is the whole of what this format declares.
 *
 * A 4DN pairs file is a text contact list with a `#`-commented preamble, and
 * that preamble is doing more work here than a header usually does: it carries
 * the **chromosome sizes**, which is the bin table, and the **column layout**,
 * which is where the two coordinates live. Everything the importer needs to
 * turn records into a cooler is in it, and nothing in it is guessed.
 *
 * ## Why the columns are read rather than assumed
 *
 * The spec fixes an order — `readID chr1 pos1 chr2 pos2 strand1 strand2` — and
 * then says a file may declare any other. pairtools writes `chrom1`/`chrom2`
 * where the spec writes `chr1`/`chr2`, files carry extra columns (`pair_type`,
 * `mapq1`, restriction-fragment ids) and some carry the four coordinates in a
 * different order entirely. Reading `#columns:` costs one line and is the
 * difference between an importer that works on the file in front of somebody
 * and one that works on the file in the specification.
 *
 * The declared order is honoured; the spec's order is the fallback when no
 * `#columns:` line is present, which is what a file trimmed by `grep -v '^#'`
 * and re-headed by hand tends to look like.
 *
 * ## Why `#chromsize:` is required and `.px2` is not
 *
 * Without chromosome lengths there is no bin table, and a bin table inferred
 * from the largest coordinate observed would be a *different* grid for every
 * subsample of the same library — the one way of being wrong that survives
 * every check downstream and makes two files silently incomparable. So it is
 * refused by name, and the refusal says which command writes the line.
 *
 * The index is a different matter and is opportunistic in §3.4's exact sense
 * (see `px2.ts`): with one, the import can be scoped and its cost is known
 * before it starts; without one, the file is read whole. Both work.
 */

import { ViewerError } from '../errors'
import type { ByteSource } from '../types'
import { decompressedStream, forEachLine, isBgzfMember, memberSize } from './stream'

/** The spec's own column order, used when a file declares none. */
const DEFAULT_COLUMNS = ['readID', 'chr1', 'pos1', 'chr2', 'pos2', 'strand1', 'strand2']

/** Accepted spellings for each coordinate column, in preference order. */
const COLUMN_ALIASES = {
  chrom1: ['chr1', 'chrom1', 'chromosome1'],
  pos1: ['pos1', 'position1'],
  chrom2: ['chr2', 'chrom2', 'chromosome2'],
  pos2: ['pos2', 'position2'],
} as const

/**
 * The two strand columns, which are optional and are looked for separately.
 *
 * Separate from {@link COLUMN_ALIASES} because the four above are **required**
 * and these two are not: a file trimmed to five columns is a perfectly good
 * pairs file that this importer bins exactly as it bins any other, and only the
 * orientation curves are absent from it. Folding them into the required set
 * would turn an optional reading into a refusal.
 */
const STRAND_ALIASES = {
  strand1: ['strand1', 'strand_1'],
  strand2: ['strand2', 'strand_2'],
} as const

/**
 * How much of the file may be header before the reader gives up looking.
 *
 * Generous on purpose: a metagenomic assembly declares one `#chromsize:` line
 * per contig, and fifty thousand contigs is a megabyte and a half of header
 * before the first record. The cap exists to bound a file that is not a pairs
 * file at all rather than to police a real one.
 */
const MAX_HEADER_BYTES = 64 << 20

/** Enough to hold a BGZF member header and its extra field. */
const BGZF_HEADER_PROBE = 64

/** The slice a plain-gzip probe reads, knowing it will not decode to its end. */
const PLAIN_PROBE_BYTES = 1 << 16

/** One sequence, as the header declares it. */
export interface PairsContig {
  name: string
  length: number
}

/** Which field of a record holds each coordinate, zero-based. */
export interface PairsColumns {
  chrom1: number
  pos1: number
  chrom2: number
  pos2: number
  /**
   * Where the two strands are, or `-1` where the file does not carry them.
   *
   * **The one thing §3.7 reads out of a record beyond its four coordinates**,
   * and the clause it narrows is stated there rather than stepped around. The
   * original rule — *nothing about strands, pair types or mapping quality is
   * read or re-decided* — was about what a **matrix** is built from, and it
   * still holds: no strand reaches a bin, a pixel or a written `.mcool`, and a
   * reader who wants different records still runs `pairtools select`. What the
   * strands are read for is a *curve beside* the matrix — the four
   * orientation-resolved decays, which is the standard QC on a pairs file and
   * the only place the minimum reliable separation of a library is visible.
   * Nothing is decided from them; they are counted.
   */
  strand1: number
  strand2: number
}

export interface PairsHeader {
  /** The `## pairs format vX.Y` version string, as written. */
  version: string
  /** `#genome_assembly:`, or `null`. */
  assembly: string | null
  /** `#sorted:`, or `null` when the file does not say. */
  sorted: string | null
  /** `#shape:`, or `null`. */
  shape: string | null
  /** Sequences in header order, which becomes the contig order. */
  contigs: PairsContig[]
  /** Where the four coordinates live. */
  columns: PairsColumns
  /** The preamble verbatim, for provenance in a written file. */
  text: string
}

/** `true` when the first line declares the 4DN pairs format. */
export function isPairsPreamble(firstLine: string): boolean {
  return /^##\s*pairs\s+format/i.test(firstLine)
}

/**
 * Whether `source` opens a `.pairs`, without committing to reading it.
 *
 * Cheap by construction: one small read, and for a compressed file one BGZF
 * block's worth of inflate. Called from the container detection in
 * `MetaCooler.open`, where the answer decides which reader is built and must
 * therefore cost nothing when it is "no".
 */
export async function isPairsFile(source: ByteSource): Promise<boolean> {
  let first: string | null = null
  try {
    await forEachLine(
      decompressedStream(source, { to: probeEnd(source) }),
      (line) => {
        first ??= new TextDecoder().decode(line)
      },
      () => first !== null,
    )
  } catch {
    // A span that ends inside a gzip member cannot be decoded to its end, and
    // on a plain `.gz` there is no way to cut one that does not. That is not a
    // fact about the file: what was decoded *before* the cut is the answer, and
    // it is already in `first`. Swallowing the throw and discarding the line
    // with it is what made every real bgzipped pairs file fall through to
    // h5wasm and fail there instead.
  }
  return first !== null && isPairsPreamble(first)
}

/**
 * How much to read to see the first line.
 *
 * A BGZF file can be cut *exactly*, because the first member's own header says
 * how long it is — so the common case decodes cleanly with nothing to tolerate.
 * A plain `.gz` cannot: its members are unbounded, so the probe takes a fixed
 * slice and accepts that the decoder will raise at the end of it.
 */
function probeEnd(source: ByteSource): number {
  const head = source.readBytes(0, Math.min(source.size, BGZF_HEADER_PROBE))
  if (isBgzfMember(head)) {
    const size = memberSize(head)
    if (size !== null) return Math.min(source.size, size)
  }
  return Math.min(source.size, PLAIN_PROBE_BYTES)
}

/**
 * Read the preamble.
 *
 * Stops at the first record, so the cost is the header rather than the file.
 *
 * @throws ViewerError `format` when the preamble is absent or carries no
 *   `#chromsize:` lines, and `unsupported` when `#columns:` names a layout with
 *   no coordinate columns in it.
 */
export async function readPairsHeader(source: ByteSource): Promise<PairsHeader> {
  const contigs: PairsContig[] = []
  const seen = new Set<string>()
  const lines: string[] = []
  let version: string | null = null
  let assembly: string | null = null
  let sorted: string | null = null
  let shape: string | null = null
  let declared: string[] | null = null
  let bytes = 0
  let done = false

  const decoder = new TextDecoder()
  const stream = decompressedStream(source, { to: Math.min(source.size, MAX_HEADER_BYTES) })
  // The same tolerance {@link isPairsFile} needs, for the same reason and one
  // case only: a file whose header alone exceeds the cap is cut mid-member and
  // cannot be decoded to its end. What was read still decides — the checks
  // below turn "no preamble" and "no sizes" into refusals that name the fix,
  // which is a better answer than a decoder's.
  await forEachLine(
    stream,
    (line) => {
      if (done) return
      bytes += line.length + 1
      // The first non-comment byte ends the header, and it is the *only* thing
      // that does: a `#` line after records would be a malformed file, and
      // treating one as header would silently shift every field after it.
      if (line.length === 0 || line[0] !== 0x23) {
        done = true
        return
      }
      const text = decoder.decode(line)
      lines.push(text)

      if (version === null && isPairsPreamble(text)) {
        version = text.replace(/^##\s*/, '').trim()
        return
      }
      const colon = text.indexOf(':')
      if (colon < 0) return
      const key = text.slice(1, colon).trim().toLowerCase()
      const value = text.slice(colon + 1).trim()

      if (key === 'chromsize' || key === 'chromosome') {
        const parts = value.split(/\s+/)
        if (parts.length >= 2) addContig(contigs, seen, parts[0], Number(parts[1]))
      } else if (key === 'samheader') {
        // pairtools writes the sizes twice — once as `#chromsize:` and once
        // inside an embedded SAM header. The second is a fallback rather than a
        // duplicate source: a file that carries only `@SQ` still opens.
        const sq = /^@SQ\s.*\bSN:(\S+).*\bLN:(\d+)/.exec(value)
        if (sq !== null) addContig(contigs, seen, sq[1], Number(sq[2]))
      } else if (key === 'genome_assembly') {
        assembly = value
      } else if (key === 'sorted') {
        sorted = value
      } else if (key === 'shape') {
        shape = value
      } else if (key === 'columns') {
        declared = value.split(/\s+/).filter((name) => name !== '')
      }
    },
    () => done,
  ).catch(() => false)

  if (version === null) {
    throw new ViewerError(
      'format',
      'This file does not begin with a `## pairs format` line, so it is not a 4DN pairs ' +
        'file. If it is a headerless contact list, add a header with `pairtools header ' +
        'generate`, or bin it with `cooler cload pairs` and open the cooler.',
      { bytesRead: bytes },
    )
  }
  if (contigs.length === 0) {
    throw new ViewerError(
      'format',
      'This .pairs file declares no `#chromsize:` lines, so there is no bin table to ' +
        'build. Chromosome sizes cannot be inferred from the records — a grid guessed ' +
        'from the largest coordinate seen would differ between two subsamples of the ' +
        'same library. Add them with `pairtools header generate --chroms-path <chrom.sizes>`.',
      { contigs: 0 },
    )
  }

  return {
    version,
    assembly,
    sorted,
    shape,
    contigs,
    columns: resolveColumns(declared ?? DEFAULT_COLUMNS, declared !== null),
    text: lines.join('\n'),
  }
}

/** Record a sequence, ignoring a repeat and refusing a nonsensical length. */
function addContig(
  contigs: PairsContig[],
  seen: Set<string>,
  name: string,
  length: number,
): void {
  if (seen.has(name) || !Number.isFinite(length) || length <= 0) return
  seen.add(name)
  contigs.push({ name, length })
}

/**
 * Map a declared column list onto the four fields the importer reads.
 *
 * @throws ViewerError `unsupported` naming the columns the file *does* have,
 *   which is the difference between "unsupported layout" and a message somebody
 *   can act on.
 */
export function resolveColumns(names: readonly string[], wasDeclared: boolean): PairsColumns {
  const lower = names.map((name) => name.toLowerCase())
  const find = (aliases: readonly string[]): number => {
    for (const alias of aliases) {
      const at = lower.indexOf(alias)
      if (at >= 0) return at
    }
    return -1
  }
  const columns: PairsColumns = {
    chrom1: find(COLUMN_ALIASES.chrom1),
    pos1: find(COLUMN_ALIASES.pos1),
    chrom2: find(COLUMN_ALIASES.chrom2),
    pos2: find(COLUMN_ALIASES.pos2),
    strand1: find(STRAND_ALIASES.strand1),
    strand2: find(STRAND_ALIASES.strand2),
  }
  // The strands are optional, so they are left out of the completeness check:
  // `-1` there means *this file does not carry them*, which is a fact rather
  // than a fault.
  const missing = (['chrom1', 'pos1', 'chrom2', 'pos2'] as const).filter(
    (key) => columns[key] < 0,
  )
  if (missing.length > 0) {
    throw new ViewerError(
      'unsupported',
      `This .pairs file's ${wasDeclared ? '`#columns:` line' : 'assumed column layout'} has no ` +
        `${missing.join(', ')} column. It declares ${names.join(', ')}. The importer needs two ` +
        'chromosome columns and two position columns.',
      { missing, columns: [...names] },
    )
  }
  return columns
}

/**
 * Cumulative first-bin index per contig, plus a terminator — `chrom_offset`.
 *
 * The same arithmetic §3.3 describes, and the reason `/bins` never has to
 * exist: with a uniform bin size a contig's bin count is `ceil(length / size)`
 * and everything else follows from two arrays.
 */
export function chromOffsetsFor(contigs: readonly PairsContig[], binSize: number): Float64Array {
  const offsets = new Float64Array(contigs.length + 1)
  let at = 0
  for (let i = 0; i < contigs.length; i++) {
    offsets[i] = at
    at += Math.ceil(contigs[i].length / binSize)
  }
  offsets[contigs.length] = at
  return offsets
}

/** Total bins a contig set occupies at `binSize`. */
export function binCountFor(contigs: readonly PairsContig[], binSize: number): number {
  let total = 0
  for (const contig of contigs) total += Math.ceil(contig.length / binSize)
  return total
}
