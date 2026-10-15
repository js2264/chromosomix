/**
 * A window of reads, ready to draw: filtered, thinned, packed and counted.
 *
 * ## Where the work is, and why it is here
 *
 * Everything expensive about a pile-up happens once per *fetch* rather than
 * once per frame, and that is a correctness decision before it is a performance
 * one. Row assignment depends on which other reads are present, so packing at
 * paint time makes a read jump rows the moment its neighbour scrolls off —
 * under the reader's hand, while they are trying to follow it. Packing over the
 * fetched span pins each read to a row for as long as the bytes behind it are
 * in hand, which is §8.4's rule applied to layout.
 *
 * Thinning is here for the same reason. A deep window holds more reads than
 * there are rows to draw them in, and *which* reads survive must not depend on
 * where they happen to sit — otherwise reads reshuffle as the view moves. So
 * the choice is a hash of the read **name** against a keep-rate, which buys two
 * properties: a larger budget is a strict *superset* of a smaller one, so
 * growing the lane reveals more reads without rearranging the ones already
 * there; and every read decides for itself, so the answer does not depend on
 * the order they arrive.
 *
 * What it does not buy is independence from the window's own depth: the rate is
 * `budget / total`, so a pan into a deeper region thins harder and some reads
 * near the edge change their minds. That is inherent to rate-based thinning —
 * IGV has it too — and the padded fetch window is what keeps it rare, since the
 * rate is recomputed per *fetch* rather than per frame.
 *
 * What it counts is reads — how many the window held and how many were kept —
 * and not bases: the base counts that fed a consensus band are gone with the
 * band (§8.13), and the depth beside a pile is a row of its own.
 */

import { BASE_CODE } from '../fasta'
import type { ColourBy, PileMods, ReadPile } from '../types'
import {
  consumesQuery,
  consumesReference,
  forEachRecord,
  longCigarOf,
  readNameAt,
  SEQ_ALPHABET,
  skipTag,
  type RecordCursor,
} from './format'
import type { PileFilter } from './pile'
import { recordModCalls, type PlacedCall } from './basemods'

/** What a caller wants out of a window. */
export interface PileOptions {
  /**
   * Which records are **drawn**.
   *
   * There used to be a second, narrower filter here, for the base counts this
   * window also carried — a supplementary alignment is a second piece of one
   * molecule, so drawing it shows a reader where the molecule went while
   * *counting* it reports one fragment as two. Those counts are gone with the
   * consensus band they fed (§8.13), and the depth a reader compares this pile
   * against is now a row of its own, filtered on its own road (`coverageOf`,
   * which `readFilterKey` deliberately keeps the split-read switch out of).
   * So one filter, and it is the drawing one.
   */
  filter: PileFilter
  /** Rows the lane can draw. Reads beyond it are thinned away. */
  maxRows: number
  /** A hard ceiling on reads, whatever the rows allow. */
  maxReads: number
  colourBy: ColourBy
  /** Keep read names, which a reader can only ask for when reads are wide enough. */
  withNames: boolean
  /**
   * A file reference id → the name to show for it.
   *
   * Handed in because this module has the *ids* and only the worker has the
   * table: a `next_refID` is an index into the BAM header's own `@SQ` list, and
   * nothing in a window of records says what that sequence is called. Without
   * it a mate on another chromosome can only be reported as a number.
   *
   * Absent leaves every name in {@link ReadPile.contigs} an empty string — the
   * table is still built, so `mateContig` stays a valid index into it, and the
   * pile reports that it does not know the name rather than guessing one.
   */
  refNameOf?: (refId: number) => string | undefined
  /** Reference bases for the window, for mismatches. Absent means none available. */
  reference?: { start: number; bases: Uint8Array }
}

export interface PileResult {
  pile: ReadPile
  total: number
  kept: number
  capped: boolean
  rows: number
  /** `true` when any mismatch was derived from an `MD` tag rather than `=`/`X`. */
  usedMd: boolean
  /** `true` when any read carried `=`/`X` operations. */
  usedCigar: boolean
}

