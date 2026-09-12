/**
 * A hub, on screen: which one, then which row of it.
 *
 * The picker's old catalogue was a `<select>` of four published sessions, and a
 * `<select>` is exactly right for four. It is nothing at all for six hundred: a
 * 4DN hub is rows chosen by *assembly and biosource and assay*, none of which a
 * dropdown of labels can be narrowed by, and scrolling a list of accessions is
 * the thing the hub format exists to replace (§24.1). So the section is a table,
 * with a filter over the name and one over every column the hub declares, and
 * sortable headers.
 *
 * ## Filtering is filtering, not searching
 *
 * `ui/folderBrowse.ts` states this rule for a folder and it holds here for a
 * different reason. There, a search would mean walking a bucket; here the whole
 * catalogue is already in hand, so every keystroke narrows **the rows held in
 * memory** and nothing is ever refetched. The line under the table says how many
 * of how many are showing, which is what keeps "not in this hub" from reading as
 * "not anywhere" — and what makes it obvious that a second hub is a different
 * question, which this table does not try to answer. Asking the portals' own
 * search APIs from the browser was built and withdrawn (SPECS §24.4): the
 * shelf *is* the search, and the generated hubs are what it searches.
 *
 * ## Nothing is fetched until somebody asks
 *
 * The selector lists hubs; it does not load them (§24.2). Choosing one is the
 * gesture that runs the request, a `?hub=` link is the same gesture arriving
 * from outside, and the inline Demos hub costs no request at all. A reader who
 * never opens this section makes no third-party call.
 *
 * ## Why 404 has its own sentence
 *
 * The two generated hubs are published by a workflow, and a fresh fork has not
 * run it. "The host answered 404" sends somebody to check a URL that is
 * perfectly correct; *not generated yet, the Hubs workflow publishes it* sends
 * them to the thing that is actually missing. That is the whole reason
 * `fetchHub` answers with a union rather than a throw.
 */

import { button, el, fmt } from './dom'
import { fetchHub, type Hub, type HubEntry, type HubRef } from '../state/hub'
import { readHubRows, rememberedHubs, removeHubRow, subscribeHubs } from '../state/hubs'
import { canonicalUrl } from '../sources/rewrite'
import { refusalMessage } from '../state/SessionConfig'

export interface HubTableProps {
  onPick(entry: HubEntry, hub: Hub): void
  /** Called when the reader asks to remember a hub reached by URL. */
  onRemember?(ref: HubRef): void
  /**
   * The hubs to offer in the selector, before the remembered ones.
   *
   * The built-ins, handed down by whoever built this — `ui/examples.ts` owns
   * what they are and this module owns how they are chosen from. The remembered
   * rows are read here rather than passed in, because they change *under* a
   * mounted table: pressing "remember" is a gesture inside this element, and a
   * list refreshed only by rebuilding the picker would leave the hub the reader
   * just kept missing from the menu they kept it in.
   */
  hubs?: readonly HubRef[]
}

/** Which column the rows are ordered by, and which way. */
interface Sort {
  key: string
  /** `1` ascending, `-1` descending. */
  dir: 1 | -1
}

/**
 * The sort keys of the four columns that are not the hub's own.
 *
 * Namespaced rather than bare, because a hub declares its column keys and
 * nothing stops one of them being called `name`: `#` is the prefix for the
 * table's own columns and `c:` for the hub's, so the two sets cannot collide
 * however a generator names a facet. Every key goes through {@link columnKey}
 * or one of these, so there is one rule and it is stated here.
 */
const NAME = '#name'
const KIND = '#kind'
const SIZE = '#size'
const NOTE = '#note'

/** The sort key of one of the hub's own columns. */
function columnKey(key: string): string {
  return `c:${key}`
}

