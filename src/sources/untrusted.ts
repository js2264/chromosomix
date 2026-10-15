/**
 * Numbers a file declares about itself, and what its compressed bytes inflate
 * to — checked before anything is sized by them (§10, §12).
 *
 * ## The tension
 *
 * A binary reader cannot work without trusting the file's own account of its
 * shape: a `.hic` block says how many records it holds, a `.bai` how many
 * linear-index slots follow, a `.2bit` record how many gaps. And every one of
 * those numbers arrives from the same bytes as the data, so a truncated
 * download, a flipped bit or a file written to hurt is the same thirty-two bits
 * read as a count. Trusted as one, it sizes a typed array, a read or a loop —
 * and that is how a sixteen-byte `.hic` block declaring fifty million records
 * allocated 572 MiB, how one negative `nValues` in a footer became six reads and
 * 341 MiB of a 256 MiB file, and how a twenty-four-byte `.csi` declaring a
 * depth of a million would hold the annotations worker for some twenty minutes
 * a query.
 *
 * The readers kept their own guards, each written after the bug that needed it,
 * each with its own bound and its own sentence — and the ones nobody had been
 * bitten by yet had none. This module is the one place the question is asked,
 * so every reader asks it the same way and refuses in the same words.
 *
 * ## The three questions every count answers
 *
 * 1. **Is it a count at all** — a non-negative safe integer. A signed field read
 *    negative, or an int64 past 2^53, is a misread or a lie, never a size.
 * 2. **Is it below the format's ceiling** — the most any real file of the format
 *    declares, argued at the call site from the format's own definition and its
 *    writers, and set generously, because a ceiling that refuses one real file
 *    is a bug in this module and not a protection.
 * 3. **Could the bytes left hold it**, at the fewest bytes one item can take.
 *    This is the one that does the work. A file cannot declare more records
 *    than it has room for without being truncated or false, so a count that
 *    passes it sizes an allocation or a loop proportional to bytes that are
 *    actually there — and a sixteen-byte block is sixteen bytes of work, whatever
 *    its header says.
 *
 * A count that fails any of the three is refused with `format`, naming the
 * format, the field and the value, before a byte is read or allocated for it.
 *
 * ## And what an inflate may produce
 *
 * Compression is the same problem at a ratio of a thousand to one: a
 * megabyte of deflate can stand for a gigabyte of zeros, and the platform's
 * `DecompressionStream` produces all of a written chunk's output before anyone
 * can look at it. So {@link inflateCapped} feeds the decompressor in slices,
 * counts what comes out, and stops the stream the moment the count passes the
 * caller's cap — one slice's worth of output past it at most, never the bomb.
 */

import { ViewerError } from '../errors'
import { fmt } from '../units'

/** Which field of which format a number came from — the subject of any refusal. */
export interface Field {
  /** The format as a sentence names it: `.hic`, `BAM index`, `.2bit`. */
  readonly format: string
  /** The field, in the format's own words where it has them: `record count`, `nBlockCount`. */
  readonly field: string
}

export interface CountLimits extends Field {
  /**
   * The most any real file of this format declares. Argued where it is set,
   * from the format's definition and its writers' behaviour, and generous.
   */
  readonly ceiling: number
  /**
   * Bytes left — in the buffer or in the file, whichever bounds the items —
   * from where the items begin. Omitted where the reader cannot know them.
   */
  readonly available?: number
  /** The fewest bytes one item can occupy, for {@link available}. One by default. */
  readonly bytesPerItem?: number
}

/**
 * A count or length read from a file, refused unless it is one the file could
 * really hold.
 *
 * Returns the value as a number, so a call reads as the assignment it guards:
 * `const n = declaredCount(cursor.int32(), { ... })`. A `bigint` is accepted for
 * the 64-bit fields and narrowed here, once.
 *
 * @throws ViewerError `format`, naming the format, the field and the value.
 */
export function declaredCount(value: number | bigint, limits: CountLimits): number {
  const count = narrow(value)
  const failure = countFailure(count, limits)
  if (failure === null) return count
  throw new ViewerError(
    'format',
    `The ${limits.field} of this ${limits.format} reads ${shown(value)}, ${failure.reason}. ` +
      SUSPECT,
    {
      format: limits.format,
      field: limits.field,
      value: typeof value === 'bigint' ? value.toString() : value,
      ceiling: limits.ceiling,
      ...(limits.available === undefined ? {} : { available: limits.available }),
      ...(failure.most === undefined ? {} : { most: failure.most }),
    },
  )
}

