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

/**
 * The detail key a phased file's rows carry, so the §8.16 picker finds the
 * haplotype as a categorical field of the file and offers it as a colouring
 * with no code of its own.
 */
export const G3D_FIELD_HAPLOTYPE = 'haplotype'

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
  const named = /\.(g3d|3dg)(\.txt)?(\.gz)?$/i.test(fileName)
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
    const row = rowOf(columns)
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
function rowOf(columns: string[]): Row | null {
  if (columns.length < 5 || columns.length > 6) return null
  if (!isInteger(columns[1])) return null
  const x = Number(columns[2])
  const y = Number(columns[3])
  const z = Number(columns[4])
  if (columns[2] === '' || columns[3] === '' || columns[4] === '') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  let contig = columns[0]
  let hap = columns[5]
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
  return { contig, start: Number(columns[1]), xyz: [x, y, z], hap: categoryOf(hap) }
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
  const rows: Row[] = []
  let skipped = 0
  forEachRow(text, (columns) => {
    const row = rowOf(columns)
    if (row === null) skipped++
    else rows.push(row)
  })
  if (rows.length === 0) {
    throw new Error(
      skipped > 0
        ? `No usable rows: all ${skipped} lines failed the "chromosome, start, x, y, z" test that ` +
          'a g3d begins with.'
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
  const width = widthOf(starts.values())
  // Written only where it tells two beads apart: a haploid file's rows all
  // saying `haplotype shared` would offer the picker a category with one
  // level, which is a colouring that colours nothing.
  const phased = haplotypes.length > 1
  const builder = new FeatureBuilder()
  for (const row of rows) {
    builder.add(row.contig, row.start, row.start + width, {
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
  const parts = [beads, spacing(model.width)]
  if (model.haplotypes.length > 1) parts.push(`${model.haplotypes.length} haplotypes`)
  parts.push(`${count(set.contigs.length)} sequence${set.contigs.length === 1 ? '' : 's'}`)
  return parts.join(DETAIL_SEP)
}

/**
 * A number with its thousands separated, and a base-pair spacing in the unit
 * that reads — `5 kb`, `1.04 Mb`, `250 bp`.
 *
 * Written here rather than imported from `ui/dom.ts`, because this module is
 * read in the annotations worker, and a worker that imports the DOM helpers
 * for a number format is a worker that has a bundle it did not ask for.
 */
function count(value: number): string {
  return value.toLocaleString('en-US')
}

function spacing(bp: number): string {
  if (bp >= 1e6) return `${trim(bp / 1e6)} Mb`
  if (bp >= 1e3) return `${trim(bp / 1e3)} kb`
  return `${count(bp)} bp`
}

/** Two decimals at most, and none where they would be zeros. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}