/**
 * How many rows are put in the document at once.
 *
 * A hub was six hundred rows when this table was written and a `<tbody>` of six
 * hundred is nothing. The ENCODE shelves are 126,000 (§24.3), and 126,000 rows
 * of eight cells is a million elements: the tab stops for several seconds on
 * every keystroke of the filter, and on a phone it stops for good.
 *
 * A cap rather than virtual scrolling, and the choice is worth stating. Virtual
 * scrolling would draw the same window on a scroll rather than on a filter, and
 * it would cost this table its two best properties: the browser's own find-in-
 * page, and a `<table>` a screen reader can walk. What a reader does with a
 * catalogue this size is *narrow it* — that is what the filter row is for, and
 * what the line under the table says when the cap bites. A thousand rows is
 * about thirty screens: far more than anybody scrolls, and few enough to draw
 * in one frame.
 *
 * The cap is on **drawing** and never on filtering or sorting: both run over
 * every entry the hub has, so the rows that appear are the first thousand of
 * the real answer rather than a filter of the first thousand.
 */
const DRAWN = 1000

export class HubTable {
  readonly el: HTMLElement

  private readonly select: HTMLSelectElement
  private readonly urlInput: HTMLInputElement
  private readonly rememberSlot: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly filterInput: HTMLInputElement
  private readonly filterRow: HTMLElement
  private readonly tableBox: HTMLElement
  private readonly unsubscribe: () => void

  /** One filter box per hub column, by key. Rebuilt when the columns change. */
  private columnFilters = new Map<string, HTMLInputElement>()
  private hub: Hub | null = null
  private ref: HubRef | null = null
  private sort: Sort | null = null
  /** Bumped on every load, so a slow hub cannot overwrite a fast one. */
  private pending = 0

  constructor(private readonly props: HubTableProps) {
    this.select = el('select', { class: 'select hub-select' })
    this.select.addEventListener('change', () => {
      const chosen = this.refs().find((ref) => ref.id === this.select.value)
      if (chosen === undefined) {
        this.clear()
        return
      }
      void this.load(chosen)
    })

    this.urlInput = el('input', {
      class: 'input input-tiny hub-url',
      type: 'url',
      placeholder: 'https://lab.example.org/hub.json',
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.loadTyped()
    })

    this.rememberSlot = el('span', { class: 'hub-remember' })
    this.statusEl = el('p', { class: 'hint hub-status' })

    // Built once and never replaced, because it is where the caret is: a filter
    // input rebuilt on each repaint loses focus on the first character typed
    // into it (`ui/folderBrowse.ts` records the same lesson).
    this.filterInput = el('input', {
      class: 'input input-tiny hub-filter',
      type: 'text',
      placeholder: 'filter by name or note',
    })
    this.filterInput.addEventListener('input', () => this.paint())
    this.filterRow = el('div', { class: 'hub-filters hidden' }, this.filterInput)
    this.tableBox = el('div', { class: 'hub-rows hidden' })

    this.el = el(
      'div',
      { class: 'hub-table' },
      el(
        'div',
        { class: 'hub-pick-row' },
        this.select,
        // Beside the selector rather than under it: "connect to a hub I was
        // given the URL of" is the same question the menu answers, and a
        // separate section for it would read as a different one.
        this.urlInput,
        button('add', () => void this.loadTyped(), {
          class: 'btn',
          title: 'Read a hub from this URL. Nothing is fetched until you press it.',
        }),
      ),
      el('div', { class: 'hub-status-row' }, this.statusEl, this.rememberSlot),
      this.filterRow,
      this.tableBox,
    )

    this.paintSelect()
    // The remembered list changes under a mounted table — this element is where
    // "remember" is pressed — and two pickers may be looking at it at once.
    this.unsubscribe = subscribeHubs(() => this.paintSelect())
  }

