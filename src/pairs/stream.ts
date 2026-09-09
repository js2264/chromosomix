/**
 * A `.pairs` file's bytes, decompressed, as a stream this side can pull.
 *
 * ## The mistake this module was built on, and the correction
 *
 * It used to hand a whole BGZF file to one `DecompressionStream('gzip')`, on
 * the reasoning that BGZF *is* gzip — a concatenation of standard members — and
 * that the specification requires concatenated members to be walked. The
 * reasoning is right about the format and wrong about the platform:
 *
 * - **Node walks concatenated members.** That is where it was verified, and it
 *   passed.
 * - **Chromium does not.** `DecompressionStream('gzip')` stops at the end of
 *   the first member and throws `TypeError: Junk found after end of compressed
 *   data.` — which is the browser, the only place this code actually runs.
 *
 * And it is not a large-file problem: BGZF's end-of-file marker is itself an
 * empty second member, so **every** bgzipped file failed, including a
 * one-block one. The test fixtures that passed were plain single-member gzip.
 *
 * ## What replaces it, and why it is faster rather than slower
 *
 * BGZF is decompressed **one member at a time**, which is what the format
 * actually is. The obvious way to do that is the way `annotations/tabix.ts`
 * did — `new Blob([payload]).stream().pipeThrough(...)` and a `Response` to
 * collect it — and that is genuinely slow: three objects per 64 KiB member,
 * measured at **34 MB/s** in Chromium.
 *
 * Taking the writer and reader off the `DecompressionStream` directly, with no
 * `Blob` and no `Response`, measures at **260 MB/s** on the same data in the
 * same browser — 7.6× the `Blob` form, and faster than the single-stream path
 * it replaces. `inflateMember` is that loop, and `annotations/tabix.ts` now
 * shares it.
 *
 * **What is left is a per-member cost, and it belongs to deflate rather than to
 * this API.** The same 260 MB/s falls to **78 MB/s** on a file framed in 1.4 KB
 * members instead of 64 KiB ones, because a deflate stream has a fixed cost
 * however little it carries. `fflate`'s pure-JS inflate measures 76 MB/s on
 * exactly those members, so swapping the platform API for a dependency would
 * buy nothing; and issuing the members concurrently is *slower* still, since
 * the cost is CPU rather than latency. Both were measured before being ruled
 * out.
 *
 * A **plain** gzip `.pairs.gz` — one member, which is what `gzip` produces — is
 * still handed to `DecompressionStream('gzip')` whole, because for a single
 * member that is exactly right and there is no framing to walk. A plain gzip
 * that is *itself* a concatenation (`cat a.gz b.gz`) is not supported and
 * cannot be: unlike BGZF, nothing in the framing says where the next member
 * begins without inflating the one before it.
 *
 * ## Progress is measured in compressed bytes
 *
 * The denominator has to be known before the read starts, and the only number
 * that is, is the source's own size. Uncompressed length is not in a gzip
 * trailer in any usable form (`ISIZE` is modulo 2^32, and per-member at that),
 * and the pairix index's `linecount` — where there is one — counts records
 * rather than bytes. So the bar tracks bytes *fed in*, which is exact, monotone
 * and available for an unindexed file too.
 */

import type { ByteSource } from '../types'

/**
 * How much of the source is handed to the inflater at a time.
 *
 * Large enough that the per-chunk overhead disappears against the inflate, and
 * small enough that progress moves and a cancel is noticed. It is also the
 * granularity a remote source coalesces at, so it wants to be a multiple of the
 * 1 MiB the sources already read in.
 */
export const PULL_CHUNK_BYTES = 4 << 20

/** A BGZF member header is always at least this long. */
const BGZF_HEADER_BYTES = 12

/** No BGZF member exceeds 64 KiB compressed; the format guarantees it. */
export const BGZF_MAX_MEMBER = 1 << 16

/** gzip's first two bytes, which BGZF shares because BGZF *is* gzip. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Whether these bytes begin a BGZF member rather than a plain gzip one.
 *
 * gzip magic, then the `FEXTRA` flag, then a `BC` subfield in the extra field.
 * A plain `.gz` has the first and not the others, and must keep working — which
 * is why this is a *test* and not an assumption.
 */
export function isBgzfMember(bytes: Uint8Array, at = 0): boolean {
  if (bytes.length < at + BGZF_HEADER_BYTES) return false
  if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b || bytes[at + 2] !== 8) return false
  if ((bytes[at + 3] & 4) === 0) return false
  return memberSize(bytes, at) !== null
}

/**
 * The total size of the BGZF member starting at `bytes[at]`, or `null`.
 *
 * `BSIZE` is stored as *total member size minus one*, which is the single most
 * common off-by-one in the format.
 */
