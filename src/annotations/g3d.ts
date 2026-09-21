/**
 * WashU's g3d text: a 3D model of the fibre, one bead per row (§25).
 *
 * The format is the one `g3dtools` takes as its input and documents column by
 * column — `chromosome  start  x  y  z  [category]` — and it is what a solver's
 * output looks like once the bins are named. The optional sixth column is a
 * haplotype in the common case (`m`, `p`, `s`, or the words those abbreviate)
 * and any category in general: `g3dtools` says a cell, a sample or a time
 * point may stand there, and this reader believes it. Dip-C's `.3dg` is the
 * same table with the haplotype folded into the chromosome's name —
 * `chr7(mat)` — which `g3dtools 3dg` unfolds on the way in, and so does this.
 *
 * Three facts about the file decide how it is read, and each is visible in
 * the example `g3dtools` ships:
 *
 * - **There is no end column and there is no header.** A bead's width is the
 *   file's resolution, and the resolution *is* the spacing of its sorted starts:
 *   the most common difference between consecutive beads of one chromosome and
 *   one haplotype ({@link widthOf}). Nothing else declares it and nothing else
 *   is asked to. It is printed on the row, so a file whose beads are irregular
 *   is seen rather than suffered.
 * - **The rows are not sorted.** The example's starts run 16, 25, 33, 41, 50
 *   and then 26, 27, 28 Mb. `FeatureBuilder.finish` sorts, and the coordinates
 *   ride through it so they stay with their rows.
 * - **A phased file has two beads at every locus.** They are two chains over
 *   the same intervals rather than two files: the map beside the model has one
 *   `chr7`, and a locus on it lights both homologues.
 *
 * It is a `FeatureSet` — §8.14's decision, restated in `annotations/types.ts`
 * for `structure` — so the beads are drawn as boxes on a lane, searched,
 * exported and piled on exactly as a peak set is, and what the model has
 * besides rides on the set as one optional field (`FeatureSet.model`).
 *
 * ## What this refuses to guess
 *
 * A file with one bead per chromosome has no spacing to infer, and is given a
 * width of one base rather than an invented one; the summary says so by
 * printing it. A row whose coordinate is not a number is dropped and counted,
 * because a bead nowhere is not a bead — and a file where every row fails is
 * refused with the sentence naming the columns, as every other parser here
 * refuses.
 */

import { FeatureBuilder, type StructureSchema } from './featureset'
import { forEachRow, isInteger } from './parse'
import { DETAIL_SEP, type FeatureSet } from './types'
import { resolutionLabel } from '../units'

/**
 * The detail key a phased file's rows carry, so the §8.16 picker finds the
 * haplotype as a categorical field of the file and offers it as a colouring
 * with no code of its own.
 */
export const G3D_FIELD_HAPLOTYPE = 'haplotype'

/**
 * Whether a file **name** says it is a structure — `.g3d`, the text g3dtools
 * takes or the container it writes, or a `.3dg`, gzipped or not.
 *
 * By name only, which is what a road that has not read the file yet can ask:
 * the deck routing a drop to its structure cell, the session deciding to open
 * one. A structure under another name is still read as one by
 * {@link sniffG3d}; it simply arrives as a row without opening a cell.
 */
