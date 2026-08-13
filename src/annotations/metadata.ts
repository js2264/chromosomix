/**
 * The columns the *file itself* carries about its own units, as annotations.
 *
 * Every container this viewer opens keeps a table beside its pixels, and those
 * tables have always held more than the arithmetic the reader needs. A
 * metacool's `/genomes` carries completeness and contamination beside the bin
 * counts, its `/contigs` carries whatever the assembler and the annotator
 * joined on — MGE calls, coverage, a bin id — and every cooler's `/bins`
 * carries at least the balancing weight. All of it is already indexed against
 * the axis of the map, needs no naming convention to be matched (§8.2 has
 * nothing to check: these *are* the map's own names), and until now could only
 * be read as a table, one row at a time, in a view that is not the picture.
 *
 * So it is drawn beside the map, as lanes, through the same {@link
 * AnnotationStore} a dropped bigWig goes through — see `ui/MetadataCard.ts` for
 * why that is the whole design and not an implementation note.
 *
 * Two things here are not in any other annotation module, and both come from
 * the same fact: **a metadata lane is indexed by the map's own cells, not by
 * base pairs.**
 *
 * - The **level rule** ({@link showsAtLevel}). A genome × genome overview has
 *   one cell per MAG, and a bin weight has nothing to say about a cell that is
 *   forty thousand bins; a bin × bin view has one cell per bin, and a genome's
 *   contamination has something exact to say about every one of them. So a
 *   column is offered where its own table is *no finer* than the axis, and
 *   nowhere else. Broadcasting a genome's value down onto its bins invents
 *   nothing; rolling a bin column up into a genome would have to pick a
 *   statistic nobody asked for, and would then be drawn as though the file had
 *   said it.
 * - The **cell resolution** ({@link cellsOf}). The reader already sends, with
 *   every block, the runs its axes are made of and the bin each run's sequence
 *   starts at, which is exactly enough to say which row of which table each
 *   cell of the picture is — pooled or dense, on any of the three levels, and
 *   without going back through a name that a metagenome is entitled to use
 *   twice.
 *
 * Everything in this module is free of DOM and of the reader, so the mapping
 * can be tested as arithmetic (`test/unit/metadata.test.ts`).
 */

import type { AnnotationEntry, AnnotationKind, MetadataSource } from './types'
import { defaultStyle, placementOn } from './types'
import type { Column, Table } from '../types'

// ---------------------------------------------------------------------------
// What a metadata column is
// ---------------------------------------------------------------------------

/**
 * The three tables a value can be keyed on, coarsest first.
 *
 * The same three the file writes and the same three the tables view lists.
 * `bins` is the one no view shows as a table — `/bins` is deliberately never
 * read whole at open time (§3.3) — and it is also the only one every container
 * has, because a balanced cooler keeps its weights there.
 */
export type MetaTable = 'genomes' | 'contigs' | 'bins'

/** Which of the two pictures a column is drawn as. */
export type MetaKind = 'quantitative' | 'qualitative'

/** What one cell of the axis is; `MatrixResult.level` under another name. */
export type MetaLevel = 'bin' | 'contig' | 'genome'

/** The axis unit each table describes, for the level rule. */
const TABLE_LEVEL: Record<MetaTable, MetaLevel> = {
  genomes: 'genome',
  contigs: 'contig',
  bins: 'bin',
}

/** Coarsest first — the order the drop-down groups its options in. */
export const META_TABLES: readonly MetaTable[] = ['genomes', 'contigs', 'bins']

/**
 * Whether a column of one table can be drawn against an axis of one level.
 *
 * The level rule, and the whole of it: **a table may be no finer than the
 * axis**. A genome's value is exact on every contig and every bin inside it, so
 * a genomes column draws on all three; a bin's value is a statement about one
 * bin and nothing else, so a bins column draws only where a cell is a bin.
 *
 * The alternative — aggregating upward, a mean weight per contig — is not
 * offered anywhere in this module, and the reason is that it would be drawn in
 * exactly the same ink as a value the file wrote. A reader cannot see the
 * difference between "the file says 0.83" and "we averaged 4,000 numbers the
 * file wrote and got 0.83", and a lane that does not distinguish them will
 * eventually be read as though it were the first.
 */