export function memberSize(bytes: Uint8Array, at = 0): number | null {
  if (bytes.length < at + BGZF_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const extraLength = view.getUint16(at + 10, true)
  let cursor = at + 12
  const end = Math.min(cursor + extraLength, bytes.length)
  while (cursor + 4 <= end) {
    const si1 = bytes[cursor]
    const si2 = bytes[cursor + 1]
    const length = view.getUint16(cursor + 2, true)
    if (si1 === 66 && si2 === 67 && length === 2) {
      return view.getUint16(cursor + 4, true) + 1
    }
    cursor += 4 + length
  }
  return null
}

/**
 * Inflate one member's deflate payload.
 *
 * The writer and reader are taken off the `DecompressionStream` directly. The
 * `Blob` + `pipeThrough` + `Response` spelling is the obvious one and costs
 * 7.6× as much — see the module docblock. `deflate-raw` rather than `gzip`
 * because the gzip framing has already been stripped by the caller, which is
 * the only way to know where the member ended in the first place.
 */
export async function inflateMember(payload: Uint8Array): Promise<Uint8Array> {
  if (payload.length === 0) return payload
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  const pump = (async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      total += value.length
    }
  })()
  await writer.write(payload as Uint8Array<ArrayBuffer>)
  await writer.close()
  await pump
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * The *uncompressed* size of the member at `at`, from its `ISIZE` trailer.
 *
 * The only honest way to recognise BGZF's end-of-file marker. Its deflate
 * payload is two bytes (`03 00`) rather than zero — an empty deflate stream is
 * still a deflate stream — so testing the compressed length says every real
 * marker is a data member, which is how a complete file came to be reported as
 * truncated.
 */
function uncompressedSize(bytes: Uint8Array, at: number, size: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(at + size - 4, true)
}

/** The deflate payload of the member at `at`, given its total size. */
function payloadOf(bytes: Uint8Array, at: number, size: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const extraLength = view.getUint16(at + 10, true)
  // 12-byte header + the extra field, and 8 bytes of CRC32 and ISIZE trailer.
  return bytes.subarray(at + 12 + extraLength, at + size - 8)
}

/**
 * What the framing said about how a BGZF span ended.
 *
 * Reported rather than acted on, because the same two facts mean different
 * things to different callers. A *span* read cuts where the index pointed and
 * ends mid-member as a matter of course; a *whole-file* read that ends the same
 * way is reading a file that was never fully written — a cancelled upload, an
 * interrupted `bgzip`, a truncated copy — and that is worth saying out loud
 * rather than drawing a map of whatever arrived.
 */
export interface FramingInfo {
  /** Bytes were left over that do not complete a member. */
  partialMember: boolean
  /** The last complete member was BGZF's empty end-of-file marker. */
  endedOnEofMarker: boolean
}

export interface SpanOptions {
  /** First byte to read. Defaults to the start of the file. */
  from?: number
  /** One past the last byte to read. Defaults to the end of the file. */
  to?: number
  /** Called with compressed bytes consumed and the total to consume. */
  onProgress?: (done: number, total: number) => void
  /** Polled between chunks; returning `true` ends the stream early. */
  cancelled?: () => boolean
  /**
   * Called once, when a BGZF stream closes, with how it ended.
   *
   * Never called for a plain gzip or an uncompressed file: neither carries
   * framing this side can check, so there is nothing to report and a caller
   * must not read silence as "the file is whole".
   */
  onFraming?: (info: FramingInfo) => void
}

/**
 * The bytes of `[from, to)`, decompressed if the file is compressed.
 *
 * A plain `.pairs` is passed through untouched rather than refused, which costs
 * one branch and is the difference between "bring a bgzipped file" and "bring a
 * pairs file". The same opportunism §3.4 applies to the index applies here to
 * the compression: neither is required, and each only ever makes the same file
 * cheaper.
 */
export function decompressedStream(
  source: ByteSource,
  options: SpanOptions = {},
): ReadableStream<Uint8Array> {
  // The probe reads the *file's* first bytes, never the span's: a span starting
  // mid-file begins inside a member and does not carry gzip magic, but the file
  // it came from does.
  const head = source.readBytes(0, Math.min(source.size, 64))
  if (isBgzfMember(head)) return bgzfStream(source, options)
  const raw = spanStream(source, options)
  return isGzip(head) ? raw.pipeThrough(new DecompressionStream('gzip')) : raw
}

/** The compressed bytes of a span, unchanged, in source-sized reads. */
function spanStream(
  source: ByteSource,
  options: SpanOptions,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const from = options.from ?? 0
  const to = Math.min(options.to ?? source.size, source.size)
  const total = Math.max(0, to - from)
  let at = from
  let fed = 0

  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (options.cancelled?.() === true || at >= to) {
        controller.close()
        return
      }
      // Synchronous by construction — see `ByteSource.readBytes`. That is why
      // every caller of this module runs in a worker.
      const bytes = source.readBytes(at, Math.min(PULL_CHUNK_BYTES, to - at))
      if (bytes.length === 0) {
        controller.close()
        return
      }
      at += bytes.length
      fed += bytes.length
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>)
      options.onProgress?.(fed, total)
    },
  })
}