/**
 * A stable value in `[0, 1)` for a read name.
 *
 * FNV-1a, and the choice of *name* over position or file offset is the whole
 * point: a read keeps its number however the window moves, so thinning is
 * stable under a pan, and a larger keep-rate is a superset of a smaller one, so
 * growing the lane never rearranges what is already drawn.
 */
export function thinKey(bytes: Uint8Array, from: number, to: number): number {
  let hash = 0x811c9dc5
  for (let i = from; i < to; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 4294967296
}

/**
 * Build the pile for one window.
 *
 * `bytes` is the inflated content of the window's byte spans and begins at
 * `from` — which is a within-block offset, not zero (see `bam/index.ts`).
 */
export function pileOf(
  bytes: Uint8Array,
  from: number,
  contig: string,
  refId: number,
  start: number,
  end: number,
  options: PileOptions,
): PileResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // Two passes over one buffer. The first counts how many reads are in the
  // window and decides the keep rate; the second builds the arrays. Counting
  // first is what lets a read decide for itself whether it survives, so the
  // answer does not depend on the order they arrive.
  const drawn = options.filter
  let total = 0
  const keys: number[] = []
  forEachRecord(bytes, from, (cursor) => {
    if (!wanted(cursor, refId, start, end, drawn)) return
    total++
    keys.push(thinKey(bytes, cursor.at + 32, cursor.at + 32 + cursor.nameBytes - 1))
  })

  // The keep rate, as a *threshold* on the hash rather than a count: every read
  // decides for itself, so the answer does not depend on the order they arrive.
  const budget = Math.max(1, Math.min(options.maxReads, options.maxRows * ROWS_TO_READS))
  const rate = total <= budget ? 1 : budget / total
  const capped = rate < 1

  const rows: number[] = []
  const held: Held[] = []
  let index = 0
  forEachRecord(bytes, from, (cursor) => {
    if (!wanted(cursor, refId, start, end, drawn)) return
    const key = keys[index++]
    if (key >= rate) return
    held.push(read(bytes, view, cursor, options, rows))
  })

  return {
    pile: pack(held, contig, refId, start, end, options),
    total,
    kept: held.length,
    capped,
    rows: rows.length,
    usedMd: held.some((one) => one.fromMd),
    usedCigar: held.some((one) => one.fromCigar),
  }
}

/**
 * Reads per row, for turning a row budget into a read budget.
 *
 * A row holds several reads where they do not overlap — a 100 bp read in a
 * 10 kb window is a hundredth of a row — so a budget expressed in rows has to
 * be multiplied by something. Eight is deliberately generous: overshooting
 * means the packer runs out of rows and drops the tail, which is visible and
 * reported, while undershooting silently draws a sparser pile than the lane
 * could have held.
 */
const ROWS_TO_READS = 8

/** Whether this record counts at all. */
function wanted(
  cursor: RecordCursor,
  refId: number,
  start: number,
  end: number,
  filter: PileFilter,
): boolean {
  if (cursor.refId !== refId) return false
  if ((cursor.flag & filter.exclude) !== 0) return false
  if (cursor.mapq < filter.minMapq) return false
  return cursor.pos >= 0 && cursor.end > start && cursor.pos < end
}

/** One read, before it is flattened into the pile's arrays. */
interface Held {
  refStart: number
  refEnd: number
  clipStart: number
  clipEnd: number
  row: number
  flag: number
  mapq: number
  mateContig: number
  matePos: number
  tlen: number
  name: string
  ops: number[]
  diffPos: number[]
  diffBase: number[]
  fromMd: boolean
  fromCigar: boolean
  /** Its base-modification calls, where the pile is coloured by them; `null` otherwise. */
  mods: PlacedCall[] | null
}