export function isStructureName(name: string): boolean {
  const last = name.split(/[\\/]/).pop() ?? name
  return /\.(g3d|3dg|bed3d)(\.txt)?(\.gz)?$/i.test(last.split(/[?#]/)[0] ?? last)
}

/**
 * The two text layouts a structure comes in.
 *
 * `g3d` is WashU's: `chrom start x y z [haplotype]`, no end column, the bead
 * width inferred from the spacing of the starts. `bed3d` is the same file with
 * the end written down — `chrom start end x y z [haplotype]` — for a model
 * whose beads are the bins of a map, or of any width a BED can say. One
 * reader for both; the layout is the one thing that differs.
 */
export type StructureLayout = 'g3d' | 'bed3d'

/** The three category names `g3dtools` writes, from the letters it accepts. */
const SHARED = 'shared'
const MATERNAL = 'maternal'
const PATERNAL = 'paternal'

/** How many data rows {@link sniffG3d} reads before it is satisfied. */
const ENOUGH_ROWS = 200

/**
 * The most a chain's typical step may be, as a fraction of the cloud's extent,
 * before the rows stop looking like a chain (see {@link looksCoherent}).
 *
 * A chain of `n` beads steps about `1/n` of its own extent; a scatter of
 * unrelated numbers steps about half of it. A third is far from both.
 */
const COHERENT_STEP = 1 / 3

/**
 * Whether these lines are a g3d.
 *
 * Asked before `sniffFormat`, because `sniffFormat`'s last line is `return
 * 'bed'` and a five-column g3d read as a BED is a lane of boxes whose "end"
 * column is a coordinate in space. Four tests on the shape, and a fifth on the
 * numbers that no BED-family file can pass by accident:
 *
 * 1. five or six columns — `g3dtools` reads the sixth where there is one and
 *    ignores anything after it, so more than six is somebody else's format;
 * 2. an integer in column 2;
 * 3. finite numbers in columns 3–5, at least one of them **fractional or
 *    negative** over the sample. This is what keeps a BED5 out: its column 3 is
 *    an integer end, its 4 a name and its 5 an integer score, and a file of
 *    integer lattice coordinates is a file that has to be *named* `.g3d` to be
 *    read as one;
 * 4. column 6, where present, a category — a word beginning with a letter.
 *    `+`, `-` and `.` are a strand, and a strand is a BED6;
 * 5. **consecutive beads of one chromosome are neighbours in space** — the
 *    signature of a chain, and the test that settles the case the shape
 *    tests cannot ({@link looksCoherent}).
 *
 * The name is a tiebreak only, as in every sniffer here: a file called `.g3d`
 * or `.3dg` is spared the fractional test, because a reader who named the
 * format has answered the question that test was asking.
 */
export function sniffG3d(text: string, fileName = ''): boolean {
  return sniffStructure(text, fileName, 'g3d')
}

/**
 * Whether these lines are a bed3d: `chrom start end x y z [haplotype]`.
 *
 * The same five tests as {@link sniffG3d}, one column to the right, plus an
 * integer end after the integer start. A BED6 is kept out twice over: its
 * fourth column is a name, its sixth a strand, and neither is a finite number
 * — and a BED of integer coordinates that happens to be numeric in every
 * column still has to be named `.bed3d` to be read as one.
 */
export function sniffBed3d(text: string, fileName = ''): boolean {
  return sniffStructure(text, fileName, 'bed3d')
}

function sniffStructure(text: string, fileName: string, layout: StructureLayout): boolean {
  const named =
    layout === 'g3d'
      ? /\.(g3d|3dg)(\.txt)?(\.gz)?$/i.test(fileName)
      : /\.bed3d(\.txt)?(\.gz)?$/i.test(fileName)
  const sample: Row[] = []
  let fractional = false
  let index = 0
  const length = text.length
  // Walked here rather than through `forEachRow`, for the reason every sniffer
  // walks its own lines: this runs on every dropped file before anything knows
  // what it is, and `forEachRow` has no way to stop.
  while (index < length && sample.length < ENOUGH_ROWS) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop-- // CRLF
    const line = text.slice(index, stop)
    index = end + 1
    if (line === '' || line.charCodeAt(0) === 35) continue
    if (line.startsWith('track ') || line.startsWith('browser ')) continue
    const columns = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    const row = rowOf(columns, layout)
    if (row === null) return false
    if (!Number.isInteger(row.xyz[0]) || !Number.isInteger(row.xyz[1]) || !Number.isInteger(row.xyz[2])) {
      fractional = true
    } else if (row.xyz[0] < 0 || row.xyz[1] < 0 || row.xyz[2] < 0) {
      fractional = true
    }
    sample.push(row)
  }
  if (sample.length === 0) return false
  if (!fractional && !named) return false
  return looksCoherent(sample)
}

/** One row, read the way both the sniffer and the parser read it. */
interface Row {
  contig: string
  start: number
  /** The bead's own end, where the layout writes one (`bed3d`); else `null`. */
  end: number | null
  xyz: [number, number, number]
  hap: string
}

/**
 * A row's columns as a bead, or `null` where they are not one.
 *
 * The `.3dg` rule lives here so the sniffer and the parser agree about it: a
 * chromosome written `chr7(mat)` with no sixth column is `chr7` on the
 * maternal chain. `mat`/`pat` and `m`/`p` are folded onto the words
 * `g3dtools` writes, so a `.3dg` and a g3d of the same model name their
 * homologues the same way.
 */
function rowOf(columns: string[], layout: StructureLayout): Row | null {
  // Where the coordinates start: after the start in a g3d, after the end in a
  // bed3d. Everything after them reads the same.
  const at = layout === 'g3d' ? 2 : 3
  if (columns.length < at + 3 || columns.length > at + 4) return null
  if (!isInteger(columns[1])) return null
  let end: number | null = null
  if (layout === 'bed3d') {
    if (!isInteger(columns[2])) return null
    end = Number(columns[2])
    if (end <= Number(columns[1])) return null
  }
  const x = Number(columns[at])
  const y = Number(columns[at + 1])
  const z = Number(columns[at + 2])
  if (columns[at] === '' || columns[at + 1] === '' || columns[at + 2] === '') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  let contig = columns[0]
  let hap = columns[at + 3]
  if (hap !== undefined) {
    if (!/^[A-Za-z][\w.-]*$/.test(hap)) return null
  } else {
    const folded = /^(.+)\(([\w.-]+)\)$/.exec(contig)
    if (folded !== null) {
      contig = folded[1]
      hap = folded[2]
    }
  }
  if (contig === '') return null
  return { contig, start: Number(columns[1]), end, xyz: [x, y, z], hap: categoryOf(hap) }
}

/** The category name a row's sixth column means, in `g3dtools`' own words. */
function categoryOf(value: string | undefined): string {
  if (value === undefined || value === '') return SHARED
  const lower = value.toLowerCase()
  if (lower === 'm' || lower === 'mat' || lower === MATERNAL) return MATERNAL
  if (lower === 'p' || lower === 'pat' || lower === PATERNAL) return PATERNAL
  if (lower === 's' || lower === SHARED) return SHARED
  return value
}

/**
 * Whether a sample of rows is a chain rather than a scatter.
 *
 * Per chromosome and haplotype, the beads are sorted by start and the median
 * distance between neighbours is compared with the extent of the whole cloud.
 * A model steps a small fraction of its own size from one bead to the next;
 * a BED5 whose "coordinates" are an end, a name and a score does not, and nor
 * does anything else that happens to have five numeric columns. Asked only of
 * a group with enough beads to have a median worth reading, so a file of a
 * few rows is judged on its shape alone.
 */
function looksCoherent(sample: readonly Row[]): boolean {
  const groups = new Map<string, Row[]>()
  for (const row of sample) {
    const key = `${row.contig} ${row.hap}`
    const held = groups.get(key)
    if (held === undefined) groups.set(key, [row])
    else held.push(row)
  }
  let lo = [Infinity, Infinity, Infinity]
  let hi = [-Infinity, -Infinity, -Infinity]
  for (const row of sample) {
    lo = lo.map((v, k) => Math.min(v, row.xyz[k]))
    hi = hi.map((v, k) => Math.max(v, row.xyz[k]))
  }
  const extent = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  // A cloud with no extent is one bead, or one bead's worth of copies: nothing
  // to measure a step against, and nothing a scatter could be either.
  if (!(extent > 0)) return true
  const steps: number[] = []
  for (const rows of groups.values()) {
    if (rows.length < 6) continue
    rows.sort((a, b) => a.start - b.start)
    for (let at = 1; at < rows.length; at++) {
      const a = rows[at - 1].xyz
      const b = rows[at].xyz
      steps.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))
    }
  }
  if (steps.length === 0) return true
  steps.sort((a, b) => a - b)
  const median = steps[steps.length >> 1]
  return median < extent * COHERENT_STEP
}

