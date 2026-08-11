/**
 * What a deck of panels *is*, as a value: the list, the link, the budget.
 *
 * Everything in this module is pure, and that is the point of its existing
 * apart from {@link PanelDeck}. A deck is the one part of the viewer whose
 * arithmetic can be wrong in a way nobody sees until a laptop swaps — N workers
 * each holding a whole-genome block (§2) is N times a budget that was written
 * for one — and a hash key that does not round-trip is a link that silently
 * shows a different number of maps than the one that was sent. Both are stated
 * here as functions over numbers and strings, so `test/unit/panel-deck.ts` can
 * hold them to it.
 *
 * The deck is **companions plus a lead**. The lead is the session's own file:
 * it owns the breadcrumb, the tables, the tracks and the second-file split, and
 * it is not in this list. A companion is a file and a worker and nothing else.
 * That asymmetry is the same one the two-file comparison makes (§16.5) and it
 * is made for the same reason: exactly one file has to decide what the session
 * is *of*, or the breadcrumb has no subject.
 */

import { LANE_EDGES, type LaneEdge } from '../annotations/types'

/**
 * A **backstop** on how many maps may be on screen at once, lead included.
 *
 * It was six, and six was a judgement about how many maps are useful rather
 * than about what the machine can do — which is the wrong kind of limit to put
 * on a grid a reader draws. A deck is a figure, and a figure is however many
 * panels the figure has: a row of eight replicates, a 4 × 4 of every MAG in a
 * community, a column down one chromosome. Each of those is a legitimate thing
 * to want and none of them fits in six.
 *
 * The real limit was never this number. Every panel is a worker, an h5wasm
 * instance and — for a whole-file view — a dense block held whole, and
 * {@link panelBudgetBytes} already divides this tab's budget by the panel count,
 * so the *reads* get smaller as the deck grows and refuse when a share will not
 * do. That is a limit measured in bytes on the machine in front of the reader,
 * which is the only honest one; a fixed count says no to a sixteenth 400-bin
 * panel on a workstation and yes to a sixth whole-genome one on a phone.
 *
 * So what is left here is a backstop against arithmetic rather than a policy: a
 * hand-edited hash asking for ten thousand cells should be refused before ten
 * thousand workers are started. 64 is an 8 × 8 grid — past any figure and past
 * the point where a panel is a picture rather than a swatch — and every press
 * that reaches it is still answered in the deck's own bar rather than with an
 * error screen.
 */
export const MAX_PANELS = 64

/**
 * The stand-in a link carries where a local file was.
 *
 * `~` because it is legal in a URI fragment, needs no escaping, and is not a
 * character any `file::group` URI begins with, so nothing can be mistaken for
 * it. See {@link serialiseMaps} for why a placeholder is written at all rather
 * than the slot being dropped.
 */
export const VACANT = '~'

/**
 * A companion panel, as the deck holds it.
 *
 * `local` and `vacant` are different states and the difference matters: a local
 * companion is *open*, with a worker and a picture, and merely cannot be put in
 * a link; a vacant one is a link's memory of a local companion, with no bytes
 * behind it and a drop rectangle where its map would be.
 */
export type PanelRef =
  | { kind: 'remote'; uri: string }
  | { kind: 'local'; uri: string }
  | { kind: 'vacant' }

/**
 * The separator between URIs in the `maps` key.
 *
 * **Not a comma**, which is what `genomes` and `regions` use. A comma is a
 * legal character in a URI path and in a query, so `maps=a,b` is ambiguous the
 * first time somebody publishes a file whose name contains one — and the
 * failure is silent: the link resolves, to two maps that are neither of the
 * ones that were sent. RFC 3986 excludes `|` from every part of a URI, so a
 * URI that has been through `encodeURIComponent` never contains a literal one.
 *
 * That last clause is an *invariant this module maintains*, not a fact about the
 * strings that arrive here. `state/ViewState.ts` writes the pipe back readable
 * after encoding the whole hash value, so a member that reached this point
 * carrying a raw one would come out the other side indistinguishable from the
 * separator — a link that resolves, to a different number of maps than were
 * sent. {@link serialiseMaps} escapes it per member so the claim above is true
 * by construction rather than by hope.
 */