export function showsAtLevel(table: MetaTable, level: MetaLevel): boolean {
  const ORDER: Record<MetaLevel, number> = { genome: 2, contig: 1, bin: 0 }
  return ORDER[TABLE_LEVEL[table]] >= ORDER[level]
}

/** One column the file carries, as the drop-down offers it. */
export interface MetaColumn {
  table: MetaTable
  column: string
  kind: MetaKind
  /** Rows in the source table; the number of units the column describes. */
  rows: number
  /**
   * The distinct values, where the column is qualitative and has been read.
   *
   * Carried on the descriptor so the card can say "6 categories" before
   * anything is drawn, and so the palette a lane uses is decided once, over the
   * whole column, rather than per block — a category that changes colour when
   * you zoom is a legend that lies.
   */
  levels?: readonly string[]
}

/**
 * A whole column, decoded, indexed by row of its own table.
 *
 * `from` is the first row the arrays cover, which is `0` for the two tables
 * that are read whole and the block's first bin for a `/bins` column, where
 * reading the whole thing would mean reading a column the same length as the
 * file's bin count for a picture of four thousand cells.
 */
export type MetaValues =
  | { kind: 'quantitative'; from: number; values: Float64Array }
  | { kind: 'qualitative'; from: number; codes: Int32Array; levels: readonly string[] }

/**
 * What one axis of one block resolves to, per cell.
 *
 * The output of this module and the input to `render/meta.ts`. `NaN` and `-1`
 * both mean *this cell has no value*, which is a different thing from zero and
 * from the first category — a cell of `__unbinned__`, a run the axis carries
 * that the table does not, a bin past the end of its contig.
 */
export type MetaCells =
  | {
      kind: 'quantitative'
      values: Float64Array
      /** Over the cells in hand, skipping the gaps; `null` where every cell is one. */
      extent: { min: number; max: number } | null
    }
  | { kind: 'qualitative'; codes: Int32Array; levels: readonly string[] }

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The columns that are the table's *skeleton* rather than an annotation of it.
 *
 * A name is what the axis is already labelled with and a `genome_id` is a join
 * key; drawn as a lane, the first is a thousand distinct categories and the
 * second is a staircase. Everything else the creator wrote is offered,
 * including the ones this app happens to use: a contig's `length` as a barplot
 * beside a metagenome is a genuine picture of an assembly, and hiding it
 * because the reader also uses it for arithmetic would be an odd rule to have
 * to explain.
 *
 * `/bins` has `chrom`, `start` and `end` cut for the same reason — they are the
 * bin's address, and the address is the axis.
 */
const SKELETON: Record<MetaTable, readonly string[]> = {
  genomes: ['name'],
  contigs: ['name', 'genome_id'],
  bins: ['chrom', 'start', 'end'],
}

/**
 * Past this many distinct values a numeric column is a measurement rather than
 * a set of labels.
 *
 * Twelve, which is where a discrete palette stops being readable anyway. The
 * columns this rescues are the ones a binner writes — a cluster id, a
 * `is_circular` flag, a three-way quality call — which are integers in the file
 * and categories to every reader of it, and which as a barplot are a picture of
 * the numbering rather than of the data.
 */
export const MAX_NUMERIC_CATEGORIES = 12

/**
 * How many distinct values it takes for a text column to be an identifier.
 *
 * A column with a different string on nearly every row is an accession, a path
 * or a description; drawn as colours it is confetti with a legend as long as
 * the axis. Nine tenths rather than all of them, because a real annotation
 * column has ties and a real accession column has a handful of blanks.
 */
const IDENTIFIER_SHARE = 0.9

