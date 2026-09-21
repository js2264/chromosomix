/**
 * The genomes table — the landing view (spec §5.1).
 *
 * Opening a file lands here, not on a heatmap: it costs two small reads, it is
 * the operation a metagenomics user actually performs, and a 4,000 × 4,000
 * heatmap of scalars is less informative than a sortable MAG table carrying the
 * quality metrics the binner produced.
 *
 * Two rules from the spec are structural here rather than optional:
 *
 * - **No column names are hard-coded.** `name`, `length`, `n_contigs` and
 *   `n_bins` are ordered first because the format guarantees them; everything
 *   else — completeness, contamination, taxonomy, genomad scores, whatever the
 *   creator joined in — is discovered from the payload and rendered generically.
 * - **`__unbinned__` is absent, with no toggle to reveal it** (§7.4). The row is
 *   simply not among the displayable indices. Nothing is renumbered to achieve
 *   that: the omitted genome keeps its index, its `genome_id` and all of its
 *   bins, and the one number retained about it lives in the info panel.
 */

import { payloadColumnIsText, type GenomesResult } from '../worker/protocol'
import { button, el, fmt } from './dom'
import { KEYS, keyedButton, withKey } from './commands'
import { SearchBox } from './SearchBox'
import { VirtualTable, type ColumnDef, type VirtualTableOptions } from './VirtualTable'

/** Columns the format guarantees, in the order they are shown. */
const CORE_ORDER = ['name', 'length', 'n_contigs', 'n_bins']

export interface GenomesTableOptions {
  data: GenomesResult
  /** Restores the filters, search and sort a user left behind (`state/UiMemory`). */
  persistence?: VirtualTableOptions['persistence']
  onOpenGenome(name: string): void
  /**
   * Show every ticked genome as one map — their own on the diagonal, everything
   * between them off it.
   *
   * The plural of {@link onOpenGenome}, and it subsumes what "compare two"
   * used to do: a pair is a selection of two, plus the two diagonals that make
   * the off-diagonal block readable.
   */
  onOpenSelection(names: string[]): void
  /**
   * Open the whole file at once.
   *
   * The same place the root crumb's menu leads, offered here as well because
   * the crumb is a chevron in the corner and this is the screen someone is on
   * when they wonder whether the whole thing can be seen at once.
   */
  onOpenWhole(): void
  /**
   * Go straight to a window, without opening the genome that contains it.
   *
   * The twin of the contigs table's box, and the same gap: every other door on
   * this screen opens a *whole* something — a genome, a selection of them, the
   * file — while a reader who knows the ten kilobases they want has to walk
   * through two of those to reach a box that will take them. The reader is
   * resolved by `parseMetacoolerRange`, which takes a genome name, a contig
   * name, or either with coordinates on it, so one box answers all of them.
   */
  onOpenRegion(region: string): void
}

export class GenomesTable {
  readonly el: HTMLElement
  private readonly table: VirtualTable
  private readonly names: string[]
  private readonly locus: SearchBox

  constructor(options: GenomesTableOptions) {
    const { data } = options
    this.names = data.table.data['name'] as string[]

    const columns = buildColumns(data)
    const show = button('show selected →', () => {
      const rows = this.table.selection
      if (rows.length > 0) options.onOpenSelection(rows.map((row) => this.names[row]))
    })
    show.disabled = true
    // "Select all" has moved into the filter row, as a box in the gutter above
    // the ticks it sets — see the contigs table for why a toolbar button could
    // not say which rows it meant.
    const none = button('clear selection', () => this.table.clearSelection(), {
      class: 'btn btn-quiet',
      title: 'Untick everything, including rows the filters are hiding',
    })
    none.disabled = true

    this.table = new VirtualTable({
      columns,
      rows: Array.from(data.display),
      selectable: true,
      searchKeys: ['name'],
      searchPlaceholder: 'search genome names…',
      emptyMessage: 'No genomes match these filters.',
      ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
      onOpen: (row) => options.onOpenGenome(this.names[row]),
      onSelect: (rows) => {
        show.disabled = rows.length === 0
        none.disabled = rows.length === 0
        // Two are named, because two is the comparison this table was built for
        // and reading "MAG_7 × MAG_12 →" is worth more than a count. Past that
        // the names would be longer than the button.
        show.textContent =
          rows.length === 2
            ? `show ${this.names[rows[0]]} × ${this.names[rows[1]]} →`
            : rows.length > 0
              ? `show ${fmt.int(rows.length)} selected →`
              : 'show selected →'
      },
    })
    this.table.addToolbarItem(none)
    this.table.addToolbarItem(show)
    this.table.addToolbarItem(
      keyedButton('whole genome →', KEYS.whole, () => options.onOpenWhole(), {
        title: withKey('Every genome at once, as one map', KEYS.whole),
      }),
    )

    this.locus = new SearchBox({
      placeholder: 'genome, contig, or contig:start-end',
      title:
        'Open a window without opening the genome around it first — MAG_012, a contig of ' +
        'one, or contig:1,200,000-1,210,000. Coordinates are 0-based and half-open, as in ' +
        'cooler. The same box the / key opens.',
      onSubmit: (text) => {
        if (text !== '') options.onOpenRegion(text)
      },
    })

    this.el = el(
      'section',
      { class: 'view view-genomes' },
      el(
        'header',
        { class: 'view-head' },
        el('h2', { text: 'Genomes' }),
        el('p', {
          class: 'hint',
          text:
            'Click a genome to open its matrix. Tick any number and show them as one map — ' +
            'each genome on the diagonal and every block between them off it, which is the ' +
            'phage–host, plasmid–host and HGT view. Or name a window in the box and go ' +
            'straight there.',
        }),
        this.locus.el,
      ),
      this.table.el,
    )
  }

