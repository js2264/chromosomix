/**
 * The rail of facets down the side of a portal store: one group per column,
 * every value with a count, tick what you want.
 *
 * What a data portal puts on the left of its search page, drawn from
 * `state/facets.ts`'s counts. The number beside a value is what ticking it
 * would give (the module explains why that is the honest number), so a reader
 * narrowing 55,000 rows to the twelve they want reads the rail top to bottom
 * and never sees a zero they did not cause.
 *
 * ## Rebuilt on every change, except where the caret is
 *
 * The groups are cheap to rebuild and are rebuilt whole on every paint, which
 * is what keeps the counts honest without a diff. Three things survive a
 * paint because a reader may be in the middle of them: which groups are folded,
 * which groups are showing all of their values rather than the first few, and
 * the text in a group's own filter box — that last one is built once per key
 * and reused, because an input rebuilt under a caret loses the caret.
 *
 * ## Shard facets are ticked like the rest
 *
 * ENCODE's rows are twelve files chosen by assembly and kind of file (§24.3),
 * and the two choices are drawn here as the first two groups, with checkboxes
 * as every other facet has: they read like facets, they narrow like facets —
 * two genomes ticked is both shards read and their rows shown together — and
 * the one way they differ, that ticking one *fetches* a file, is said where its
 * count would be: *on request*, until it has been read.
 */

import { button, el, fmt } from '../dom'
import { icon } from '../icons'
import type { FacetCount } from '../../state/facets'
import { UNSPECIFIED } from '../../state/facets'
import type { StoreColumn } from '../../state/store'
import type { ShardFacet } from './registry'

/** How many values a group shows before it offers the rest. */
const SHOWN = 8
/** Past this many values a group gets a filter box of its own. */
const FILTER_FROM = 12

export interface ShardChoice {
  facets: readonly [ShardFacet, ShardFacet]
  /** The values ticked under each, by key. */
  ticked: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Rows behind each value, by `key|id` — `undefined` for a shard that is not
   * read yet, whose count nobody knows without reading it, and which the rail
   * says is *on request* rather than inventing a nought.
   */
  counts: ReadonlyMap<string, number>
  onToggle(key: string, id: string): void
}

export interface FacetRailProps {
  onToggle(key: string, value: string): void
  onClear(key: string): void
}

export class FacetRail {
  readonly el = el('div', { class: 'facet-rail', attrs: { 'aria-label': 'narrow the rows' } })
  private readonly folded = new Set<string>()
  private readonly expanded = new Set<string>()
  private readonly filters = new Map<string, HTMLInputElement>()

  constructor(private readonly props: FacetRailProps) {}

  /** Draw every group from these counts, in the columns' order. */
  paint(
    columns: readonly StoreColumn[],
    counts: ReadonlyMap<string, readonly FacetCount[]>,
    shard?: ShardChoice,
  ): void {
    const groups: HTMLElement[] = []
    if (shard !== undefined) {
      for (const facet of shard.facets) groups.push(this.shardGroup(facet, shard))
    }
    for (const column of columns) {
      const values = counts.get(column.key) ?? []
      // A column nothing in the store fills is a heading over nothing.
      if (values.length === 0) continue
      groups.push(this.group(column, values))
    }
    this.el.replaceChildren(...groups)
  }

  /** The filter typed into a group, for the paint to honour. */
  private filterOf(key: string): string {
    return (this.filters.get(key)?.value ?? '').trim().toLowerCase()
  }

