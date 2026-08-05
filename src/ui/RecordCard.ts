/**
 * The record card: the `/genomes` or `/contigs` row that the heatmap on screen
 * is a picture *of*.
 *
 * A genome or contig view answers "what does this map look like"; the table it
 * came from answers "what is this thing" — completeness, contamination,
 * taxonomy, length, bin count, and whatever else the binner joined in. Both
 * questions are asked at the same moment and, until now, only one of them could
 * be answered without navigating back to the table and losing the view.
 *
 * Two rules are inherited from the tables rather than invented here, so a field
 * means the same thing in both places:
 *
 * - **No column names are hard-coded.** The guaranteed columns lead because the
 *   format guarantees them; every other column is discovered from the payload
 *   and rendered generically. A file with `Present Markers` and `GC-content`
 *   shows them, and this module never learns their names.
 * - **An empty fixed-length string is padding, not a value** (§5.1). It reads as
 *   an em dash, the same way the tables treat it as missing rather than as `''`.
 *
 * The DOM half is one function at the bottom; everything above it is pure, which
 * is what lets the field selection be tested in a Node environment.
 */

import { payloadColumnIsText, type TablePayload } from '../worker/protocol'
import { el, fmt } from './dom'
import { cardTitle, type IconName } from './icons'

/** One row of the card's key/value grid. */
export interface RecordField {
  key: string
  value: string
  /** Hover text for the key, where the column needs a caveat. */
  title?: string
}

export interface RecordSpec {
  /** `Genome`, `Contig (rows)` — what this record is, and on which axis. */
  heading: string
  /**
   * The mark before the heading, as every card in the three panels carries one.
   *
   * Named by the caller rather than derived from the heading, because the
   * heading is a *phrase* — "Chromosome (columns)" — and matching prose against
   * a list of nouns to pick a picture is the kind of cleverness that quietly
   * stops working the day a file calls its sequences something else.
   */
  icon: IconName
  name: string
  fields: RecordField[]
}

/**
 * Columns the format guarantees, first and in this order. The union of the two
 * tables' core columns: `/contigs` has no `n_contigs`, `/genomes` no
 * `genome_id`, and a name absent from a payload is simply skipped.
 */
const CORE_ORDER = ['name', 'length', 'n_contigs', 'n_bins', 'genome_id']

export interface RecordFieldOptions {
  /** Columns to leave out — `genome_id`, once its name has been resolved. */
  skip?: string[]
  /**
   * Placed before the file's own columns, for a field that is context rather
   * than data: which genome a contig belongs to is the first thing to know
   * about it, and a metagenomic contigs table is wide enough to push it out of
   * sight if it goes at the end.
   */
  lead?: RecordField[]
  /** Appended after the file's own columns. */
  extra?: RecordField[]
}

/** The row index of `name` in a payload's `name` column, or `-1`. */
export function findRow(payload: TablePayload, name: string): number {
  const names = payload.data['name']
  if (names === undefined || !payloadColumnIsText(names)) return -1
  return names.indexOf(name)
}

/**
 * Every column of one row, in display order, formatted as text.
 *
 * `name` is never a field: it is the card's title, and repeating it inside the
 * grid would push the informative columns down by a line.
 */
export function recordFields(
  payload: TablePayload,
  row: number,
  options: RecordFieldOptions = {},
): RecordField[] {
  if (row < 0 || row >= payload.length) return []
  const skip = new Set(['name', ...(options.skip ?? [])])
  const ordered = [
    ...CORE_ORDER.filter((name) => payload.columns.includes(name)),
    ...payload.columns.filter((name) => !CORE_ORDER.includes(name)),
  ]

  const fields: RecordField[] = [...(options.lead ?? [])]
  for (const key of ordered) {
    if (skip.has(key)) continue
    const column = payload.data[key]
    if (column === undefined) continue
    if (payloadColumnIsText(column)) {
      const text = column[row] ?? ''
      fields.push({ key, value: text === '' ? '—' : text })
    } else {
      const value = column[row]
      fields.push({ key, value: formatNumber(key, value) })
    }
  }
  fields.push(...(options.extra ?? []))
  return fields
}

/**
 * A length is base pairs and says so; everything else keeps the tables'
 * formatting, which is thousands separators for an integer and three places for
 * a float.
 */
function formatNumber(key: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return key === 'length' ? `${fmt.int(value)} bp` : fmt.num(value)
}

/** Render one record as a sidebar card. */
export function recordCard(spec: RecordSpec): HTMLElement {
  return el(
    'div',
    { class: 'card record-card' },
    cardTitle(spec.heading, spec.icon),
    el('p', { class: 'record-name', text: spec.name, title: spec.name }),
    el(
      'div',
      { class: 'kv kv-record' },
      ...spec.fields.flatMap((field) => [
        el('div', { class: 'k', text: field.key, title: field.title ?? field.key }),
        el('div', { class: 'v', text: field.value, title: field.value }),
      ]),
    ),
  )
}