function read(
  bytes: Uint8Array,
  view: DataView,
  cursor: RecordCursor,
  options: PileOptions,
  rows: number[],
): Held {
  const long = longCigarOf(bytes, cursor)
  const opCount = long === null ? cursor.cigarOps : long.length
  const opAt = (i: number): number =>
    long === null ? view.getUint32(cursor.cigarAt + i * 4, true) : long[i]

  const ops: number[] = []
  let clipStart = 0
  let clipEnd = 0
  for (let i = 0; i < opCount; i++) {
    const packed = opAt(i)
    ops.push(packed)
    const op = packed & 0xf
    const length = packed >>> 4
    // Soft clips at either end are drawn faintly, so they are kept apart from
    // the aligned extent rather than folded into it: a read whose clip is half
    // its length is saying something about the alignment.
    if (op === 4) {
      if (i === 0 || (i === 1 && (opAt(0) & 0xf) === 5)) clipStart = length
      else if (i === opCount - 1 || (i === opCount - 2 && (opAt(opCount - 1) & 0xf) === 5)) {
        clipEnd = length
      }
    }
  }

  const diffs = mismatches(bytes, cursor, ops, options.reference)
  // Packed against the *clipped* extent, so a read whose soft clip is drawn
  // does not overlap the one beside it.
  const row = place(rows, cursor.pos - clipStart, cursor.end + clipEnd)

  return {
    refStart: cursor.pos,
    refEnd: cursor.end,
    clipStart,
    clipEnd,
    row,
    flag: cursor.flag,
    mapq: cursor.mapq,
    mateContig: cursor.nextRefId,
    matePos: cursor.nextPos,
    tlen: cursor.tlen,
    // Always, even when they are not shipped. Two records are one template
    // because they share a name, so the join below needs every name whether or
    // not a reader will ever see one.
    name: readNameAt(bytes, cursor),
    ops,
    diffPos: diffs.pos,
    diffBase: diffs.base,
    fromMd: diffs.fromMd,
    fromCigar: diffs.fromCigar,
    // Only when asked: the tag walk is cheap but unpacking SEQ for every read
    // of a window is not, and nothing else here needs the bases.
    mods: options.colourBy === 'basemod' ? recordModCalls(bytes, cursor, ops) : null,
  }
}

/** Bases between two reads in one row, so they read as two and not one. */
const ROW_GAP = 3

/** The first row this read fits in, growing the stack when none does. */
function place(rows: number[], from: number, to: number): number {
  for (let row = 0; row < rows.length; row++) {
    if (rows[row] + ROW_GAP <= from) {
      rows[row] = to
      return row
    }
  }
  rows.push(to)
  return rows.length - 1
}

/** The `BASE_CODE` value of the read's base at `index`, from the packed nibbles. */
function baseAt(bytes: Uint8Array, seqAt: number, index: number): number {
  const byte = bytes[seqAt + (index >> 1)]
  const nibble = index % 2 === 0 ? byte >> 4 : byte & 0xf
  return BASE_CODE[SEQ_ALPHABET.charCodeAt(nibble)]
}

// ---------------------------------------------------------------------------
// Disagreement with the reference, in three tiers
// ---------------------------------------------------------------------------

interface Diffs {
  pos: number[]
  base: number[]
  fromMd: boolean
  fromCigar: boolean
}

/**
 * Where this read disagrees with the reference, from whatever says so.
 *
 * Three sources in order of directness, and none of them is available on every
 * file — which is why {@link ReadWindow.diffs} reports which one answered.
 *
 * 1. **`=` and `X` operations.** The aligner said outright which bases match.
 *    Rare, but unambiguous and free.
 * 2. **The `MD` tag.** Carries the *reference* bases at each mismatch, so the
 *    read's own base is the answer. Neither `bwa mem` nor `minimap2` writes one
 *    by default, so this is absent more often than not.
 * 3. **A reference we already hold** — residues of a FASTA open in the same
 *    worker. Costs nothing extra and works over an assembly nobody published.
 *
 * Each walks an aligned op only as far as the read has bases for it, and the
 * third only where the reference is held: an op's length is twenty-eight bits
 * of the file, and walking it whole, base by base, was hours of one corrupt
 * record (§10). A real read's aligned bases are all its own, so nothing a real
 * read says is lost — and a read stored without its bases (`*`) no longer has
 * the bytes after them compared as though they were.
 */