  private group(column: StoreColumn, values: readonly FacetCount[]): HTMLElement {
    const key = column.key
    const ticked = values.filter((one) => one.on).length
    const needle = this.filterOf(key)
    const matching =
      needle === '' ? values : values.filter((one) => labelOf(one.value).toLowerCase().includes(needle))
    const showAll = this.expanded.has(key) || needle !== ''
    const shown = showAll ? matching : matching.slice(0, SHOWN)
    const hidden = matching.length - shown.length

    const rows = shown.map((one) => this.valueRow(key, one))
    const body = el('div', { class: 'facet-values' }, ...rows)
    if (hidden > 0) {
      body.appendChild(
        button(`${fmt.int(hidden)} more…`, () => {
          this.expanded.add(key)
          this.repaintLater()
        }, { class: 'btn-link facet-more' }),
      )
    } else if (showAll && needle === '' && matching.length > SHOWN) {
      body.appendChild(
        button('fewer', () => {
          this.expanded.delete(key)
          this.repaintLater()
        }, { class: 'btn-link facet-more' }),
      )
    }
    if (needle !== '' && matching.length === 0) {
      body.appendChild(el('p', { class: 'hint facet-empty', text: 'Nothing here matches.' }))
    }

    const head = el(
      'button',
      {
        class: 'facet-head',
        type: 'button',
        attrs: { 'aria-expanded': String(!this.folded.has(key)) },
      },
      icon(this.folded.has(key) ? 'chevron-right' : 'chevron-down', { size: 13 }),
      el('span', { class: 'facet-label', text: column.label }),
      ticked > 0 ? el('span', { class: 'facet-ticked', text: String(ticked) }) : null,
    )
    head.addEventListener('click', () => {
      if (this.folded.has(key)) this.folded.delete(key)
      else this.folded.add(key)
      this.repaintLater()
    })
    const clear =
      ticked > 0
        ? button('clear', () => this.props.onClear(key), {
            class: 'btn-link facet-clear',
            title: `Untick everything under ${column.label}`,
          })
        : null

    const filter = values.length >= FILTER_FROM ? this.filterBox(key, column.label) : null

    return el(
      'section',
      { class: `facet-group${this.folded.has(key) ? ' is-folded' : ''}` },
      el('div', { class: 'facet-head-row' }, head, clear),
      this.folded.has(key) ? null : el('div', { class: 'facet-body' }, filter, body),
    )
  }

  /** The filter box of one group, built once so a caret in it survives a paint. */
  private filterBox(key: string, label: string): HTMLInputElement {
    let box = this.filters.get(key)
    if (box === undefined) {
      box = el('input', {
        class: 'input input-tiny facet-filter',
        type: 'text',
        placeholder: `filter ${label.toLowerCase()}`,
        attrs: { 'aria-label': `filter the values of ${label}` },
      })
      box.addEventListener('input', () => this.repaintLater())
      this.filters.set(key, box)
    }
    return box
  }

  private valueRow(key: string, one: FacetCount): HTMLElement {
    const box = el('input', { type: 'checkbox', class: 'facet-box' })
    box.checked = one.on
    box.addEventListener('change', () => this.props.onToggle(key, one.value))
    return el(
      'label',
      { class: `facet-value${one.on ? ' is-on' : ''}${one.count === 0 ? ' is-empty' : ''}` },
      box,
      el('span', { class: 'facet-value-text', text: labelOf(one.value), title: labelOf(one.value) }),
      el('span', { class: 'facet-count', text: fmt.int(one.count) }),
    )
  }

  private shardGroup(facet: ShardFacet, shard: ShardChoice): HTMLElement {
    const ticked = shard.ticked.get(facet.key) ?? new Set<string>()
    const rows = facet.values.map((value) => {
      // Checkboxes, as every other facet is: a genome and a kind of file are
      // choices of *which shards to read*, and two genomes ticked is both
      // read and their rows shown together — the same OR every facet has.
      const box = el('input', { type: 'checkbox', class: 'facet-box' })
      const on = ticked.has(value.id)
      box.checked = on
      box.addEventListener('change', () => shard.onToggle(facet.key, value.id))
      const count = shard.counts.get(`${facet.key}|${value.id}`)
      return el(
        'label',
        { class: `facet-value${on ? ' is-on' : ''}` },
        box,
        el('span', { class: 'facet-value-text', text: value.label, title: value.label }),
        el('span', {
          class: `facet-count${count === undefined ? ' facet-count-unread' : ''}`,
          text: count === undefined ? 'on request' : fmt.int(count),
          title: count === undefined ? 'Tick it and this shard is read.' : '',
        }),
      )
    })
    return el(
      'section',
      { class: 'facet-group facet-group-shard' },
      el(
        'div',
        { class: 'facet-head-row' },
        el(
          'div',
          { class: 'facet-head facet-head-static' },
          icon('chevron-down', { size: 13 }),
          el('span', { class: 'facet-label', text: facet.label }),
        ),
      ),
      el('div', { class: 'facet-body' }, el('div', { class: 'facet-values' }, ...rows)),
    )
  }

  /**
   * Ask the owner to paint again.
   *
   * The rail holds no counts of its own — they are the owner's, computed from
   * the query — so a fold or a "more" is a request rather than a repaint. The
   * owner listens for it on the element, which keeps this class ignorant of
   * who owns it.
   */
  private repaintLater(): void {
    this.el.dispatchEvent(new CustomEvent('facet-rail-repaint', { bubbles: true }))
  }
}

/** What an empty cell is called on the rail. */
export function labelOf(value: string): string {
  return value === '' ? UNSPECIFIED : value
}
