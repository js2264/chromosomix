/**
 * A real, BGZF-compressed, BAI-indexed BAM, written here.
 *
 * `bam-fixtures.ts` builds the *uncompressed* content, which is what the
 * decoders take and is all most tests need. This goes the rest of the way —
 * blocks, virtual offsets, a bin index and a linear index — because the oracle
 * test hands the result to somebody else's reader, and a fixture the oracle
 * cannot open tests nothing.
 *
 * The same role `hicWriter.ts` plays for `.hic`, and written for the same
 * reason: a format is a contract with other programs, and a fixture that only
 * this repo can produce is a contract with itself.
 */

import { bamBytes, bgzfBlock, concat, recordBytes, type TestRecord } from '../unit/bam-fixtures'

/**
 * The bin a record belongs in, by the BAI rule.
 *
 * A record goes in the smallest bin that wholly contains it, which is why a
 * read spanning a 16 kb boundary lands several levels up the tree — and why an
 * index reader that only ever looks at the deepest level silently misses long
 * reads.
 */
export function reg2bin(beg: number, end: number): number {
  const last = end - 1
  if (beg >> 14 === last >> 14) return 4681 + (beg >> 14)
  if (beg >> 17 === last >> 17) return 585 + (beg >> 17)
  if (beg >> 20 === last >> 20) return 73 + (beg >> 20)
  if (beg >> 23 === last >> 23) return 9 + (beg >> 23)
  if (beg >> 26 === last >> 26) return 1 + (beg >> 26)
  return 0
}

/** How far along the reference a spelled CIGAR reaches. */
function referenceSpan(cigar: string): number {
  let span = 0
  for (const [, length, op] of cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    if ('MDN=X'.includes(op)) span += Number(length)
  }
  return span
}

export interface WrittenBam {
  bam: Uint8Array
  bai: Uint8Array
}

/**
 * Write `records` as a BGZF BAM with a BAI beside it.
 *
 * `recordsPerBlock` decides the layout, and the two useful settings are the two
 * extremes of what a real file does.
 *
 * **One record per block** — the default — is pathological for a real file and
 * ideal for testing offsets: every record gets a distinct virtual offset whose
 * within-block part is zero, so a reader that drops the low sixteen bits and one
 * that keeps them cannot be told apart by luck.
 *
 * **Many records per block** is what `samtools` actually writes, and it is what
 * a budget assertion needs. A block holds tens of kilobytes of records, so the
 * chunk for a bin is a handful of blocks rather than hundreds — which is the
 * layout in which a windowed read is *visibly* a small part of the file, and it
 * exercises the non-zero within-block offsets a one-per-block file never
 * produces.
 */
export async function writeBam(
  refs: Array<{ name: string; length: number }>,
  records: TestRecord[],
  headerText = '@HD\tVN:1.6\tSO:coordinate\n',
  recordsPerBlock = 1,
  /**
   * Cut blocks at fixed byte boundaries, letting records straddle them.
   *
   * What `bgzf_write` actually does: it copies bytes into a buffer and flushes
   * when the buffer is full, with no idea that records exist. So a record
   * beginning near the end of a block continues into the next one, routinely,
   * in every file `samtools` has ever written — and a reader that starts its
   * walk at the beginning of a block rather than at the virtual offset's own
   * within-block part begins in the middle of a record and reads its bytes as
   * a length. The two block layouts above cannot catch that, because both put
   * every record wholly inside one block.
   */
  straddle = false,
): Promise<WrittenBam> {
  if (straddle) return writeStraddled(refs, records, headerText)
  const headerBlock = await bgzfBlock(bamBytes(refs, [], headerText))
  const blocks: Uint8Array[] = [headerBlock]
  let at = headerBlock.length

  // Chunks per (ref, bin), and the linear index per ref, built as we place
  // each record — the index has to describe the layout, so it is written from
  // the layout rather than from the records.
  const bins = refs.map(() => new Map<number, Array<[bigint, bigint]>>())
  const linear = refs.map(() => [] as number[])

  for (const { group, encoded } of blocksOf(records, recordsPerBlock)) {
    const block = await bgzfBlock(concat(encoded))
    const blockAt = at
    blocks.push(block)
    at += block.length

    // Each record's virtual offset is this block's start in the file, shifted
    // up sixteen bits, plus where the record begins *inside* the inflated
    // block — which is the half `parseTabix` throws away and this must not.
    let within = 0
    for (let i = 0; i < group.length; i++) {
      const record = group[i]
      const begin = (BigInt(blockAt) << 16n) | BigInt(within)
      within += encoded[i].length
      const end = (BigInt(blockAt) << 16n) | BigInt(within)

      const span = referenceSpan(record.cigar)
      const bin = reg2bin(record.pos, record.pos + Math.max(1, span))
      const forRef = bins[record.refId]
      const held = forRef.get(bin)
      if (held === undefined) forRef.set(bin, [[begin, end]])
      else held.push([begin, end])

      // The linear index: the lowest offset of any record overlapping each
      // 16 kb window the record touches.
      const slots = linear[record.refId]
      const first = record.pos >> 14
      const last = (record.pos + Math.max(1, span) - 1) >> 14
      for (let slot = first; slot <= last; slot++) {
        if (slots[slot] === undefined) slots[slot] = blockAt
      }
    }
  }

  // The empty block that marks a bgzipped file's end.
  blocks.push(await bgzfBlock(new Uint8Array(0)))

  return { bam: concat(blocks), bai: writeBai(bins, linear) }
}

