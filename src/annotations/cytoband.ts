/**
 * Chromosome ideograms: UCSC's cytoBand and cytoBandIdeo (§8.22).
 *
 * Five columns — `chrom chromStart chromEnd name gieStain` — and the fifth is
 * the whole of the format: the Giemsa stain a metaphase chromosome takes over
 * that stretch. `gneg` is a light band, `gpos25` to `gpos100` dark ones by how
 * dark, `acen` the centromere, `gvar` variable heterochromatin and `stalk` the
 * narrow stalk of an acrocentric's short arm, which is where its rDNA is. IGV
 * reads the same file for its ideogram, and every UCSC assembly publishes one:
 * `cytoBandIdeo` is the same five columns with a row per unplaced sequence too,
 * its name left empty.
 *
 * It is a {@link FeatureSet} — one band per row — for §8.14's reason, which is
 * stronger here than anywhere: a band is an interval with a name, and the
 * search, the export, the hit test and every task that reads intervals are the
 * code a peak set already uses. What makes it a kind of its own is the glyph.
 * A band is not a box on a row: it is a stretch of *one* shape, the chromosome,
 * whose outline pinches at the centromere and narrows at a stalk, and the
 * packing, the strand bands, the colour picker and the arrowheads every other
 * feature lane has are questions a karyotype is never asked.
 *
 * ## Where the stain goes
 *
 * Into the detail, as `stain gpos50`, so the card and the tooltip say it the
 * way the file does — and into the **score**, as the darkness the stain names:
 * `gneg` 0, `gposN` N, a bare `gpos` 100. That is a number the file states
 * rather than one this invents, and it is what lets a task read the bands as
 * light and dark: *Signal by group* split by score is compartment E1 in G-light
 * against G-dark bands, with no code of its own. `acen`, `gvar` and `stalk` are
 * not a darkness and score `NaN`.
 *
 * ## What the file says about the genome
 *
 * UCSC's bands **tile** each chromosome, from its first base to its last, so a
 * cytoBand is a `chrom.sizes` with a picture on it: the end of the last band is
 * the chromosome's length. That is checked rather than assumed — a file whose
 * bands start at 0 and leave no gap is taken at its word ({@link cytoBandLengths}),
 * and one that does not gives the lower bound every other feature file gives.
 */

import { FeatureBuilder } from './featureset'
import { forEachRow, isInteger } from './parse'
import { type FeatureSet } from './types'
import { fmt } from '../units'

/**
 * The stains a cytoBand's fifth column holds. `gpos` with or without its
 * darkness: UCSC writes `gpos25` to `gpos100`, a few assemblies `gpos33` and
 * `gpos66`, and some older files a bare `gpos`.
 */
const STAIN = /^(gneg|gpos\d{0,3}|acen|gvar|stalk)$/

/** The detail key a band's stain is written under. */
export const BAND_FIELD_STAIN = 'stain'

/** How many rows {@link sniffCytoBand} checks before it is satisfied. */
const ENOUGH_ROWS = 8

/**
 * One row as a band, or `null`.
 *
 * Five columns, the fourth possibly empty — cytoBandIdeo's unplaced sequences
 * have no band name — or **four**, where a whitespace-separated file has
 * collapsed that empty name away and left the stain in column 4. A stain in the
 * last column is the test either way.
 */
function bandOf(columns: string[]): { name: string; stain: string } | null {
  if (!isInteger(columns[1]) || !isInteger(columns[2])) return null
  if (columns.length === 5 && STAIN.test(columns[4])) return { name: columns[3], stain: columns[4] }
  if (columns.length === 4 && STAIN.test(columns[3])) return { name: '', stain: columns[3] }
  return null
}

/**
 * Whether these lines are a cytoBand.
 *
 * Every row inspected must end in a stain. That is a word no other format in
 * the BED family puts in its fifth column — a BED5's is a score, a number — so
 * the test cannot capture a BED, and nothing that is a cytoBand fails it. Asked
 * before `sniffFormat` for the reason every sniffer in that block is: that
 * function's last line is `return 'bed'`, and a cytoBand read as a BED is a lane
 * of grey boxes whose one column anybody opened the file for was never read.
 */
export function sniffCytoBand(text: string): boolean {
  let rows = 0
  let index = 0
  const length = text.length
  // Its own walk rather than `forEachRow`, for `sniffBarChart`'s reason: this is
  // asked of every dropped file before anything knows what it is, and a walk
  // that cannot stop splits every line of a large one to answer a question eight
  // rows settle.
  while (index < length && rows < ENOUGH_ROWS) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const line = text.slice(index, stop)
    index = end + 1
    if (line === '' || line.charCodeAt(0) === 35) continue // '#'
    if (line.startsWith('track ') || line.startsWith('browser ')) continue
    const columns = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    if (bandOf(columns) === null) return false
    rows++
  }
  return rows > 0
}

