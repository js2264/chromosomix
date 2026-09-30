/**
 * The session lifted through an edit of the reference (SPECS §27.8): the
 * sequence of the edited assembly, and a track's features, pairs and signal,
 * each in the edited coordinates — what the tools downstream of a curation need
 * besides the AGP.
 *
 * Every file writes the same sequences the AGP does (`assemblyObjects`): the
 * edited assembly's, then each stretch set aside as unplaced as its own. A
 * stretch set aside for any other reason lifts to nowhere.
 *
 * Nothing here reads a file: what reads the sequence and the signal is handed
 * in, so the arithmetic of where each base goes is tested without a worker.
 */

import { complementByte } from '../annotations/fasta'
import type { FeatureSet, PairSet } from '../annotations/types'
import type { BigWigContig, BigWigSpans } from '../analysis/write/bigwig'
import { isGap, type EditedAssembly, type Piece } from '../genome/edit'
import { assemblyObjects, type AssemblyObject } from './exports'

/** Where a stretch of an original sequence lands among the sequences the files write. */
export interface ObjectLanding {
  object: string
  /** Where its piece begins in the object. */
  offset: number
  piece: Piece
}

/** Every piece of every original sequence, with the object and offset it lands at. */
export function objectLandings(objects: readonly AssemblyObject[]): Map<string, ObjectLanding[]> {
  const out = new Map<string, ObjectLanding[]>()
  for (const object of objects) {
    let offset = 0
    for (const part of object.parts) {
      if (isGap(part)) {
        offset += part.gap
        continue
      }
      const list = out.get(part.sequence) ?? []
      list.push({ object: object.name, offset, piece: part })
      out.set(part.sequence, list)
      offset += part.end - part.start
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.piece.start - b.piece.start)
  return out
}

/** A stretch of an original sequence as it lands: each place, clipped to the piece it lands in. */
export interface Lifted {
  object: string
  start: number
  end: number
  /** `-1` where the piece it landed in is read backwards. */
  strand: 1 | -1
}

/**
 * An original stretch `[start, end)`, lifted: once for each piece it overlaps,
 * clipped to it — none where it was set aside, two where it was copied, and
 * one per piece where an edit cut through it.
 */
export function liftStretch(landings: ReadonlyMap<string, readonly ObjectLanding[]>, sequence: string, start: number, end: number): Lifted[] {
  const out: Lifted[] = []
  for (const landing of landings.get(sequence) ?? []) {
    const piece = landing.piece
    const lo = Math.max(start, piece.start)
    const hi = Math.min(end, piece.end)
    if (hi <= lo) continue
    out.push(
      piece.strand === 1
        ? { object: landing.object, start: landing.offset + (lo - piece.start), end: landing.offset + (hi - piece.start), strand: 1 }
        : { object: landing.object, start: landing.offset + (piece.end - hi), end: landing.offset + (piece.end - lo), strand: -1 },
    )
  }
  return out
}

/** One base's landing: the object and position the base at `bp` lands at, the first of them. */
function liftBase(landings: ReadonlyMap<string, readonly ObjectLanding[]>, sequence: string, bp: number): Lifted | null {
  return liftStretch(landings, sequence, bp, bp + 1)[0] ?? null
}

/** What a lifted file's header says about where it came from. */
export interface LiftContext {
  /** What was lifted: a track's label. */
  what: string
  /** The file whose edit it was lifted through. */
  file: string
  by: string
  created: string
}

function header(context: LiftContext, format: string): string {
  return `# ${context.what} as ${format}, lifted through the edit of ${context.file} by ${context.by} on ${context.created}`
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

/** Read bases of an original sequence, `[start, end)`: one ASCII byte each, case kept; `null` where the file has no such sequence. */
export type ReadBases = (sequence: string, start: number, end: number) => Promise<Uint8Array | null>

/** The most bases asked for at once: what one request to the annotation worker answers. */
export const FASTA_CHUNK = 400_000

/** Bases on a FASTA line. */
export const FASTA_WIDTH = 60

const NEWLINE = 10
const N = 78

/** A FASTA of the edited assembly, as the parts of a blob, and the sequences the file had none of. */
export interface FastaOut {
  parts: Uint8Array[]
  /** Original sequences the sequence file did not have: their pieces are written as `N`. */
  missing: string[]
  bases: number
}

/**
 * The edited assembly's sequence, piece by piece through ranged reads: each
 * edited sequence a record, a reversed piece reverse-complemented base for
 * base (case kept, so a soft-masked repeat stays one), a gap written as `N`,
 * sixty bases a line. A piece of a sequence the file lacks is written as `N`
 * and named, rather than written as nothing, so that every coordinate of the
 * AGP is still the same base in the FASTA.
 *
 * @returns `null` where `cancelled` said so.
 */
export async function fastaOf(
  assembly: EditedAssembly,
  read: ReadBases,
  options: { width?: number; onProgress?: (done: number, total: number) => void; cancelled?: () => boolean } = {},
): Promise<FastaOut | null> {
  const width = Math.max(1, Math.trunc(options.width ?? FASTA_WIDTH))
  const objects = assemblyObjects(assembly)
  const total = objects.reduce((sum, object) => sum + object.length, 0)
  const parts: Uint8Array[] = []
  const missing = new Set<string>()
  let buffer = new Uint8Array(1 << 20)
  let used = 0
  let column = 0
  let done = 0
  const flush = (): void => {
    if (used === 0) return
    parts.push(buffer.slice(0, used))
    used = 0
  }
  const put = (byte: number): void => {
    if (used === buffer.length) {
      flush()
      buffer = new Uint8Array(1 << 20)
    }
    buffer[used++] = byte
  }
  const base = (byte: number): void => {
    put(byte)
    column++
    if (column === width) {
      put(NEWLINE)
      column = 0
    }
  }
  const text = (line: string): void => {
    for (let i = 0; i < line.length; i++) put(line.charCodeAt(i) & 0x7f)
  }
  for (const object of objects) {
    if (column !== 0) {
      put(NEWLINE)
      column = 0
    }
    text(`>${object.name}\n`)
    for (const part of object.parts) {
      if (options.cancelled?.() === true) return null
      if (isGap(part)) {
        for (let k = 0; k < part.gap; k++) base(N)
        done += part.gap
        continue
      }
      const length = part.end - part.start
      // Forward, chunk by chunk from the start; reversed, from the end, each
      // chunk read backwards and complemented.
      for (let k = 0; k < length; k += FASTA_CHUNK) {
        const size = Math.min(FASTA_CHUNK, length - k)
        const from = part.strand === 1 ? part.start + k : part.end - k - size
        const bases = missing.has(part.sequence) ? null : await read(part.sequence, from, from + size)
        if (bases === null || bases.length !== size) {
          missing.add(part.sequence)
          for (let i = 0; i < size; i++) base(N)
        } else if (part.strand === 1) {
          for (let i = 0; i < size; i++) base(bases[i])
        } else {
          for (let i = size - 1; i >= 0; i--) base(complementByte(bases[i]))
        }
        done += size
        options.onProgress?.(done, total)
      }
    }
  }
  if (column !== 0) put(NEWLINE)
  flush()
  return { parts, missing: [...missing], bases: total }
}

// ---------------------------------------------------------------------------
// Features and pairs
// ---------------------------------------------------------------------------

/** How a lift went: rows written, and what did not survive it. */
export interface LiftCount {
  written: number
  /** Features set aside with what they lay on, or pairs one of whose anchors was. */
  dropped: number
  /** Features an edit cut through, written once per piece. */
  split: number
}

/**
 * A feature set lifted as BED6: each feature once per piece it lies on —
 * clipped there, its strand turned where the piece is — and not at all where
 * it lay on what was set aside.
 */
export function liftedFeaturesBed(set: FeatureSet, assembly: EditedAssembly, context: LiftContext): { text: string; count: LiftCount } {
  const landings = objectLandings(assemblyObjects(assembly))
  const rows: Array<{ object: string; start: number; end: number; line: string }> = []
  const count: LiftCount = { written: 0, dropped: 0, split: 0 }
  for (let i = 0; i < set.length; i++) {
    const contig = set.contigs[set.contig[i]]
    const lifted = liftStretch(landings, contig, set.start[i], set.end[i])
    if (lifted.length === 0) {
      count.dropped++
      continue
    }
    if (lifted.length > 1) count.split++
    const name = set.name[i] === '' ? `region_${i + 1}` : set.name[i]
    const score = Number.isFinite(set.score[i]) ? set.score[i] : 0
    for (const place of lifted) {
      const strand = set.strand[i] === 0 ? '.' : set.strand[i] * place.strand > 0 ? '+' : '-'
      rows.push({ object: place.object, start: place.start, end: place.end, line: [place.object, place.start, place.end, name, score, strand].join('\t') })
      count.written++
    }
  }
  sortRows(rows, assembly)
  return { text: `${[header(context, 'BED'), ...rows.map((row) => row.line)].join('\n')}\n`, count }
}

/**
 * A pair set lifted as BEDPE: each anchor at the place its middle base lands,
 * its extent lifted about it; a pair one of whose anchors was set aside is not
 * written, since half a loop is no loop.
 */
export function liftedPairsBedpe(set: PairSet, assembly: EditedAssembly, context: LiftContext): { text: string; count: LiftCount } {
  const landings = objectLandings(assemblyObjects(assembly))
  const rows: Array<{ object: string; start: number; end: number; line: string }> = []
  const count: LiftCount = { written: 0, dropped: 0, split: 0 }
  const anchor = (contig: string, start: number, end: number): Lifted | null => {
    const middle = liftBase(landings, contig, Math.floor((start + end - 1) / 2))
    if (middle === null) return null
    // The anchor's extent, where the piece its middle lands in holds it.
    const whole = liftStretch(landings, contig, start, end).find((place) => place.object === middle.object && place.start <= middle.start && place.end >= middle.end)
    return whole ?? middle
  }
  for (let i = 0; i < set.length; i++) {
    const a = anchor(set.contigs[set.contig1[i]], set.start1[i], set.end1[i])
    const b = anchor(set.contigs[set.contig2[i]], set.start2[i], set.end2[i])
    if (a === null || b === null) {
      count.dropped++
      continue
    }
    const name = set.name[i] === '' ? '.' : set.name[i]
    const score = Number.isFinite(set.score[i]) ? set.score[i] : '.'
    rows.push({ object: a.object, start: a.start, end: a.end, line: [a.object, a.start, a.end, b.object, b.start, b.end, name, score, '.', '.'].join('\t') })
    count.written++
  }
  sortRows(rows, assembly)
  return { text: `${[header(context, 'BEDPE'), ...rows.map((row) => row.line)].join('\n')}\n`, count }
}

/** Rows in the order the files write their sequences, then by start. */
function sortRows(rows: Array<{ object: string; start: number; end: number }>, assembly: EditedAssembly): void {
  const rank = new Map(assemblyObjects(assembly).map((object, i) => [object.name, i]))
  rows.sort((x, y) => (rank.get(x.object) ?? 0) - (rank.get(y.object) ?? 0) || x.start - y.start || x.end - y.end)
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

/** A signal's intervals over an original stretch, at the file's own resolution, or `null` where it has no such sequence. */
export type ReadSignal = (
  sequence: string,
  start: number,
  end: number,
) => Promise<{ starts: ArrayLike<number>; ends: ArrayLike<number>; values: ArrayLike<number>; summary: boolean } | null>

/** The widest stretch a signal is asked for at once. */
export const SIGNAL_CHUNK = 5_000_000

/** A signal lifted: its spans per sequence, as `writeBigWig` takes them. */
export interface LiftedSignal {
  contigs: BigWigContig[]
  spans: BigWigSpans[]
  /** Whether any of it came from a zoom level rather than the file's own resolution. */
  summary: boolean
  intervals: number
}

/**
 * A signal lifted through the edit: every interval of every piece, clipped to
 * it and carried to where the piece lands — mirrored where the piece is read
 * backwards — and nothing for a stretch set aside.
 *
 * @returns `null` where `cancelled` said so.
 */
export async function liftedSignal(
  assembly: EditedAssembly,
  read: ReadSignal,
  options: { onProgress?: (done: number, total: number) => void; cancelled?: () => boolean } = {},
): Promise<LiftedSignal | null> {
  const objects = assemblyObjects(assembly)
  const total = objects.reduce((sum, object) => sum + object.length, 0)
  const spans: BigWigSpans[] = []
  let summary = false
  let intervals = 0
  let done = 0
  for (const object of objects) {
    const starts: number[] = []
    const ends: number[] = []
    const values: number[] = []
    let offset = 0
    for (const part of object.parts) {
      if (options.cancelled?.() === true) return null
      if (isGap(part)) {
        offset += part.gap
        done += part.gap
        continue
      }
      const length = part.end - part.start
      const lifted: Array<[number, number, number]> = []
      for (let k = 0; k < length; k += SIGNAL_CHUNK) {
        const from = part.start + k
        const to = Math.min(part.end, from + SIGNAL_CHUNK)
        const got = await read(part.sequence, from, to)
        if (got !== null) {
          summary ||= got.summary
          for (let i = 0; i < got.values.length; i++) {
            const lo = Math.max(from, got.starts[i])
            const hi = Math.min(to, got.ends[i])
            const value = got.values[i]
            if (hi <= lo || !Number.isFinite(value)) continue
            lifted.push(
              part.strand === 1
                ? [offset + (lo - part.start), offset + (hi - part.start), value]
                : [offset + (part.end - hi), offset + (part.end - lo), value],
            )
          }
        }
        done += to - from
        options.onProgress?.(done, total)
      }
      // A reversed piece's intervals arrive last-first; each piece's own are
      // put in order before the next piece's follow them.
      lifted.sort((x, y) => x[0] - y[0])
      for (const [s, e, v] of lifted) {
        starts.push(s)
        ends.push(e)
        values.push(v)
      }
      offset += length
    }
    intervals += values.length
    if (values.length > 0) spans.push({ contig: object.name, starts, ends, values })
  }
  return { contigs: objects.map((object) => ({ name: object.name, length: object.length })), spans, summary, intervals }
}