export const MAPS_SEPARATOR = '|'

/** The separator as it appears *inside* a member, where it is data. */
const ESCAPED_SEPARATOR = '%7C'

/**
 * The `maps` value for a list of companions, or `undefined` for no key at all.
 *
 * A local companion is written as {@link VACANT} rather than omitted, and that
 * is the whole of "degrades honestly" (§11, §16.6). `uri2` omits its local
 * second file, which is right when there is one slot: its absence says
 * *nothing here*, which is true. With N slots omission moves every companion
 * after it one place to the left, so a link sent from a deck of
 * `[remote, local, remote]` would arrive as a deck of two — the same number of
 * maps a reader would get from a link that had never had the middle one, and no
 * sign anywhere that a map is missing. The placeholder keeps the count, keeps
 * the order, and puts a drop rectangle where the file the sender was looking at
 * should go.
 */
export function serialiseMaps(refs: readonly PanelRef[]): string | undefined {
  if (refs.length === 0) return undefined
  return refs
    .map((ref) =>
      // Only the separator, and only inside a member. Escaping the whole URI
      // would double-encode it and cost the readability the pipe was chosen for
      // — `maps=a.cool|b.cool` is a list at a glance and
      // `maps=http%3A%2F%2F…` is not.
      ref.kind === 'remote' ? ref.uri.split(MAPS_SEPARATOR).join(ESCAPED_SEPARATOR) : VACANT,
    )
    .join(MAPS_SEPARATOR)
}

/**
 * Read a `maps` value back into companions.
 *
 * Empty segments are dropped rather than treated as vacancies, so a
 * hand-trimmed `maps=a||b` is two maps rather than three; a *deliberate*
 * vacancy is spelled, and spelling it is what the round trip preserves.
 */
export function parseMaps(value: string | undefined): PanelRef[] {
  if (value === undefined || value === '') return []
  const refs: PanelRef[] = []
  for (const part of value.split(MAPS_SEPARATOR)) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    refs.push(
      trimmed === VACANT
        ? { kind: 'vacant' }
        : { kind: 'remote', uri: trimmed.split(ESCAPED_SEPARATOR).join(MAPS_SEPARATOR) },
    )
    if (refs.length >= MAX_PANELS - 1) break
  }
  return refs
}

/**
 * `true` when two companion lists name the same files in the same order.
 *
 * Identity of the list, not of the panels: this is what tells a re-render that
 * nothing about the deck moved, so five workers are not put down and rebuilt
 * because a colour changed.
 */
export function sameRefs(a: readonly PanelRef[], b: readonly PanelRef[]): boolean {
  if (a.length !== b.length) return false
  return a.every((ref, index) => {
    const other = b[index]
    return ref.kind === other.kind && (ref.kind === 'vacant' || ref.uri === (other as { uri: string }).uri)
  })
}

/**
 * Exchange two cells of a deck, returning a new list.
 *
 * A **swap** and not an insert, which is the arrangement model (§16.9) showing
 * through: the deck is a rectangle the reader drew, and sliding a map into a
 * cell by shifting every map between here and there would rearrange three
 * pictures to move one. Dropping a map on a cell puts it there and puts
 * whatever was there where it came from — an exchange of two, whatever the
 * distance between them, and a shape that cannot change under the gesture.
 *
 * Out of range is a copy, so a drop that lands nowhere is inert rather than an
 * error.
 */