/**
 * What kind of picture a column is, from the values themselves.
 *
 * Text is qualitative and numbers are quantitative, with the one exception
 * {@link MAX_NUMERIC_CATEGORIES} describes. `null` means *not an annotation*:
 * an identifier column, or one with nothing in it.
 */
export function classify(column: Column): MetaKind | null {
  if (column.length === 0) return null
  if (isText(column)) {
    const distinct = new Set<string>()
    for (const value of column) {
      if (value !== '') distinct.add(value)
      // An identifier is recognisable long before the whole column has been
      // walked, and these columns are as long as the file's contig count.
      if (distinct.size > MAX_NUMERIC_CATEGORIES && distinct.size > column.length * IDENTIFIER_SHARE) {
        return null
      }
    }
    if (distinct.size === 0) return null
    return distinct.size > column.length * IDENTIFIER_SHARE && column.length > 4
      ? null
      : 'qualitative'
  }
  const distinct = new Set<number>()
  let integral = true
  let any = false
  for (let i = 0; i < column.length; i++) {
    const value = Number(column[i])
    if (!Number.isFinite(value)) continue
    any = true
    if (!Number.isInteger(value)) integral = false
    if (distinct.size <= MAX_NUMERIC_CATEGORIES) distinct.add(value)
    if (!integral && distinct.size > MAX_NUMERIC_CATEGORIES) break
  }
  if (!any) return null
  // Small integers repeated over many rows are labels; anything else is a
  // measurement. The row-count clause is what stops a four-genome file's
  // completeness column — four distinct floats, or four distinct integers —
  // from being read as four categories.
  return integral && distinct.size <= MAX_NUMERIC_CATEGORIES && column.length > distinct.size * 2
    ? 'qualitative'
    : 'quantitative'
}

/** `true` when a decoded column holds strings. */
function isText(column: Column): column is string[] {
  return Array.isArray(column) && (column.length === 0 || typeof column[0] === 'string')
}

/**
 * Every column of one table worth offering, in the file's own column order.
 *
 * The order matters more than it looks: a creator writes the columns of a
 * `/genomes` table in the order they think about them, and a list re-sorted
 * alphabetically here would present a reader's own file back to them
 * rearranged.
 */
export function discoverTable(table: MetaTable, data: Table | null): MetaColumn[] {
  if (data === null) return []
  const out: MetaColumn[] = []
  for (const name of data.columns) {
    if (SKELETON[table].includes(name)) continue
    const column = data.data[name]
    if (column === undefined) continue
    const kind = classify(column)
    if (kind === null) continue
    out.push({
      table,
      column: name,
      kind,
      rows: data.length,
      ...(kind === 'qualitative' ? { levels: levelsOf(column) } : {}),
    })
  }
  return out
}

/**
 * The distinct values of a qualitative column, in the order they first appear.
 *
 * First-appearance rather than alphabetical, for the same reason the column
 * order is kept: a file usually writes its rows in a meaningful order, so the
 * first category to appear is the first one the reader will meet. Blanks are
 * not a category — an empty cell is a missing value, and giving it a colour and
 * a legend entry would draw the gaps as a finding.
 */
