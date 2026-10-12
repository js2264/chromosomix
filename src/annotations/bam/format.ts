/**
 * BAM: the header, and one alignment record at a time.
 *
 * ## Why this is written here
 *
 * The same argument `hic/format.ts` makes about `hic-straw` and `tabix.ts`
 * makes about `@gmod/tabix`, and it is not repeated at length: every read in
 * this application goes through a source that counts its requests, caches its
 * chunks and signs them where a bucket needs it, and a parser that fetches for
 * itself sits outside all three. `@gmod/bam` is good and is a devDependency
 * here for exactly one purpose — to be the oracle these decoders are tested
 * against, the way `hic-straw` is for `.hic` — because a reader tested against
 * itself is tested against nothing.
 *
 * What is left once the fetching is somebody else's problem is two structures:
 * a header that is a length-prefixed string and a table, and a record that is a
 * fixed 36-byte prefix followed by five variable-length blocks. Neither is
 * large and neither is subtle.
 *
 * ## What is decoded, and what is stepped over
 *
 * A coverage pass over a deep window touches a few hundred thousand records and
 * wants four numbers from each of them. Building an object per record to throw
 * away eleven of its fields is most of the cost of the pass, so the reading
 * comes in two shapes deliberately: {@link forEachRecord} walks the buffer and
 * hands out offsets, allocating nothing, and {@link decodeRecord} builds the
 * whole record for the one read a reader pointed at. The first is what a lane
 * is drawn from; the second is what a dialog is filled from.
 *
 * `end` is the exception that is always computed. A record stores where it
 * begins and how it aligns, never where it ends, so the reference span — the
 * only thing a coverage pass actually needs — costs a walk of the CIGAR whether
 * anybody asked for it or not.
 */

/** `BAM\1`, and the whole of the is-this-a-BAM question once BGZF is inflated. */
const BAM_MAGIC = [0x42, 0x41, 0x4d, 0x01]

/** The fixed part of an alignment record, before `read_name` begins. */
export const RECORD_PREFIX_BYTES = 32

/**
 * The flag bits, named.
 *
 * Spelled out rather than left as literals at the call sites because six of
 * them are read in three different modules and `(flag & 0x900) !== 0` is not a
 * sentence anybody should have to decode twice.
 */
export const FLAG = {
  PAIRED: 0x1,
  PROPER_PAIR: 0x2,
  UNMAPPED: 0x4,
  MATE_UNMAPPED: 0x8,
  REVERSE: 0x10,
  MATE_REVERSE: 0x20,
  FIRST_IN_PAIR: 0x40,
  SECOND_IN_PAIR: 0x80,
  SECONDARY: 0x100,
  QC_FAIL: 0x200,
  DUPLICATE: 0x400,
  SUPPLEMENTARY: 0x800,
} as const

/**
 * Step over one tag value, returning where the next tag begins, or `-1`.
 *
 * Here rather than beside either of its two readers — a read's `MD` for its
 * mismatches, and a spliced read's `XS` for the strand its intron is on — so a
 * tag type one of them learns to step over is a type the other steps over too.
 */
export function skipTag(bytes: Uint8Array, at: number, type: string, to: number): number {
  const width: Record<string, number | undefined> = { c: 1, C: 1, s: 2, S: 2, i: 4, I: 4, f: 4, A: 1 }
  if (type === 'Z' || type === 'H') {
    let end = at
    while (end < to && bytes[end] !== 0) end++
    return end + 1
  }
  if (type === 'B') {
    const sub = String.fromCharCode(bytes[at])
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(at + 1, true)
    const each = width[sub]
    if (each === undefined || count < 0) return -1
    return at + 5 + count * each
  }
  const each = width[type]
  return each === undefined ? -1 : at + each
}

/**
 * The reads no pile-up and no coverage should ever count.
 *
 * Secondary and supplementary alignments are *the same molecule* reported a
 * second time, so counting them inflates depth at exactly the loci — repeats,
 * fusion breakpoints — where somebody is reading the number most carefully.
 * Unmapped records carry a position only as a courtesy to their mate. QC-fail
 * is the aligner's own verdict.
 *
 * Duplicates are deliberately *not* in here: marking them is a pipeline's
 * decision and reading a duplicate-marked file with them hidden by default
 * would silently disagree with the same file read anywhere else. It is offered
 * as a filter instead.
 */
