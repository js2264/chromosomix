/**
 * Faceted search over a store's rows, with nothing on screen in it.
 *
 * A store is chosen by *narrowing* (§24.1): a reader arrives wanting the
 * bigWigs on GM12878 from one lab, not a list of accessions, and the way every
 * data portal answers that is a rail of facets — one per column, each value
 * with a count, tick what you want — beside a table that shrinks as you tick.
 * ENCODE's matrix is the same thing folded into two dimensions. This module is
 * that arithmetic, over the `StoreEntry[]` the parser hands back, and it is
 * pure so the counts can be pinned in a unit test without a document.
 *
 * ## The two rules the counts follow
 *
 * **Within a facet, ticked values are OR; across facets they are AND.** Ticking
 * *ChIP-seq* and *ATAC-seq* under Assay asks for either; ticking *GRCh38* under
 * Assembly as well asks for either of those on that assembly. This is what
 * every portal does and what a reader expects without being told.
 *
 * **A facet's counts are computed against every other facet.** The number
 * beside an unticked value says how many rows *ticking it would add* — so it
 * ignores this facet's own selection (otherwise every unticked value would read
 * zero the moment one was ticked) and honours everybody else's. A value ticked
 * down to zero rows stays in the list, ticked, so it can be unticked.
 *
 * ## Why the counting is one pass
 *
 * The largest ENCODE shard is 55,000 rows over eight columns, and a rail that
 * recounted every facet by filtering the rows again per facet would be eight
 * passes per keystroke. Instead each row is scored once — how many facets it
 * fails, and which one if it failed exactly one — and both questions are
 * answered from that: a row matches everything when it fails none, and counts
 * toward facet *i* when it fails none or fails only *i*.
 *
 * ## The matrix
 *
 * A pivot of two facets against each other, counting rows that satisfy the
 * text and every facet *except* the two on the axes — the same rule the rail's
 * counts follow, extended to a pair. The axes are capped by population rather
 * than truncated by name, and the caller is told what was left out, because a
 * grid of eight hundred biosamples is not a picture anyone reads.
 *
 * ## The view travels in the query string
 *
 * `?store=encode&assay=ChIP-seq&target=CTCF&view=matrix` is a link to a
 * narrowed store (§24.2), and the facet keys are the store's own column keys, so
 * a link reads the way the rail does. The handful of names the page itself
 * uses are reserved and never read as facets.
 */

import type { StoreColumn, StoreEntry } from './store'

/** Which values are ticked, per column key. An absent key means no filter. */
export type FacetSelection = ReadonlyMap<string, ReadonlySet<string>>

/** How a store is narrowed: free text, and the ticked facets. */
export interface StoreQuery {
  text: string
  facets: FacetSelection
}

/** Everything about a store's presentation that a link carries. */
export interface StoreView extends StoreQuery {
  mode: 'list' | 'matrix'
  /** The matrix's two axes, by column key, when the reader chose them. */
  axes?: readonly [string, string]
}

/** The query that narrows nothing. */
export const EMPTY_QUERY: StoreQuery = { text: '', facets: new Map() }

/** The view a store opens on before anybody has touched it. */
export const EMPTY_VIEW: StoreView = { ...EMPTY_QUERY, mode: 'list' }

/** The value a row has for a column, or `''` when it has none. */
export function valueOf(entry: StoreEntry, key: string): string {
  return entry.fields?.[key] ?? ''
}

/** The label a value with no text is shown under. */
export const UNSPECIFIED = 'unspecified'

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

/** `selection` with `value` ticked or unticked under `key`. */
export function toggleFacet(selection: FacetSelection, key: string, value: string): FacetSelection {
  const next = new Map(selection)
  const held = new Set(next.get(key) ?? [])
  if (held.has(value)) held.delete(value)
  else held.add(value)
  if (held.size === 0) next.delete(key)
  else next.set(key, held)
  return next
}