/**
 * {@link declaredCount}'s test without its refusal, for the one kind of field a
 * reader is allowed to shrug at: an optional section whose absence the format
 * permits, where an implausible count means "this is not that section" rather
 * than "this file is broken".
 */
export function plausibleCount(value: number | bigint, limits: CountLimits): boolean {
  return countFailure(narrow(value), limits) === null
}

export interface SpanLimits extends Field {
  /** Bytes in the file (or buffer) the span must lie inside. */
  readonly size: number
  /** The most bytes one such span holds in any real file, where the format bounds it. */
  readonly ceiling?: number
}

/**
 * An offset and a length read from a file, refused unless the bytes they name
 * are inside it.
 *
 * The read a span sizes is the cost, not the allocation: a source answers a
 * read past the end with whatever is there, so an index entry claiming two
 * gigabytes fetches everything from its offset to the end of the file — once
 * per entry. Checking the span first is what keeps a hostile index from
 * reading a file many times over.
 *
 * @throws ViewerError `format`, naming the format, the field and the span.
 */
export function declaredSpan(offset: number, length: number, limits: SpanLimits): void {
  const detail = { format: limits.format, field: limits.field, offset, length, size: limits.size }
  if (!isCount(offset) || !isCount(length)) {
    throw new ViewerError(
      'format',
      `The ${limits.field} of this ${limits.format} points at ${shown(length)} bytes from byte ` +
        `${shown(offset)}, which is not a place in a file. ${SUSPECT}`,
      detail,
    )
  }
  if (limits.ceiling !== undefined && length > limits.ceiling) {
    throw new ViewerError(
      'format',
      `The ${limits.field} of this ${limits.format} is ${fmt.int(length)} bytes long, more than ` +
        `the ${fmt.int(limits.ceiling)} any real one holds. ${SUSPECT}`,
      { ...detail, ceiling: limits.ceiling },
    )
  }
  if (offset + length > limits.size) {
    throw new ViewerError(
      'format',
      `The ${limits.field} of this ${limits.format} points at bytes ${fmt.int(offset)} to ` +
        `${fmt.int(offset + length)}, past the end of a file of ${fmt.int(limits.size)}. ${SUSPECT}`,
      detail,
    )
  }
}

// ---------------------------------------------------------------------------
// Inflating
// ---------------------------------------------------------------------------

/** What `DecompressionStream` is asked to undo: zlib, bare deflate, or gzip. */
export type Encoding = 'deflate' | 'deflate-raw' | 'gzip'

export interface InflateLimits extends Field {
  readonly encoding: Encoding
  /** The most output bytes allowed; the stream is stopped as soon as one more arrives. */
  readonly maxBytes: number
}

/**
 * Compressed bytes handed to the decompressor at a time.
 *
 * The platform decompresses **all** of a written chunk before the reader sees
 * any of it — Chromium's and Firefox's transformers loop until the chunk is
 * consumed, enqueueing as they go — so the size of one write is the size of
 * the worst surprise: deflate tops out near 1032:1, and 64 KiB in can be
 * 64 MiB out before the count below gets a look. Small enough that this is the
 * whole overshoot past any cap, and large enough that a BGZF member, which is
 * never more than 64 KiB, is still one write.
 */
const INFLATE_SLICE_BYTES = 64 << 10

/**
 * The longest output an inflate may produce when what it produces becomes text.
 *
 * V8's longest string is 2^29 − 24 characters (`String::kMaxLength`), and the
 * other engines' are no longer, so a buffer past this could not be decoded into
 * one whatever an inflate allowed: the cap refuses no file that could otherwise
 * have been read, and it turns the gigabyte a megabyte of gzip can expand to
 * into a sentence rather than a dead worker. Binary spans read through the
 * same path — an index, a window of a BAM — are far smaller.
 */
export const TEXT_INFLATE_MAX = 2 ** 29

/**
 * Inflate `input`, refusing the moment the output passes `limits.maxBytes`.
 *
 * The writer and reader are taken off the `DecompressionStream` directly, as
 * `pairs/stream.ts` measured to be 7.6× the `Blob`-and-`Response` spelling, and
 * the input is written in {@link INFLATE_SLICE_BYTES} pieces so that the count
 * is taken between them. Past the cap the readable side is cancelled, which
 * errors the writable one, so a write waiting on room fails at once and nothing
 * more is decompressed. A stream the decompressor itself rejects — a bad header,
 * a truncated member — is refused too, in the same words, rather than surfacing
 * as the platform's bare `TypeError`.
 *
 * @throws ViewerError `format` past the cap or on undecodable bytes;
 *   `unsupported` where the runtime has no `DecompressionStream`.
 */
