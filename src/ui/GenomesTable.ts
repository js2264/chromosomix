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
}

export class GenomesTable {
  readonly el: HTMLElement
  private readonly table: VirtualTable
  private readonly names: string[]

  constructor(options: GenomesTableOptions) {
    const { data } = options
    this.names = data.table.data['name'] as string[]

    const columns = buildColumns(data)
    const show = button('show selected →', () => {
      const rows = this.table.selection
      if (rows.length > 0) options.onOpenSelection(rows.map((row) => this.names[row]))
    })
    show.disabled = true
    const all = button('select all', () => this.table.selectAll(), {
      class: 'btn btn-quiet',
      title: 'Tick every genome the current filters leave visible',
    })
    const none = button('clear', () => this.table.clearSelection(), {
      class: 'btn btn-quiet',
      title: 'Untick everything',
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
    this.table.addToolbarItem(all)
    this.table.addToolbarItem(none)
    this.table.addToolbarItem(show)
    this.table.addToolbarItem(
      keyedButton('whole genome →', KEYS.whole, () => options.onOpenWhole(), {
        title: withKey('Every genome at once, as one map', KEYS.whole),
      }),
    )

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
            'phage–host, plasmid–host and HGT view.',
        }),
      ),
      this.table.el,
    )
  }

  /** The `/` key: a table's box is the filter above it. */
  focusSearch(): void {
    this.table.focusSearch()
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
    return {
      key: name,
      label: name,
      kind: 'number',
      align: 'right',
      width: 'minmax(5.5rem, 0.7fr)',
      value: (row) => column[row],
      format: (value) => (typeof value === 'number' ? fmt.num(value) : ''),
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
