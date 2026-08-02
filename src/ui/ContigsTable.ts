/**
 * The contigs table.
 *
 * Two jobs. For a plain `.cool` or `.mcool` it is *the* entry point (spec §9):
 * the synthesised genomes table is one meaningless row, so landing there would
 * be landing on nothing. For a `.metacool` it is the third breadcrumb segment —
 * the contigs of one genome, on the way to a region.
 *
 * Whole-genome browsing of a eukaryotic cooler is explicitly out of scope (§9),
 * so this view leads to a region and never to a "whole file" heatmap.
 */

import { payloadColumnIsText, type ContigsResult } from '../worker/protocol'
import { el, fmt } from './dom'
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

    this.table = new VirtualTable({
      columns,
      rows: options.rows ?? Array.from({ length: payload.length }, (_, index) => index),
      searchKeys: ['name'],
      searchPlaceholder: 'search contig names…',
      emptyMessage: 'No contigs match these filters.',
      ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
      onOpen: (row) => options.onOpenContig(names[row]),
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
      ),
      this.table.el,
    )
  }
}
