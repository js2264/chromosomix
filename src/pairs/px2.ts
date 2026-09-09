/**
 * The pairix index — `.px2` — and the two things it is actually for here.
 *
 * ## It is not a `.tbi`, and it says so in its first eight bytes
 *
 * pairix is a fork of tabix and the family resemblance is close enough to be a
 * trap. The body is the same: a bin index and a linear index per reference,
 * chunks as pairs of virtual offsets. The *header* is not, and it does not
 * pretend to be — the magic is `PX2.004\1` rather than `TBI\1`, so
 * `annotations/tabix.ts`'s `parseTabix` rejects a `.px2` outright instead of
 * misreading one. That refusal is the good case and this module exists beside
 * it rather than inside it for exactly that reason.
 *
 * What differs, verified against pairix's `index.c`:
 *
 * - **magic** is 8 bytes, and three versions are in circulation (`PX2.004\1`,
 *   `PX2.003\1`, `PX2.002\1`);
 * - a **`linecount`** follows `n_ref` — 8 bytes in `.004`, 4 in the two older
 *   ones. This is the field that makes an import's cost knowable before it
 *   starts;
 * - the **config block** is a raw dump of a C struct carrying *two* column
 *   triples (`sc/bc/ec` and `sc2/bc2/ec2`) for the two dimensions, plus a
 *   delimiter, a region-split character, a meta character and a line-skip;
 * - a **reference name is a chromosome pair**, joined by the region-split
 *   character the header carries — `chr1|chr2`, not `chr1`.
 *
 * The config block is written with `sizeof(ti_conf_t)`, which means **compiler
 * padding is part of the on-disk layout**. Summing the field widths gives 36
 * bytes and a plausible-looking answer; a build that pads to 40 gives another.
 * Rather than pick one and be silently wrong on half the files in the world,
 * {@link parsePx2} tries each candidate and keeps the one whose *successor*
 * fields make sense — the name block length has to be positive, has to fit, and
 * has to split into exactly `n_ref` NUL-terminated names. A layout that
 * satisfies all three is the layout.
 *
 * ## What is read, and what is deliberately not
 *
 * Only two things, because only two are wanted:
 *
 * 1. **`linecount`** — the exact number of records, before a byte of data is
 *    read. §12's "refused from the index alone" and §18.6's pre-flight estimate
 *    both want precisely this, and no other Hi-C container hands it over.
 * 2. **One byte span per chromosome pair**, as the union of that key's chunks.
 *
 * The bin index is walked to compute (2) and then discarded, exactly as
 * `parseTabix` discards it — and here the reason is stronger rather than
 * weaker. An import bins *every record in scope* at a chosen resolution; there
 * is no window to narrow to, so a finer index would be carried and never asked.
 * What the spans buy is scope: binning four contigs of a metagenome without
 * reading the other two thousand.
 */

import { BGZF_MAX_BLOCK, blockSize, inflateBgzf } from '../annotations/tabix'
import { ViewerError } from '../errors'
import type { ByteSource } from '../types'

/** The magics pairix has written, newest first; the flag is a 64-bit linecount. */
const MAGICS: Array<{ magic: string; wideLinecount: boolean }> = [
  { magic: 'PX2.004', wideLinecount: true },
  { magic: 'PX2.003', wideLinecount: false },
  { magic: 'PX2.002', wideLinecount: false },
]

/**
 * Candidate `sizeof(ti_conf_t)` values, in the order they are tried.
 *
 * 36 is the sum of the fields with natural alignment; 40 is what a build that
 * rounds the struct up to its largest member's multiple produces. Both are
 * validated rather than assumed — see the module docblock.
 */
const CONF_SIZES = [36, 40, 44]

/** Where one chromosome pair's records live, as compressed byte offsets. */
export interface PairSpan {
  /** First BGZF block holding a record for this pair. */
  from: number
  /** Byte offset of the last block holding one; the block extends past it. */
  to: number
}

export interface Px2Index {
  /** Chromosome-pair keys in index order, as written (`chr1|chr2`). */
  keys: string[]
  /** Byte span per key. */
  spans: Map<string, PairSpan>
  /** Exact record count, from the header. */
  linecount: number
  /** The character joining the two chromosomes in a key. */
  splitChar: string
  /** The comment character records are skipped by. */
  metaChar: string
  /** Header lines skipped when the index was built. */
  lineSkip: number
}

