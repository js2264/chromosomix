/**
 * References named with `--sequence`, opened the way the annotations worker
 * opens them (§8.8, §8.21).
 *
 * A reference used to be read whole here, always — `readFile`, then the same
 * `parseFasta` the worker runs — and the reason it could be is the one
 * `cli/main.ts` gave: there is no thread to cross, so none of the cap that
 * keeps a genome inside the worker. What there is instead is Node's own
 * ceiling: `readFile` refuses a file over 2 GiB, so a plain mouse or human
 * FASTA was refused before a byte of it was parsed, and the motif search —
 * the one task that can take a genome a piece at a time — could not be run on
 * one from a shell at all.
 *
 * So a reference is opened by **whichever road the browser would take**:
 *
 * - a `.2bit`, by range through its own index, settled by its magic exactly as
 *   `cli/tracks.ts` settles it for a track;
 * - a plain FASTA with its `.fai` beside it — `samtools faidx`'s spelling,
 *   `genome.fa.fai` — by range through the index;
 * - anything else whole, gzipped or not, as before.
 *
 * And by range whether it is on this disk or at an address: a ranged reference
 * reads through a descriptor for a path and through the app's range source for
 * an address (`cli/remote.ts`), whose `.fai` is looked for beside it, so a
 * remote genome is read a window at a time without being fetched at all.
 *
 * Either way it answers {@link Reference}: `bases` for a task that wants a
 * whole sequence, and for a reference read by range also `read`, which is the
 * door the motif search and base composition walk a genome through without
 * holding it. `bases` over a ranged reference reads the sequence from disk and
 * keeps the last one asked for — the origin call asks for each in turn, and a
 * GC vector asks for one sequence's windows one after another — so a run holds
 * a chromosome at a time and never the genome.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { looksLikeFasta, parseFasta, type SequenceStore } from '../annotations/fasta'
import { byteRange, contigsOf, parseFai, residuesIn, residuesInLines, type FaiRecord } from '../annotations/fai'
import { WHOLE_FILE_INFLATION, decodeAnnotationBytes } from '../annotations/parse'
import { FASTA_NAME } from '../annotations/sidecar'
import {
  contigsOfRecords,
  dnaByteRange,
  looksLikeTwoBit,
  openTwoBit,
  unpackDna,
  type TwoBitRecord,
} from '../annotations/twobit'
import type { Contig } from '../genome/assembly'
import { contigIndexOf } from '../genome/naming'
import { inflationCap } from '../sources/untrusted'
import { fileNameOf, wholeBytes, type Where } from './remote'

/** A loaded reference, however it was opened. */
export interface Reference {
  /** The file's sequences, in its own order, with the lengths it states. */
  readonly contigs: readonly Contig[]
  /** Residues across every sequence. */
  readonly total: number
  /**
   * One sequence's residues, whole, by the §5.9 ladder of names — read from
   * disk for a reference opened by range, held for one read whole.
   */
  bases(contig: string): Uint8Array | undefined
  /** A window, read where it lies and not kept; only on a reference opened by range. */
  read?(contig: string, start: number, end: number): Promise<Uint8Array | undefined>
}

/** `readFile`'s ceiling: past it Node refuses the read before it starts. */
const WHOLE_READ_MAX = 2 ** 31 - 1

/** One `readSync` is limited to this; a longer read is several. */
const SYNC_READ_MAX = 1 << 30

/** A file read by range: a descriptor's `pread`s, or a range source's. */
interface Ranged {
  readonly size: number
  read(length: number, position: number): Uint8Array
  /**
   * Whether each read is a fresh array nobody else holds — a descriptor's is,
   * a range source's may be a slice of its cache — and so one the residues can
   * be gathered in where they lie.
   */
  readonly fresh: boolean
  close(): void
}

/** The ranged reader for wherever a reference's bytes are. */
function rangedOf(where: Where): Ranged {
  if (where.kind === 'range') {
    const { source } = where
    return {
      size: source.size,
      read: (length, position) => source.readBytes(position, length),
      fresh: false,
      close: () => source.close(),
    }
  }
  const fd = openSync(where.path, 'r')
  return {
    size: fstatSync(fd).size,
    read: (length, position) => readAt(fd, length, position),
    fresh: true,
    close: () => closeSync(fd),
  }
}

/**
 * Open one `--sequence`, from a path or wherever `cli/remote.ts` says its bytes
 * are. `faiText` answers the text of a sidecar beside it, or `null` where there
 * is none — a path's by its directory, an address's by the address beside it.
 */
export async function openReference(
  at: string | Where,
  faiText: (name: string) => Promise<string | null> = async (name) => {
    if (typeof at !== 'string') return null
    const path = join(dirname(at), name)
    return existsSync(path) ? readFile(path, 'utf8') : null
  },
): Promise<Reference> {
  const where: Where = typeof at === 'string' ? { kind: 'disk', path: at } : at
  const name = where.kind === 'disk' ? basename(where.path) : fileNameOf(where.source.url)
  const file = rangedOf(where)
  const head = file.read(4, 0)
  if (looksLikeTwoBit(head)) return openTwoBitReference(file)
  if (FASTA_NAME.test(name)) {
    const text = await faiText(`${name}.fai`)
    // An index that does not parse is no index, and the answer to that is the
    // read that always worked — the worker's terms for the same failure.
    const records = text === null ? [] : parseFai(text)
    if (records.length > 0) return indexedReference(file, records)
  }
  // Read whole, so the handle opened to sniff it is not kept: a ranged
  // reference holds its own for the run, and a held one needs none.
  file.close()
  return wholeReference(where, name, file.size)
}

