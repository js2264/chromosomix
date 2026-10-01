/**
 * Base modifications, from a read's `MM` and `ML` tags (SAMtags §1.7).
 *
 * ## What the two tags say
 *
 * `MM` is a list of groups, one per (base, strand, modification set):
 *
 * ```
 * MM:Z:C+m?,5,12,0;C+h?,5,12,0;A+a.,0,3;
 * ```
 *
 * Each group names a **canonical base** (`C`, or `N` for any base), the
 * **strand** the modification is on relative to the read as sequenced, one or
 * more **codes** — single letters (`m` 5mC, `h` 5hmC, `a` 6mA …) run together
 * as `mh`, or one ChEBI number — an optional **mode**, and then **skip counts**.
 * A skip count is how many of that base to step over before the next one that
 * carries a call: `C+m,5,12,0` puts calls on the 6th, 19th and 20th `C`.
 *
 * `ML` is one byte per call, in the order the groups list them and, inside a
 * group, position-major — `C+mh,0` carries two bytes, `m` then `h` for the one
 * cytosine. A byte `p` is the probability `(p + 0.5) / 256`, which is the
 * spec's own reading and the one modkit and IGV both use: no byte means
 * exactly zero or exactly one.
 *
 * ## The three things that are easy to get wrong
 *
 * **The bases are counted on the read as it came off the sequencer.** SEQ is
 * stored reverse-complemented for a reverse-strand alignment, so the count
 * runs over the reverse complement of SEQ, from what is SEQ's *last* base. A
 * reader that counts on SEQ as stored puts every reverse read's calls on the
 * wrong bases — usually on no `C` at all — and nothing errors.
 *
 * **The letter in `MM` is matched on that sequence whatever the strand sign
 * says.** `G-m` counts `G`s in the read; the `-` says the 5mC is on the
 * opposite strand, the cytosine paired with that `G`. That is htslib's reading.
 *
 * **The mode decides what the bases with no call mean.** `.`, and no mode at
 * all, which the spec makes the same, say a skipped base *is* unmodified: a
 * caller wrote nothing because it had nothing to report. `?` says nothing about
 * a skipped base, which is what a caller that only reports some sites writes.
 * So a `.` group yields a call — low probability, flagged implicit — at every
 * base it steps over and every base after its last skip, and a `?` group yields
 * calls only where it lists them. A fraction modified computed without that
 * difference reports a 5% site as 100% on any file written with `?`.
 *
 * ## Where a call lands
 *
 * On the reference through the CIGAR, as every base of the read does. A call
 * on a base in a soft clip or an insertion has no reference position and is
 * dropped — the read is not aligned there, so there is no column to colour —
 * and a deletion or a splice simply advances the reference past bases the read
 * does not have.
 *
 * A record whose tags disagree with its own sequence — skips that run off the
 * end of it, an `ML` shorter than the calls `MM` makes, an `MN` that is not the
 * length of SEQ (the tags outlived a hard clip) — yields no calls at all. A
 * partial reading of a malformed record would be calls on the wrong bases,
 * which is worse than none.
 */

import { consumesQuery, consumesReference, longCigarOf, readSequence, skipTag, type RecordCursor } from './format'

/** One group of `MM`: a base, a strand, its codes, its mode and its skips. */
export interface ModGroup {
  /** The canonical base, upper case: `A C G T N` (`U` is read as `T`). */
  base: string
  strand: '+' | '-'
  /** `['m', 'h']` for `C+mh`; `['76792']` for a ChEBI code. */
  codes: string[]
  /** `implicit` for `.` or no mode — an unlisted base is unmodified; `explicit` for `?`. */
  mode: 'implicit' | 'explicit'
  /** Skip counts, as written. */
  skips: number[]
}