function mismatches(
  bytes: Uint8Array,
  cursor: RecordCursor,
  ops: number[],
  reference?: { start: number; bases: Uint8Array },
): Diffs {
  const out: Diffs = { pos: [], base: [], fromMd: false, fromCigar: false }

  // (1) The aligner said so.
  if (ops.some((packed) => (packed & 0xf) === 8)) {
    let refPos = cursor.pos
    let queryPos = 0
    for (const packed of ops) {
      const op = packed & 0xf
      const length = packed >>> 4
      if (op === 8) {
        const span = Math.min(length, cursor.seqLength - queryPos)
        for (let k = 0; k < span; k++) {
          out.pos.push(refPos + k)
          out.base.push(baseAt(bytes, cursor.seqAt, queryPos + k))
        }
      }
      if (consumesReference(op)) refPos += length
      if (consumesQuery(op)) queryPos += length
    }
    out.fromCigar = true
    return out
  }

  // (2) The MD tag.
  const md = mdTag(bytes, cursor)
  if (md !== null) {
    fromMd(bytes, cursor, ops, md, out)
    out.fromMd = true
    return out
  }

  // (3) Residues we happen to hold.
  if (reference !== undefined) {
    let refPos = cursor.pos
    let queryPos = 0
    const referenceEnd = reference.start + reference.bases.length
    for (const packed of ops) {
      const op = packed & 0xf
      const length = packed >>> 4
      if (consumesReference(op) && consumesQuery(op)) {
        const from = Math.max(0, reference.start - refPos)
        const to = Math.min(length, referenceEnd - refPos, cursor.seqLength - queryPos)
        for (let k = from; k < to; k++) {
          const at = refPos + k - reference.start
          const want = BASE_CODE[reference.bases[at]]
          const have = baseAt(bytes, cursor.seqAt, queryPos + k)
          // Only a definite disagreement between two known bases. An `N` on
          // either side is an absence of information, not a variant.
          if (want !== have && want < 4 && have < 4) {
            out.pos.push(refPos + k)
            out.base.push(have)
          }
        }
      }
      if (consumesReference(op)) refPos += length
      if (consumesQuery(op)) queryPos += length
    }
  }
  return out
}

/** The `MD` tag's text, or `null`. Read directly rather than decoding every tag. */
function mdTag(bytes: Uint8Array, cursor: RecordCursor): string | null {
  const qualAt = cursor.seqAt + ((cursor.seqLength + 1) >> 1)
  let at = qualAt + cursor.seqLength
  const to = cursor.at + cursor.bytes - 4
  while (at + 3 <= to) {
    const tag = String.fromCharCode(bytes[at], bytes[at + 1])
    const type = String.fromCharCode(bytes[at + 2])
    at += 3
    if (tag === 'MD' && type === 'Z') {
      let end = at
      while (end < to && bytes[end] !== 0) end++
      return new TextDecoder().decode(bytes.subarray(at, end))
    }
    at = skipTag(bytes, at, type, to)
    if (at < 0) return null
  }
  return null
}


/**
 * Walk an `MD` tag alongside the CIGAR.
 *
 * `MD` counts only the bases that align — it knows nothing of insertions or
 * soft clips — so the two have to be walked together: the CIGAR says which of
 * the read's bases are aligned and where, and `MD` says which of *those*
 * disagree. A deletion appears in `MD` as `^` and its reference bases, and
 * consumes no aligned base at all.
 */