/** `selection` with `key` set to exactly `values`, or cleared when there are none. */
export function setFacet(
  selection: FacetSelection,
  key: string,
  values: Iterable<string>,
): FacetSelection {
  const next = new Map(selection)
  const held = new Set(values)
  if (held.size === 0) next.delete(key)
  else next.set(key, held)
  return next
}

/** `selection` with nothing ticked under `key`. */
export function clearFacet(selection: FacetSelection, key: string): FacetSelection {
  if (!selection.has(key)) return selection
  const next = new Map(selection)
  next.delete(key)
  return next
}

/** Whether `value` is ticked under `key`. */
export function isTicked(selection: FacetSelection, key: string, value: string): boolean {
  return selection.get(key)?.has(value) ?? false
}

/** How many values are ticked, over every facet. */
export function tickedCount(selection: FacetSelection): number {
  let n = 0
  for (const values of selection.values()) n += values.size
  return n
}

/** `true` when the query narrows nothing. */
export function isEmptyQuery(query: StoreQuery): boolean {
  return query.text.trim() === '' && tickedCount(query.facets) === 0
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * The words a text box asks for, lower-cased.
 *
 * Every word must appear somewhere on the row — its label, its note or any of
 * its cells — so `ctcf gm12878` finds a CTCF ChIP on GM12878 whether the cell
 * line is in the label or in the Biosample column. A single substring would
 * have made the order the reader typed the words in matter.
 */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((word) => word !== '')
}

/** Everything searchable on one row, lower-cased and joined once. */
function haystack(entry: StoreEntry): string {
  const cells = entry.fields === undefined ? '' : Object.values(entry.fields).join(' ')
  return `${entry.label} ${entry.note ?? ''} ${cells}`.toLowerCase()
}

function matchesText(entry: StoreEntry, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const hay = haystack(entry)
  return words.every((word) => hay.includes(word))
}

/**
 * The facets that actually apply to these columns, as `[key, values]` pairs.
 *
 * A selection may name a key the store has no column for — a link written
 * against last week's columns, or a key another view of the same store uses
 * for itself — and such a key must narrow nothing rather than everything: a
 * facet nobody can see or untick is a filter nobody can undo.
 */
function applicable(
  facets: FacetSelection,
  columns: readonly StoreColumn[],
): Array<[string, ReadonlySet<string>]> {
  const out: Array<[string, ReadonlySet<string>]> = []
  for (const column of columns) {
    const values = facets.get(column.key)
    if (values !== undefined && values.size > 0) out.push([column.key, values])
  }
  return out
}