/** One modification call on one base of a read. */
export interface ModCall {
  /** Index into SEQ **as stored** — the orientation the CIGAR walks. */
  query: number
  code: string
  /** The `ML` byte, `0 … 255`; `255` where the record carries no `ML`. */
  prob: number
  /** `true` for a base a `.` group stepped over: unmodified by the file's own statement. */
  implicit: boolean
}

const GROUP = /^([ACGTUN])([-+])([A-Za-z]+|\d+)([.?]?)((?:,\d+)*),?$/

/**
 * Parse an `MM` string into its groups, or `null` where it is malformed.
 *
 * The trailing `;` is optional in practice — early ONT basecallers dropped it —
 * and an empty group between two `;` is skipped rather than refused.
 */
export function parseMM(text: string): ModGroup[] | null {
  const out: ModGroup[] = []
  for (const raw of text.split(';')) {
    const part = raw.trim()
    if (part === '') continue
    const match = GROUP.exec(part)
    if (match === null) return null
    const [, base, strand, codeText, mode, skipText] = match
    const codes = /^\d+$/.test(codeText) ? [codeText] : [...codeText]
    const skips = skipText === '' ? [] : skipText.slice(1).split(',').map(Number)
    out.push({
      base: base === 'U' ? 'T' : base,
      strand: strand as '+' | '-',
      codes,
      mode: mode === '?' ? 'explicit' : 'implicit',
      skips,
    })
  }
  return out
}

const COMPLEMENT: Record<string, string> = {
  A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', N: 'N',
  M: 'K', K: 'M', R: 'Y', Y: 'R', S: 'S', W: 'W', B: 'V', V: 'B', D: 'H', H: 'D',
}

/** The reverse complement of a sequence, IUPAC codes included. */
export function reverseComplement(seq: string): string {
  let out = ''
  for (let i = seq.length - 1; i >= 0; i--) {
    const base = seq[i].toUpperCase()
    out += COMPLEMENT[base] ?? 'N'
  }
  return out
}

/**
 * Every call `MM` and `ML` make on one read, in SEQ's stored orientation.
 *
 * `seq` is SEQ as the record stores it and `reverse` is the record's
 * `0x10` bit; the counting is done on the read as sequenced and the indices
 * are turned back before they are returned, so a caller walks the CIGAR with
 * them directly. `ml` absent means every listed call is certain (`255`).
 *
 * Sorted by `query`, and empty for a record whose tags do not fit its
 * sequence — see the module's last paragraph.
 */
export function modCallsOf(
  seq: string,
  reverse: boolean,
  mm: string,
  ml: ArrayLike<number> | null,
): ModCall[] {
  const groups = parseMM(mm)
  if (groups === null || seq.length === 0) return []
  const original = reverse ? reverseComplement(seq) : seq.toUpperCase()
  const length = original.length
  const toStored = (index: number): number => (reverse ? length - 1 - index : index)
  const out: ModCall[] = []
  let mlAt = 0

  for (const group of groups) {
    const needed = group.skips.length * group.codes.length
    if (ml !== null && mlAt + needed > ml.length) return []
    const matches = (base: string): boolean => group.base === 'N' || base === group.base
    let at = 0
    for (let k = 0; k < group.skips.length; k++) {
      let skip = group.skips[k]
      // Step over `skip` matching bases — each one, under `.`, a statement
      // that the base is unmodified — and land on the next.
      while (at < length) {
        if (matches(original[at])) {
          if (skip === 0) break
          if (group.mode === 'implicit') {
            for (const code of group.codes) {
              out.push({ query: toStored(at), code, prob: 0, implicit: true })
            }
          }
          skip--
        }
        at++
      }
      if (at >= length) return []
      for (let c = 0; c < group.codes.length; c++) {
        const prob = ml === null ? 255 : ml[mlAt + k * group.codes.length + c]
        out.push({ query: toStored(at), code: group.codes[c], prob, implicit: false })
      }
      at++
    }
    // After the last listed base, the rest of this base are unmodified under
    // `.` and unknown under `?`.
    if (group.mode === 'implicit') {
      for (; at < length; at++) {
        if (!matches(original[at])) continue
        for (const code of group.codes) out.push({ query: toStored(at), code, prob: 0, implicit: true })
      }
    }
    mlAt += needed
  }
  out.sort((a, b) => a.query - b.query)
  return out
}

