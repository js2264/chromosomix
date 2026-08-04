/**
 * The contigs table.
 *
 * Two jobs. For a plain `.cool` or `.mcool` it is *the* entry point (spec §9):
 * the synthesised genomes table is one meaningless row, so landing there would
 * be landing on nothing. For a `.metacool` it is the third breadcrumb segment —
 * the contigs of one genome, on the way to a region.
 *
 * §9 used to rule whole-genome browsing of a eukaryotic cooler out entirely, so
 * this view led to a region and to nothing else. It is not out of scope any
 * more — the whole map is read at the resolution it is drawn at, so no file is
 * too large for it — and the way there is a button in the toolbar rather than
 * only a chevron in the breadcrumb.
 */

import { payloadColumnIsText, type ContigsResult } from '../worker/protocol'
import { button, el, fmt } from './dom'
import { VirtualTable, type ColumnDef, type VirtualTableOptions } from './VirtualTable'

const CORE_ORDER = ['name', 'length']

export interface ContigsTableOptions {
  data: ContigsResult
  /** Rows to show; defaults to every contig. Used to scope to one genome. */
  rows?: number[]
  /** Columns to omit — `genome_id` is noise on a synthesised single-genome file. */
  hideColumns?: string[]
  title?: string
  hint?: string
  /** Restores the filters, search and sort a user left behind (`state/UiMemory`). */
  persistence?: VirtualTableOptions['persistence']
  onOpenContig(name: string): void
  /** Show every ticked sequence as one map — see the genomes table's twin. */
  onOpenSelection?(names: string[]): void
  /**
   * Open the whole file at once — see {@link GenomesTableOptions.onOpenWhole}.
   *
   * Absent where there is nothing to open: this table is also the third crumb
   * of a metacool, the contigs *of one genome*, and "the whole file" is not
   * what someone reading a MAG's contigs is asking for.
   */
  onOpenWhole?(): void
}

export class ContigsTable {
  readonly el: HTMLElement
  private readonly table: VirtualTable

  constructor(options: ContigsTableOptions) {
    const payload = options.data.table
    const names = payload.data['name'] as string[]
    const hidden = new Set(options.hideColumns ?? [])
    const ordered = [
      ...CORE_ORDER.filter((name) => payload.columns.includes(name)),
      ...payload.columns.filter((name) => !CORE_ORDER.includes(name)),
    ].filter((name) => !hidden.has(name))

    const columns: ColumnDef[] = ordered.map((name) => {
      const column = payload.data[name]
      if (payloadColumnIsText(column)) {
        return {
          key: name,
          label: name,
          kind: 'string',
          width: name === 'name' ? 'minmax(12rem, 1.4fr)' : 'minmax(7rem, 1fr)',
          value: (row) => (column[row] === '' ? undefined : column[row]),
        }
      }
      return {
        key: name,
        label: name,
        kind: 'number',
        align: 'right',
        width: 'minmax(6rem, 0.7fr)',
        value: (row) => column[row],
        format: (value) =>
          typeof value !== 'number' ? '' : name === 'length' ? fmt.int(value) : fmt.num(value),
      }
    })

    const chooser = options.onOpenSelection
    const show = button('show selected →', () => {
      const rows = this.table.selection
      if (chooser !== undefined && rows.length > 0) chooser(rows.map((row) => names[row]))
    })
    show.disabled = true
    const all = button('select all', () => this.table.selectAll(), {
      class: 'btn btn-quiet',
      title: 'Tick everything the current filters leave visible',
    })
    const none = button('clear', () => this.table.clearSelection(), {
      class: 'btn btn-quiet',
      title: 'Untick everything',
    })
    none.disabled = true

    this.table = new VirtualTable({
      columns,
      rows: options.rows ?? Array.from({ length: payload.length }, (_, index) => index),
      // Ticking is offered wherever showing several is: on a metacool's
      // per-genome contigs list the map of "these contigs" is the genome view
      // one crumb up, so there is nothing for a selection to add.
      ...(chooser === undefined ? {} : { selectable: true }),
      onSelect: (rows) => {
        show.disabled = rows.length === 0
        none.disabled = rows.length === 0
        show.textContent =
          rows.length > 0 ? `show ${fmt.int(rows.length)} selected →` : 'show selected →'
      },
      searchKeys: ['name'],
      searchPlaceholder: 'search contig names…',
      emptyMessage: 'No contigs match these filters.',
      ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
      onOpen: (row) => options.onOpenContig(names[row]),
    })
    if (chooser !== undefined) {
      this.table.addToolbarItem(all)
      this.table.addToolbarItem(none)
      this.table.addToolbarItem(show)
    }
    const whole = options.onOpenWhole
    if (whole !== undefined) {
      this.table.addToolbarItem(
        button('whole genome →', () => whole(), {
          class: 'btn',
          title: 'Every sequence at once, as one map',
        }),
      )
    }

    this.el = el(
      'section',
      { class: 'view view-contigs' },
      el(
        'header',
        { class: 'view-head' },
        el('h2', { text: options.title ?? 'Contigs' }),
        el('p', {
          class: 'hint',
          text:
            options.hint ??
            // 0-based and half-open, because that is what the reader does:
            // cooler's `parse_region` applies no 1-based conversion despite the
            // UCSC-looking syntax, and `metacooler/range.ts` mirrors the code
            // rather than the docstrings. Saying "1-based" here put every
            // hand-typed start one base off the region the CLI would load.
            'Click a contig to open it as a region. Add coordinates in the region box ' +
              'to narrow it further (contig:start-end, 0-based and half-open, as in cooler).',
        }),
      ),
      this.table.el,
    )
  }

  /** Release the table's listeners and flush its pending filter state. */
  destroy(): void {
    this.table.destroy()
  }
}