  /** Stop listening for remembered-hub changes. */
  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Replace what the table shows. Absolute entries only (already resolved).
   *
   * `ref` is what the hub was reached *through*, and it is optional because a
   * hub can be handed over already in hand — built in memory, out of anything —
   * and then there is no reference and nothing to remember.
   */
  show(hub: Hub, ref?: HubRef): void {
    // A hub shown directly is not the answer to a load that is still in flight,
    // and must not be overwritten by one that lands afterwards.
    this.pending++
    this.hub = hub
    this.ref = ref ?? null
    this.sort = null
    this.select.value = ref?.id ?? ''
    this.buildFilters(hub)
    this.paint()
    this.offerRemember()
  }

  /** Fetch (on a gesture) and show; renders loading and error states itself. */
  async load(ref: HubRef): Promise<void> {
    const token = ++this.pending
    this.ref = ref
    this.select.value = this.refs().some((held) => held.id === ref.id) ? ref.id : ''
    if (ref.hub !== undefined) {
      this.show(ref.hub, ref)
      return
    }
    if (ref.url === undefined) {
      this.clear()
      return
    }
    this.hub = null
    this.tableBox.classList.add('hidden')
    this.filterRow.classList.add('hidden')
    this.rememberSlot.replaceChildren()
    this.say(`Reading ${ref.label}…`, false)

    const result = await fetchHub(ref.url)
    if (token !== this.pending) return
    if (result.ok) {
      // Through `show`, so there is one road into the painted state — but
      // `show` bumps the token, which is exactly right: the hub is now what
      // this table holds, and an older request landing later must not replace it.
      this.show(result.hub, ref)
      return
    }
    if (result.reason === 'missing' && ref.builtin) {
      // A state, not an error, and the reason `fetchHub` tells 404 apart at all.
      this.say(
        `${ref.label} is not generated yet; the Hubs workflow publishes it. ` +
          'Run it once (Actions → Hubs → Run workflow) and this fills in.',
        false,
      )
      return
    }
    this.say(
      result.reason === 'refused'
        ? refusalMessage(result.refusal, ref.url)
        : result.message,
      true,
    )
  }

  clear(): void {
    this.pending++
    this.hub = null
    this.ref = null
    this.sort = null
    this.select.value = ''
    this.columnFilters = new Map()
    this.filterRow.replaceChildren(this.filterInput)
    this.filterRow.classList.add('hidden')
    this.tableBox.replaceChildren()
    this.tableBox.classList.add('hidden')
    this.rememberSlot.replaceChildren()
    this.say('', false)
  }

  // -------------------------------------------------------------------------
  // The selector
  // -------------------------------------------------------------------------

  /** Every hub on offer: the built-ins this was given, then the remembered ones. */
  private refs(): HubRef[] {
    return [...(this.props.hubs ?? []), ...rememberedHubs()]
  }

  /**
   * The selector, grouped by where each shelf came from.
   *
   * Every reference names its own heading (`HubRef.group`), and the *order of
   * first appearance* is the order the headings come out in — so what the menu
   * looks like is decided by `ui/examples.ts`'s list and not by a second
   * ordering written here that would have to be kept in step with it.
   * Remembered hubs are the one heading this module names, because it is the
   * one nothing else can: `state/hubs.ts` knows a label and a URL and has no
   * business knowing what the picker calls its own section.
   *
   * A reference with no group falls back to *Built in*, which is what the
   * three shipped shelves were before there were eighteen of them — so a build
   * that hands this table a bare `{id, label, url}` still gets a sane menu.
   *
   * **Ungrouped when there is only one heading and it is not the reader's own**,
   * which is the rule this had before and the reason it had it: an `<optgroup>`
   * over a list with no other part is a heading for nothing. A remembered hub
   * is the exception and keeps its heading whatever else is in the menu,
   * because that heading is what tells a reader which rows are theirs — the
   * ones that offer *forget*, and the ones whose 404 is an honest 404 rather
   * than a sentence about our workflow.
   */
  private paintSelect(): void {
    const held = this.select.value
    const option = (ref: HubRef): HTMLOptionElement =>
      el('option', { value: ref.id, text: ref.label, title: ref.url ?? '' })
    const ordered = new Map<string, HubRef[]>()
    for (const ref of this.props.hubs ?? []) {
      const heading = ref.group ?? 'Built in'
      const shelf = ordered.get(heading)
      if (shelf === undefined) ordered.set(heading, [ref])
      else shelf.push(ref)
    }
    const remembered = rememberedHubs()
    if (remembered.length > 0) ordered.set('Hubs you connected', remembered)

    const groups: HTMLElement[] = []
    if (ordered.size <= 1 && remembered.length === 0) {
      for (const shelf of ordered.values()) groups.push(...shelf.map(option))
    } else {
      for (const [heading, shelf] of ordered) {
        const box = el('optgroup', { attrs: { label: heading } })
        for (const ref of shelf) box.appendChild(option(ref))
        groups.push(box)
      }
    }
    this.select.replaceChildren(
      el('option', { value: '', text: 'choose a hub…' }),
      ...groups,
    )
    // A hub that has been forgotten while it was on screen leaves the selector
    // on the placeholder rather than silently pointing at somebody else's row.
    this.select.value = this.refs().some((ref) => ref.id === held) ? held : ''
  }