/**
 * The reference position of every base of SEQ, `-1` where it has none.
 *
 * A soft clip and an insertion consume the read and not the reference, so their
 * bases are `-1`; a deletion and a splice consume the reference and not the
 * read, so they move the position on and assign nothing; a hard clip is not in
 * SEQ at all.
 */
export function queryToReference(ops: ArrayLike<number>, pos: number, seqLength: number): Int32Array {
  const out = new Int32Array(seqLength).fill(-1)
  let ref = pos
  let query = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] & 0xf
    const length = ops[i] >>> 4
    const onRef = consumesReference(op)
    const onQuery = consumesQuery(op)
    if (onRef && onQuery) {
      for (let k = 0; k < length && query + k < seqLength; k++) out[query + k] = ref + k
    }
    if (onRef) ref += length
    if (onQuery) query += length
  }
  return out
}

/** A call placed on the reference. */
export interface PlacedCall {
  /** 0-based reference position. */
  pos: number
  code: string
  prob: number
  implicit: boolean
}

/**
 * Calls on a read, on the reference — dropping those in clips and insertions.
 *
 * The decoded-record road, for a caller holding a whole record (a dialog, a
 * test); {@link recordModCalls} is the same answer read out of a buffer.
 */
export function placeModCalls(calls: readonly ModCall[], ops: ArrayLike<number>, pos: number, seqLength: number): PlacedCall[] {
  if (calls.length === 0) return []
  const reference = queryToReference(ops, pos, seqLength)
  const out: PlacedCall[] = []
  for (const call of calls) {
    const at = reference[call.query]
    if (at === undefined || at < 0) continue
    out.push({ pos: at, code: call.code, prob: call.prob, implicit: call.implicit })
  }
  out.sort((a, b) => a.pos - b.pos)
  return out
}

/** The three tags this reads, out of one record's tag block. */
export interface ModTags {
  mm: string | null
  ml: Uint8Array | null
  /** `MN`: the SEQ length `MM` was written against, where the writer said. */
  mn: number | null
}

/**
 * Find `MM`/`Mm`, `ML`/`Ml` and `MN` in a record without decoding every tag.
 *
 * The lower-case spellings are the draft names the first ONT basecallers
 * wrote, before the tags were standardised, and files carrying them are still
 * the commonest kind of modified-base BAM on public servers.
 */
export function modTagsAt(bytes: Uint8Array, cursor: RecordCursor): ModTags {
  const out: ModTags = { mm: null, ml: null, mn: null }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = cursor.seqAt + ((cursor.seqLength + 1) >> 1) + cursor.seqLength
  const to = cursor.at + cursor.bytes - 4
  while (at + 3 <= to) {
    const a = bytes[at]
    const b = bytes[at + 1]
    const type = String.fromCharCode(bytes[at + 2])
    at += 3
    // `M` and then `M`/`m`, `L`/`l`, `N`.
    if (a === 77) {
      if ((b === 77 || b === 109) && type === 'Z') {
        let end = at
        while (end < to && bytes[end] !== 0) end++
        out.mm = new TextDecoder().decode(bytes.subarray(at, end))
      } else if ((b === 76 || b === 108) && type === 'B' && bytes[at] === 67) {
        const count = view.getInt32(at + 1, true)
        if (count >= 0 && at + 5 + count <= to) out.ml = bytes.slice(at + 5, at + 5 + count)
      } else if (b === 78 && 'cCsSiI'.includes(type)) {
        out.mn = readInteger(view, at, type)
      }
    }
    at = skipTag(bytes, at, type, to)
    if (at < 0) break
  }
  return out
}

