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
import { KEYS, keyedButton, withKey } from './commands'
import { SearchBox } from './SearchBox'
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
  /**
   * Go straight to a window inside a sequence: `chrIV:1,200,000-1,210,000`.
   *
   * The door this view did not have. Everything else here opens a *whole*
   * something — a whole sequence by clicking its row, the whole file from the
   * toolbar — and on a mammalian cooler the smaller of those two is still a
   * quarter of a gigabase. A reader who knows the ten kilobases they want had to
   * open the chromosome that contains them and narrow from there, which is a
   * large read taken to reach a small one; the reader is already paying for it
   * by the time the box they need appears.
   *
   * The read itself was never the problem. `readDenseMatrix` bounds every query
   * by `bin1_offset`, so ten bins cost ten bins' worth of pixels whichever view
   * asks — the whole of what was missing is somewhere to ask from.
   */
  onOpenRegion?(region: string): void
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
  private readonly locus: SearchBox | null

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
    // No "select all" here any more. It lived in the toolbar, three controls
    // away from the rows it acted on, and it was the *only* thing in this table
    // that could not say which rows it meant — so a reader who had filtered to
    // six of them read the button, pressed it, and had no way to tell from the
    // toolbar whether they had six or every one in the file. The box in the
    // filter row says it by where it is: it sits in the gutter directly above
    // the ticks it sets, on the line the filters are on.
    const none = button('clear selection', () => this.table.clearSelection(), {
      class: 'btn btn-quiet',
      title: 'Untick everything, including rows the filters are hiding',
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
      this.table.addToolbarItem(none)
      this.table.addToolbarItem(show)
    }
    const whole = options.onOpenWhole
    if (whole !== undefined) {
      this.table.addToolbarItem(
        keyedButton('whole genome →', KEYS.whole, () => whole(), {
          title: withKey('Every sequence at once, as one map', KEYS.whole),
        }),
      )
    }

    // Optional on the class, always passed by the session: a table with nowhere
    // to send a locus should not grow a box that pretends otherwise, and this
    // one is mounted from two places.
    const go = options.onOpenRegion
    this.locus =
      go === undefined
        ? null
        : new SearchBox({
            placeholder: 'contig, or contig:start-end',
            title:
              'Open a window inside a sequence without opening the whole of it first — ' +
              'chrIV:1,200,000-1,210,000. Coordinates are 0-based and half-open, as in ' +
              'cooler. The same box the / key opens.',
            onSubmit: (text) => {
              if (text !== '') go(text)
            },
          })

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
        ...(this.locus === null ? [] : [this.locus.el]),
      ),
      this.table.el,
    )
  }

  /**
   * The `/` key.
   *
   * The **locus** box where there is one, and the filter otherwise. `/` means
   * "where do I want to be" in every other view of this application — it is the
   * key that opens the region bar on a map and the search field in the browser —
   * and a table is not the place for it to mean something else. The filter keeps
   * its own box directly above the rows, visible and one click away, which is
   * where a reader narrowing a list is already looking.
   */
  focusSearch(): void {
    if (this.locus !== null) this.locus.focus()
    else this.table.focusSearch()
  }

  /** Release the table's listeners and flush its pending filter state. */
  destroy(): void {
    this.table.destroy()
  }
}