/**
 * How dark a stain is, as the file names it: `0` to `100`, or `NaN` for the
 * three stains that are not a darkness.
 */
export function stainDarkness(stain: string): number {
  if (stain === 'gneg') return 0
  if (stain.startsWith('gpos')) {
    const rest = stain.slice(4)
    if (rest === '') return 100
    const value = Number(rest)
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100
  }
  return Number.NaN
}

/** A band's stain, read back out of the detail the parser wrote. */
export function stainOf(detail: string): string {
  const at = detail.indexOf(`${BAND_FIELD_STAIN} `)
  if (at < 0) return ''
  const from = at + BAND_FIELD_STAIN.length + 1
  const space = detail.indexOf(' ', from)
  return space < 0 ? detail.slice(from) : detail.slice(from, space)
}

/**
 * A band's name in ISCN, chromosome first — `Xq28`, `1p36.33`.
 *
 * What a cytogeneticist writes and what the lane's caption says; the file
 * writes the band alone, since its first column says whose it is. A UCSC `chr`
 * prefix is not part of it. A band with no name — an unplaced sequence's one
 * band — is its chromosome.
 */
export function iscnName(contig: string, band: string): string {
  const chromosome = /^chr/i.test(contig) ? contig.slice(3) : contig
  return band === '' ? chromosome : `${chromosome}${band}`
}

/** Parse a cytoBand or cytoBandIdeo into one feature per band. */
export function parseCytoBand(text: string): FeatureSet {
  const builder = new FeatureBuilder()
  let skipped = 0
  forEachRow(text, (columns) => {
    const band = bandOf(columns)
    if (band === null) {
      skipped++
      return
    }
    builder.add(columns[0], Number(columns[1]), Number(columns[2]), {
      name: band.name,
      score: stainDarkness(band.stain),
      detail: `${BAND_FIELD_STAIN} ${band.stain}`,
    })
  })
  if (builder.length === 0 && skipped > 0) {
    throw new Error(
      `No usable rows: all ${skipped} lines failed the "sequence, start, end, band, stain" test a ` +
        'cytoBand is made of.',
    )
  }
  return builder.finish()
}

/**
 * Each sequence's length, when the bands say it — else `null`.
 *
 * They say it when they **tile** it: the first band starts at 0 and every band
 * starts where the one before it ended. Then the last band's end is the
 * chromosome's end, which is how UCSC writes every cytoBand and what makes one
 * a declaration of the genome rather than a set of features on it (§8.22). One
 * sequence with a gap or an overlap and the whole file falls back to the lower
 * bound, because a file that tiles some chromosomes and not others is not
 * making the claim this reads it as making.
 */
export function cytoBandLengths(set: FeatureSet): Array<{ name: string; length: number }> | null {
  const out: Array<{ name: string; length: number }> = []
  for (let c = 0; c < set.contigs.length; c++) {
    const from = set.contigAt[c]
    const to = set.contigAt[c + 1]
    if (to <= from) continue
    let expected = 0
    for (let i = from; i < to; i++) {
      if (set.start[i] !== expected) return null
      expected = set.end[i]
    }
    out.push({ name: set.contigs[c], length: expected })
  }
  return out.length > 0 ? out : null
}

/** One line for under the label: `862 bands · 24 sequences · 48 centromeric`. */
export function cytoBandSummary(set: FeatureSet): string {
  let centromere = 0
  let named = 0
  for (let i = 0; i < set.length; i++) {
    if (stainOf(set.detail[i]) === 'acen') centromere++
    if (set.name[i] !== '') named++
  }
  const sequences = set.contigAt.reduce(
    (count, _, c) => (c < set.contigs.length && set.contigAt[c + 1] > set.contigAt[c] ? count + 1 : count),
    0,
  )
  const parts = [
    `${fmt.int(set.length)} band${set.length === 1 ? '' : 's'}`,
    `${fmt.int(sequences)} sequence${sequences === 1 ? '' : 's'}`,
  ]
  // cytoBandIdeo's unplaced sequences are one unnamed band each, and a file
  // that is *only* those is a chrom.sizes in five columns: saying how many are
  // real bands keeps that from reading as a karyotype.
  if (named < set.length) parts.push(`${fmt.int(named)} named`)
  if (centromere > 0) parts.push(`${fmt.int(centromere)} centromeric`)
  return parts.join(' · ')
}
