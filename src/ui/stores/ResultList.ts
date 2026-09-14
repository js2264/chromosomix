/**
 * The rows of a portal store that survive the narrowing, grouped by what they
 * belong to.
 *
 * A 4DN experiment set is a contact map and the bigWigs and peak files
 * published beside it, and a reader who narrows to one set means the set: so
 * rows are drawn under a heading per group — the set's accession, what it is
 * of, how many files — with a tick box that takes the whole group and, where
 * the generator wrote one, *open with its tracks*, which is the pre-configured
 * session for that group (§24.3). The session shelves stopped being a menu of
 * their own the day this heading existed.
 *
 * ## A thousand rows are drawn, and every row is counted
 *
 * The cap `StoreTable` had, for the reason it had it: the largest ENCODE shard
 * is 55,000 rows, a list of them is a quarter of a million elements, and what
 * a reader does with a catalogue that size is narrow it. The cap is on
 * drawing only — the counts, the facets and the tray see every row — and the
 * line above the list says so when it bites.
 */

import { button, el, fmt } from '../dom'
import { icon } from '../icons'
import { valueOf } from '../../state/facets'
import type { StoreColumn, StoreEntry } from '../../state/store'
import { rowActions, type StoreHost } from './host'
import { labelOf } from './FacetRail'

/** How many rows are put in the document at once. */
export const DRAWN = 1000

export interface ResultListProps {
  host: StoreHost
  /** A row was ticked or unticked. */
  onTick(entry: StoreEntry, on: boolean): void
  /** A whole group was ticked or unticked. */
  onTickAll(entries: readonly StoreEntry[], on: boolean): void
}

export interface ResultListPaint {
  /** The rows that passed the query, in the store's order. */
  entries: readonly StoreEntry[]
  columns: readonly StoreColumn[]
  /** The column rows are grouped under, or none for a flat list. */
  group?: string
  /** The columns a group's heading repeats. */
  headline?: readonly string[]
  /** Pre-configured sessions by `${group}|${assembly}`. */
  sessions: ReadonlyMap<string, StoreEntry>
  /** The ticked rows, by URI. */
  selected: ReadonlySet<string>
}

export class ResultList {
  readonly el = el('div', { class: 'portal-rows' })

  constructor(private readonly props: ResultListProps) {}

  paint(paint: ResultListPaint): void {
    const drawn = paint.entries.slice(0, DRAWN)
    const nodes: HTMLElement[] = []
    if (paint.group === undefined) {
      for (const entry of drawn) nodes.push(this.row(entry, paint, paint.columns.slice(0, 4)))
    } else {
      // Group by first appearance, so the store's own order decides which set
      // is first and a diff between two weeks of it stays readable — except
      // the rows that belong to no set, which go last whatever the order: a
      // heading that says *not in a set* at the top of a portal is the least
      // interesting thing in it standing in the way of the rest.
      const groups = new Map<string, StoreEntry[]>()
      const loose: StoreEntry[] = []
      for (const entry of drawn) {
        const key = valueOf(entry, paint.group)
        if (key === '') {
          loose.push(entry)
          continue
        }
        const held = groups.get(key)
        if (held === undefined) groups.set(key, [entry])
        else held.push(entry)
      }
      if (loose.length > 0) groups.set('', loose)
      const detail = paint.columns
        .filter((column) => column.key !== paint.group && !(paint.headline ?? []).includes(column.key))
        .slice(0, 4)
      for (const [key, entries] of groups) {
        nodes.push(this.groupHead(key, entries, paint))
        for (const entry of entries) nodes.push(this.row(entry, paint, detail))
      }
    }
    this.el.replaceChildren(...nodes)
  }

