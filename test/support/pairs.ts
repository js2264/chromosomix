/**
 * Synthetic `.pairs` files, and the brute-force binning they are checked against.
 *
 * The importer's whole job is to turn records into a pixel table, so the only
 * check worth much is a *second* implementation of the same arithmetic written
 * the slow, obvious way — a map keyed by `${bin1}:${bin2}`, no scratch rows, no
 * hashing, no assumptions about order. {@link referenceBin} is that, and it is
 * deliberately written to look nothing like `pairs/bin.ts`.
 */

import { gzipSync, deflateRawSync, crc32 } from 'node:zlib'

import type { ByteSource, SourceStats } from '@/types'

/** A `ByteSource` over bytes already in hand. */
export class BytesSource implements ByteSource {
  readonly id: string
  readonly size: number
  constructor(
    private readonly data: Uint8Array,
    id = 'sample.pairs.gz',
  ) {
    this.size = data.byteLength
    this.id = id
  }
  async mount(): Promise<string> {
    return this.id
  }
  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    return this.data.subarray(position, position + n).slice()
  }
  stats(): SourceStats {
    return { requests: 0, bytes: 0 }
  }
  close(): void {}
}

export interface Contig {
  name: string
  length: number
}

/** One record, in the spec's own coordinates: **1-based** positions. */
export interface Record {
  chrom1: string
  pos1: number
  chrom2: string
  pos2: number
}

export interface PairsTextOptions {
  contigs: readonly Contig[]
  records: readonly Record[]
  /** Omitted entirely when `null`; the spec's order when absent. */
  columns?: string[] | null
  sorted?: string | null
  assembly?: string | null
  /** Drop the `## pairs format` preamble, to exercise the refusal. */
  noPreamble?: boolean
  /** Emit sizes as an embedded SAM header instead of `#chromsize:`. */
  samHeaderSizes?: boolean
}

/** Render a `.pairs` file as text. */
export function pairsText(options: PairsTextOptions): string {
  const lines: string[] = []
  if (options.noPreamble !== true) lines.push('## pairs format v1.0')
  if (options.sorted !== null) lines.push(`#sorted: ${options.sorted ?? 'chr1-chr2-pos1-pos2'}`)
  lines.push('#shape: upper triangle')
  if (options.assembly != null) lines.push(`#genome_assembly: ${options.assembly}`)
  for (const contig of options.contigs) {
    lines.push(
      options.samHeaderSizes === true
        ? `#samheader: @SQ\tSN:${contig.name}\tLN:${contig.length}`
        : `#chromsize: ${contig.name} ${contig.length}`,
    )
  }
  if (options.columns !== null) {
    const columns = options.columns ?? ['readID', 'chr1', 'pos1', 'chr2', 'pos2', 'strand1', 'strand2']
    lines.push(`#columns: ${columns.join(' ')}`)
  }
  let id = 0
  for (const record of options.records) {
    lines.push(
      `SRR.${id++}\t${record.chrom1}\t${record.pos1}\t${record.chrom2}\t${record.pos2}\t+\t-`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** Plain-gzip the text, which is what a `.gz` with no index usually is. */
export function gzipped(text: string): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(text, 'utf8')))
}

/**
 * BGZF the text: gzip members of bounded size, each carrying a `BC` subfield.
 *
 * Written here rather than shelled out to `bgzip` for the same reason
 * `test/support/hicWriter.ts` exists — a fixture a CI runner cannot build is a
 * test that does not run.
 */
export function bgzipped(text: string, blockSize = 1 << 14): Uint8Array {
  return bgzipBytes(Buffer.from(text, 'utf8'), blockSize)
}

/** The same, for bytes that are not text — a `.px2` is binary. */
export function bgzipBytes(data: Uint8Array, blockSize = 1 << 14): Uint8Array {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return bgzipFrom(buffer, blockSize)
}