function readInteger(view: DataView, at: number, type: string): number {
  switch (type) {
    case 'c': return view.getInt8(at)
    case 'C': return view.getUint8(at)
    case 's': return view.getInt16(at, true)
    case 'S': return view.getUint16(at, true)
    case 'i': return view.getInt32(at, true)
    default: return view.getUint32(at, true)
  }
}

/**
 * Every call one record makes, on the reference, read straight out of the
 * buffer: the road the pile and the depth both take.
 *
 * Empty — and cheap — for the overwhelming majority of records in the
 * overwhelming majority of files, which carry no `MM` at all: the tag walk is
 * the whole cost, and the sequence is only unpacked once a tag is found.
 */
export function recordModCalls(bytes: Uint8Array, cursor: RecordCursor, ops: ArrayLike<number> | null = null): PlacedCall[] {
  if (cursor.seqLength <= 0) return []
  const tags = modTagsAt(bytes, cursor)
  if (tags.mm === null || tags.mm === '') return []
  if (tags.mn !== null && tags.mn !== cursor.seqLength) return []
  const seq = readSequence(bytes, cursor.seqAt, cursor.seqLength)
  const calls = modCallsOf(seq, (cursor.flag & 0x10) !== 0, tags.mm, tags.ml)
  if (calls.length === 0) return []
  return placeModCalls(calls, ops ?? cigarOf(bytes, cursor), cursor.pos, cursor.seqLength)
}

function cigarOf(bytes: Uint8Array, cursor: RecordCursor): ArrayLike<number> {
  const long = longCigarOf(bytes, cursor)
  if (long !== null) return long
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Uint32Array(cursor.cigarOps)
  for (let i = 0; i < cursor.cigarOps; i++) out[i] = view.getUint32(cursor.cigarAt + i * 4, true)
  return out
}

/** An `ML` byte as the probability it encodes: `(p + 0.5) / 256`. */
export function probabilityOf(byte: number): number {
  return (byte + 0.5) / 256
}

/**
 * Which side of a threshold a call falls: `1` modified, `0` unmodified, `-1`
 * neither.
 *
 * Two-sided, as modkit's `--filter-threshold` is: a call is *modified* at or
 * above `threshold` and *unmodified* at or below `1 − threshold`, and anything
 * between is a call the caller was not sure of, which is left out of a
 * fraction and not drawn. At `0.5` nothing is between, because no byte encodes
 * exactly a half.
 */
export function modStateOf(byte: number, threshold: number): 1 | 0 | -1 {
  const p = probabilityOf(byte)
  if (p >= threshold) return 1
  if (p <= 1 - threshold) return 0
  return -1
}

/**
 * The modification codes, by name — SAMtags §1.7's table, plus the ChEBI
 * numbers in common use that have no letter.
 */
export const MOD_CODE_NAMES: Record<string, string> = {
  m: '5mC',
  h: '5hmC',
  f: '5fC',
  c: '5caC',
  C: 'any C mod',
  g: '5hmU',
  e: '5fU',
  b: '5caU',
  T: 'any T mod',
  U: 'any U mod',
  a: '6mA',
  A: 'any A mod',
  o: '8oxoG',
  G: 'any G mod',
  n: 'Xao',
  N: 'any mod',
  '21839': '4mC',
  '17802': 'pseU',
  '17596': 'inosine',
  '27551': '5mC',
  '76792': '5hmC',
  '28871': '6mA',
}

/** `5mC`, or the code itself where it is not one the table knows. */
export function modName(code: string): string {
  return MOD_CODE_NAMES[code] ?? (/^\d+$/.test(code) ? `ChEBI:${code}` : code)
}

/** `5mC (m)` — the name and the code a reader will find in the file. */
export function modLabel(code: string): string {
  const name = modName(code)
  return name === code ? code : `${name} (${code})`
}
