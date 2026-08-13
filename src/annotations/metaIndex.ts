/**
 * The open file's own tables, as the metadata lanes read them (§8.12).
 *
 * One of these per open file. It answers three questions and holds the answers:
 * **what columns are there**, **what is in one**, and **which row of which
 * table is this cell of the picture** — and it is the only object that knows
 * both the reader's tables and the annotation store, which is exactly why it
 * exists rather than the card asking the worker directly.
 *
 * Two of the three tables are already in hand. `/genomes` and `/contigs` are
 * read whole by the views that list them, so a metadata lane over either costs
 * nothing beyond the arithmetic — the same tables, read once per file, and the
 * session hands them straight in.
 *
 * `/bins` is the one that is not, and deliberately (§3.3): it is one row per
 * bin, and reading a whole column of it would be a read as long as the file for
 * a picture that is at most a few thousand cells wide. So a bins column is
 * fetched **over the block on screen**, cached by the range it covers, and
 * re-fetched when a picture that needs more of it arrives. The read is bounded
 * by what is being looked at, which is the same promise every other read in
 * this application makes (§2).
 *
 * Values arrive asynchronously and lanes are drawn synchronously, so
 * {@link MetadataIndex.valuesFor} answers with what it holds and starts a fetch
 * for what it does not, then calls back. A lane whose column has not arrived
 * draws nothing for one frame; it does not blink, block or ask twice.
 */

import type { ReaderClient } from '../worker/client'
import { tableFromPayload } from '../worker/protocol'
import type { Column, Table } from '../types'
import {
  cellsOf,
  discoverTable,
  levelsOf,
  showsAtLevel,
  valuesOf,
  type MetaBlock,
  type MetaCells,
  type MetaColumn,
  type MetaKind,
  type MetaRowIndex,
  type MetaTable,
  type MetaValues,
} from './metadata'
import type { AnnotationEntry } from './types'

/**
 * How much of a `/bins` column one lane may pull in at once.
 *
 * Four million rows — 32 MB as doubles, and about the point where the fetch
 * itself becomes the thing the reader is waiting for. It is not a limit anyone
 * meets by zooming in: it bites only on a whole-file bin-level picture of a
 * very large map, where the honest answer is that the column is bigger than the
 * question, and the lane says so rather than freezing the tab.
 */
export const BIN_COLUMN_CAP = 4_000_000

/** One column's values, plus what it took to get them. */
interface Held {
  values: MetaValues | null
  /** The bin range in hand, for a `/bins` column; `null` for a whole table. */
  range: { from: number; to: number } | null
  /** A fetch is out; a second request for the same column must not start one. */
  fetching: boolean
  /** Set when the read failed or was refused; the row says so. */
  error?: string
}

export interface MetadataIndexOptions {
  /** `/genomes` with every column; `null` for a plain cooler. */
  genomes: Table | null
  /** `/contigs` (or `/chroms`) with every column. */
  contigs: Table
  /** The file's bin size in base pairs, for the contig → bin arithmetic. */
  binsize: number
  /** What `/bins` carries, by name and kind; `[]` where there is no such group. */
  binColumns: ReadonlyArray<{ name: string; text: boolean }>
  /** How a `/bins` column is read. Absent on a file whose reader has gone. */
  client?: ReaderClient
  /** Something arrived: redraw. */
  onChange(): void
}

export class MetadataIndex implements MetaRowIndex {
  private readonly genomes: Table | null
  private readonly contigs: Table
  private readonly binsize: number
  /** Every column worth offering, discovered once. */
  readonly columns: readonly MetaColumn[]
  /** Column values, keyed `table/column`. */
  private readonly held = new Map<string, Held>()
  /** Contig name → row, first match wins; see {@link contigRow}. */
  private readonly contigRows = new Map<string, number>()
  private readonly genomeRows = new Map<string, number>()
  /**
   * The first bin of each contig, and the file's bin count at the end.
   *
   * `chrom_offset` rebuilt on this side from the lengths, because the reader
   * does not send it and because the alternative — asking per lookup — would be
   * a round trip inside a paint. It is the same cumulative sum
   * (`metacooler/coords.ts`), computed once per file.
   */
  private readonly binOffsets: Float64Array
  private readonly genomeOfContigRow: Int32Array
  /** Bumped whenever a column lands; what the lanes' own cache is keyed on. */
  private version = 0