/** Split a `chr1|chr2` key into its two chromosomes. */
export function splitKey(key: string, splitChar: string): [string, string] {
  const at = key.indexOf(splitChar)
  return at < 0 ? [key, key] : [key.slice(0, at), key.slice(at + splitChar.length)]
}

/**
 * Parse a `.px2`.
 *
 * The index is itself BGZF, so it is inflated whole first — safe for the same
 * reason a `.tbi` is: it holds one entry per populated bin, not one per record.
 *
 * @throws ViewerError `format` when the magic is not pairix's, or when no
 *   candidate struct layout produces a coherent name block.
 */
export function parsePx2(inflated: Uint8Array): Px2Index {
  if (inflated.length < 20) {
    throw new ViewerError('format', 'This .px2 index is too short to hold a header.', {
      bytes: inflated.length,
    })
  }
  const view = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength)
  const magic = String.fromCharCode(...inflated.subarray(0, 8))
  const known = MAGICS.find((entry) => entry.magic === magic)
  if (known === undefined) {
    throw new ViewerError(
      'format',
      'This is not a pairix index: the magic bytes are not PX2. A `.tbi` cannot be used ' +
        'for a pairs file — build one with `pairix <file>.pairs.gz`.',
      { magic: magic.replace(/[^\x20-\x7e]/g, '?') },
    )
  }

  const nRef = view.getInt32(8, true)
  let at = 12
  let linecount: number
  if (known.wideLinecount) {
    linecount = Number(view.getBigUint64(at, true))
    at += 8
  } else {
    linecount = view.getUint32(at, true)
    at += 4
  }

  const layout = resolveConfLayout(view, inflated, at, nRef)
  const { splitChar, metaChar, lineSkip, namesAt, nameBytes } = layout

  const keys: string[] = []
  const raw = new TextDecoder().decode(inflated.subarray(namesAt, namesAt + nameBytes))
  for (const name of raw.split('\0')) if (name !== '') keys.push(name)

  let cursor = namesAt + nameBytes
  const spans = new Map<string, PairSpan>()
  for (let ref = 0; ref < nRef; ref++) {
    if (cursor + 4 > inflated.length) break
    const nBin = view.getInt32(cursor, true)
    cursor += 4
    let from = Number.POSITIVE_INFINITY
    let to = Number.NEGATIVE_INFINITY
    for (let b = 0; b < nBin; b++) {
      if (cursor + 8 > inflated.length) break
      // The bin number is not kept: every chunk of every bin belongs to this
      // key, and the span this module serves is their union.
      cursor += 4
      const nChunk = view.getInt32(cursor, true)
      cursor += 4
      for (let c = 0; c < nChunk; c++) {
        if (cursor + 16 > inflated.length) break
        // A virtual offset is `(block start << 16) | offset within block`, and
        // the block start alone passes 2^32 on any file over four gigabytes —
        // which a pairs file very much is. BigInt, not a `getUint32` pair.
        const begin = Number(view.getBigUint64(cursor, true) >> 16n)
        const end = Number(view.getBigUint64(cursor + 8, true) >> 16n)
        cursor += 16
        if (begin < from) from = begin
        if (end > to) to = end
      }
    }
    if (cursor + 4 > inflated.length) break
    const nIntv = view.getInt32(cursor, true)
    cursor += 4
    for (let i = 0; i < nIntv; i++) {
      if (cursor + 8 > inflated.length) break
      const offset = Number(view.getBigUint64(cursor, true) >> 16n)
      cursor += 8
      // The linear index only ever *lowers* the start.
      if (offset > 0 && offset < from) from = offset
    }
    if (Number.isFinite(from) && Number.isFinite(to) && ref < keys.length) {
      spans.set(keys[ref], { from, to })
    }
  }

  return { keys, spans, linecount, splitChar, metaChar, lineSkip }
}

interface ConfLayout {
  splitChar: string
  metaChar: string
  lineSkip: number
  namesAt: number
  nameBytes: number
}