export const DEFAULT_EXCLUDE =
  FLAG.UNMAPPED | FLAG.SECONDARY | FLAG.SUPPLEMENTARY | FLAG.QC_FAIL

/** One entry of the reference table, in the file's own order. */
export interface BamRef {
  name: string
  length: number
}

/** What `@HD SO:` claimed, or `unknown` where there is no `@HD` line at all. */
export type SortOrder = 'coordinate' | 'queryname' | 'unsorted' | 'unknown'

export interface BamHeader {
  /** The SAM text header, verbatim. Kept because `@RG` and `@PG` are read from it. */
  text: string
  refs: BamRef[]
  sortOrder: SortOrder
  /** Byte offset, within the inflated header region, where the first record begins. */
  recordsFrom: number
}

/** `true` when these inflated bytes begin a BAM. */
export function isBam(bytes: Uint8Array): boolean {
  if (bytes.length < BAM_MAGIC.length) return false
  return BAM_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * Parse the header out of the inflated start of a BAM.
 *
 * Returns `null` when the buffer stops mid-header rather than throwing, which
 * is what lets the caller grow its read and try again. That is not a rare path:
 * `l_text` is unbounded and a co-assembly of twenty thousand contigs writes a
 * reference table of about a megabyte, spanning a dozen BGZF blocks — so
 * "inflate the first block and parse the header" is wrong on precisely the
 * files this viewer exists for.
 */
export function readHeader(bytes: Uint8Array): BamHeader | null {
  if (!isBam(bytes)) {
    throw new Error('This is not a BAM: the first four bytes are not BAM\\1.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8) return null
  const textBytes = view.getInt32(4, true)
  if (textBytes < 0) throw new Error('This BAM header declares a negative length.')
  let at = 8 + textBytes
  if (bytes.length < at + 4) return null
  const text = new TextDecoder().decode(bytes.subarray(8, at))
  const refCount = view.getInt32(at, true)
  at += 4
  if (refCount < 0) throw new Error('This BAM header declares a negative reference count.')

  const refs: BamRef[] = []
  for (let i = 0; i < refCount; i++) {
    if (bytes.length < at + 4) return null
    const nameBytes = view.getInt32(at, true)
    at += 4
    if (nameBytes < 0) throw new Error('This BAM header declares a negative name length.')
    if (bytes.length < at + nameBytes + 4) return null
    // The stored name includes its own NUL terminator, which is not part of it.
    const name = new TextDecoder().decode(bytes.subarray(at, at + nameBytes - 1))
    at += nameBytes
    const length = view.getInt32(at, true)
    at += 4
    refs.push({ name, length })
  }
  return { text, refs, sortOrder: sortOrderOf(text), recordsFrom: at }
}

/**
 * What the `@HD` line's `SO:` says.
 *
 * Read rather than assumed because the difference is not cosmetic: every byte
 * this module fetches is addressed by an index that only exists for a
 * coordinate-sorted file, and a name-sorted BAM handed to a region query
 * answers with whatever happened to be in those blocks. Refusing it by name is
 * the only honest option, and `samtools sort` is the fix.
 */
function sortOrderOf(text: string): SortOrder {
  for (const line of text.split('\n')) {
    if (!line.startsWith('@HD')) continue
    for (const field of line.split('\t')) {
      if (!field.startsWith('SO:')) continue
      const value = field.slice(3).trim()
      if (value === 'coordinate' || value === 'queryname' || value === 'unsorted') return value
      return 'unknown'
    }
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// CIGAR
// ---------------------------------------------------------------------------

/** `MIDNSHP=X`, indexed by the op code stored in the low four bits. */
export const CIGAR_OPS = 'MIDNSHP=X'

/** Ops that advance along the reference: M, D, N, =, X. */
const CONSUMES_REFERENCE = [true, false, true, true, false, false, false, true, true]

/** Ops that advance along the read: M, I, S, =, X. */
const CONSUMES_QUERY = [true, true, false, false, true, false, false, true, true]

/** Whether this op code moves along the reference. */
export function consumesReference(op: number): boolean {
  return CONSUMES_REFERENCE[op] === true
}

/** Whether this op code moves along the read. */
export function consumesQuery(op: number): boolean {
  return CONSUMES_QUERY[op] === true
}

/**
 * How far along the reference a CIGAR reaches.
 *
 * Reads the packed ops straight out of the buffer rather than through an array,
 * because this is the one thing computed for every record of every window and
 * an `Uint32Array` view per record is an allocation per record.
 */
export function referenceLength(
  view: DataView,
  cigarAt: number,
  opCount: number,
): number {
  let span = 0
  for (let i = 0; i < opCount; i++) {
    const packed = view.getUint32(cigarAt + i * 4, true)
    if (consumesReference(packed & 0xf)) span += packed >>> 4
  }
  return span
}

// ---------------------------------------------------------------------------
// Walking a buffer of records
// ---------------------------------------------------------------------------

/**
 * Where one record is, and the four numbers every caller wants from it.
 *
 * Handed to a visitor and **reused between records** — this object is the same
 * object every time, mutated in place. That is what makes a pass over three
 * hundred thousand records allocate nothing, and it is why a visitor that wants
 * to keep something must copy it out rather than keep the cursor.
 */
export interface RecordCursor {
  /** Offset of this record's `refID` field — the start of its fixed prefix. */
  at: number
  /** Total bytes of this record, including its own four-byte length prefix. */
  bytes: number
  refId: number
  pos: number
  /** Reference end, exclusive. Zero-length for a record with no aligned op. */
  end: number
  mapq: number
  flag: number
  nameBytes: number
  cigarOps: number
  cigarAt: number
  seqLength: number
  seqAt: number
  nextRefId: number
  nextPos: number
  tlen: number
}

/**
 * Walk every whole record in `bytes`, from `from`.
 *
 * Stops cleanly at a truncated tail rather than throwing: a window is fetched
 * as a byte span sized from the index and the last thing in it is routinely
 * half a record belonging to the block after. The visitor returns `false` to
 * stop early.
 *
 * `pos` is the file's own 0-based coordinate and is passed through untouched.
 * A record with `pos === -1` is an unplaced read and is handed on with an `end`
 * equal to its start, so a caller that does not filter it cannot accidentally
 * paint it at the origin.
 *
 * A record whose name, CIGAR and sequence do not fit inside its own length is
 * not a record, and stops the walk as a non-positive length does. Every caller
 * sizes something by those fields — an `l_seq` sizes an `Int32Array` for base
 * modifications and a loop that builds the read's string — so a corrupt one
 * reaching a visitor was a two-billion-iteration loop over bytes that belong
 * to the next record, or to nothing (§10).
 */
export function forEachRecord(
  bytes: Uint8Array,
  from: number,
  visit: (cursor: RecordCursor) => boolean | void,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cursor: RecordCursor = {
    at: 0, bytes: 0, refId: -1, pos: -1, end: -1, mapq: 0, flag: 0,
    nameBytes: 0, cigarOps: 0, cigarAt: 0, seqLength: 0, seqAt: 0,
    nextRefId: -1, nextPos: -1, tlen: 0,
  }
  let at = from
  while (at + 4 <= bytes.length) {
    const blockSize = view.getInt32(at, true)
    // A non-positive block size is not a short read, it is a buffer that is not
    // records — stop rather than loop forever on a zero.
    if (blockSize <= 0) break
    const recordAt = at + 4
    if (recordAt + blockSize > bytes.length) break
    if (blockSize < RECORD_PREFIX_BYTES) break

    const nameBytes = view.getUint8(recordAt + 8)
    const cigarOps = view.getUint16(recordAt + 12, true)
    const cigarAt = recordAt + RECORD_PREFIX_BYTES + nameBytes
    const seqLength = view.getInt32(recordAt + 16, true)
    const pos = view.getInt32(recordAt + 4, true)
    // Name, CIGAR, packed bases and qualities, in that order before the tags.
    // `Math.ceil` rather than `>> 1`: an `l_seq` near 2^31 wraps under a shift.
    const fixed = RECORD_PREFIX_BYTES + nameBytes + cigarOps * 4 + Math.ceil(seqLength / 2) + seqLength
    if (seqLength < 0 || fixed > blockSize) break

    cursor.at = recordAt
    cursor.bytes = blockSize + 4
    cursor.refId = view.getInt32(recordAt, true)
    cursor.pos = pos
    cursor.mapq = view.getUint8(recordAt + 9)
    cursor.flag = view.getUint16(recordAt + 14, true)
    cursor.nameBytes = nameBytes
    cursor.cigarOps = cigarOps
    cursor.cigarAt = cigarAt
    cursor.seqLength = seqLength
    cursor.seqAt = cigarAt + cigarOps * 4
    cursor.nextRefId = view.getInt32(recordAt + 20, true)
    cursor.nextPos = view.getInt32(recordAt + 24, true)
    cursor.tlen = view.getInt32(recordAt + 28, true)
    cursor.end = pos < 0 ? pos : pos + referenceLength(view, cigarAt, cigarOps)

    if (visit(cursor) === false) return
    at += 4 + blockSize
  }
}

/**
 * The name of the read a cursor is on.
 *
 * Separate from the walk because it allocates a string, which is the one thing
 * a coverage pass must not do per record.
 */
export function readNameAt(bytes: Uint8Array, cursor: RecordCursor): string {
  const from = cursor.at + RECORD_PREFIX_BYTES
  // `l_read_name` counts the NUL terminator; the name does not include it.
  return new TextDecoder().decode(bytes.subarray(from, from + cursor.nameBytes - 1))
}

// ---------------------------------------------------------------------------
// SEQ, and the tag block
// ---------------------------------------------------------------------------

/**
 * The 4-bit sequence alphabet, in the order the format numbers it.
 *
 * `=` at zero is "same as the reference", which no aligner in common use
 * writes; the rest are IUPAC. Two bases per byte, high nibble first.
 */
export const SEQ_ALPHABET = '=ACMGRSVTWYHKDBN'

/** Unpack `l_seq` bases out of the packed nibbles at `seqAt`. */
export function readSequence(
  bytes: Uint8Array,
  seqAt: number,
  seqLength: number,
): string {
  let out = ''
  for (let i = 0; i < seqLength; i++) {
    const byte = bytes[seqAt + (i >> 1)]
    out += SEQ_ALPHABET[i % 2 === 0 ? byte >> 4 : byte & 0xf]
  }
  return out
}

/** A tag's value, in the four shapes a caller can do anything with. */
export type TagValue = number | string | number[]

/**
 * Read the tag block of one record into a plain object.
 *
 * Every type in the specification is handled, including `B` arrays, because a
 * tag this reader skips is a tag that reads as absent — and `MD`, `NM`, `SA`
 * and `RG` all being absent is indistinguishable from a file that does not
 * carry them, which is the one confusion this feature cannot afford.
 *
 * An unknown type character stops the walk rather than throwing: the rest of
 * the record has already been read, and losing the tags of one odd record is a
 * better outcome than losing the window it is in.
 */
export function readTags(
  bytes: Uint8Array,
  from: number,
  to: number,
): Record<string, TagValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Record<string, TagValue> = {}
  let at = from
  while (at + 3 <= to) {
    const tag = String.fromCharCode(bytes[at], bytes[at + 1])
    const type = String.fromCharCode(bytes[at + 2])
    at += 3
    if (type === 'B') {
      const subtype = String.fromCharCode(bytes[at])
      const count = view.getInt32(at + 1, true)
      at += 5
      const width = NUMERIC_WIDTH[subtype]
      // An array longer than the tag block is the block's end misread, and
      // reading it would build a list of whatever follows: the next record's
      // bytes, a few megabytes of them.
      if (width === undefined || count < 0 || at + count * width > to) return out
      const values: number[] = []
      for (let i = 0; i < count; i++) values.push(readNumeric(view, at + i * width, subtype))
      at += count * width
      out[tag] = values
      continue
    }
    if (type === 'Z' || type === 'H') {
      let end = at
      while (end < to && bytes[end] !== 0) end++
      out[tag] = new TextDecoder().decode(bytes.subarray(at, end))
      at = end + 1
      continue
    }
    if (type === 'A') {
      out[tag] = String.fromCharCode(bytes[at])
      at += 1
      continue
    }
    const width = NUMERIC_WIDTH[type]
    if (width === undefined) return out
    out[tag] = readNumeric(view, at, type)
    at += width
  }
  return out
}

const NUMERIC_WIDTH: Record<string, number | undefined> = {
  c: 1, C: 1, s: 2, S: 2, i: 4, I: 4, f: 4,
}

function readNumeric(view: DataView, at: number, type: string): number {
  switch (type) {
    case 'c': return view.getInt8(at)
    case 'C': return view.getUint8(at)
    case 's': return view.getInt16(at, true)
    case 'S': return view.getUint16(at, true)
    case 'i': return view.getInt32(at, true)
    case 'I': return view.getUint32(at, true)
    case 'f': return view.getFloat32(at, true)
    default: return 0
  }
}

/** One alignment, decoded whole. Built for a dialog, never for a pass. */
export interface BamRecord {
  refId: number
  pos: number
  end: number
  mapq: number
  flag: number
  name: string
  /** Packed ops, `(length << 4) | op`, with a long CIGAR already resolved. */
  cigar: Uint32Array
  seq: string
  /** Phred scores, or `null` where the record stores the `0xff` "absent" run. */
  qual: Uint8Array | null
  nextRefId: number
  nextPos: number
  tlen: number
  tags: Record<string, TagValue>
}

/**
 * Decode the record a cursor is sitting on, whole.
 *
 * The `CG` tag is resolved here rather than left to the caller. A record with
 * more than 65,535 CIGAR operations — a long-read alignment across a spliced
 * transcript, routinely — cannot fit its op count in the `n_cigar_op` field, so
 * the format stores a two-op placeholder (`<l_seq>S<ref_len>N`) and the real
 * ops in a `B,I` tag. The reference *span* is right either way, which is why
 * coverage never has to know; the picture of the read is not, which is why
 * anything drawing one does.
 */
export function decodeRecord(bytes: Uint8Array, cursor: RecordCursor): BamRecord {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const qualAt = cursor.seqAt + ((cursor.seqLength + 1) >> 1)
  const tagsFrom = qualAt + cursor.seqLength
  const tagsTo = cursor.at + cursor.bytes - 4
  const tags = readTags(bytes, tagsFrom, tagsTo)

  let cigar = new Uint32Array(cursor.cigarOps)
  for (let i = 0; i < cursor.cigarOps; i++) cigar[i] = view.getUint32(cursor.cigarAt + i * 4, true)
  const long = tags['CG']
  if (Array.isArray(long) && isLongCigarPlaceholder(cigar, cursor.seqLength)) {
    cigar = Uint32Array.from(long)
    delete tags['CG']
  }

  const qual = bytes.subarray(qualAt, qualAt + cursor.seqLength)
  return {
    refId: cursor.refId,
    pos: cursor.pos,
    end: cursor.end,
    mapq: cursor.mapq,
    flag: cursor.flag,
    name: readNameAt(bytes, cursor),
    cigar,
    seq: readSequence(bytes, cursor.seqAt, cursor.seqLength),
    qual: qual.length > 0 && qual[0] === 0xff ? null : qual.slice(),
    nextRefId: cursor.nextRefId,
    nextPos: cursor.nextPos,
    tlen: cursor.tlen,
    tags,
  }
}

/** `<l_seq>S<ref_len>N` — the two-op stand-in a `CG` tag replaces. */
function isLongCigarPlaceholder(cigar: Uint32Array, seqLength: number): boolean {
  if (cigar.length !== 2) return false
  const softClip = (cigar[0] & 0xf) === 4 && cigar[0] >>> 4 === seqLength
  return softClip && (cigar[1] & 0xf) === 3
}

/**
 * The real ops of a record whose CIGAR is too long to fit in the record.
 *
 * `null` for the overwhelming majority, which have an ordinary CIGAR and pay
 * two comparisons for the question. Where it is not null, the ops in the record
 * are the `<l_seq>S<ref_len>N` stand-in — and that matters to anything walking
 * the CIGAR rather than merely measuring it, because the `N` is a *skip* and a
 * pass that honours skips will emit no aligned block at all. The reference
 * *span* is right either way, which is why the record's end never needs this.
 */
export function longCigarOf(bytes: Uint8Array, cursor: RecordCursor): Uint32Array | null {
  if (cursor.cigarOps !== 2) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = view.getUint32(cursor.cigarAt, true)
  const second = view.getUint32(cursor.cigarAt + 4, true)
  if ((first & 0xf) !== 4 || first >>> 4 !== cursor.seqLength) return null
  if ((second & 0xf) !== 3) return null
  const qualAt = cursor.seqAt + ((cursor.seqLength + 1) >> 1)
  const tags = readTags(bytes, qualAt + cursor.seqLength, cursor.at + cursor.bytes - 4)
  const long = tags['CG']
  return Array.isArray(long) ? Uint32Array.from(long) : null
}