  constructor(private readonly options: MetadataIndexOptions) {
    this.genomes = options.genomes
    this.contigs = options.contigs
    this.binsize = Math.max(1, options.binsize)

    const names = stringsOf(this.contigs, 'name')
    for (let row = 0; row < names.length; row++) {
      // First wins, exactly as the reader's own `contigIds` resolves a repeated
      // name: two MAGs may each have assembled a `contig_1`, and a lane drawn
      // at contig level has only the name to go on. At *bin* level it has the
      // bin, which is unambiguous, and that is the path this map is not on.
      if (!this.contigRows.has(names[row])) this.contigRows.set(names[row], row)
    }
    const genomeNames = this.genomes === null ? [] : stringsOf(this.genomes, 'name')
    for (let row = 0; row < genomeNames.length; row++) {
      if (!this.genomeRows.has(genomeNames[row])) this.genomeRows.set(genomeNames[row], row)
    }

    const lengths = numbersOf(this.contigs, 'length')
    this.binOffsets = new Float64Array(lengths.length + 1)
    for (let row = 0; row < lengths.length; row++) {
      this.binOffsets[row + 1] = this.binOffsets[row] + Math.ceil(lengths[row] / this.binsize)
    }
    const ids = numbersOf(this.contigs, 'genome_id')
    this.genomeOfContigRow = new Int32Array(lengths.length).fill(-1)
    for (let row = 0; row < ids.length && row < this.genomeOfContigRow.length; row++) {
      this.genomeOfContigRow[row] = Number.isFinite(ids[row]) ? ids[row] : -1
    }

    this.columns = [
      ...discoverTable('genomes', this.genomes),
      ...discoverTable('contigs', this.contigs),
      // A `/bins` column is offered from its dtype alone, because that is all
      // that can be known without reading it. Its `kind` is therefore the
      // dtype's own answer rather than {@link classify}'s — a numeric bins
      // column is a measurement, which is what a weight is, and a text one is a
      // set of labels. The columns that name the bin are left out for the same
      // reason they are everywhere else: the address is the axis.
      ...options.binColumns
        .filter(({ name }) => !['chrom', 'start', 'end'].includes(name))
        .map(({ name, text }) => ({
          table: 'bins' as const,
          column: name,
          kind: (text ? 'qualitative' : 'quantitative') as MetaKind,
          rows: Math.round(this.binOffsets[this.binOffsets.length - 1]),
        })),
    ]
  }

  /** Which generation of the held values this is; see {@link MetaSource}. */
  revision(): number {
    return this.version
  }

  /** The descriptor for one column, or `null` where the file has no such thing. */
  columnFor(table: MetaTable, column: string): MetaColumn | null {
    return this.columns.find((it) => it.table === table && it.column === column) ?? null
  }

  /** How many bins the file has, from the contig lengths. */
  get nBins(): number {
    return Math.round(this.binOffsets[this.binOffsets.length - 1])
  }

  // -------------------------------------------------------------------------
  // MetaRowIndex — the cell → row arithmetic's lookups
  // -------------------------------------------------------------------------

  genomeRow(name: string): number {
    return this.genomeRows.get(name) ?? -1
  }

  contigRow(name: string): number {
    return this.contigRows.get(name) ?? -1
  }

  /**
   * The contig covering an absolute bin, by binary search over the offsets.
   *
   * The unambiguous half of the pair: a bin belongs to exactly one sequence
   * whatever that sequence is called, which is what makes a bin-level lane on a
   * metagenome correct where a name lookup would not be.
   */
  contigRowOfBin(bin: number): number {
    if (!(bin >= 0) || bin >= this.binOffsets[this.binOffsets.length - 1]) return -1
    let low = 0
    let high = this.binOffsets.length - 2
    while (low <= high) {
      const mid = (low + high) >> 1
      if (bin < this.binOffsets[mid]) high = mid - 1
      else if (bin >= this.binOffsets[mid + 1]) low = mid + 1
      else return mid
    }
    return -1
  }

  genomeOfContig(row: number): number {
    return row >= 0 && row < this.genomeOfContigRow.length ? this.genomeOfContigRow[row] : -1
  }

  binsInContig(row: number): number {
    if (row < 0 || row + 1 >= this.binOffsets.length) return 0
    return Math.round(this.binOffsets[row + 1] - this.binOffsets[row])
  }

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  /**
   * The values of one column, over the bins a picture needs, or `null` while
   * they are on their way.
   *
   * `need` is the bin range a bin-level lane is about to draw and is ignored
   * for the other two tables, which are held whole. A cached range that already
   * covers what is needed is handed back as it stands — panning inside a window
   * that has arrived costs nothing, which is the rule the sample cache follows
   * for the same reason (§8.4).
   */
  valuesFor(
    table: MetaTable,
    column: string,
    need?: { from: number; to: number },
  ): MetaValues | null {
    const key = `${table}/${column}`
    const held = this.held.get(key)
    if (table !== 'bins') {
      if (held !== undefined) return held.values
      const values = this.wholeColumn(table, column)
      this.held.set(key, { values, range: null, fetching: false })
      this.version++
      return values
    }

    const want = this.binRange(need)
    if (held !== undefined && held.error !== undefined) return null
    if (held !== undefined && held.range !== null && covers(held.range, want)) return held.values
    if (held?.fetching !== true) this.fetchBins(key, column, want)
    // What is in hand is still worth drawing while a wider window is fetched:
    // it is the right numbers over part of the picture, and the alternative is
    // a lane that blanks on every zoom.
    return held?.values ?? null
  }