export function swapItems<T>(items: readonly T[], a: number, b: number): T[] {
  const next = [...items]
  if (a < 0 || b < 0 || a >= next.length || b >= next.length || a === b) return next
  const held = next[a]
  next[a] = next[b]
  next[b] = held
  return next
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * How the panels are arranged.
 *
 * Three, because there are three questions a reader asks of several maps and
 * each has a shape. `row` reads them left to right, which is how a figure
 * compares conditions; `column` stacks them, which is how a narrow window
 * shows two; `grid` is the square arrangement, which is the only one that
 * keeps four maps large enough to see. Not view state — see §16.6: the hash
 * says which maps, and how many columns they are in is furniture, like the
 * width of a side panel.
 */
export type DeckLayout = 'row' | 'column' | 'grid'

export const DECK_LAYOUTS: readonly DeckLayout[] = ['row', 'column', 'grid']

export function isDeckLayout(value: unknown): value is DeckLayout {
  return typeof value === 'string' && (DECK_LAYOUTS as readonly string[]).includes(value)
}

/**
 * Columns in the CSS grid, for `count` panels in this layout.
 *
 * `grid` is the near-square: `ceil(sqrt(n))`, which gives 1, 2, 2, 2, 3, 3 for
 * one to six. Deliberately *not* `floor` — three panels in two columns leaves
 * one alone on a second row, which is a shape a reader reads as "and this other
 * one", and that is exactly what three maps of three conditions are not.
 */
export function columnsFor(count: number, layout: DeckLayout): number {
  const n = Math.max(1, Math.floor(count))
  if (layout === 'column') return 1
  if (layout === 'row') return n
  return Math.ceil(Math.sqrt(n))
}

// ---------------------------------------------------------------------------
// Drawing a deck (§16.9)
// ---------------------------------------------------------------------------

/**
 * Which edge of the maps a reader pressed `+` on.
 *
 * Two words rather than four compass points, because the grid is filled in
 * reading order and those are the only two edges that can grow it without
 * moving what is already in it: a cell opened *beside* the maps is a new
 * column, a cell opened *below* them is a new row, and both leave every map
 * where the reader last saw it.
 */
export type GrowDirection = 'beside' | 'below'

/**
 * The MIME-ish type a map being dragged between cells is carried under.
 *
 * Its own type rather than `text/plain`, so the grid can tell a map apart from
 * a *file* being dropped on it — the two land on the same cells and mean
 * different things, and a `dragover` that cannot tell them apart either
 * highlights a drop target for a track or refuses one for a map.
 */
export const DECK_DRAG_TYPE = 'application/x-metacooler-deck-panel'

/**
 * A deck's shape: how many cells it has, and how many of them are in a row.
 *
 * **Cells**, not maps. That distinction is the whole of §16.9: the reader draws
 * the arrangement first and fills it afterwards, so a deck of one map and three
 * empty cards is a real, publishable, four-cell deck rather than a deck of one
 * with some furniture round it. The empty cards are `vacant` refs
 * ({@link PanelRef}), which is why the same `~` that a link already used for a
 * local companion also carries a cell nobody has dropped anything into yet.
 */
export interface DeckShape {
  /** Cells, lead included, filled and empty alike. */
  cells: number
  /** Cells in a row; the last row may be short after a map is closed. */
  columns: number
}

/**
 * The shape one press of `+` produces.
 *
 * A deck grows by a whole **row or column**, and the arithmetic says why: the
 * grid is a rectangle laid out in reading order, so a single extra cell on the
 * right of a two-row deck is not expressible — it would have to go at the end
 * of the first row, which pushes every map after it one place along. Growing by
 * a full edge is the only move that adds space without rearranging what the
 * reader has already placed.
 *
 * A ragged last row — what closing a map out of the middle leaves behind — is
 * filled in by the same rule rather than preserved: `rows` is counted with
 * `ceil`, so the row that was short becomes a whole one, and the deck is a
 * rectangle again. That is the shape the reader drew, and the holes are drop
 * targets rather than gaps.
 *
 * This says only how many cells and how wide. **Where the maps go is
 * {@link grownPlacement}**, and the two have to be read together: the shape
 * alone is not enough to grow a deck without rearranging it, which is the trap
 * the first attempt at this fell into.
 */
export function grownDeck(shape: DeckShape, direction: GrowDirection): DeckShape {
  const { cells, columns } = clampShape(shape)
  const rows = Math.ceil(cells / columns)
  return direction === 'beside'
    ? { cells: rows * (columns + 1), columns: columns + 1 }
    : { cells: (rows + 1) * columns, columns }
}

/**
 * Which cell each map moves to when the deck grows: old index per new cell.
 *
 * Indices are **flat, in reading order, lead included** — cell 0 is the lead's
 * cell, and `null` is a cell this press opened. Say a 2 × 2 deck grows beside:
 * `[0, 1, null, 2, 3, null]`, which reads as *the first row keeps its two maps
 * and gains a cell, and so does the second*.
 *
 * This exists because {@link grownDeck} is not enough on its own, and the way
 * that goes wrong is worth stating. A deck is one flat list of cells laid into
 * `grid-template-columns: repeat(n, …)`, so a cell's position is *derived* from
 * its index and the column count — cell `k` sits at row `⌊k/n⌋`, column `k mod
 * n`. Raising `n` therefore re-maps every index at once. Growing **below**
 * changes no column count and appending is exactly right; growing **beside**
 * changes it, and appending the new cells at the end reflows the whole deck: a
 * 2 × 2 of four maps becomes a 3-wide row of three with the fourth alone
 * underneath, and the "column of empty cards" the reader pressed for appears
 * along the bottom. A new column has to be *spliced* into the end of each row,
 * which is what this computes.
 *
 * The lead never moves — it is at row 0, column 0, and both growths insert only
 * after a row's existing cells — so `out[0]` is always `0`.
 */
export function grownPlacement(shape: DeckShape, direction: GrowDirection): (number | null)[] {
  const { cells, columns } = clampShape(shape)
  const next = grownDeck({ cells, columns }, direction)
  const out: (number | null)[] = new Array<number | null>(next.cells).fill(null)
  for (let from = 0; from < cells; from++) {
    const row = Math.floor(from / columns)
    const column = from % columns
    out[row * next.columns + column] = from
  }
  return out
}

/** A shape as the two functions above agree to read it, however it arrived. */
function clampShape(shape: DeckShape): DeckShape {
  const cells = Math.max(1, Math.floor(shape.cells))
  return { cells, columns: Math.min(Math.max(1, Math.floor(shape.columns)), cells) }
}

// ---------------------------------------------------------------------------
// Cost (§2, §16.7)
// ---------------------------------------------------------------------------

/**
 * What one panel of `count` may spend on a block.
 *
 * `checkBrowserDenseSize` budgets one block against a share of what the device
 * reports, and it has no idea how many blocks are about to be live. N panels
 * multiply it exactly: five whole-genome coolers is five dense blocks, five
 * rasters and five pooled buffers, all resident, and every one of them passes a
 * guard that was asked about one.
 *
 * So the budget is divided. The deck's whole allowance is one panel's — the
 * allowance the session had before anybody added a second map — and each panel
 * gets an equal share of it. Two consequences, both wanted: the deck can never
 * cost more than the single map it replaced, and **adding a panel makes every
 * panel's allowance smaller**, so the sixth map is refused by arithmetic rather
 * than by a limit somebody had to guess. The refusal is
 * `checkBrowserDenseSize`'s own, with its own numbers in it, so a reader is
 * told what the block costs and what this tab is lending it.
 */
export function panelBudgetBytes(count: number, deviceBudgetBytes: number): number {
  return deviceBudgetBytes / Math.max(1, Math.floor(count))
}

// ---------------------------------------------------------------------------
// Alignment (§16.8)
// ---------------------------------------------------------------------------

/**
 * The room a deck must leave on each edge, given what every panel takes there.
 *
 * The deck's promise is that its pictures are of one place and can be read
 * against each other, which holds only while they are the same size at the same
 * height in their cells. Once a track can be placed on one map and not the next
 * that stops being free: a map with a strip above it stands lower than a map
 * without one, and the eye has to correct for the offset before it can compare
 * anything. So every panel leaves room for the deepest stack in the deck and
 * pads out whatever its own tracks do not fill.
 *
 * A **fold over all the reports at once**, rather than a running maximum kept
 * as they arrive. Panels announce their stacks whenever they change, in
 * whatever order they finish reading their files, and a maximum accumulated in
 * that order is a maximum over whoever has spoken so far — which on the first
 * pass is one panel, and reserves nothing.
 */
export function deepestStacks(
  reports: ReadonlyArray<Readonly<Record<LaneEdge, number>>>,
): Record<LaneEdge, number> {
  const room: Record<LaneEdge, number> = { top: 0, right: 0, bottom: 0, left: 0 }
  for (const report of reports) {
    // Clamped at nothing: a panel that has not laid anything out yet reports a
    // placeholder rather than a thickness, and a negative floor would pull the
    // maps it is meant to line up *out* of line.
    for (const edge of LANE_EDGES) room[edge] = Math.max(room[edge], report[edge] ?? 0)
  }
  return room
}