function bgzipFrom(data: Buffer, blockSize: number): Uint8Array {
  const parts: Buffer[] = []
  for (let at = 0; at < data.length || at === 0; at += blockSize) {
    const slice = data.subarray(at, Math.min(at + blockSize, data.length))
    parts.push(bgzfBlock(slice))
    if (slice.length === 0) break
  }
  // The 28-byte empty block that marks a well-formed BGZF end of file.
  parts.push(bgzfBlock(Buffer.alloc(0)))
  return new Uint8Array(Buffer.concat(parts))
}

function bgzfBlock(payload: Buffer): Buffer {
  const deflated = deflateRawSync(payload, { level: 6 })
  const total = 12 + 6 + deflated.length + 8
  const header = Buffer.alloc(18)
  header.writeUInt8(0x1f, 0)
  header.writeUInt8(0x8b, 1)
  header.writeUInt8(8, 2)
  header.writeUInt8(4, 3) // FEXTRA
  header.writeUInt32LE(0, 4) // MTIME
  header.writeUInt8(0, 8) // XFL
  header.writeUInt8(0xff, 9) // OS
  header.writeUInt16LE(6, 10) // XLEN
  header.writeUInt8(66, 12) // 'B'
  header.writeUInt8(67, 13) // 'C'
  header.writeUInt16LE(2, 14) // subfield length
  header.writeUInt16LE(total - 1, 16) // BSIZE - 1
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(payload) >>> 0, 0)
  trailer.writeUInt32LE(payload.length >>> 0, 4)
  return Buffer.concat([header, deflated, trailer])
}

export interface ReferencePixels {
  /** `"bin1:bin2" -> count`, upper-triangular, global bin coordinates. */
  cells: Map<string, number>
  nBins: number
  sum: number
}

/**
 * Bin the records the slow, obvious way.
 *
 * Deliberately unlike the implementation: a string-keyed map, one record at a
 * time, no ordering assumption anywhere. If this and `binPairs` agree on a
 * shuffled file, on a sorted file and on the boundaries, the fast path's three
 * optimisations are all sound.
 */
export function referenceBin(
  contigs: readonly Contig[],
  records: readonly Record[],
  binSize: number,
): ReferencePixels {
  const offsets = new Map<string, number>()
  let at = 0
  for (const contig of contigs) {
    offsets.set(contig.name, at)
    at += Math.ceil(contig.length / binSize)
  }
  const lengths = new Map(contigs.map((contig) => [contig.name, contig.length]))
  const cells = new Map<string, number>()
  let sum = 0
  for (const record of records) {
    const base1 = offsets.get(record.chrom1)
    const base2 = offsets.get(record.chrom2)
    if (base1 === undefined || base2 === undefined) continue
    const cap1 = Math.ceil(lengths.get(record.chrom1)! / binSize) - 1
    const cap2 = Math.ceil(lengths.get(record.chrom2)! / binSize) - 1
    // 1-based in, zero-based bin out.
    let b1 = base1 + Math.min(cap1, Math.floor((record.pos1 - 1) / binSize))
    let b2 = base2 + Math.min(cap2, Math.floor((record.pos2 - 1) / binSize))
    if (b1 > b2) [b1, b2] = [b2, b1]
    const key = `${b1}:${b2}`
    cells.set(key, (cells.get(key) ?? 0) + 1)
    sum++
  }
  return { cells, nBins: at, sum }
}

/** A deterministic pseudo-random generator, so a failure is reproducible. */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Sort records into the file order `#sorted: chr1-chr2-pos1-pos2` declares. */
export function sortRecords(
  contigs: readonly Contig[],
  records: readonly Record[],
): Record[] {
  const rank = new Map(contigs.map((contig, i) => [contig.name, i]))
  return [...records].sort((a, b) => {
    const c1 = (rank.get(a.chrom1) ?? -1) - (rank.get(b.chrom1) ?? -1)
    if (c1 !== 0) return c1
    const c2 = (rank.get(a.chrom2) ?? -1) - (rank.get(b.chrom2) ?? -1)
    if (c2 !== 0) return c2
    if (a.pos1 !== b.pos1) return a.pos1 - b.pos1
    return a.pos2 - b.pos2
  })
}