export function levelsOf(column: Column): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < column.length; i++) {
    const text = textOf(column[i])
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** One cell as the category name it stands for. */
function textOf(value: string | number | bigint | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : ''
}

/**
 * A whole column, as the values a lane reads.
 *
 * Encoded once, against the levels the descriptor already fixed, so that the
 * same category is the same colour in every view and in every export. A value
 * the descriptor has never seen — impossible for a column read whole, possible
 * for a `/bins` slice read after the descriptor was made — is a gap rather than
 * a new level, because a legend that grows as you scroll is not a legend.
 */
export function valuesOf(column: Column, kind: MetaKind, levels: readonly string[], from = 0): MetaValues {
  if (kind === 'quantitative') {
    const values = new Float64Array(column.length)
    for (let i = 0; i < column.length; i++) {
      const value = Number(column[i])
      values[i] = Number.isFinite(value) ? value : Number.NaN
    }
    return { kind: 'quantitative', from, values }
  }
  const index = new Map(levels.map((level, code) => [level, code]))
  const codes = new Int32Array(column.length).fill(-1)
  for (let i = 0; i < column.length; i++) {
    codes[i] = index.get(textOf(column[i])) ?? -1
  }
  return { kind: 'qualitative', from, codes, levels }
}

// ---------------------------------------------------------------------------
// The block's axis
// ---------------------------------------------------------------------------

/**
 * One run of an axis, exactly as the reader reports it (`AxisGroup`).
 *
 * Structural rather than imported, like `render/locus.ts`'s `AxisRun` and for
 * the same reason: this module describes annotations and has no business
 * depending on the wire format the reader answers in.
 */
export interface MetaAxisRun {
  label: string
  start: number
  end: number
  /** The arithmetic origin of the run's sequence; see `AxisGroup.unitStart`. */
  unitStart?: number
  /** The absolute bin the run's sequence begins at; bin level only. */
  unitBin?: number
}

/**
 * Where a cell of the *table* lands on the axis the picture is drawn in.
 *
 * The identity almost always, and the exception is the turn. A turned map is
 * drawn on a lattice of **half-bin** columns (`render/rotate.ts`), so the cell
 * a metadata column is indexed by is two of the columns the lane is drawn
 * against, and the block may not begin where the rotation's origin does. Two
 * numbers carry both facts, and they are applied at the one place a cell
 * becomes a position — which is what keeps the renderers free of any knowledge
 * that a turn exists.
 */
export interface CellScale {
  /** The drawn unit that cell `0` begins at. */
  origin: number
  /** Drawn units per cell. */
  per: number
}

/** A picture whose cells are the axis's own units — every view but the turn. */
export const IDENTITY_CELLS: CellScale = { origin: 0, per: 1 }

/** The drawn unit a cell begins at. */
export function unitOfCell(scale: CellScale, cell: number): number {
  return scale.origin + cell * scale.per
}

/** The cell a drawn unit falls in; the inverse, for the readout. */
export function cellOfUnit(scale: CellScale, unit: number): number {
  return scale.per === 0 ? -1 : Math.floor((unit - scale.origin) / scale.per)
}

/** One axis of one rendered block, as this module needs it. */
export interface MetaBlock {
  level: MetaLevel
  runs: readonly MetaAxisRun[]
  /** Cells on this axis — `nrows` or `ncols`. */
  cells: number
  /** The bin the block opens at (`rowExtent[0]`/`colExtent[0]`). */
  blockStart: number
  /** Bins summed into one cell; `1` for a dense read. */
  binsPerCell: number
  /** How the cells land on the drawn axis; the identity unless turned. */
  scale?: CellScale
}

/**
 * The lookups a cell → row mapping needs, which only the open file can answer.
 *
 * An interface rather than the tables themselves, so the arithmetic below can
 * be tested against four lines of fixture and so this module never learns what
 * a `Table` is shaped like. `ui/MetadataIndex.ts` is the implementation.
 */
export interface MetaRowIndex {
  /** Row of `/genomes` for a genome name, or `-1`. */
  genomeRow(name: string): number
  /** Row of `/contigs` for a contig name, or `-1`. */
  contigRow(name: string): number
  /** Row of `/contigs` whose sequence covers an absolute bin, or `-1`. */
  contigRowOfBin(bin: number): number
  /** The genome a contig row belongs to, or `-1` on a file with no genomes. */
  genomeOfContig(row: number): number
  /** How many bins a contig row has; `0` for a row that is not there. */
  binsInContig(row: number): number
}

/**
 * Which row of one table each cell of one axis is, and `-1` where none.
 *
 * The three levels, each resolved by the least ambiguous thing available:
 *
 * - **bin.** The run carries `unitBin`, the absolute bin its sequence begins
 *   at, so the contig is found by *position* and not by name. That matters on a
 *   metagenome, where two MAGs are perfectly entitled to have assembled a
 *   `contig_1` each, and a name lookup would draw one MAG's annotation on the
 *   other's bins.
 * - **contig.** A cell is a whole sequence and there is no bin to ask, so the
 *   name is all there is. Ambiguity resolves to the first match, which is what
 *   the reader's own `contigIds` does with a repeated name.
 * - **genome.** Genome names are unique by construction — they are the keys the
 *   file's genome layer is built on.
 *
 * A cell claimed by two runs — which happens above bin level, where several
 * short sequences share one cell — keeps the **first**, because the first is
 * what the axis is labelled with and a lane that disagrees with its own axis
 * label is worse than one that is coarse.
 */
export function rowsForCells(block: MetaBlock, table: MetaTable, index: MetaRowIndex): Int32Array {
  const rows = new Int32Array(Math.max(0, block.cells)).fill(-1)
  for (const run of block.runs) {
    const from = Math.max(0, Math.trunc(run.start))
    const to = Math.min(rows.length, Math.trunc(run.end))
    if (to <= from) continue
    const contig =
      block.level === 'genome'
        ? -1
        : run.unitBin === undefined
          ? index.contigRow(run.label)
          : index.contigRowOfBin(run.unitBin)
    const row =
      table === 'genomes'
        ? block.level === 'genome'
          ? index.genomeRow(run.label)
          : index.genomeOfContig(contig)
        : contig
    if (row < 0) continue
    for (let cell = from; cell < to; cell++) if (rows[cell] < 0) rows[cell] = row
  }
  return rows
}

/** The bins one cell of a bin-level axis covers. */
export interface BinSpan {
  /** First absolute bin, or `-1` where the cell is not on a sequence. */
  start: number
  /** How many bins, clamped to the end of the sequence; `0` where there are none. */
  count: number
}

/**
 * The bin range of every cell of a bin-level axis.
 *
 * One formula, and it is the reader's own (`AxisGroup.unitStart`): the cells of
 * a sequence are counted from that sequence's own start, so
 *
 * ```
 * cells into the sequence = blockStart + cell − unitStart
 * first bin of the cell   = unitBin + that × binsPerCell
 * ```
 *
 * and it is exact in all four cases the reader produces. A dense block sends
 * `unitStart` as the sequence's own first bin and `binsPerCell` of 1, so the
 * expression collapses to `blockStart + cell`. A pooled block anchors each
 * sequence's grid to that sequence's start, sends `unitStart` only on the first
 * run — the only one that can open partway along — and the default for every
 * later run, its own block-local `start`, is right by construction.
 *
 * The count is clamped to what the sequence has left, because the last cell of
 * a contig is partial in general and a mean taken over bins that do not exist
 * would be a mean over zeros.
 */
export function binSpansForCells(block: MetaBlock, index: MetaRowIndex): BinSpan[] {
  const spans: BinSpan[] = Array.from({ length: Math.max(0, block.cells) }, () => ({
    start: -1,
    count: 0,
  }))
  if (block.level !== 'bin') return spans
  const stride = Math.max(1, Math.trunc(block.binsPerCell))
  for (const run of block.runs) {
    const from = Math.max(0, Math.trunc(run.start))
    const to = Math.min(spans.length, Math.trunc(run.end))
    if (to <= from) continue
    const first = run.unitBin
    if (first === undefined) continue
    const origin = run.unitStart ?? block.blockStart + run.start
    const bins = index.binsInContig(index.contigRowOfBin(first))
    for (let cell = from; cell < to; cell++) {
      if (spans[cell].start >= 0) continue
      const into = (block.blockStart + cell - origin) * stride
      if (into < 0) continue
      const left = bins > 0 ? bins - into : stride
      if (left <= 0) continue
      spans[cell] = { start: first + into, count: Math.min(stride, left) }
    }
  }
  return spans
}

// ---------------------------------------------------------------------------
// Cells → values
// ---------------------------------------------------------------------------

/**
 * One column, resolved onto the cells of one axis of one block.
 *
 * The only place the two halves meet, and the only thing `render/meta.ts` is
 * given. Where a cell covers several bins — a pooled block, which is every
 * whole-genome picture — a quantitative column is **averaged** over them and a
 * qualitative one takes the **most common** of them. Both are aggregations, and
 * the difference from the roll-up {@link showsAtLevel} refuses is that these
 * stay inside the unit the axis is drawn in: the cell *is* those bins, and
 * every one of them is on screen at that position. Rolling a bin column up to a
 * genome would put a number where the file has none.
 */
export function cellsOf(options: {
  block: MetaBlock
  table: MetaTable
  values: MetaValues
  index: MetaRowIndex
}): MetaCells {
  const { block, table, values, index } = options
  const cells = Math.max(0, block.cells)
  if (table === 'bins') return binCells(binSpansForCells(block, index), values, cells)
  const rows = rowsForCells(block, table, index)
  if (values.kind === 'quantitative') {
    const out = new Float64Array(cells).fill(Number.NaN)
    for (let cell = 0; cell < cells; cell++) {
      const row = rows[cell] - values.from
      if (rows[cell] < 0 || row < 0 || row >= values.values.length) continue
      out[cell] = values.values[row]
    }
    return { kind: 'quantitative', values: out, extent: extentOf(out) }
  }
  const codes = new Int32Array(cells).fill(-1)
  for (let cell = 0; cell < cells; cell++) {
    const row = rows[cell] - values.from
    if (rows[cell] < 0 || row < 0 || row >= values.codes.length) continue
    codes[cell] = values.codes[row]
  }
  return { kind: 'qualitative', codes, levels: values.levels }
}

/** The bins path: a span per cell, averaged or voted on. */
function binCells(spans: readonly BinSpan[], values: MetaValues, cells: number): MetaCells {
  if (values.kind === 'quantitative') {
    const out = new Float64Array(cells).fill(Number.NaN)
    for (let cell = 0; cell < cells && cell < spans.length; cell++) {
      const { start, count } = spans[cell]
      if (start < 0 || count <= 0) continue
      let sum = 0
      let seen = 0
      for (let i = 0; i < count; i++) {
        const at = start + i - values.from
        if (at < 0 || at >= values.values.length) continue
        const value = values.values[at]
        // A filtered bin's weight is `NaN` in the file and means *no value
        // here*, exactly as it does in a bigWig. Averaged in as a zero it would
        // draw a filtered region as a low one rather than as an empty one.
        if (!Number.isFinite(value)) continue
        sum += value
        seen++
      }
      if (seen > 0) out[cell] = sum / seen
    }
    return { kind: 'quantitative', values: out, extent: extentOf(out) }
  }
  const codes = new Int32Array(cells).fill(-1)
  const tally = new Map<number, number>()
  for (let cell = 0; cell < cells && cell < spans.length; cell++) {
    const { start, count } = spans[cell]
    if (start < 0 || count <= 0) continue
    if (count === 1) {
      const at = start - values.from
      codes[cell] = at >= 0 && at < values.codes.length ? values.codes[at] : -1
      continue
    }
    tally.clear()
    for (let i = 0; i < count; i++) {
      const at = start + i - values.from
      if (at < 0 || at >= values.codes.length) continue
      const code = values.codes[at]
      if (code < 0) continue
      tally.set(code, (tally.get(code) ?? 0) + 1)
    }
    let best = -1
    let bestCount = 0
    for (const [code, seen] of tally) {
      // Ties go to the lower code, which is the level that appears earlier in
      // the file: an arbitrary rule, but a *stable* one, so a cell does not
      // change colour between two draws of the same picture.
      if (seen > bestCount || (seen === bestCount && best >= 0 && code < best)) {
        best = code
        bestCount = seen
      }
    }
    codes[cell] = best
  }
  return { kind: 'qualitative', codes, levels: values.levels }
}

/** The range over the cells in hand, skipping the gaps; `null` where all are. */
export function extentOf(values: Float64Array): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return min > max ? null : { min, max }
}