function fromMd(
  bytes: Uint8Array,
  cursor: RecordCursor,
  ops: number[],
  md: string,
  out: Diffs,
): void {
  // The aligned bases, in order: their reference position and their query index.
  const refOf: number[] = []
  const queryOf: number[] = []
  let refPos = cursor.pos
  let queryPos = 0
  for (const packed of ops) {
    const op = packed & 0xf
    const length = packed >>> 4
    if (consumesReference(op) && consumesQuery(op)) {
      // As far as the read has bases: see {@link mismatches}.
      const span = Math.min(length, cursor.seqLength - queryPos)
      for (let k = 0; k < span; k++) {
        refOf.push(refPos + k)
        queryOf.push(queryPos + k)
      }
    }
    if (consumesReference(op)) refPos += length
    if (consumesQuery(op)) queryPos += length
  }

  let at = 0
  for (const token of md.match(/(\d+|\^[A-Za-z]+|[A-Za-z])/g) ?? []) {
    if (token.charCodeAt(0) === 94) continue // `^`: a deletion, no aligned base
    const number = Number(token)
    if (Number.isFinite(number) && token !== '') {
      at += number
      continue
    }
    if (at < refOf.length) {
      out.pos.push(refOf[at])
      out.base.push(baseAt(bytes, cursor.seqAt, queryOf[at]))
    }
    at += 1
  }
}

// ---------------------------------------------------------------------------
// Flattening, mates, and colour
// ---------------------------------------------------------------------------

import { FLAG } from './format'

/**
 * Insert sizes past which a pair is drawn as unusual.
 *
 * A number rather than a distribution, because the alternative is estimating
 * one from the window on screen — which changes as the reader pans, so the same
 * pair would be flagged in one view and not the next. `1000` is generous for
 * the short-insert libraries §8.13 is scoped to; a Hi-C library's entire signal
 * lives above it, which is one of several reasons that case is not this one.
 */
const LARGE_INSERT = 1000

/** Which category a read falls in, under the chosen colouring. */
function categoryOf(one: Held, by: ColourBy, refId: number): number {
  switch (by) {
    case 'strand':
      return (one.flag & FLAG.REVERSE) !== 0 ? 1 : 0
    case 'mapq':
      // Three bands rather than a gradient: a reader is asking "can I trust
      // this one", which is a question with a small number of answers.
      return one.mapq === 0 ? 0 : one.mapq < 30 ? 1 : 2
    case 'pair':
      if ((one.flag & FLAG.PAIRED) === 0) return 0
      if ((one.flag & FLAG.PROPER_PAIR) !== 0) return 1
      return 2
    case 'mate':
      if ((one.flag & FLAG.PAIRED) === 0) return 0
      // The *flag*, not `next_refID`. A mapped read whose mate is unmapped is
      // written by bwa, bowtie2, samtools fixmate and GATK with RNEXT `=` and
      // PNEXT equal to its own position — the SAM specification recommends it,
      // so the mate is placed beside its partner rather than left floating — and
      // reading the reference id instead put every one of them in "same
      // sequence". The category existed, had a swatch in the legend, and could
      // never be reached; and clicking such a read opened a card that said
      // "unmapped", because `ReadDialog` reads the flag.
      if ((one.flag & FLAG.MATE_UNMAPPED) !== 0) return 1
      if (one.mateContig < 0) return 1
      return one.mateContig === refId ? 2 : 3
    case 'insert': {
      const size = Math.abs(one.tlen)
      if ((one.flag & FLAG.PAIRED) === 0 || size === 0) return 0
      return size > LARGE_INSERT ? 2 : 1
    }
    default:
      return 0
  }
}

/** The labels a colouring uses, in category order. */
export function groupsFor(by: ColourBy): string[] {
  switch (by) {
    case 'strand':
      return ['forward', 'reverse']
    case 'mapq':
      return ['MAPQ 0', 'MAPQ < 30', 'MAPQ ≥ 30']
    case 'pair':
      return ['unpaired', 'proper pair', 'not a proper pair']
    case 'mate':
      return ['unpaired', 'mate unmapped', 'same sequence', 'another sequence']
    case 'insert':
      return ['unpaired', 'ordinary insert', `insert > ${LARGE_INSERT}`]
    case 'basemod':
      // One category: the reads are drawn plain and the calls on them carry
      // the colour (§8.13), so the key is the calls' and not the reads'.
      return ['reads']
    default:
      return ['reads']
  }
}

