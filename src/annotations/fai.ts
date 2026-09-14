/**
 * The FASTA index: `samtools faidx`, and the arithmetic that turns it into
 * byte ranges.
 *
 * A `.fai` is five columns per sequence — name, length, the byte offset of its
 * first residue, residues per line, bytes per line — and those five are enough
 * to read any window of any sequence without reading anything else: the
 * offset of residue `i` is `offset + (i / linebases) * linewidth + i %
 * linebases`, and the bytes between two such offsets are the residues wanted
 * plus the line endings between them. That is the whole of what makes a
 * three-gigabyte genome openable here (§8.8): the assembly is the first two
 * columns, which is a `chrom.sizes`, and a window of letters is one ranged
 * read.
 *
 * Nothing here touches a file. `parseFai` reads text and {@link byteRange}
 * does sums; the worker owns the handle and does the reading, so the two can
 * be pinned by a test that never leaves memory.
 */

import type { Contig } from '../genome/assembly'

/** One line of a `.fai`. */
export interface FaiRecord {
  name: string
  length: number
  /** Byte offset of the first residue. */
  offset: number
  /** Residues per line, for every line but the last. */
  lineBases: number
  /** Bytes per line, line ending included. */
  lineWidth: number
}

/**
 * Parse a `.fai`.
 *
 * Tab- or space-separated, five or six columns (a FASTQ index carries a sixth,
 * which is ignored rather than refused), a duplicate name skipped for the
 * reason `parseChromSizes` skips one: every coordinate is looked up by name.
 * Anything that is not five non-negative integers after a name is not an
 * index, and the answer is *no records* rather than a partial one — an index
 * half read would place half the genome and lose the rest silently.
 */
export function parseFai(text: string): FaiRecord[] {
  const out: FaiRecord[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 5) return []
    const [name, length, offset, lineBases, lineWidth] = [
      parts[0],
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4]),
    ]
    const numbers = [length, offset, lineBases, lineWidth]
    if (numbers.some((value) => !Number.isInteger(value) || value < 0)) return []
    // A line holding no residues and a line shorter than its own residues are
    // both files no `faidx` wrote.
    if (lineBases === 0 || lineWidth < lineBases) return []
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, length, offset, lineBases, lineWidth })
  }
  return out
}

/** `true` when this text has the shape of a `.fai` — for a file dropped without its name. */
export function looksLikeFai(text: string): boolean {
  return parseFai(text.split('\n', 50).join('\n')).length > 0
}

/** The first two columns, which are a `chrom.sizes`. */
export function contigsOf(records: readonly FaiRecord[]): Contig[] {
  return records.map((record) => ({ name: record.name, length: record.length }))
}

/**
 * The byte offset of residue `at` (zero-based) of a sequence.
 *
 * Whole lines before it, at their full width, plus the residues on its own
 * line. Valid up to and including `length`, where it names the byte after the
 * last residue on the last line — which is what an exclusive end needs.
 */
export function byteOf(record: FaiRecord, at: number): number {
  const line = Math.floor(at / record.lineBases)
  return record.offset + line * record.lineWidth + (at - line * record.lineBases)
}

/**
 * The bytes to read for residues `[start, end)`, clipped to the sequence.
 *
 * `to` is exclusive and is the offset *of residue `end - 1` plus one*, not the
 * offset of residue `end`: when `end` falls on a line boundary the latter is
 * the first byte of the next line, and the read would carry a line ending it
 * then has to drop — harmless, but a byte for nothing on every window that
 * happens to end a line. Empty (`from === to`) for a window with no residues.
 */
export function byteRange(record: FaiRecord, start: number, end: number): { from: number; to: number } {
  const first = Math.max(0, Math.min(record.length, Math.floor(start)))
  const last = Math.max(first, Math.min(record.length, Math.ceil(end)))
  if (last <= first) return { from: byteOf(record, first), to: byteOf(record, first) }
  return { from: byteOf(record, first), to: byteOf(record, last - 1) + 1 }
}

/**
 * The residues in a slab of file bytes: everything above `0x20`, which drops
 * the line endings — either flavour — and any stray whitespace, exactly as
 * `parseFasta` does for a file read whole.
 */
export function residuesIn(bytes: Uint8Array): Uint8Array {
  let kept = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x20) kept++
  if (kept === bytes.length) return bytes
  const out = new Uint8Array(kept)
  let at = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x20) out[at++] = bytes[i]
  return out
}