// ---------------------------------------------------------------------------
// The rows on the card
// ---------------------------------------------------------------------------

/**
 * What every metadata entry's id begins with.
 *
 * The same argument `SYNTHETIC_PREFIX` makes: `mintAnnotationId` produces `a`
 * followed by a decimal number and `reserveAnnotationId` reads one back by
 * taking `Number` of everything after the first character, so an id of that
 * shape minted here could later be handed to a loaded track — and two rows
 * under one id is one row listed twice, where removing either removes both.
 * This shape begins with neither `a` nor a digit, and the colons mean no suffix
 * of a column name can rescue it either.
 */
export const METADATA_PREFIX = 'metadata:'

/**
 * The id a column always has, derived rather than minted.
 *
 * So that adding `contamination` twice lands on the row that is already there
 * instead of stacking a second identical lane beside it — `AnnotationStore.begin`
 * replaces an id it already holds and keeps its slot — and so that a row
 * restored from session storage is recognisably the same row.
 */
export function metadataId(table: MetaTable, column: string): string {
  return `${METADATA_PREFIX}${table}:${column}`
}

/** The table and column a metadata id names, or `null` for any other id. */
export function metadataSpec(id: string): { table: MetaTable; column: string } | null {
  if (!id.startsWith(METADATA_PREFIX)) return null
  const rest = id.slice(METADATA_PREFIX.length)
  const cut = rest.indexOf(':')
  if (cut <= 0) return null
  const table = rest.slice(0, cut) as MetaTable
  return META_TABLES.includes(table) ? { table, column: rest.slice(cut + 1) } : null
}