  /**
   * One row of the card, resolved onto one axis of one block (§8.12).
   *
   * The whole of what the lanes are given, and the one method that puts the two
   * halves of this feature together: the level rule decides whether this
   * picture can show this column at all, the values come from the cache above,
   * and the arithmetic is `annotations/metadata.ts`'s.
   *
   * `null` on three roads, and they are all the same answer to the lane —
   * *nothing to draw this frame*: a row whose source is not a metadata column,
   * a column this level cannot honestly show ({@link showsAtLevel}), and a
   * `/bins` slice that has not landed yet.
   */
  cellsFor(entry: AnnotationEntry, block: MetaBlock): MetaCells | null {
    const source = entry.source
    if (source.kind !== 'metadata') return null
    if (!showsAtLevel(source.table, block.level)) return null
    const need =
      source.table === 'bins'
        ? {
            from: block.blockStart,
            to: block.blockStart + Math.max(0, block.cells) * Math.max(1, block.binsPerCell),
          }
        : undefined
    const values = this.valuesFor(source.table, source.column, need)
    if (values === null) return null
    return cellsOf({ block, table: source.table, values, index: this })
  }

  /**
   * One column as a TSV, at **its own** granularity (§8.12).
   *
   * One row per unit of the source table, named — `genome`, `contig` or `bin` —
   * under `#` comment lines saying which file, which table and which column
   * these came from. The granularity is the argument for the whole export: a
   * lane is drawn at whatever level the picture is, so a reader who wants to
   * check a bar against the number behind it needs the column as the file wrote
   * it and not as the picture summarised it.
   *
   * A `/bins` column is written from what has been read, which is the window
   * the picture covers — the first line after the header says which bins those
   * are, so a partial export cannot be mistaken for a whole one.
   */
  exportTsv(table: MetaTable, column: string, uri: string): string | null {
    const descriptor = this.columnFor(table, column)
    const values = this.valuesFor(table, column)
    if (descriptor === null || values === null) return null
    const unit = table === 'genomes' ? 'genome' : table === 'contigs' ? 'contig' : 'bin'
    const names = table === 'genomes' ? this.genomeNamesInOrder() : this.contigNamesInOrder()
    const total =
      values.kind === 'quantitative' ? values.values.length : values.codes.length
    const lines = [
      `# metacooler.js — a column of the map's own tables`,
      `# file: ${uri}`,
      `# table: /${table}`,
      `# column: ${column} (${descriptor.kind})`,
      ...(table === 'bins'
        ? [`# bins: ${values.from}–${values.from + total} of ${this.nBins}`]
        : []),
      `${unit}\t${column}`,
    ]
    for (let i = 0; i < total; i++) {
      const row = values.from + i
      const name = table === 'bins' ? String(row) : (names[row] ?? String(row))
      const value =
        values.kind === 'quantitative'
          ? Number.isFinite(values.values[i])
            ? String(values.values[i])
            : ''
          : (values.levels[values.codes[i]] ?? '')
      lines.push(`${name}\t${value}`)
    }
    return `${lines.join('\n')}\n`
  }

  /** Genome names in table order, for the export's first column. */
  private genomeNamesInOrder(): string[] {
    return this.genomes === null ? [] : stringsOf(this.genomes, 'name')
  }

  /** Contig names in table order. */
  private contigNamesInOrder(): string[] {
    return stringsOf(this.contigs, 'name')
  }

  /** Why a column cannot be drawn, where that is the answer. */
  errorFor(table: MetaTable, column: string): string | null {
    return this.held.get(`${table}/${column}`)?.error ?? null
  }

  /** Forget what was read, so the next draw asks again. */
  clear(): void {
    this.held.clear()
  }

  /** A whole column of one of the two tables that are held in memory. */
  private wholeColumn(table: MetaTable, column: string): MetaValues | null {
    const source = table === 'genomes' ? this.genomes : this.contigs
    const descriptor = this.columnFor(table, column)
    if (source === null || descriptor === null) return null
    const data = source.data[column]
    if (data === undefined) return null
    return valuesOf(data, descriptor.kind, descriptor.levels ?? [], 0)
  }