export async function inflateCapped(input: Uint8Array, limits: InflateLimits): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ViewerError(
      'unsupported',
      `Reading a ${limits.format} needs DecompressionStream, which this runtime does not have. ` +
        'Every browser since 2023 has it; a very old one does not.',
      { format: limits.format },
    )
  }
  const stream = new DecompressionStream(limits.encoding)
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  let over = false

  const drained = (async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      total += value.byteLength
      if (total > limits.maxBytes) {
        over = true
        await reader.cancel()
        return
      }
      parts.push(value)
    }
  })()
  const fed = (async (): Promise<void> => {
    for (let at = 0; at < input.byteLength; at += INFLATE_SLICE_BYTES) {
      if (over) return
      const slice = input.subarray(at, Math.min(at + INFLATE_SLICE_BYTES, input.byteLength))
      await writer.write(slice as Uint8Array<ArrayBuffer>)
    }
    if (!over) await writer.close()
  })()
  // Both sides settle whatever happens — a cancel fails the pending write, a
  // decode error fails both — and neither may be left to reject unobserved.
  const [read, wrote] = await Promise.allSettled([drained, fed])

  if (over) throw inflatedPast(limits, limits.maxBytes, input.byteLength)
  const failed = read.status === 'rejected' ? read.reason : wrote.status === 'rejected' ? wrote.reason : null
  if (failed !== null) {
    const why = failed instanceof Error ? failed.message : String(failed)
    throw new ViewerError(
      'format',
      `The ${limits.field} of this ${limits.format} does not inflate (${why.replace(/\.$/, '')}). ${SUSPECT}`,
      { format: limits.format, field: limits.field },
    )
  }
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * How large an inflate may grow, as a function of what went in.
 *
 * A fixed cap cannot be both safe and generous: a cap small enough that a
 * thousand-to-one bomb stays harmless refuses a large real file, and one large
 * enough for the real file lets the bomb through. Proportion does both. Real
 * data compresses by a factor its format bounds — `straw` sizes a `.hic` block's
 * buffer at ten times its compressed length and notes that three is the most it
 * has seen — so `ratio` is set well above the format's and a file of real data
 * never meets it, while a bomb is held to `ratio` times its own size rather than
 * to a thousand. `floor` keeps a small file free to compress as well as it
 * likes, since a few megabytes are harmless however they were made, and
 * `ceiling` is the most the reader could use whatever arrived.
 */
export interface InflationPolicy {
  readonly ratio: number
  readonly floor: number
  readonly ceiling: number
}

/** The cap {@link InflationPolicy} gives `compressedBytes` of input. */
export function inflationCap(compressedBytes: number, policy: InflationPolicy): number {
  return Math.min(policy.ceiling, Math.max(policy.floor, Math.ceil(compressedBytes * policy.ratio)))
}

/**
 * The refusal for compressed data that inflates past its cap, for a reader that
 * inflates in pieces and keeps its own count — a BGZF span is many members,
 * each capped by the format, and their sum by what the caller can hold.
 */
export function inflatedPast(field: Field, maxBytes: number, compressedBytes: number): ViewerError {
  return new ViewerError(
    'format',
    `The ${field.field} of this ${field.format} inflates to more than ${fmt.bytes(maxBytes)}, ` +
      `past what any real one holds. ${SUSPECT}`,
    { format: field.format, field: field.field, maxBytes, compressed: compressedBytes },
  )
}

// ---------------------------------------------------------------------------

/** The end of every refusal here: what the number says about the file. */
const SUSPECT = 'The file is truncated, corrupt, or not the format its first bytes claim.'

function narrow(value: number | bigint): number {
  if (typeof value === 'number') return value
  // Outside the safe range a bigint does not narrow to the number it is, so it
  // is narrowed to one that fails the first question instead.
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : Number.NaN
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function countFailure(count: number, limits: CountLimits): { reason: string; most?: number } | null {
  if (!isCount(count)) return { reason: 'which is not a count' }
  if (count > limits.ceiling) {
    return { reason: `more than the ${fmt.int(limits.ceiling)} any real one declares` }
  }
  if (limits.available !== undefined) {
    const most = Math.floor(Math.max(0, limits.available) / Math.max(1, limits.bytesPerItem ?? 1))
    if (count > most) {
      const room = Math.max(0, limits.available)
      return {
        reason: `and the ${fmt.int(room)} byte${room === 1 ? '' : 's'} after it could hold at most ${fmt.int(most)}`,
        most,
      }
    }
  }
  return null
}

function shown(value: number | bigint): string {
  if (typeof value === 'bigint') return value.toString()
  return Number.isSafeInteger(value) ? fmt.int(value) : String(value)
}