/** Which of the two lane kinds a column is drawn as. */
export function kindFor(kind: MetaKind): AnnotationKind {
  return kind === 'quantitative' ? 'metadata' : 'classes'
}

/**
 * The edge a metadata lane opens on.
 *
 * The **top**, and by elimination: a loaded track lands at the bottom, a
 * computed one on the left (`SYNTHETIC_EDGE`), and a metadata lane arriving on
 * either would be a new row in the middle of a stack somebody has arranged. It
 * is also the right edge on the merits — metadata is what a reader wants
 * *above* the map while they read the columns of it, in the position a genome
 * browser puts its ideogram — and it is an ordinary lane, so the location row
 * moves it anywhere.
 */
export const METADATA_EDGE = 'top' as const

/**
 * A discovered column, as a row on the card.
 *
 * `status: 'ready'` at birth, like a synthetic track and for a stronger reason:
 * there is nothing to fetch that the open file is not already holding. The
 * caller puts it in the store with `begin` and the lane draws on the next
 * frame.
 */
export function metadataEntry(
  column: MetaColumn,
  colour: string,
): AnnotationEntry & { source: MetadataSource } {
  const kind = kindFor(column.kind)
  return {
    id: metadataId(column.table, column.column),
    card: 'metadata',
    kind,
    label: column.column,
    source: {
      kind: 'metadata',
      name: `${column.table}/${column.column}`,
      table: column.table,
      column: column.column,
    },
    status: 'ready',
    visible: true,
    placement: placementOn(METADATA_EDGE),
    style: defaultStyle(kind, colour),
  }
}

/** `where it comes from`, as the row writes it under the name. */
export function originOf(table: MetaTable, column: string): string {
  return `${table === 'bins' ? '/bins' : `/${table}`} · ${column}`
}

/** `48 genomes · 6 categories` — the row's summary line. */
export function summaryOf(column: MetaColumn): string {
  const unit = column.table === 'bins' ? 'bins' : column.table
  const rows = `${column.rows.toLocaleString('en-US')} ${unit}`
  return column.kind === 'quantitative'
    ? rows
    : `${rows} · ${(column.levels?.length ?? 0).toLocaleString('en-US')} categories`
}