/**
 * Pick the struct layout whose successor fields are coherent.
 *
 * The validation is the point: a wrong candidate does not produce a slightly
 * wrong answer, it produces a `nameBytes` that is negative, enormous, or runs
 * off the end of the buffer — all three of which are checked, along with the
 * name block actually holding `n_ref` names.
 */
function resolveConfLayout(
  view: DataView,
  bytes: Uint8Array,
  confAt: number,
  nRef: number,
): ConfLayout {
  const tried: number[] = []
  for (const size of CONF_SIZES) {
    const lengthAt = confAt + size
    if (lengthAt + 4 > bytes.length) continue
    const nameBytes = view.getInt32(lengthAt, true)
    const namesAt = lengthAt + 4
    tried.push(nameBytes)
    if (nameBytes <= 0 || namesAt + nameBytes > bytes.length) continue
    const names = new TextDecoder()
      .decode(bytes.subarray(namesAt, namesAt + nameBytes))
      .split('\0')
      .filter((name) => name !== '')
    if (names.length !== nRef) continue
    // The three single-byte fields sit immediately after the seven uint32s.
    const charsAt = confAt + 28
    return {
      splitChar: String.fromCharCode(bytes[charsAt + 1] || 0x7c),
      metaChar: String.fromCharCode(bytes[charsAt + 2] || 0x23),
      lineSkip: view.getInt32(confAt + 32, true),
      namesAt,
      nameBytes,
    }
  }
  throw new ViewerError(
    'format',
    'This .px2 index has a header this reader cannot lay out: no candidate config size ' +
      `produced a coherent name block for ${nRef} references. Rebuild it with ` +
      '`pairix <file>.pairs.gz`, or open the file without an index.',
    { nRef, candidates: CONF_SIZES, sawNameBytes: tried },
  )
}

/**
 * Load and parse the `.px2` sitting beside a pairs file, or `null`.
 *
 * `null` rather than a throw for an *absent* index, because an unindexed file
 * is a supported input and not an error — the import reads it whole and says
 * so. A present-but-broken index does throw, since silently ignoring one is how
 * a reader ends up scanning eleven gigabytes with no explanation.
 */
export async function loadPx2(open: () => Promise<ByteSource | null>): Promise<Px2Index | null> {
  const source = await open()
  if (source === null) return null
  try {
    const bytes = source.readBytes(0, source.size)
    return parsePx2(await inflateBgzf(bytes))
  } finally {
    source.close()
  }
}

/** A byte range to read, merged across the keys asked for. */
export interface ByteSpan {
  from: number
  to: number
}

/**
 * The byte spans covering `wanted`, merged where they touch.
 *
 * The end of each span is made **exact** rather than padded: `to` names the
 * start of the last block holding a record, and that block's own length is in
 * its header, so one 12-byte read turns a 64 KiB over-ask into a precise
 * boundary. That matters more here than it does for a tabix span, because the
 * result is fed to `DecompressionStream('gzip')` as a whole — and a truncated
 * final member is a decode error rather than a few wasted bytes.
 */
export function spansFor(
  index: Px2Index,
  wanted: readonly string[],
  source: ByteSource,
): ByteSpan[] {
  const spans: ByteSpan[] = []
  for (const key of wanted) {
    const span = index.spans.get(key)
    if (span === undefined) continue
    spans.push({ from: span.from, to: endOfBlockAt(source, span.to) })
  }
  spans.sort((a, b) => a.from - b.from)
  const merged: ByteSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    // A gap smaller than a source chunk costs more to seek over than to read
    // across — the same argument `CoolerStore.pixelBandsOf` makes about pixel
    // bands, and `tabix.ts` about sequence spans.
    if (last !== undefined && span.from <= last.to + (1 << 20)) {
      last.to = Math.max(last.to, span.to)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

/** One past the end of the BGZF block beginning at `at`. */
function endOfBlockAt(source: ByteSource, at: number): number {
  if (at >= source.size) return source.size
  const header = source.readBytes(at, Math.min(BGZF_MAX_BLOCK, source.size - at))
  const size = blockSize(header)
  return size === null ? Math.min(source.size, at + BGZF_MAX_BLOCK) : Math.min(source.size, at + size)
}