/**
 * Flatten the held reads into the pile's parallel arrays.
 *
 * Mates are joined here, over the window, rather than left to the renderer: it
 * is one pass with a map, and doing it per frame would rebuild that map sixty
 * times a second. A read whose mate is outside the window keeps `-1` and is
 * drawn with a stub — the same as an unpaired read, because in both cases there
 * is nothing on screen to draw a line to.
 */
function pack(
  held: Held[],
  contig: string,
  refId: number,
  start: number,
  end: number,
  options: PileOptions,
): ReadPile {
  const length = held.length
  const pile: ReadPile = {
    contig,
    start,
    end,
    length,
    refStart: new Int32Array(length),
    refEnd: new Int32Array(length),
    clipStart: new Int32Array(length),
    clipEnd: new Int32Array(length),
    row: new Int16Array(length),
    flags: new Uint16Array(length),
    mapq: new Uint8Array(length),
    mateContig: new Int32Array(length),
    matePos: new Int32Array(length),
    tlen: new Int32Array(length),
    group: new Uint8Array(length),
    mate: new Int32Array(length).fill(-1),
    opAt: new Int32Array(length + 1),
    opCode: new Uint8Array(held.reduce((sum, one) => sum + one.ops.length, 0)),
    opLen: new Int32Array(held.reduce((sum, one) => sum + one.ops.length, 0)),
    diffAt: new Int32Array(length + 1),
    diffPos: new Int32Array(held.reduce((sum, one) => sum + one.diffPos.length, 0)),
    diffBase: new Uint8Array(held.reduce((sum, one) => sum + one.diffPos.length, 0)),
    contigs: [],
    groups: groupsFor(options.colourBy),
    names: [],
  }

  let ops = 0
  let diffs = 0
  for (let i = 0; i < length; i++) {
    const one = held[i]
    pile.refStart[i] = one.refStart
    pile.refEnd[i] = one.refEnd
    pile.clipStart[i] = one.clipStart
    pile.clipEnd[i] = one.clipEnd
    pile.row[i] = one.row
    pile.flags[i] = one.flag
    pile.mapq[i] = one.mapq
    pile.mateContig[i] = one.mateContig
    pile.matePos[i] = one.matePos
    pile.tlen[i] = one.tlen
    pile.opAt[i] = ops
    for (const packed of one.ops) {
      pile.opCode[ops] = packed & 0xf
      pile.opLen[ops] = packed >>> 4
      ops++
    }
    pile.diffAt[i] = diffs
    for (let k = 0; k < one.diffPos.length; k++) {
      pile.diffPos[diffs] = one.diffPos[k]
      pile.diffBase[diffs] = one.diffBase[k]
      diffs++
    }
    if (options.withNames) pile.names.push(one.name)
  }
  pile.opAt[length] = ops
  pile.diffAt[length] = diffs
  if (options.colourBy === 'basemod') pile.mods = packMods(held)

  for (let i = 0; i < length; i++) pile.group[i] = categoryOf(held[i], options.colourBy, refId)

  nameMates(pile, refId, contig, options)
  joinMates(pile, held)
  return pile
}

/**
 * Flatten every read's modification calls into the pile's {@link PileMods}.
 *
 * Codes are numbered by how many modified calls each has in the window, most first,
 * so `codes[0]` is what an unset choice of modification resolves to — the
 * same answer the lane, its key and its readout then all give.
 */