  /** Read the typed URL and load it — the "add a hub by URL" gesture. */
  private async loadTyped(): Promise<void> {
    // Canonicalised so a `gs://` or `s3://` shelf is the https URL it stands
    // for before the scheme is judged (§24.5).
    const url = canonicalUrl(this.urlInput.value.trim())
    if (url === '') return
    if (!/^https?:\/\//i.test(url)) {
      this.say(`${url} is not an http(s) URL, so there is nothing to fetch.`, true)
      return
    }
    // A typed hub is a reference like any other, and `builtin: false` is what
    // makes its 404 an honest 404 rather than a sentence about our workflow.
    await this.load({ id: `hub:typed`, label: hubLabelFor(url), url, builtin: false })
  }

  /**
   * Offer to keep the hub on screen, when it was reached by URL and is not kept.
   *
   * Not offered for a built-in (it is already in the menu), not offered for a
   * hub already remembered (the row exists), and not offered at all when the
   * host gave no `onRemember` — a picker in a dialog has nowhere to put the
   * answer.
   */
  private offerRemember(): void {
    this.rememberSlot.replaceChildren()
    const ref = this.ref
    const remember = this.props.onRemember
    if (ref === null || remember === undefined) return
    if (ref.builtin || ref.url === undefined) return
    const kept = readHubRows().find((row) => row.url === ref.url)
    if (kept !== undefined) {
      // The other half of remembering: a hub already in the menu can be taken
      // out of it from the same spot, so the stored-data screen's "forget
      // everything" is not the only way to drop one lab's shelf. The table
      // hears the change back through `subscribeHubs` and repaints its menu.
      this.rememberSlot.appendChild(
        button('forget this hub', () => removeHubRow(kept.id), {
          class: 'btn-link',
          title: 'Take it out of the menu in this browser. Nothing on the host changes.',
        }),
      )
      return
    }
    const url = ref.url
    this.rememberSlot.appendChild(
      button(
        'remember this hub',
        () => {
          // The hub's own name, not the URL-derived label, because by now we
          // have read the file and it says what it is called.
          remember({ ...ref, label: this.hub?.name === '' ? ref.label : (this.hub?.name ?? ref.label), url })
          this.rememberSlot.replaceChildren()
        },
        {
          class: 'btn-link',
          title: 'Keep it in the menu, in this browser. The stored-data screen lists it.',
        },
      ),
    )
  }

  // -------------------------------------------------------------------------
  // The table
  // -------------------------------------------------------------------------