/**
 * The spacing of a set of beads: the commonest difference between consecutive
 * starts of one chromosome and one haplotype, over every group.
 *
 * The mode rather than the minimum, because a file that is mostly regular
 * with one odd gap is a regular file, and the minimum would answer with the
 * gap. Counted across groups so a chromosome of three beads cannot outvote a
 * chromosome of three thousand. `1` where no group has two beads: a file with
 * nothing to measure gets a width of one base rather than an invented one.
 */
export function widthOf(groups: Iterable<readonly number[]>): number {
  const counts = new Map<number, number>()
  for (const starts of groups) {
    const sorted = [...starts].sort((a, b) => a - b)
    for (let at = 1; at < sorted.length; at++) {
      const step = sorted[at] - sorted[at - 1]
      if (step <= 0) continue
      counts.set(step, (counts.get(step) ?? 0) + 1)
    }
  }
  let best = 0
  let width = 1
  for (const [step, count] of counts) {
    // Ties go to the smaller step: a file whose beads alternate between two
    // spacings is at the finer one with gaps, not at the coarser one with
    // beads in between.
    if (count > best || (count === best && step < width)) {
      best = count
      width = step
    }
  }
  return width
}

/** The commonest of some lengths, ties to the smaller; 1 where there are none. */
function modeOf(lengths: readonly number[]): number {
  const votes = new Map<number, number>()
  for (const length of lengths) {
    if (length > 0) votes.set(length, (votes.get(length) ?? 0) + 1)
  }
  let width = 1
  let best = 0
  for (const [length, count] of votes) {
    if (count > best || (count === best && length < width)) {
      best = count
      width = length
    }
  }
  return width
}