function packMods(held: Held[]): PileMods {
  // [modified calls, all calls] per code: ranked by the first and then the
  // second, so a code with no modified call anywhere still has a place.
  const tally = new Map<string, [number, number]>()
  let total = 0
  for (const one of held) {
    for (const call of one.mods ?? []) {
      const counted = tally.get(call.code) ?? [0, 0]
      if (call.prob >= 128) counted[0]++
      counted[1]++
      tally.set(call.code, counted)
      total++
    }
  }
  const ranked = [...tally.entries()].sort(
    (a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || (a[0] < b[0] ? -1 : 1),
  )
  const index = new Map(ranked.map(([code], at) => [code, at]))
  const out: PileMods = {
    at: new Int32Array(held.length + 1),
    pos: new Int32Array(total),
    code: new Uint8Array(total),
    prob: new Uint8Array(total),
    codes: ranked.map(([code]) => code),
    counts: ranked.map(([, [modified]]) => modified),
  }
  let at = 0
  for (let i = 0; i < held.length; i++) {
    out.at[i] = at
    for (const call of held[i].mods ?? []) {
      out.pos[at] = call.pos
      out.code[at] = index.get(call.code) ?? 0
      out.prob[at] = call.prob
      at++
    }
  }
  out.at[held.length] = at
  return out
}

/**
 * Turn each mate's *file* reference id into an index into {@link ReadPile.contigs}.
 *
 * Two things happen here and both matter. The ids are compacted — a window
 * whose mates land on three sequences carries three names, not the header's
 * whole `@SQ` list, which for a scaffolded assembly is a hundred thousand
 * strings sent per window.
 *
 * And the read's *own* sequence is named with the name the caller asked about
 * rather than the file's. Those differ whenever the map and the file disagree
 * about spelling (§5.9): a file saying `1` under a map saying `chr1` would
 * otherwise report every ordinary mate as being on another sequence, which is
 * the shape of "this library has translocations everywhere".
 */
function nameMates(pile: ReadPile, refId: number, contig: string, options: PileOptions): void {
  const seen = new Map<number, number>()
  for (let i = 0; i < pile.length; i++) {
    const id = pile.mateContig[i]
    if (id < 0) {
      pile.mateContig[i] = -1
      continue
    }
    let at = seen.get(id)
    if (at === undefined) {
      at = pile.contigs.length
      pile.contigs.push(id === refId ? contig : (options.refNameOf?.(id) ?? ''))
      seen.set(id, at)
    }
    pile.mateContig[i] = at
  }
}

/**
 * Join each read to the other end of its template, where both are here.
 *
 * By name, which is what makes two records one template. Only pairs where both
 * ends survived the thinning are joined — a read whose mate was thinned away is
 * drawn as though its mate were off-screen, which is honest: it is not here.
 */
function joinMates(pile: ReadPile, held: Held[]): void {
  const seen = new Map<string, number>()
  for (let i = 0; i < held.length; i++) {
    const name = held[i].name
    if (name === '') continue
    // A supplementary record is skipped outright rather than tested against
    // whatever else wears the name. Two reasons, and the second is the one that
    // bit: it is another piece of the *same* end, so joining it would draw an
    // insert thread across a breakpoint no template spans — and if it merely
    // lost the comparison it would still have claimed the name below, which for
    // a split whose second piece maps upstream is the first record in
    // coordinate order. The two genuine ends would then never meet each other,
    // so turning on split reads would silently remove the threads from exactly
    // the templates it was turned on to look at.
    if ((pile.flags[i] & FLAG.SUPPLEMENTARY) !== 0) continue
    const first = seen.get(name)
    if (first === undefined) {
      seen.set(name, i)
      continue
    }
    // Only the two *ends* of one template. A name is not enough to say that two
    // records are each other's mate — it is also what a reused name and a third
    // alignment of one end look like — so the flags have to agree that these
    // are opposite ends.
    if (
      pile.mate[first] === -1 &&
      pile.mate[i] === -1 &&
      ((pile.flags[first] ^ pile.flags[i]) & (FLAG.FIRST_IN_PAIR | FLAG.SECOND_IN_PAIR)) !== 0
    ) {
      pile.mate[first] = i
      pile.mate[i] = first
    }
  }
}