  /**
   * The `/` key: the **locus** box, as in every other view of this application.
   *
   * The filter keeps its own box directly above the rows — visible, and one
   * click away, which is where a reader narrowing a list is already looking.
   * `/` is the key that opens the region bar on a map and the search field in
   * the browser, and a table is not the place for it to mean something else.
   */
  focusSearch(): void {
    this.locus.focus()
  }

  /** Release the table's listeners and flush its pending filter state. */
  destroy(): void {
    this.table.destroy()
  }

  clearSelection(): void {
    this.table.clearSelection()
  }
}

/**
 * Build the column list from whatever the file's `/genomes` table contains.
 *
 * The final column is the free density proxy of §4 —
 * `bin1_offset[hi] − bin1_offset[lo]`, two lookups into an index already in
 * memory. It is sortable because ranking MAGs by contact density is useful, and
 * it is labelled a proxy in both the header and its tooltip because it is
 * **not** a contact count and must never be read as one.
 */
function buildColumns(data: GenomesResult): ColumnDef[] {
  const payload = data.table
  const present = new Set(payload.columns)
  const ordered = [
    ...CORE_ORDER.filter((name) => present.has(name)),
    ...payload.columns.filter((name) => !CORE_ORDER.includes(name)),
  ]

  const columns: ColumnDef[] = ordered.map((name) => {
    const column = payload.data[name]
    if (payloadColumnIsText(column)) {
      return {
        key: name,
        label: name,
        kind: 'string',
        width: name === 'name' ? 'minmax(10rem, 1.4fr)' : 'minmax(7rem, 1fr)',
        // An empty fixed-length string is padding, not a value: treating it as
        // missing is what keeps "contamination < 5" from matching blank rows.
        value: (row) => (column[row] === '' ? undefined : column[row]),
      }
    }
    // One decimal count for the whole column, measured once.
    //
    // `null` where the column holds values too small for three places to say
    // anything about them, and then each cell keeps `fmt.num`'s significant
    // digits: a per-column count would print a set of 1e-5 scores as a column
    // of `0.000`.
    const digits = columnDigits(column)
    return {
      key: name,
      label: name,
      kind: 'number',
      align: 'right',
      width: 'minmax(5.5rem, 0.7fr)',
      value: (row) => column[row],
      format: (value) =>
        typeof value !== 'number'
          ? ''
          : digits === null
            ? fmt.num(value)
            : fmt.fixed(value, digits),
    }
  })

  columns.push({
    key: '__density__',
    label: 'nnz rows (proxy)',
    kind: 'number',
    align: 'right',
    width: 'minmax(7rem, 0.8fr)',
    title:
      'Number of non-zero pixels whose row bin falls inside this genome ' +
      '(bin1_offset[hi] − bin1_offset[lo]). A free density proxy — NOT a contact count.',
    value: (row) => data.density[row],
    format: (value) => (typeof value === 'number' ? fmt.int(value) : ''),
  })

  return columns
}

/**
 * How many decimal places a numeric column should print, or `null` for none.
 *
 * The **most** any value in it actually carries, capped at three, because that
 * is the count at which no row loses a digit and none gains a zero it did not
 * earn: a column of `0.99`, `1`, `0.98` prints two places throughout and a
 * column of integers prints none. Measured over the whole column rather than
 * sampled — a MAG table is thousands of rows, this runs once per open, and the
 * one value with three places is exactly the one a sample would miss.
 *
 * `null` where anything in the column is below what three places can show, so
 * a set of tiny scores keeps `fmt.num`'s significant digits instead of being
 * flattened to `0.000`.
 */
function columnDigits(column: ArrayLike<number>): number | null {
  let digits = 0
  for (let row = 0; row < column.length; row++) {
    const value = column[row]
    if (value === undefined || !Number.isFinite(value)) continue
    if (value !== 0 && Math.abs(value) < 1e-3) return null
    // Asked of the *rounded* text rather than of the float: a bigWig's 0.98
    // arrives as 0.9800000190734863, and its seventeen digits are the reader's
    // business only insofar as three of them are. `toFixed` rather than
    // `fmt.num`, because this counts characters and `fmt.num` is localised —
    // on a machine whose numbers read `0,99` the point would not be found and
    // every column would come out as integers.
    const text = value.toFixed(3).replace(/0+$/, '')
    const point = text.indexOf('.')
    if (point >= 0) digits = Math.max(digits, text.length - point - 1)
  }
  return digits
}