  private groupHead(key: string, entries: readonly StoreEntry[], paint: ResultListPaint): HTMLElement {
    const first = entries[0]
    const chips = (paint.headline ?? [])
      .map((column) => valueOf(first, column))
      .filter((value) => value !== '')
      .map((value) => el('span', { class: 'portal-chip', text: value }))
    const allOn = entries.every((entry) => paint.selected.has(entry.uri))
    const box = el('input', {
      type: 'checkbox',
      class: 'portal-box',
      title: `Tick every file of ${labelOf(key)}`,
      attrs: { 'aria-label': `tick every file of ${labelOf(key)}` },
    })
    box.checked = allOn
    box.addEventListener('change', () => this.props.onTickAll(entries, box.checked))

    // One *open with its tracks* per assembly the group was published on: a
    // session is one set of coordinates (§24.3), and a set on two assemblies
    // is two sessions.
    const assemblies = [...new Set(entries.map((entry) => valueOf(entry, 'assembly')))]
    const sessions = assemblies.flatMap((assembly) => {
      const session = paint.sessions.get(`${key}|${assembly}`)
      if (session === undefined) return []
      return [
        button(
          assemblies.length > 1 ? `open with its tracks · ${assembly}` : 'open with its tracks',
          () => this.props.host.open(session),
          {
            class: 'btn btn-quiet portal-session',
            title: `${session.label} — a pre-configured session: the map with the tracks published beside it, in one tab`,
          },
        ),
      ]
    })

    return el(
      'div',
      { class: 'portal-group' },
      box,
      el('span', { class: 'portal-group-key', text: key === '' ? 'not in a set' : key }),
      ...chips,
      el('span', { class: 'portal-group-count', text: `${fmt.int(entries.length)} file${entries.length === 1 ? '' : 's'}` }),
      ...sessions,
    )
  }

  private row(entry: StoreEntry, paint: ResultListPaint, detail: readonly StoreColumn[]): HTMLElement {
    const box = el('input', {
      type: 'checkbox',
      class: 'portal-box',
      attrs: { 'aria-label': `tick ${entry.label}` },
    })
    box.checked = paint.selected.has(entry.uri)
    box.addEventListener('change', () => this.props.onTick(entry, box.checked))
    const name = button(entry.label, () => this.props.host.open(entry), {
      class: 'btn-link portal-name',
      title: entry.note ?? '',
    })
    const chips = detail
      .map((column) => [column, valueOf(entry, column.key)] as const)
      .filter(([, value]) => value !== '')
      .map(([column, value]) =>
        el('span', { class: 'portal-chip portal-chip-dim', text: value, title: column.label }),
      )
    return el(
      'div',
      { class: `portal-row${paint.selected.has(entry.uri) ? ' is-on' : ''}` },
      box,
      el('span', { class: `portal-kind portal-kind-${entry.kind}`, title: kindTitle(entry.kind) }, icon(kindIcon(entry.kind), { size: 12 })),
      el('div', { class: 'portal-row-text' }, name, ...chips),
      entry.size === undefined
        ? null
        : el('span', { class: 'portal-size', text: fmt.bytes(entry.size) }),
      el('div', { class: 'portal-row-actions' }, ...rowActions(entry, this.props.host)),
    )
  }
}

function kindIcon(kind: StoreEntry['kind']): 'grid-2x2' | 'dna' | 'layers' {
  return kind === 'map' ? 'grid-2x2' : kind === 'workspace' ? 'layers' : 'dna'
}

function kindTitle(kind: StoreEntry['kind']): string {
  return kind === 'map'
    ? 'A contact map'
    : kind === 'workspace'
      ? 'A saved session: a file with its tracks placed'
      : 'A genome file: a track, a sequence or an annotation'
}

/**
 * The line over the list: how many rows, of how many, and whether the cap bit.
 *
 * Pure, so the wording is testable without a DOM: "my row is not here" and "my
 * row is filtered out" look the same on screen and only one of them is
 * something the reader can undo.
 */
export function countLine(total: number, matching: number, narrowed: boolean): string {
  if (total === 0) return 'This store lists nothing.'
  const capped =
    matching > DRAWN ? ` The first ${fmt.int(DRAWN)} are drawn; narrow further to see the rest.` : ''
  if (!narrowed) return `${fmt.int(total)} ${total === 1 ? 'file' : 'files'}.${capped}`
  if (matching === 0) return `Nothing matches. ${fmt.int(total)} ${total === 1 ? 'file' : 'files'} in this store.`
  return `${fmt.int(matching)} of ${fmt.int(total)} files.${capped}`
}
