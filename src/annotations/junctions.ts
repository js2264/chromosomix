/**
 * RNA-seq splice junctions: STAR's `SJ.out.tab`, a junctions BED, a leafcutter
 * `.junc` (§8.23).
 *
 * A junction is an **intron a read was seen to skip**: the last base of one
 * exon joined to the first base of the next, with a count of the reads that
 * said so. Every aligner that splices reports them, in one of three shapes:
 *
 * | Shape | Written by | Coordinates | Count |
 * |---|---|---|---|
 * | `SJ.out.tab`, nine integer columns | STAR | the intron, 1-based inclusive | unique reads (col 7) |
 * | BED12 of two blocks | TopHat, regtools, IGV, Portcullis | the two anchors and the gap | the score |
 * | BED6, `.junc` | leafcutter's old `bam2junc` | the intron, 0-based half-open | the score |
 *
 * All three become one {@link FeatureSet} whose features are the **introns** —
 * donor to acceptor, 0-based half-open, which is STAR's two columns minus one at
 * the start — with the read count as the score. The intron and not the
 * anchors-and-intron a junctions BED spans, because the intron is the fact:
 * the arc is drawn between its ends, the card gives its length, and a task that
 * reads intervals — a metaplot over splice sites — wants the splice sites.
 *
 * ## Why a kind of its own
 *
 * The glyph. A junction is not a box on a row: it is an **arc** from one exon's
 * end to the next's start, as tall as its count against the lane's ceiling and
 * labelled with that count — a sashimi plot's arc, which is the picture every
 * reader of RNA-seq has learnt to read alternative splicing from. And it has an
 * axis: arcs from two samples are only comparable against one ceiling, which is
 * the argument §8.17 made for a barChart's limits.
 *
 * ## What the columns become
 *
 * Everything but the count goes into the detail, keyed, so the card lists it and
 * the colour picker offers it (§8.16): `multi` (STAR's multi-mapping reads),
 * `motif` (`GT/AG` on the strand the intron is transcribed from — STAR writes a
 * reverse-strand GT/AG as `2`, its `CT/AC` spelling, and the reader is told the
 * motif rather than which strand it was read on), `annotated` (`yes` where the
 * junction is in the GTF STAR was given), `overhang` (the longest anchor any
 * read had) and, from a BED, `anchors` — the two flanks, which are the only
 * thing a BED says that the intron does not.
 */

import { FeatureBuilder } from './featureset'
import { forEachRow, isInteger } from './parse'
import { DETAIL_SEP, type FeatureSet } from './types'
import { fmt } from '../units'

/** Which of the three shapes a file is. */
export type JunctionFlavour = 'star' | 'bed' | 'junc'

/**
 * STAR's intron motifs by code, as the transcript reads them.
 *
 * STAR numbers each motif twice — once per genomic strand — so `1` and `2` are
 * the same `GT/AG` read forwards and backwards. What a reader wants is the
 * splice sites a spliceosome saw, which is the forward spelling, so `2` is
 * `GT/AG` here and not `CT/AC`.
 */
export const STAR_MOTIFS: readonly string[] = [
  'non-canonical',
  'GT/AG',
  'GT/AG',
  'GC/AG',
  'GC/AG',
  'AT/AC',
  'AT/AC',
]

/** The detail keys a junction's attributes are written under. */
export const JUNCTION_FIELD_MULTI = 'multi'
export const JUNCTION_FIELD_MOTIF = 'motif'
export const JUNCTION_FIELD_ANNOTATED = 'annotated'
export const JUNCTION_FIELD_OVERHANG = 'overhang'
export const JUNCTION_FIELD_ANCHORS = 'anchors'

/** How many rows a sniffer checks before it is satisfied. */
const ENOUGH_ROWS = 8

/**
 * The first few data rows, split — and whether a `track` line said
 * `junctions`, which is how TopHat names its BED and the one hint a junctions
 * BED carries inside it.
 */
function head(text: string): { rows: string[][]; declared: boolean } {
  const rows: string[][] = []
  let declared = false
  let index = 0
  const length = text.length
  while (index < length && rows.length < ENOUGH_ROWS) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const line = text.slice(index, stop)
    index = end + 1
    if (line === '' || line.charCodeAt(0) === 35) continue // '#'
    if (line.startsWith('track ')) {
      if (/junction/i.test(line)) declared = true
      continue
    }
    if (line.startsWith('browser ')) continue
    rows.push(line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/))
  }
  return { rows, declared }
}

