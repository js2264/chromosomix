/**
 * A `.pairs` file's bytes, decompressed, as a stream this side can pull.
 *
 * ## Why this is not `annotations/tabix.ts`
 *
 * That module inflates a *span* — the byte range holding one sequence's
 * records, found from an index — and it does so one BGZF block at a time
 * through `DecompressionStream('deflate-raw')`, because a span's edges are
 * virtual offsets and only a block-at-a-time decode can honour them.
 *
 * This module inflates a *file*, and doing it a block at a time would be the
 * single most expensive decision in the import. A BGZF block holds at most
 * 64 KiB, so a gigabyte of pairs is upwards of twenty thousand blocks, and a
 * `Blob` + `DecompressionStream` + `Response` per block is twenty thousand
 * allocations of three objects each before a single record is parsed.
 *
 * The alternative is available and is exactly one line: **BGZF is gzip**. A
 * BGZF file is a concatenation of standard gzip members, and
 * `DecompressionStream('gzip')` walks concatenated members by specification —
 * verified here against a three-member file, and the reason a whole-file import
 * runs at the platform's inflate ceiling (~195 MB/s) rather than at whatever
 * per-block object churn would leave of it.
 *
 * So: spans go through `tabix.ts`, whole files go through here, and the two
 * coexist because they are answering different questions rather than because
 * one was overlooked.
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

/** gzip's first two bytes, which BGZF shares because BGZF *is* gzip. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
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
}

/**
 * The bytes of `[from, to)`, decompressed if the file is gzipped.
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
  const from = options.from ?? 0
  const to = Math.min(options.to ?? source.size, source.size)
  const total = Math.max(0, to - from)
  let at = from
  let fed = 0

  // Parameterised on `ArrayBuffer` rather than left as a bare `Uint8Array`
  // because that is what `DecompressionStream`'s writable side is typed to
  // accept; the sources hand back exactly these bytes either way.
  const raw = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (options.cancelled?.() === true) {
        controller.close()
        return
      }
      if (at >= to) {
        controller.close()
        return
      }
      const length = Math.min(PULL_CHUNK_BYTES, to - at)
      // Synchronous by construction — see `ByteSource.readBytes`. That is why
      // every caller of this module runs in a worker.
      const bytes = source.readBytes(at, length)
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

  // The probe reads the *file's* first bytes, never the span's: a span starting
  // mid-file begins inside a BGZF member and does not carry gzip magic, but the
  // file it came from does.
  const head = source.readBytes(0, 2)
  return isGzip(head) ? raw.pipeThrough(new DecompressionStream('gzip')) : raw
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
