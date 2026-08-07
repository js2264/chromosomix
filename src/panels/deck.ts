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

/**
 * How many maps may be on screen at once, lead included.
 *
 * The same argument `MAX_SESSIONS` makes, at a smaller number, because these
 * are all live at once rather than one at a time: every panel is a worker, an
 * h5wasm instance and — for a whole-file view — a dense block held whole.
 * Six is more than any figure has panels in it and well short of what makes a
 * tab unresponsive. Above it, {@link panelBudgetBytes} would in any case be
 * refusing the reads.
 */
export const MAX_PANELS = 6

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
 * URI that has been through `encodeURIComponent` never contains a literal one,
 * and the split cannot be wrong.
 */
export const MAPS_SEPARATOR = '|'

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
    .map((ref) => (ref.kind === 'remote' ? ref.uri : VACANT))
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
    refs.push(trimmed === VACANT ? { kind: 'vacant' } : { kind: 'remote', uri: trimmed })
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
 * Move the item at `from` to `to`, returning a new list.
 *
 * Generic because the deck reorders two lists that must never disagree — the
 * refs it publishes to the hash and the live slots it holds — and one function
 * over both is the only way that is structurally true rather than promised. An
 * out-of-range move is a copy, so a `◀` on the first panel is inert rather than
 * an error.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
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