  /** The bins a fetch should cover: what was asked for, widened and clamped. */
  private binRange(need: { from: number; to: number } | undefined): { from: number; to: number } {
    const total = this.nBins
    if (need === undefined) return { from: 0, to: Math.min(total, BIN_COLUMN_CAP) }
    // Half again either side, so a pan inside the window that arrived is free.
    const span = Math.max(1, need.to - need.from)
    const pad = Math.ceil(span / 2)
    return {
      from: Math.max(0, Math.floor(need.from - pad)),
      to: Math.min(total, Math.ceil(need.to + pad)),
    }
  }

  private fetchBins(key: string, column: string, range: { from: number; to: number }): void {
    const client = this.options.client
    const held = this.held.get(key) ?? { values: null, range: null, fetching: false }
    if (client === undefined) {
      this.held.set(key, { ...held, error: 'this file’s reader is no longer open' })
      return
    }
    if (range.to - range.from > BIN_COLUMN_CAP) {
      this.held.set(key, {
        ...held,
        fetching: false,
        error: `${(range.to - range.from).toLocaleString('en-US')} bins is more of /bins/${column} than can be read at once — zoom in`,
      })
      this.options.onChange()
      return
    }
    this.held.set(key, { ...held, fetching: true })
    void client
      .request<'binColumn'>({ kind: 'binColumn', column, from: range.from, to: range.to })
      .then((result) => {
        const raw: Column = result.text ?? result.values ?? new Float64Array(0)
        const descriptor = this.columnFor('bins', column)
        const kind: MetaKind = descriptor?.kind ?? (result.text === undefined ? 'quantitative' : 'qualitative')
        // The levels of a bins column can only be known from what has been
        // read, so the first slice fixes them and later ones are encoded
        // against the same list. A category that first appears in a later
        // window joins the end rather than renumbering the ones already drawn:
        // the colours a reader has already seen do not move.
        const levels =
          kind === 'qualitative' ? mergeLevels(descriptor?.levels ?? [], levelsOf(raw)) : []
        if (descriptor !== null && kind === 'qualitative') {
          const index = this.columns.indexOf(descriptor)
          if (index >= 0) (this.columns as MetaColumn[])[index] = { ...descriptor, levels }
        }
        this.held.set(key, {
          values: valuesOf(raw, kind, levels, result.from),
          range: { from: result.from, to: result.to },
          fetching: false,
        })
        this.version++
        this.options.onChange()
      })
      .catch((error: unknown) => {
        this.held.set(key, {
          ...held,
          fetching: false,
          error: error instanceof Error ? error.message : 'the column could not be read',
        })
        this.options.onChange()
      })
  }
}

/** `true` when a range already in hand covers the one being asked for. */
function covers(held: { from: number; to: number }, want: { from: number; to: number }): boolean {
  return held.from <= want.from && held.to >= want.to
}

/** The levels already fixed, plus any this read found, in that order. */
function mergeLevels(known: readonly string[], found: readonly string[]): string[] {
  const out = [...known]
  const seen = new Set(known)
  for (const level of found) {
    if (seen.has(level)) continue
    seen.add(level)
    out.push(level)
  }
  return out
}

/** A string column, or an empty list for a table that has no such column. */
function stringsOf(table: Table, column: string): string[] {
  const data = table.data[column]
  if (data === undefined) return []
  return Array.isArray(data) && (data.length === 0 || typeof data[0] === 'string')
    ? (data as string[])
    : []
}

/** A numeric column as plain numbers, or an empty list where there is none. */
function numbersOf(table: Table, column: string): number[] {
  const data = table.data[column]
  if (data === undefined) return []
  if (Array.isArray(data)) return typeof data[0] === 'string' ? [] : (data as number[])
  return Array.from(data as ArrayLike<number | bigint>, Number)
}

/** Build one from the two table payloads the session already holds. */
export function metadataIndexFrom(options: {
  genomes: Parameters<typeof tableFromPayload>[0] | null
  contigs: Parameters<typeof tableFromPayload>[0]
  binsize: number
  binColumns: ReadonlyArray<{ name: string; text: boolean }>
  client?: ReaderClient
  onChange(): void
}): MetadataIndex {
  return new MetadataIndex({
    genomes: options.genomes === null ? null : tableFromPayload(options.genomes),
    contigs: tableFromPayload(options.contigs),
    binsize: options.binsize,
    binColumns: options.binColumns,
    ...(options.client === undefined ? {} : { client: options.client }),
    onChange: options.onChange,
  })
}
