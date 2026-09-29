/**
 * FASTA: the sequence itself, as the one annotation that *is* the genome.
 *
 * Everything else this viewer draws is a measurement over a genome — coverage,
 * genes, peaks, contacts. A FASTA is the coordinate system those measurements
 * are quoted against, and that makes it two things at once: an assembly (every
 * sequence and its true length, which is what a `chrom.sizes` carries) and a
 * track (what is actually there, base by base).
 *
 * It is parsed from **bytes**, never from a decoded string. A yeast genome is 12
 * MB and a fly's is 140; `TextDecoder` would turn either into a UTF-16 string of
 * twice the size, which is then walked once and thrown away. Residues are ASCII
 * by definition, so the bytes *are* the sequence and the decode is pure cost.
 *
 * The parsed sequences stay in the annotations worker, exactly as a bigWig's
 * handle does (§8.2): a view asks for the window it is drawing, at the
 * resolution it is drawing it, and gets either GC content per bin or the bases
 * themselves. Handing a chromosome to the main thread to slice there would be
 * the same mistake as sending a bigWig's every interval.
 */

import type { Contig } from '../genome/assembly'

/** One FASTA file, parsed. */
export interface SequenceStore {
  /** Names in file order, with the lengths the file itself establishes. */
  contigs: Contig[]
  /** Residues per sequence, one ASCII byte each, exactly as written. */
  bases: Map<string, Uint8Array>
  /** Residues across every sequence, for the one-line summary. */
  total: number
}

const GREATER_THAN = 0x3e
const NEWLINE = 0x0a

/**
 * `true` when these bytes begin a FASTA.
 *
 * The first byte, and nothing else. A FASTA's whole grammar is "a `>` line names
 * what follows", so the first character of the file is the entire test — and
 * anything cleverer would have to read residues and decide whether `RYKM` is
 * IUPAC or a column of gene names. Whitespace before the first record is not
 * allowed for by design: a leading blank line makes the file ambiguous with a
 * text format, and every writer of a FASTA emits the header first.
 */
export function looksLikeFasta(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === GREATER_THAN
}

/**
 * Parse a FASTA out of its bytes.
 *
 * Two passes. The first finds the record boundaries and counts each record's
 * residues; the second allocates exactly that many bytes per sequence and fills
 * them. Counting first is what makes the second pass a straight copy into a
 * right-sized `Uint8Array` — the alternative is growing a buffer per record,
 * which for a chromosome means copying it *log n* times, or keeping a list of
 * line slices, which for a 60-column file is one array entry per 60 bases.
 *
 * Line endings, and any other whitespace, are dropped: everything above
 * `0x20` is a residue. A second record with a name already seen is skipped
 * rather than merged, for the reason `parseChromSizes` skips a duplicate row —
 * every coordinate here is looked up by name, so two sequences under one name
 * means one of them has no coordinates at all.
 */
export function parseFasta(bytes: Uint8Array): SequenceStore {
  const decoder = new TextDecoder()
  const heads: number[] = []
  // A header is a `>` at the start of a line: byte zero, or just after a
  // newline. Checked this way rather than by splitting into lines, because a
  // 140 MB file is two million lines and none of them need to exist as objects.
  if (bytes.length > 0 && bytes[0] === GREATER_THAN) heads.push(0)
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] === GREATER_THAN && bytes[i - 1] === NEWLINE) heads.push(i)
  }

  const contigs: Contig[] = []
  const stores = new Map<string, Uint8Array>()
  let total = 0
  for (let record = 0; record < heads.length; record++) {
    const head = heads[record]
    let lineEnd = bytes.indexOf(NEWLINE, head)
    if (lineEnd < 0) lineEnd = bytes.length
    const name = nameOf(decoder, bytes, head + 1, lineEnd)
    const from = Math.min(lineEnd + 1, bytes.length)
    const to = record + 1 < heads.length ? heads[record + 1] : bytes.length
    if (name === '' || stores.has(name)) continue

    let length = 0
    for (let i = from; i < to; i++) if (bytes[i] > 0x20) length++
    if (length === 0) continue

    const seq = new Uint8Array(length)
    let at = 0
    for (let i = from; i < to; i++) {
      const byte = bytes[i]
      if (byte > 0x20) seq[at++] = byte
    }
    stores.set(name, seq)
    contigs.push({ name, length })
    total += length
  }
  return { contigs, bases: stores, total }
}