/**
 * Read a g3d into beads with a place on each.
 *
 * Two passes, because the width is a fact about the whole file and every bead's
 * end depends on it: the rows are collected first, the spacing inferred from
 * all of them, and only then is each bead given its interval and handed to the
 * builder. The builder sorts, and the coordinates go through it so a file
 * written in any order comes out with every bead at its own locus.
 */
export function parseG3d(text: string, fileName = ''): FeatureSet {
  return parseStructure(text, fileName, 'g3d')
}

/**
 * Read a bed3d — {@link parseG3d} with the end column taken from the file.
 *
 * The width under the row is the commonest bead length rather than the
 * commonest spacing: a bed3d says how wide each bead is, and the number a
 * reader checks is the one they wrote.
 */
export function parseBed3d(text: string, fileName = ''): FeatureSet {
  return parseStructure(text, fileName, 'bed3d')
}

function parseStructure(text: string, fileName: string, layout: StructureLayout): FeatureSet {
  const rows: Row[] = []
  let skipped = 0
  forEachRow(text, (columns) => {
    const row = rowOf(columns, layout)
    if (row === null) skipped++
    else rows.push(row)
  })
  if (rows.length === 0) {
    const shape = layout === 'g3d' ? 'chromosome, start, x, y, z' : 'chromosome, start, end, x, y, z'
    throw new Error(
      skipped > 0
        ? `No usable rows: all ${skipped} lines failed the "${shape}" test that ` +
          `a ${layout} begins with.`
        : `${fileName === '' ? 'This file' : fileName} has no rows.`,
    )
  }
  const haplotypes: string[] = []
  const hapIds = new Map<string, number>()
  const starts = new Map<string, number[]>()
  for (const row of rows) {
    if (!hapIds.has(row.hap)) {
      hapIds.set(row.hap, haplotypes.length)
      haplotypes.push(row.hap)
    }
    const key = `${row.contig} ${row.hap}`
    const held = starts.get(key)
    if (held === undefined) starts.set(key, [row.start])
    else held.push(row.start)
  }
  const width =
    layout === 'g3d' ? widthOf(starts.values()) : modeOf(rows.map((row) => (row.end ?? row.start) - row.start))
  // Written only where it tells two beads apart: a haploid file's rows all
  // saying `haplotype shared` would offer the picker a category with one
  // level, which is a colouring that colours nothing.
  const phased = haplotypes.length > 1
  const builder = new FeatureBuilder()
  for (const row of rows) {
    builder.add(row.contig, row.start, row.end ?? row.start + width, {
      xyz: row.xyz,
      hap: hapIds.get(row.hap) ?? 0,
      detail: phased ? `${G3D_FIELD_HAPLOTYPE} ${row.hap}` : '',
    })
  }
  const schema: StructureSchema = { width, haplotypes }
  return builder.finish(null, schema)
}

