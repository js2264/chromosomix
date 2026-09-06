/**
 * BAM and BAI bytes, built here rather than checked in.
 *
 * The same discipline as `tabix.test.ts`: a fixture this suite writes byte by
 * byte is a fixture whose layout is asserted by every test that reads it, and
 * it costs no repository space and no `make_fixtures.py` run — so these tests
 * are part of `test:nofixtures` and stay runnable on a clean clone.
 */

/** Deflate one payload, raw, the way a BGZF member holds it. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The largest a BGZF member may be. The format guarantees it; `BSIZE` is 16 bits. */
export const MAX_BLOCK = 1 << 16

/**
 * CRC-32, the gzip polynomial, computed on the fly.
 *
 * A table would be faster and these are fixtures. What matters is that it is
 * *there*: the trailer used to be written as a zero, which `tabix.ts`'s own
 * inflater never looks at — so every BAM fixture in this suite was a gzip
 * member no gzip decoder would accept, and nothing noticed because only the
 * lenient reader ever read one. The moment a fixture went through the
 * platform's `DecompressionStream`, which is the road every *text* format takes
 * (`decodeAnnotationBytes`), it failed with an empty `TypeError` some distance
 * from the cause.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Wrap a payload as one BGZF member, `BC` subfield and all.
 *
 * Refuses a payload that would not fit rather than writing one that does not.
 * `BSIZE` is a `uint16`, so an oversized block truncates silently and produces
 * a file whose blocks appear to be a few hundred bytes long — which reads as a
 * corrupt file rather than as a fixture bug, some distance from here.
 */
export async function bgzfBlock(payload: Uint8Array): Promise<Uint8Array> {
  const deflated = await deflateRaw(payload)
  const total = 12 + 6 + deflated.length + 8
  if (total > MAX_BLOCK) {
    throw new Error(
      `a BGZF block cannot exceed ${MAX_BLOCK} bytes and this one is ${total}: ` +
        'split the records across more blocks',
    )
  }
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out.set([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff], 0)
  view.setUint16(10, 6, true)
  out[12] = 66
  out[13] = 67
  view.setUint16(14, 2, true)
  view.setUint16(16, total - 1, true)
  out.set(deflated, 18)
  view.setUint32(18 + deflated.length, crc32(payload), true)
  view.setUint32(18 + deflated.length + 4, payload.length, true)
  return out
}

const CIGAR_CODE: Record<string, number> = {
  M: 0, I: 1, D: 2, N: 3, S: 4, H: 5, P: 6, '=': 7, X: 8,
}

/** `100M`, `10M200N90M` — the human spelling, packed as the format stores it. */
export function packCigar(spec: string): number[] {
  const out: number[] = []
  for (const [, length, op] of spec.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    out.push((Number(length) << 4) | CIGAR_CODE[op])
  }
  return out
}

const SEQ_CODE: Record<string, number> = {
  '=': 0, A: 1, C: 2, M: 3, G: 4, R: 5, S: 6, V: 7,
  T: 8, W: 9, Y: 10, H: 11, K: 12, D: 13, B: 14, N: 15,
}

function packSeq(seq: string): Uint8Array {
  const out = new Uint8Array((seq.length + 1) >> 1)
  for (let i = 0; i < seq.length; i++) {
    const code = SEQ_CODE[seq[i]] ?? 15
    if (i % 2 === 0) out[i >> 1] |= code << 4
    else out[i >> 1] |= code
  }
  return out
}

export interface TestRecord {
  refId: number
  pos: number
  mapq?: number
  flag?: number
  cigar: string
  seq?: string
  name?: string
  nextRefId?: number
  nextPos?: number
  tlen?: number
  /** Raw tag bytes, appended verbatim — built by {@link tagBytes}. */
  tags?: Uint8Array
}

/** One alignment record, length prefix and all. */
export function recordBytes(record: TestRecord): Uint8Array {
  const name = record.name ?? 'r1'
  const nameBytes = new TextEncoder().encode(name + '\0')
  const cigar = packCigar(record.cigar)
  const seq = record.seq ?? ''
  const packedSeq = packSeq(seq)
  const tags = record.tags ?? new Uint8Array(0)
  const size =
    32 + nameBytes.length + cigar.length * 4 + packedSeq.length + seq.length + tags.length
  const out = new Uint8Array(4 + size)
  const view = new DataView(out.buffer)
  view.setInt32(0, size, true)
  view.setInt32(4, record.refId, true)
  view.setInt32(8, record.pos, true)
  view.setUint8(12, nameBytes.length)
  view.setUint8(13, record.mapq ?? 60)
  view.setUint16(14, 0, true) // bin; never read back
  view.setUint16(16, cigar.length, true)
  view.setUint16(18, record.flag ?? 0, true)
  view.setInt32(20, seq.length, true)
  view.setInt32(24, record.nextRefId ?? -1, true)
  view.setInt32(28, record.nextPos ?? -1, true)
  view.setInt32(32, record.tlen ?? 0, true)
  let at = 36
  out.set(nameBytes, at)
  at += nameBytes.length
  for (const op of cigar) {
    view.setUint32(at, op, true)
    at += 4
  }
  out.set(packedSeq, at)
  at += packedSeq.length
  // Quality: 0xff throughout is the format's "absent".
  out.fill(0xff, at, at + seq.length)
  at += seq.length
  out.set(tags, at)
  return out
}