/** A record's name: the header up to its first space, which is the convention. */
function nameOf(decoder: TextDecoder, bytes: Uint8Array, from: number, to: number): string {
  let end = from
  while (end < to && bytes[end] > 0x20) end++
  return decoder.decode(bytes.subarray(from, end)).trim()
}

// ---------------------------------------------------------------------------
// What a view asks a sequence for
// ---------------------------------------------------------------------------

/**
 * Base identity, by byte: 0 A, 1 C, 2 G, 3 T or U, 4 anything else.
 *
 * A table rather than a switch because it is consulted once per base of a
 * drawn window, and because it makes case-folding free — a soft-masked genome
 * writes its repeats in lower case, and a repeat is still a G.
 */
/**
 * The base on the other strand, byte for byte and case kept: `A`↔`T`, `C`↔`G`,
 * and anything else — `N`, an IUPAC code — as it is. What a sequence lane draws
 * on a reversed piece of an edited sequence (§27.2), and what an exported FASTA
 * writes there.
 */
export function complementByte(byte: number): number {
  switch (byte) {
    case 65: return 84 // A → T
    case 84: return 65
    case 67: return 71 // C → G
    case 71: return 67
    case 97: return 116 // a → t
    case 116: return 97
    case 99: return 103 // c → g
    case 103: return 99
    default: return byte
  }
}

export const BASE_CODE = ((): Uint8Array => {
  const table = new Uint8Array(256).fill(4)
  const set = (letter: string, code: number): void => {
    table[letter.charCodeAt(0)] = code
    table[letter.toLowerCase().charCodeAt(0)] = code
  }
  set('A', 0)
  set('C', 1)
  set('G', 2)
  set('T', 3)
  // RNA. A `U` drawn as an unknown base would be every position of an mRNA.
  set('U', 3)
  return table
})()

/**
 * The narrowest window GC content is ever computed over.
 *
 * GC over a single base is a step function between 0 and 1, and GC over eight is
 * a nine-level staircase; both are noise drawn at the width of a line. Twenty
 * five bases is about where the number starts describing the sequence rather
 * than the individual bases in it, and it is the window a genome browser's GC
 * track conventionally uses. Zoomed out the bin is the pixel, which is always
 * wider than this, so the floor only ever applies near the transition to letters.
 */
export const GC_WINDOW_MIN = 25

/** One GC-content profile over one window, in the shape a track sample takes. */
export interface GcBins {
  starts: Int32Array
  ends: Int32Array
  values: Float32Array
}

/**
 * GC content over `[start, end)`, in bins of about `bin` bases.
 *
 * `NaN` for a bin with no A, C, G or T in it at all — a run of `N`, which every
 * assembly has between its contigs. That is not "GC of zero", and drawing it as
 * one would put a floor-scraping line across every gap; `NaN` is the same "no
 * data here" a bigWig's gaps produce, and the track code already breaks its line
 * at one.
 */
export function gcBins(seq: Uint8Array, start: number, end: number, bin: number): GcBins {
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(seq.length, Math.ceil(end))
  const width = Math.max(GC_WINDOW_MIN, Math.round(bin))
  const count = to > from ? Math.ceil((to - from) / width) : 0
  const starts = new Int32Array(count)
  const ends = new Int32Array(count)
  const values = new Float32Array(count)
  for (let slot = 0; slot < count; slot++) {
    const b0 = from + slot * width
    const b1 = Math.min(to, b0 + width)
    let gc = 0
    let at = 0
    for (let i = b0; i < b1; i++) {
      const code = BASE_CODE[seq[i]]
      if (code === 1 || code === 2) gc++
      else if (code === 0 || code === 3) at++
    }
    starts[slot] = b0
    ends[slot] = b1
    values[slot] = gc + at > 0 ? gc / (gc + at) : Number.NaN
  }
  return { starts, ends, values }
}