/**
 * A BGZF span, member by member.
 *
 * Members are walked using their own `BSIZE`, so the boundaries are known
 * without inflating anything — which is the property that makes this possible
 * at all and the one a plain gzip does not have.
 *
 * A member left incomplete at the end of the span is **dropped rather than
 * fatal**. That is deliberate and is what a span read needs: `px2.ts` aims its
 * spans at exact member boundaries, but a caller reading a fixed prefix (the
 * header probe on a file larger than the cap) necessarily cuts mid-member, and
 * a decoder error there would throw away everything that was read before it.
 */
function bgzfStream(source: ByteSource, options: SpanOptions): ReadableStream<Uint8Array> {
  const from = options.from ?? 0
  const to = Math.min(options.to ?? source.size, source.size)
  const total = Math.max(0, to - from)
  let at = from
  let fed = 0
  let carry = new Uint8Array(0)

  let endedOnEofMarker = false
  const close = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    options.onFraming?.({ partialMember: carry.length > 0, endedOnEofMarker })
    controller.close()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (options.cancelled?.() === true) {
          // A cancel says nothing about the file, so no framing is reported.
          controller.close()
          return
        }
        // Enough of a member in hand to know its length, and all of it?
        const size = carry.length >= BGZF_HEADER_BYTES ? memberSize(carry) : null
        if (size !== null && carry.length >= size) {
          const payload = payloadOf(carry, 0, size)
          const inflatedSize = uncompressedSize(carry, 0, size)
          carry = carry.subarray(size)
          // A member that inflates to nothing is the end-of-file marker. It is
          // a real member and is skipped rather than enqueued, so a consumer
          // never sees a zero-length chunk — and skipped without inflating it,
          // since there is nothing in it to inflate.
          endedOnEofMarker = inflatedSize === 0
          if (inflatedSize > 0) {
            controller.enqueue(await inflateMember(payload))
            return
          }
          continue
        }
        if (at >= to) {
          // Whether a trailing partial member is the caller's cut or a broken
          // file is not knowable here — `onFraming` reports it and the caller
          // decides (see {@link FramingInfo}).
          close(controller)
          return
        }
        const bytes = source.readBytes(at, Math.min(PULL_CHUNK_BYTES, to - at))
        if (bytes.length === 0) {
          close(controller)
          return
        }
        at += bytes.length
        fed += bytes.length
        options.onProgress?.(fed, total)
        if (carry.length === 0) {
          // `slice`, not a view: `carry` outlives this iteration and the source
          // is free to reuse the buffer it handed back.
          carry = bytes.slice()
        } else {
          const joined = new Uint8Array(carry.length + bytes.length)
          joined.set(carry)
          joined.set(bytes, carry.length)
          carry = joined
        }
      }
    },
  })
}

/**
 * Walk the decompressed bytes line by line, without ever building a string.
 *
 * The callback is handed the raw bytes of one line, valid only until it
 * returns. That is the whole point: a `.pairs` import parses tens of millions
 * of records, and `TextDecoder` per line — or worse, `split('\t')` per line —
 * is what separates a four-second import from a forty-second one. Callers that
 * need text (the header, and only the header) decode for themselves.
 *
 * A final line with no trailing newline is delivered, because a hand-edited
 * pairs file routinely lacks one and dropping its last record silently would be
 * the worst possible way to be wrong.
 *
 * @returns `false` when it stopped early because the caller cancelled.
 */
export async function forEachLine(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: Uint8Array) => void,
  cancelled?: () => boolean,
): Promise<boolean> {
  const reader = stream.getReader()
  let carry = new Uint8Array(0)
  try {
    for (;;) {
      // Before the read, not after it. A caller that has what it came for —
      // the header probe wants one line — must not be made to issue another
      // read to discover that: on a span cut mid-member, that read is where
      // the decoder raises, and the answer would be thrown away with it.
      if (cancelled?.() === true) return false
      const { done, value } = await reader.read()
      if (done) break

      let buf: Uint8Array
      if (carry.length === 0) {
        buf = value
      } else {
        buf = new Uint8Array(carry.length + value.length)
        buf.set(carry)
        buf.set(value, carry.length)
      }

      let start = 0
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue
        // A CRLF file is not the common case and is cheap to tolerate.
        const end = i > start && buf[i - 1] === 0x0d ? i - 1 : i
        onLine(buf.subarray(start, end))
        start = i + 1
      }
      // `slice`, not `subarray`: the tail has to outlive `value`, which the
      // next `read()` is free to reuse.
      carry = buf.subarray(start).slice()
    }
    if (carry.length > 0) onLine(carry)
    return true
  } finally {
    reader.releaseLock()
  }
}