/** The rows matching the text and every applicable facet. */
export function select(
  entries: readonly StoreEntry[],
  columns: readonly StoreColumn[],
  query: StoreQuery,
): StoreEntry[] {
  const words = wordsOf(query.text)
  const facets = applicable(query.facets, columns)
  return entries.filter(
    (entry) =>
      matchesText(entry, words) &&
      facets.every(([key, values]) => values.has(valueOf(entry, key))),
  )
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** One value of one facet: how many rows it stands for, and whether it is ticked. */
export interface FacetCount {
  value: string
  count: number
  on: boolean
}

/**
 * The counts of every facet, each computed against every *other* facet.
 *
 * Ordered by count and then by value, ticked values first so the reader sees
 * what they asked for at the top of a long list. A ticked value with no rows
 * left stays, at zero, because it has to be untickable.
 */
export function facetCounts(
  entries: readonly StoreEntry[],
  columns: readonly StoreColumn[],
  query: StoreQuery,
): Map<string, FacetCount[]> {
  const words = wordsOf(query.text)
  const keys = columns.map((column) => column.key)
  const selections = keys.map((key) => {
    const values = query.facets.get(key)
    return values === undefined || values.size === 0 ? null : values
  })
  const tallies = keys.map(() => new Map<string, number>())

  for (const entry of entries) {
    if (!matchesText(entry, words)) continue
    // Score the row once: how many facets it fails, and which one if exactly one.
    let failed = 0
    let failedAt = -1
    for (let i = 0; i < keys.length; i++) {
      const wanted = selections[i]
      if (wanted === null) continue
      if (!wanted.has(valueOf(entry, keys[i]))) {
        failed++
        failedAt = i
        if (failed > 1) break
      }
    }
    if (failed > 1) continue
    for (let i = 0; i < keys.length; i++) {
      // Counts toward facet i when it passes everything, or fails only i.
      if (failed === 1 && failedAt !== i) continue
      const tally = tallies[i]
      const value = valueOf(entry, keys[i])
      tally.set(value, (tally.get(value) ?? 0) + 1)
    }
  }

  const out = new Map<string, FacetCount[]>()
  keys.forEach((key, i) => {
    const ticked = selections[i]
    const rows: FacetCount[] = []
    for (const [value, count] of tallies[i]) {
      rows.push({ value, count, on: ticked?.has(value) ?? false })
    }
    // Ticked values with no rows left — a second facet took them all — are
    // listed at zero rather than dropped, so they can be unticked.
    if (ticked !== null) {
      for (const value of ticked) {
        if (!tallies[i].has(value)) rows.push({ value, count: 0, on: true })
      }
    }
    rows.sort(compareCounts)
    out.set(key, rows)
  })
  return out
}

/** Ticked first, then the most populous, then by name — with "unspecified" last. */
function compareCounts(a: FacetCount, b: FacetCount): number {
  if (a.on !== b.on) return a.on ? -1 : 1
  if ((a.value === '') !== (b.value === '')) return a.value === '' ? 1 : -1
  if (a.count !== b.count) return b.count - a.count
  return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' })
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export interface Pivot {
  /** The row axis's values, most populous first, capped. */
  rows: string[]
  /** The column axis's values, likewise. */
  cols: string[]
  /** `counts.get(row)?.get(col)`: rows on that cell, or absent for none. */
  counts: Map<string, Map<string, number>>
  /** How many distinct values each axis had before the cap. */
  rowValues: number
  colValues: number
  /** Rows counted anywhere in the grid, before the caps. */
  total: number
}

export interface PivotOptions {
  maxRows?: number
  maxCols?: number
}

/** How much of a grid is drawn before the reader is asked to narrow. */
export const PIVOT_MAX_ROWS = 60
export const PIVOT_MAX_COLS = 24

/**
 * The matrix of `rowKey` against `colKey`.
 *
 * Counted over the rows that satisfy the text and every facet other than the
 * two axes, which is the rail's own rule extended to a pair: a cell says how
 * many rows ticking *both* of its values would give you, whatever is ticked
 * on either axis now. The axes are ordered by their totals and capped, with
 * the uncapped sizes reported beside them so the view can say what it left
 * out.
 */
export function pivot(
  entries: readonly StoreEntry[],
  columns: readonly StoreColumn[],
  query: StoreQuery,
  rowKey: string,
  colKey: string,
  options: PivotOptions = {},
): Pivot {
  const words = wordsOf(query.text)
  const facets = applicable(query.facets, columns).filter(
    ([key]) => key !== rowKey && key !== colKey,
  )
  const counts = new Map<string, Map<string, number>>()
  const rowTotals = new Map<string, number>()
  const colTotals = new Map<string, number>()
  let total = 0
  for (const entry of entries) {
    if (!matchesText(entry, words)) continue
    if (!facets.every(([key, values]) => values.has(valueOf(entry, key)))) continue
    const row = valueOf(entry, rowKey)
    const col = valueOf(entry, colKey)
    let held = counts.get(row)
    if (held === undefined) {
      held = new Map()
      counts.set(row, held)
    }
    held.set(col, (held.get(col) ?? 0) + 1)
    rowTotals.set(row, (rowTotals.get(row) ?? 0) + 1)
    colTotals.set(col, (colTotals.get(col) ?? 0) + 1)
    total++
  }
  const byTotal = (totals: Map<string, number>): string[] =>
    [...totals.entries()]
      .sort((a, b) => {
        // "unspecified" sinks whatever its count: it is the absence of a value
        // and belongs at the edge of the picture, not in the middle of it.
        if ((a[0] === '') !== (b[0] === '')) return a[0] === '' ? 1 : -1
        if (a[1] !== b[1]) return b[1] - a[1]
        return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
      })
      .map(([value]) => value)
  const rows = byTotal(rowTotals)
  const cols = byTotal(colTotals)
  return {
    rows: rows.slice(0, options.maxRows ?? PIVOT_MAX_ROWS),
    cols: cols.slice(0, options.maxCols ?? PIVOT_MAX_COLS),
    counts,
    rowValues: rows.length,
    colValues: cols.length,
    total,
  }
}

// ---------------------------------------------------------------------------
// The query string
// ---------------------------------------------------------------------------

/**
 * The parameter names a page uses for itself, which a facet may not be called.
 *
 * `store` names the store, `q` the text, `view` and `axes` the presentation,
 * and `embed`, `config` and `edges` are the page's own mounting parameters
 * (§21.1, §7.3). A store whose column happens to be called `view` cannot be
 * linked on that column; it can still be ticked.
 */
export const RESERVED_PARAMS: ReadonlySet<string> = new Set([
  'store',
  'q',
  'view',
  'axes',
  'embed',
  'config',
  'edges',
])

/**
 * Read a view out of a query string's parameters.
 *
 * Every parameter that is not reserved is read as a facet — `assay=ChIP-seq`,
 * repeated for each ticked value — because at the moment a page mounts, the
 * store's columns are not known yet: the keys are believed and the store's
 * view later ignores the ones it has no column for (`select`). An empty value
 * ticks `''`, which is the row that says nothing in that column.
 */
export function readStoreView(params: URLSearchParams): StoreView {
  const facets = new Map<string, Set<string>>()
  for (const key of new Set(params.keys())) {
    if (RESERVED_PARAMS.has(key)) continue
    const values = params.getAll(key)
    if (values.length === 0) continue
    facets.set(key, new Set(values))
  }
  const axesRaw = params.get('axes')
  const parts = axesRaw === null ? [] : axesRaw.split(',').map((part) => part.trim())
  const axes: readonly [string, string] | undefined =
    parts.length === 2 && parts[0] !== '' && parts[1] !== '' && !RESERVED_PARAMS.has(parts[0]) && !RESERVED_PARAMS.has(parts[1])
      ? [parts[0], parts[1]]
      : undefined
  return {
    text: params.get('q') ?? '',
    facets,
    mode: params.get('view') === 'matrix' ? 'matrix' : 'list',
    ...(axes === undefined ? {} : { axes }),
  }
}

/**
 * Write a view into `params`, replacing the view that was there.
 *
 * `q`, `view`, `axes` and every key in `stale` — the facets the previous write
 * put there, which the caller remembers — are cleared first, so unticking a
 * value takes it out of the link. Everything else is left exactly as it was:
 * `store`, the page's own mounting parameters, and any parameter somebody
 * else's deployment put in the address. Nothing is written for the parts of a
 * view that are the default, so an untouched store links as `?store=x` and
 * nothing more.
 */
export function writeStoreView(
  params: URLSearchParams,
  view: StoreView,
  stale: Iterable<string> = [],
): void {
  for (const key of ['q', 'view', 'axes', ...stale]) params.delete(key)
  const text = view.text.trim()
  if (text !== '') params.set('q', text)
  for (const [key, values] of view.facets) {
    if (RESERVED_PARAMS.has(key)) continue
    for (const value of [...values].sort()) params.append(key, value)
  }
  if (view.mode === 'matrix') params.set('view', 'matrix')
  if (view.axes !== undefined) params.set('axes', `${view.axes[0]},${view.axes[1]}`)
}