/**
 * The line under a structure's label: what it holds, at what spacing.
 *
 * The spacing is printed because it was inferred (§25): a reader whose file
 * was meant to be at 10 kb and reads `1.04 Mb` here has been told the one
 * thing about their file this reader could get wrong.
 */
export function g3dSummary(set: FeatureSet): string {
  const model = set.model
  const beads = `${count(set.length)} bead${set.length === 1 ? '' : 's'}`
  if (model === undefined) return beads
  const parts = [beads, resolutionLabel(model.width)]
  if (model.haplotypes.length > 1) parts.push(`${model.haplotypes.length} haplotypes`)
  parts.push(`${count(set.contigs.length)} sequence${set.contigs.length === 1 ? '' : 's'}`)
  return parts.join(DETAIL_SEP)
}

/**
 * A number with its thousands separated.
 *
 * The spacing beside it used to be written here too, as a private copy of
 * `resolutionLabel`, because this module is read in the annotations worker and
 * `ui/dom.ts` would have brought the DOM helpers with it. `src/units.ts`
 * imports nothing, so the copy is gone and a bead spacing is spelled the way
 * every other bin size in the app is spelled.
 */
function count(value: number): string {
  return value.toLocaleString('en-US')
}

// ---------------------------------------------------------------------------
// A structure made here, and a structure written out
// ---------------------------------------------------------------------------

/** One bead of a model this app computed: where it is, and what it covers. */
export interface ModelBead {
  contig: string
  start: number
  end: number
  x: number
  y: number
  z: number
}

/**
 * A structure row's payload from beads this app placed (§25.6).
 *
 * The same builder and the same schema a parsed bed3d goes through, so the row
 * a reconstruction makes is indistinguishable from one loaded from disk — the
 * cell draws it, *Model versus map* reads it, `writeBed3d` writes it — which
 * is the whole reason the task produces a row rather than a picture. Unphased:
 * a map has one set of counts and gives one set of places.
 */
export function structureFromBeads(beads: readonly ModelBead[], width: number): FeatureSet {
  const builder = new FeatureBuilder()
  for (const bead of beads) {
    builder.add(bead.contig, bead.start, bead.end, { xyz: [bead.x, bead.y, bead.z], hap: 0 })
  }
  const schema: StructureSchema = { width, haplotypes: [SHARED] }
  return builder.finish(null, schema)
}

/**
 * A structure row as a bed3d: `chrom start end x y z [haplotype]`.
 *
 * The haplotype column only for a phased model, as the reader (§25.2) treats
 * it; the `#` header is skipped by every reader of the family, this app's
 * included, so the file reads straight back. Six decimals: a model is in its
 * own units and a coordinate written shorter than the solver's step would
 * move beads on the way to disk.
 */
export function writeBed3d(
  set: FeatureSet,
  context: { label?: string; file?: string; created?: string } = {},
): string {
  const model = set.model
  const what = context.label === undefined ? 'structure' : context.label
  const from = context.file === undefined ? '' : ` from ${context.file}`
  const when = context.created === undefined ? '' : ` on ${context.created}`
  const lines = [`# metacooler ${what}${from}${when} · bed3d: chrom start end x y z${model !== undefined && model.haplotypes.length > 1 ? ' haplotype' : ''}`]
  if (model === undefined) return lines.join('\n') + '\n'
  const phased = model.haplotypes.length > 1
  for (let i = 0; i < set.length; i++) {
    const columns = [
      set.contigs[set.contig[i]] ?? '.',
      String(set.start[i]),
      String(set.end[i]),
      coordinate(model.x[i]),
      coordinate(model.y[i]),
      coordinate(model.z[i]),
    ]
    if (phased) columns.push(model.haplotypes[model.hap[i]] ?? SHARED)
    lines.push(columns.join('\t'))
  }
  return lines.join('\n') + '\n'
}

function coordinate(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : '0'
}