  /** One filter box per column, rebuilt because the columns are the hub's. */
  private buildFilters(hub: Hub): void {
    this.columnFilters = new Map()
    const boxes: HTMLElement[] = [this.filterInput]
    for (const column of hub.columns) {
      const box = el('input', {
        class: 'input input-tiny hub-filter hub-filter-column',
        type: 'text',
        placeholder: column.label,
        attrs: { 'aria-label': `filter by ${column.label}` },
      })
      box.addEventListener('input', () => this.paint())
      this.columnFilters.set(column.key, box)
      boxes.push(box)
    }
    this.filterRow.replaceChildren(...boxes)
  }

  /** The rows that pass every filter, in the order the headers asked for. */
  private shown(hub: Hub): HubEntry[] {
    const needle = this.filterInput.value.trim().toLowerCase()
    const column: Array<[string, string]> = []
    for (const [key, box] of this.columnFilters) {
      const value = box.value.trim().toLowerCase()
      if (value !== '') column.push([key, value])
    }
    const rows = hub.entries.filter((entry) => {
      if (needle !== '') {
        const hay = `${entry.label} ${entry.note ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      for (const [key, value] of column) {
        if (!(entry.fields?.[key] ?? '').toLowerCase().includes(value)) return false
      }
      return true
    })
    const sort = this.sort
    if (sort === null) return rows
    return [...rows].sort((a, b) => sort.dir * compare(a, b, sort.key))
  }

  private paint(): void {
    const hub = this.hub
    if (hub === null) return
    const rows = this.shown(hub)
    const total = hub.entries.length

    const head = el(
      'tr',
      {},
      this.header('Name', NAME),
      this.header('Kind', KIND),
      ...hub.columns.map((column) => this.header(column.label, columnKey(column.key))),
      this.header('Size', SIZE),
      this.header('Note', NOTE),
    )
    // Sliced *after* filtering and sorting, which is the whole of what makes
    // the cap honest: the rows drawn are the first thousand of the answer to
    // the reader's question, not the answer to a question about the first
    // thousand rows.
    const body = el('tbody', {}, ...rows.slice(0, DRAWN).map((entry) => this.row(entry, hub)))
    this.tableBox.replaceChildren(
      el('table', { class: 'hub-grid' }, el('thead', {}, head), body),
    )
    this.tableBox.classList.toggle('hidden', rows.length === 0)
    // The filter row appears with the table and not before it: a row of empty
    // boxes over nothing is a search screen for a catalogue that is not loaded.
    this.filterRow.classList.toggle('hidden', total === 0)
    this.say(note(hub, total, rows.length), false)
  }

  private header(label: string, key: string): HTMLElement {
    const on = this.sort?.key === key
    const cell = el('th', {
      class: on ? 'hub-th hub-th-on' : 'hub-th',
      attrs: { scope: 'col', 'aria-sort': on ? (this.sort?.dir === 1 ? 'ascending' : 'descending') : 'none' },
    })
    cell.appendChild(
      button(
        on ? `${label} ${this.sort?.dir === 1 ? '▲' : '▼'}` : label,
        () => {
          // Second press on the same column reverses it; a different column
          // starts ascending, which is what every table in this app does.
          this.sort =
            this.sort?.key === key
              ? { key, dir: this.sort.dir === 1 ? -1 : 1 }
              : { key, dir: 1 }
          this.paint()
        },
        { class: 'btn-link hub-sort' },
      ),
    )
    return cell
  }

  /**
   * One row. The name is a button and the row is clickable around it.
   *
   * A `<button>` in the name cell rather than `role="button"` on the `<tr>`,
   * because a table row that claims to be a button stops being a row to a
   * screen reader — and because this way Enter, Space and focus are the
   * browser's own rather than three key handlers written here. The row-level
   * click is the convenience: a hand lands anywhere on a 900-pixel line.
   */
  private row(entry: HubEntry, hub: Hub): HTMLElement {
    const pick = (): void => this.props.onPick(entry, hub)
    const name = button(entry.label, pick, { class: 'btn-link hub-name' })
    const row = el(
      'tr',
      { class: 'hub-row' },
      el('td', { class: 'hub-cell hub-cell-name' }, name),
      el(
        'td',
        { class: 'hub-cell' },
        el('span', { class: `hub-badge hub-badge-${entry.kind}`, text: entry.kind }),
      ),
      ...hub.columns.map((column) =>
        el('td', { class: 'hub-cell', text: entry.fields?.[column.key] ?? '' }),
      ),
      el('td', {
        class: 'hub-cell hub-cell-size',
        text: entry.size === undefined ? '' : fmt.bytes(entry.size),
      }),
      el('td', { class: 'hub-cell hub-cell-note', text: entry.note ?? '' }),
    )
    row.addEventListener('click', (event) => {
      // A click that landed on the name button is that button's; without this
      // the row would pick a second time. `Element` rather than `HTMLElement`
      // for the reason `ui/folderBrowse.ts` gives: a glyph inside a button is
      // an `SVGElement`.
      if (event.target instanceof Element && event.target.closest('button') !== null) return
      pick()
    })
    return row
  }

  /** The one line under the selector: loading, a refusal, or the count. */
  private say(text: string, bad: boolean): void {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('hub-error', bad && text !== '')
  }
}

/**
 * What to call a hub nobody has named, from its URL alone.
 *
 * The file name when it has one worth showing, and the host otherwise: a hub at
 * `…/hubs/4dn.json` is "4dn", and one at `https://lab.example.org/` is
 * "lab.example.org". Either beats the forty-character URL in a menu, and both
 * are replaced by the hub's own `name` the moment it has been read.
 */
export function hubLabelFor(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const name = parsed.pathname.split('/').filter((part) => part !== '').pop()
  if (name === undefined || name === '') return parsed.host
  return name.replace(/\.json$/i, '')
}

/**
 * The line under the selector once a hub is showing.
 *
 * Its own function, and pure, so the wording is testable without a DOM — the
 * rule `ui/folderBrowse.ts`'s `note` follows, and for the same reason: "my row
 * is not here" and "my row is filtered out" look identical on screen, and only
 * one of them is something the reader can undo.
 */
export function note(hub: Hub, total: number, showing: number): string {
  if (total === 0) return `${hub.name === '' ? 'This hub' : hub.name} lists nothing.`
  // Drawn before matched, because a reader looking at a thousand rows out of
  // 54,000 needs to be told that the table is not the answer *before* being
  // told how the filters work. Said in both arms below for the same reason: a
  // capped view of an unfiltered hub and a capped view of a filtered one are
  // the same situation to whoever is reading it.
  const capped =
    showing > DRAWN
      ? ` The first ${DRAWN} are drawn; narrow the filters to see the rest.`
      : ''
  if (showing === total) {
    return `${total} ${total === 1 ? 'entry' : 'entries'}.${capped}`
  }
  if (showing === 0) {
    return `Nothing here matches. ${total} ${total === 1 ? 'entry' : 'entries'} in this hub.`
  }
  return (
    `Showing ${showing} of ${total}. The filters narrow what is listed, and fetch nothing.` +
    capped
  )
}

/** Order two entries by one column key. */
function compare(a: HubEntry, b: HubEntry, key: string): number {
  if (key === SIZE) {
    // A row with no size sorts last either way round, because "unknown" is not
    // "zero" and a catalogue half of whose sizes are missing should not open
    // with all of them at one end.
    const left = a.size ?? Number.POSITIVE_INFINITY
    const right = b.size ?? Number.POSITIVE_INFINITY
    return left === right ? 0 : left < right ? -1 : 1
  }
  return text(a, key).localeCompare(text(b, key), undefined, { numeric: true })
}

/** The sortable text of one cell. */
function text(entry: HubEntry, key: string): string {
  if (key === NAME) return entry.label
  if (key === KIND) return entry.kind
  if (key === NOTE) return entry.note ?? ''
  return entry.fields?.[key.slice('c:'.length)] ?? ''
}