/**
 * One STAR row's shape: nine columns, eight integers after the sequence, and
 * three of them in the small ranges STAR's own codes live in.
 *
 * Nothing else in the BED family is nine integers — a BED9's name is a word and
 * its strand a `+` — so this cannot capture one, and it asks the intron's two
 * ends to be in order as well.
 */
function looksLikeStar(columns: string[]): boolean {
  if (columns.length !== 9) return false
  for (let c = 1; c < 9; c++) if (!isInteger(columns[c])) return false
  const strand = Number(columns[3])
  const motif = Number(columns[4])
  const annotated = Number(columns[5])
  return (
    Number(columns[2]) >= Number(columns[1]) &&
    strand >= 0 &&
    strand <= 2 &&
    motif >= 0 &&
    motif <= 6 &&
    (annotated === 0 || annotated === 1)
  )
}

/**
 * A junctions BED row's two anchors, or `null`.
 *
 * BED12 with exactly two blocks that tile the row: the first starts at its
 * start and the second ends at its end, so the gap between them is the intron.
 */
function anchorsOf(columns: string[]): [number, number, number] | null {
  if (columns.length < 12) return null
  if (!isInteger(columns[1]) || !isInteger(columns[2]) || columns[9] !== '2') return null
  const sizes = columns[10].split(',').filter((part) => part !== '')
  const offsets = columns[11].split(',').filter((part) => part !== '')
  if (sizes.length !== 2 || offsets.length !== 2) return null
  if (!sizes.every(isInteger) || !offsets.every(isInteger)) return null
  const start = Number(columns[1])
  const end = Number(columns[2])
  const left = Number(sizes[0])
  const right = Number(sizes[1])
  const second = Number(offsets[1])
  if (Number(offsets[0]) !== 0 || start + second + right !== end) return null
  if (left <= 0 || right <= 0 || second <= left) return null
  // The intron's own start, after the left anchor, and its length.
  return [start + left, second - left, right]
}

/** A BED6's shape: an interval, a word or a dot, a count, a strand. */
function looksLikeJunc(columns: string[]): boolean {
  return (
    columns.length === 6 &&
    isInteger(columns[1]) &&
    isInteger(columns[2]) &&
    isInteger(columns[4]) &&
    (columns[5] === '+' || columns[5] === '-' || columns[5] === '.')
  )
}

/**
 * Which junction shape these lines are, or `null`.
 *
 * A STAR table is recognised by its columns alone, because nine integers with
 * STAR's codes in them are a statement no other file makes. The other two are
 * BEDs, and a BED12 of two blocks is also a two-exon transcript — so they need
 * the file to **say** it is about junctions: a name with `junc` in it (`.junc`,
 * `junctions.bed`, `SJ.bed`), a TopHat `track` line naming junctions, or
 * regtools' and TopHat's own `JUNC…` names on every row. Without one of those,
 * a two-block BED stays the transcripts it may well be.
 *
 * Asked before `sniffFormat`, whose last line is `return 'bed'`: a STAR table
 * read as a BED is a lane of boxes whose count was never read, and a junctions
 * BED is a lane of two-exon "genes" that are all intron.
 */
export function sniffJunctions(text: string, fileName = ''): JunctionFlavour | null {
  const { rows, declared } = head(text)
  if (rows.length === 0) return null
  if (rows.every(looksLikeStar)) return 'star'
  const named = /junc|(^|[._-])sj([._-]|$)/i.test(fileName.replace(/\.gz$/i, ''))
  const junctionNames = rows.every((columns) => /^JUNC/i.test(columns[3] ?? ''))
  if ((named || declared || junctionNames) && rows.every((columns) => anchorsOf(columns) !== null)) {
    return 'bed'
  }
  // A six-column BED is a peak set as often as not; only a file called `.junc`
  // is leafcutter's.
  if (/\.junc(\.gz)?$/i.test(fileName) && rows.every(looksLikeJunc)) return 'junc'
  return null
}