/** Concatenate tag entries into one block. */
export function tagBytes(
  tags: Array<
    | { tag: string; type: 'Z'; value: string }
    | { tag: string; type: 'i'; value: number }
    | { tag: string; type: 'A'; value: string }
    | { tag: string; type: 'B'; subtype: 'I'; value: number[] }
  >,
): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of tags) {
    const head = new TextEncoder().encode(entry.tag + entry.type)
    if (entry.type === 'Z') {
      parts.push(head, new TextEncoder().encode(entry.value + '\0'))
    } else if (entry.type === 'A') {
      parts.push(head, new TextEncoder().encode(entry.value))
    } else if (entry.type === 'i') {
      const buf = new Uint8Array(4)
      new DataView(buf.buffer).setInt32(0, entry.value, true)
      parts.push(head, buf)
    } else {
      const buf = new Uint8Array(5 + entry.value.length * 4)
      const view = new DataView(buf.buffer)
      buf[0] = 'I'.charCodeAt(0)
      view.setInt32(1, entry.value.length, true)
      entry.value.forEach((v, i) => view.setUint32(5 + i * 4, v, true))
      parts.push(head, buf)
    }
  }
  return concat(parts)
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** The uncompressed content of a BAM: header, reference table, then records. */
export function bamBytes(
  refs: Array<{ name: string; length: number }>,
  records: TestRecord[],
  headerText = '@HD\tVN:1.6\tSO:coordinate\n',
): Uint8Array {
  const text = new TextEncoder().encode(headerText)
  const parts: Uint8Array[] = []
  const head = new Uint8Array(8)
  const headView = new DataView(head.buffer)
  head.set([0x42, 0x41, 0x4d, 1], 0)
  headView.setInt32(4, text.length, true)
  parts.push(head, text)
  const count = new Uint8Array(4)
  new DataView(count.buffer).setInt32(0, refs.length, true)
  parts.push(count)
  for (const ref of refs) {
    const nameBytes = new TextEncoder().encode(ref.name + '\0')
    const entry = new Uint8Array(4 + nameBytes.length + 4)
    const view = new DataView(entry.buffer)
    view.setInt32(0, nameBytes.length, true)
    entry.set(nameBytes, 4)
    view.setInt32(4 + nameBytes.length, ref.length, true)
    parts.push(entry)
  }
  for (const record of records) parts.push(recordBytes(record))
  return concat(parts)
}

export interface TestBin {
  bin: number
  chunks: Array<[number, number]>
}

/** A `.bai` body — uncompressed, which is how a BAI is actually stored. */
export function baiBytes(
  refs: Array<{ bins: TestBin[]; linear: number[] }>,
): Uint8Array {
  let size = 8
  for (const ref of refs) {
    size += 4
    for (const bin of ref.bins) size += 8 + bin.chunks.length * 16
    size += 4 + ref.linear.length * 8
  }
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out.set([0x42, 0x41, 0x49, 1], 0)
  view.setInt32(4, refs.length, true)
  let at = 8
  for (const ref of refs) {
    view.setInt32(at, ref.bins.length, true)
    at += 4
    for (const bin of ref.bins) {
      view.setUint32(at, bin.bin, true)
      at += 4
      view.setInt32(at, bin.chunks.length, true)
      at += 4
      for (const [from, to] of bin.chunks) {
        view.setBigUint64(at, BigInt(from) << 16n, true)
        view.setBigUint64(at + 8, BigInt(to) << 16n, true)
        at += 16
      }
    }
    view.setInt32(at, ref.linear.length, true)
    at += 4
    for (const offset of ref.linear) {
      view.setBigUint64(at, BigInt(offset) << 16n, true)
      at += 8
    }
  }
  return out
}

export interface TestCsiBin {
  bin: number
  /** The lowest virtual offset in this bin — CSI's stand-in for a linear index. */
  loffset: number
  chunks: Array<[number, number]>
}

/**
 * A `.csi` body — **uncompressed**; wrap it with {@link bgzfBlock} to make a file.
 *
 * CSI is the index a reference longer than 2^29 bp must have, because BAI
 * cannot address one. It differs from BAI in three ways that all matter to a
 * reader: its geometry is declared rather than fixed, it carries a `loffset`
 * per bin instead of a linear index, and — unlike a `.bai` — it is BGZF
 * compressed, like a `.tbi`.
 */
export function csiBytes(
  refs: TestCsiBin[][],
  minShift = 14,
  depth = 6,
  aux = new Uint8Array(0),
): Uint8Array {
  let size = 16 + aux.length + 4
  for (const bins of refs) {
    size += 4
    for (const bin of bins) size += 4 + 8 + 4 + bin.chunks.length * 16
  }
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out.set([0x43, 0x53, 0x49, 1], 0) // 'CSI\1'
  view.setInt32(4, minShift, true)
  view.setInt32(8, depth, true)
  view.setInt32(12, aux.length, true)
  out.set(aux, 16)
  let at = 16 + aux.length
  view.setInt32(at, refs.length, true)
  at += 4
  for (const bins of refs) {
    view.setInt32(at, bins.length, true)
    at += 4
    for (const bin of bins) {
      view.setUint32(at, bin.bin, true)
      at += 4
      view.setBigUint64(at, BigInt(bin.loffset) << 16n, true)
      at += 8
      view.setInt32(at, bin.chunks.length, true)
      at += 4
      for (const [from, to] of bin.chunks) {
        view.setBigUint64(at, BigInt(from) << 16n, true)
        view.setBigUint64(at + 8, BigInt(to) << 16n, true)
        at += 16
      }
    }
  }
  return out
}