function writeBai(
  bins: Array<Map<number, Array<[bigint, bigint]>>>,
  linear: number[][],
): Uint8Array {
  let size = 8
  for (let ref = 0; ref < bins.length; ref++) {
    size += 4
    for (const chunks of bins[ref].values()) size += 8 + chunks.length * 16
    size += 4 + filled(linear[ref]).length * 8
  }
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out.set([0x42, 0x41, 0x49, 1], 0)
  view.setInt32(4, bins.length, true)
  let at = 8
  for (let ref = 0; ref < bins.length; ref++) {
    view.setInt32(at, bins[ref].size, true)
    at += 4
    for (const [bin, chunks] of bins[ref]) {
      view.setUint32(at, bin, true)
      at += 4
      view.setInt32(at, chunks.length, true)
      at += 4
      for (const [begin, end] of chunks) {
        view.setBigUint64(at, begin, true)
        view.setBigUint64(at + 8, end, true)
        at += 16
      }
    }
    const slots = filled(linear[ref])
    view.setInt32(at, slots.length, true)
    at += 4
    for (const offset of slots) {
      view.setBigUint64(at, BigInt(offset) << 16n, true)
      at += 8
    }
  }
  return out
}

/**
 * The same file, with blocks cut at byte boundaries rather than record ones.
 *
 * The record stream is built whole and then sliced, exactly as `bgzf_write`
 * slices its buffer, so a record that does not happen to end on a block
 * boundary continues into the block after it. Every record's virtual offset
 * therefore carries a genuine within-block part, and a reader that ignores it
 * starts mid-record.
 */
async function writeStraddled(
  refs: Array<{ name: string; length: number }>,
  records: TestRecord[],
  headerText: string,
): Promise<WrittenBam> {
  const headerBlock = await bgzfBlock(bamBytes(refs, [], headerText))
  const encoded = records.map((record) => recordBytes(record))

  // Where each record begins in the uncompressed stream of records.
  const startsAt: number[] = []
  let total = 0
  for (const one of encoded) {
    startsAt.push(total)
    total += one.length
  }
  const stream = concat(encoded)

  // Cut the stream into equal pieces and compress each, remembering where each
  // piece began in the stream and where its block landed in the file.
  const blocks: Uint8Array[] = [headerBlock]
  const pieceStartsAt: number[] = []
  const pieceFileAt: number[] = []
  let at = headerBlock.length
  for (let from = 0; from < stream.length; from += MAX_BLOCK_PAYLOAD) {
    const piece = stream.subarray(from, Math.min(from + MAX_BLOCK_PAYLOAD, stream.length))
    const block = await bgzfBlock(piece)
    pieceStartsAt.push(from)
    pieceFileAt.push(at)
    blocks.push(block)
    at += block.length
  }
  blocks.push(await bgzfBlock(new Uint8Array(0)))

  /** The virtual offset of a byte position in the record stream. */
  const virtualOf = (streamAt: number): bigint => {
    let piece = 0
    while (piece + 1 < pieceStartsAt.length && pieceStartsAt[piece + 1] <= streamAt) piece++
    return (BigInt(pieceFileAt[piece]) << 16n) | BigInt(streamAt - pieceStartsAt[piece])
  }

  const bins = refs.map(() => new Map<number, Array<[bigint, bigint]>>())
  const linear = refs.map(() => [] as number[])
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const begin = virtualOf(startsAt[i])
    const end = virtualOf(startsAt[i] + encoded[i].length)
    const span = referenceSpan(record.cigar)
    const bin = reg2bin(record.pos, record.pos + Math.max(1, span))
    const forRef = bins[record.refId]
    const held = forRef.get(bin)
    if (held === undefined) forRef.set(bin, [[begin, end]])
    else held.push([begin, end])

    const slots = linear[record.refId]
    const first = record.pos >> 14
    const last = (record.pos + Math.max(1, span) - 1) >> 14
    for (let slot = first; slot <= last; slot++) {
      // The block the record *starts* in — a floor, so the block holding its
      // first byte is the one a query must begin reading at.
      if (slots[slot] === undefined) slots[slot] = Number(begin >> 16n)
    }
  }

  return { bam: concat(blocks), bai: writeBai(bins, linear) }
}

/**
 * How much uncompressed data a block may hold here.
 *
 * Under BGZF's 64 KiB ceiling with room to spare, because deflate can *expand*
 * incompressible input slightly and a fixture full of random sequence is
 * exactly that. `recordsPerBlock` is a cap and this is the real bound: a caller
 * asking for a hundred 4 kb reads in one block is asking for six hundred
 * kilobytes, and the block-size field is sixteen bits.
 */
const MAX_BLOCK_PAYLOAD = 58_000

/** Group records into blocks that fit, honouring the caller's cap as a maximum. */
function blocksOf(
  records: TestRecord[],
  recordsPerBlock: number,
): Array<{ group: TestRecord[]; encoded: Uint8Array[] }> {
  const out: Array<{ group: TestRecord[]; encoded: Uint8Array[] }> = []
  let group: TestRecord[] = []
  let encoded: Uint8Array[] = []
  let bytes = 0
  for (const record of records) {
    const one = recordBytes(record)
    if (group.length > 0 && (group.length >= recordsPerBlock || bytes + one.length > MAX_BLOCK_PAYLOAD)) {
      out.push({ group, encoded })
      group = []
      encoded = []
      bytes = 0
    }
    group.push(record)
    encoded.push(one)
    bytes += one.length
  }
  if (group.length > 0) out.push({ group, encoded })
  return out
}

/**
 * A linear index with no holes.
 *
 * A window with no record of its own inherits the last offset seen, which is
 * what makes the array a *floor* rather than a lookup: a query landing in an
 * empty window must still be told where to start reading.
 */
function filled(slots: number[]): number[] {
  const out: number[] = []
  let last = 0
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== undefined) last = slots[i]
    out.push(last)
  }
  return out
}