function strandOf(value: string | undefined): number {
  return value === '+' ? 1 : value === '-' ? -1 : 0
}

/**
 * A BED's score column as a read count, or `NaN` where it is not a number.
 *
 * TopHat and regtools write the count there, and it runs past BED's nominal
 * 1,000 on any expressed gene, which is why it is read as a number rather than
 * clamped as a display score.
 */
function countOf(value: string | undefined): number {
  if (value === undefined || value === '' || value === '.') return Number.NaN
  const count = Number(value)
  return Number.isFinite(count) ? count : Number.NaN
}

/** Parse a junction file of any of the three shapes into one feature per intron. */
export function parseJunctions(text: string, fileName = '', flavour?: JunctionFlavour): FeatureSet {
  const shape = flavour ?? sniffJunctions(text, fileName)
  if (shape === null) throw new Error('This is not a junction file STAR, regtools or leafcutter wrote.')
  const builder = new FeatureBuilder()
  let skipped = 0
  forEachRow(text, (columns) => {
    if (shape === 'star') {
      if (!looksLikeStar(columns)) {
        skipped++
        return
      }
      const strand = Number(columns[3])
      const motif = Number(columns[4])
      const detail = [
        `${JUNCTION_FIELD_MULTI} ${columns[7]}`,
        `${JUNCTION_FIELD_MOTIF} ${STAR_MOTIFS[motif]}`,
        `${JUNCTION_FIELD_ANNOTATED} ${columns[5] === '1' ? 'yes' : 'no'}`,
        `${JUNCTION_FIELD_OVERHANG} ${columns[8]}`,
      ].join(DETAIL_SEP)
      // STAR writes the intron's first and last base, 1-based: minus one at the
      // start and nothing at the end is the 0-based half-open span.
      builder.add(columns[0], Number(columns[1]) - 1, Number(columns[2]), {
        strand: strand === 1 ? 1 : strand === 2 ? -1 : 0,
        score: Number(columns[6]),
        detail,
      })
      return
    }
    if (shape === 'bed') {
      const anchors = anchorsOf(columns)
      if (anchors === null) {
        skipped++
        return
      }
      const [from, length, right] = anchors
      const left = from - Number(columns[1])
      const name = columns[3] !== undefined && columns[3] !== '.' ? columns[3] : ''
      builder.add(columns[0], from, from + length, {
        strand: strandOf(columns[5]),
        score: countOf(columns[4]),
        name,
        detail: `${JUNCTION_FIELD_ANCHORS} ${left}/${right}`,
      })
      return
    }
    if (!looksLikeJunc(columns)) {
      skipped++
      return
    }
    builder.add(columns[0], Number(columns[1]), Number(columns[2]), {
      strand: strandOf(columns[5]),
      score: Number(columns[4]),
      name: columns[3] !== '.' ? columns[3] : '',
    })
  })
  if (builder.length === 0 && skipped > 0) {
    throw new Error(`No usable rows: all ${skipped} lines failed the junction test for this file's shape.`)
  }
  return builder.finish()
}

/** The largest count in the set — the lane's ceiling before a reader moves it. */
export function junctionCeiling(set: FeatureSet): number {
  let top = 0
  for (let i = 0; i < set.length; i++) {
    const value = set.score[i]
    if (Number.isFinite(value) && value > top) top = value
  }
  return top
}

/** One line for under the label: `2,967 junctions · 25,126 reads · 2,849 annotated`. */
export function junctionSummary(set: FeatureSet): string {
  let reads = 0
  let annotated = 0
  let described = false
  for (let i = 0; i < set.length; i++) {
    const value = set.score[i]
    if (Number.isFinite(value)) reads += value
    const detail = set.detail[i]
    if (detail.includes(`${JUNCTION_FIELD_ANNOTATED} `)) {
      described = true
      if (detail.includes(`${JUNCTION_FIELD_ANNOTATED} yes`)) annotated++
    }
  }
  const parts = [
    `${fmt.int(set.length)} junction${set.length === 1 ? '' : 's'}`,
    `${fmt.int(reads)} read${reads === 1 ? '' : 's'}`,
  ]
  if (described) parts.push(`${fmt.int(annotated)} annotated`)
  return parts.join(DETAIL_SEP)
}