/** A FASTA read whole, as every reference used to be. */
async function wholeReference(where: Where, name: string, size: number): Promise<Reference> {
  if (size > WHOLE_READ_MAX) {
    throw new Error(
      `${name} is ${(size / 1e9).toFixed(1)} GB and has no index, and a file past 2 GiB cannot be ` +
        `read whole. Index it (\`samtools faidx ${name}\`) and keep the .fai beside it: an indexed ` +
        'FASTA is read by range.',
    )
  }
  // Through `decodeAnnotationBytes` rather than `readFile` alone, so a
  // `.fa.gz` is a reference and not a parse error: every other path into this
  // command already accepts one, and a reference is the file most likely to be
  // big enough that somebody kept it compressed — and capped in proportion to
  // the file rather than at the text ceiling, since residues are kept as bytes
  // and a gzipped hg38 is 3.1 GB of them.
  const compressed = await wholeBytes(where)
  const bytes = await decodeAnnotationBytes(compressed, inflationCap(compressed.length, WHOLE_FILE_INFLATION))
  if (!looksLikeFasta(bytes)) {
    throw new Error(
      `${name} is not a FASTA: a reference begins with a > line naming its first sequence, and ` +
        'this one does not.',
    )
  }
  return heldReference(parseFasta(bytes))
}

/** A parsed store, answering by the worker's `basesOf` ladder: exact, then §5.9. */
export function heldReference(store: SequenceStore): Reference {
  return {
    contigs: store.contigs,
    total: store.total,
    bases: (contig) => {
      const direct = store.bases.get(contig)
      if (direct !== undefined) return direct
      const at = contigIndexOf(store.contigs, contig)
      return at < 0 ? undefined : store.bases.get(store.contigs[at].name)
    },
  }
}

/** A FASTA read through the `.fai` beside it. */
function indexedReference(file: Ranged, records: FaiRecord[]): Reference {
  const contigs = contigsOf(records)
  const window = (record: FaiRecord, from: number, to: number): Uint8Array => {
    const range = byteRange(record, from, to)
    const bytes = file.read(range.to - range.from, range.from)
    return file.fresh ? residuesInLines(bytes, record, from) : residuesIn(bytes)
  }
  return rangedReference(contigs, records, window)
}

/** A `.2bit`, read through its own index. */
async function openTwoBitReference(ranged: Ranged): Promise<Reference> {
  // The size, so a count in the file is checked against the bytes it really has.
  const file = await openTwoBit(async (length, position) => ranged.read(length, position), ranged.size)
  const window = (record: TwoBitRecord, from: number, to: number): Uint8Array => {
    const range = dnaByteRange(record, from, to)
    return unpackDna(ranged.read(range.to - range.from, range.from), range.firstBase, record, from, to)
  }
  return rangedReference(contigsOfRecords(file.ordered), file.ordered, window)
}

/**
 * The two ranged roads, which differ only in how a window becomes bytes.
 *
 * `bases` keeps the last sequence it read and nothing else; `read` keeps
 * nothing at all, because the search reading through it is walking the genome
 * and anything it left behind would be a genome's worth by the end.
 */
function rangedReference<T extends { name: string; length: number }>(
  contigs: Contig[],
  records: readonly T[],
  window: (record: T, from: number, to: number) => Uint8Array,
): Reference {
  const recordOf = (contig: string): T | undefined => {
    const at = contigIndexOf(contigs, contig)
    return at < 0 ? undefined : records[at]
  }
  let last: { name: string; bases: Uint8Array } | null = null
  return {
    contigs,
    total: contigs.reduce((sum, contig) => sum + contig.length, 0),
    bases: (contig) => {
      const record = recordOf(contig)
      if (record === undefined) return undefined
      if (last?.name !== record.name) last = { name: record.name, bases: window(record, 0, record.length) }
      return last.bases
    },
    read: async (contig, start, end) => {
      const record = recordOf(contig)
      if (record === undefined) return undefined
      const from = Math.max(0, Math.floor(start))
      const to = Math.min(record.length, Math.ceil(end))
      return to > from ? window(record, from, to) : new Uint8Array(0)
    },
  }
}

/** `length` bytes at `position`, in reads `readSync` will take. */
function readAt(fd: number, length: number, position: number): Uint8Array {
  const out = new Uint8Array(length)
  let filled = 0
  while (filled < length) {
    const got = readSync(fd, out, filled, Math.min(SYNC_READ_MAX, length - filled), position + filled)
    if (got === 0) break
    filled += got
  }
  return filled === length ? out : out.subarray(0, filled)
}
