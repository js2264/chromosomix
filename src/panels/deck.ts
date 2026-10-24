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
import type { Transform } from '../types'

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
  // A cell that is not a map (§25, §16.11). A **structure** cell draws the
  // session's 3D model beside the maps; a **tracks** cell draws the session's
  // tracks alone, on one axis, as the 1D browser does. Neither has a file of
  // its own to name: the structure is a row of the session's track list and
  // the tracks are that list, so the link carries a word rather than a URI.
  | { kind: 'structure' }
  | { kind: 'tracks' }

/** What a structure cell is written as in the `maps` key. */
export const STRUCTURE_REF = '3d'

/** What a tracks cell is written as in the `maps` key. */
export const TRACKS_REF = 'tracks'

/**
 * What a tracks cell's lanes are kept under, where a map's are kept under its
 * file: `tracks:1` for the first tracks cell from the left, `tracks:2` for the
 * second (§16.11).
 *
 * A lane is remembered against the file of the map it was drawn on
 * (`AnnotationStore.parkedFor`), because a slot id is minted per deck and names
 * nothing after a reload. A tracks cell has no file, so a track placed on one
 * was written nowhere: a reload, or a workspace opened again, brought the cell
 * back empty and the track on no picture at all. The cell's **seat** — which
 * tracks cell it is, counting from the left — is the one thing about it that
 * survives, and it is already what its name and its height are remembered by.
 *
 * Spelled with a scheme so that nothing reads it as a path: a workspace
 * resolves every relative name against its own address (`resolveConfig`),
 * and `tracks` alone would have become `<bucket>/tracks`.
 */
export function tracksCellKey(seat: number): string {
  return `${TRACKS_REF}:${seat + 1}`
}

/** Whether a lane's key names a tracks cell (see {@link tracksCellKey}) rather than a file. */
export function isTracksCellKey(uri: string): boolean {
  return /^tracks:[1-9]\d*$/.test(uri)
}

/** Whether a ref names a map — a file with a worker behind it. */
export function isMapRef(ref: PanelRef): ref is { kind: 'remote' | 'local'; uri: string } {
  return ref.kind === 'remote' || ref.kind === 'local'
}

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
      ref.kind === 'remote'
        ? ref.uri.split(MAPS_SEPARATOR).join(ESCAPED_SEPARATOR)
        : ref.kind === 'structure'
          ? STRUCTURE_REF
          : ref.kind === 'tracks'
            ? TRACKS_REF
            : VACANT,
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
    // A structure cell **may be repeated**, as a tracks cell always could. It
    // used to be one per deck, and then one per model, on the reasoning that
    // two cells of one row are one picture drawn twice — which is only true
    // while the two are the same picture. They are not: each cell has its own
    // camera, its own height and its own turn (§25.3), so two cells of one
    // model are two views of it, which is the usual way anybody looks at a
    // fold. The mirrors and the planted axes are the model's, kept on its row,
    // so both views share them. Which model each seat draws is this session's
    // own memory, beside the local companions and for the same reason
    // (`deck:models`).
    refs.push(
      trimmed === VACANT
        ? { kind: 'vacant' }
        : trimmed === STRUCTURE_REF
          ? { kind: 'structure' }
          : trimmed === TRACKS_REF
            ? { kind: 'tracks' }
            : { kind: 'remote', uri: trimmed.split(ESCAPED_SEPARATOR).join(MAPS_SEPARATOR) },
    )
    if (refs.length >= MAX_PANELS - 1) break
  }
  return refs
}

/**
 * A local companion, by the place it sits in the deck.
 *
 * By **index** and not by name, because the index is what `maps` preserves: a
 * local companion is written as {@link VACANT}, so the hash already says *there
 * is a panel here and it is not one you can open*. This says which file that was
 * on the machine it was written on.
 */
export interface DeckLocal {
  index: number
  uri: string
}

/**
 * The local companions of a deck, for a session's own private memory.
 *
 * **Not for the hash, and this is the whole reason the pair below exists rather
 * than a change to {@link serialiseMaps}.** The `~` placeholder is a promise to
 * a *recipient* (§16.6): it keeps the count and the order so a shared link
 * arrives with a drop rectangle where the sender's file was, rather than
 * silently one map short. Spelling the file name into the hash instead would
 * post a private filename to a stranger — which `state/shareLink.ts` already
 * refuses to do — and their deck would try to *fetch* it, against the site root
 * on the web and against `app://viewer/` in the desktop build.
 *
 * So the name lives beside the hash, in this session's own memory, where it is
 * as private as the file it names.
 */
export function localCompanions(refs: readonly PanelRef[]): DeckLocal[] {
  const locals: DeckLocal[] = []
  for (const [index, ref] of refs.entries()) {
    if (ref.kind === 'local') locals.push({ index, uri: ref.uri })
  }
  return locals
}

/**
 * Put remembered local companions back into a list parsed from the hash.
 *
 * A vacancy at a remembered index becomes a local companion again; everything
 * else is left exactly as it came. **Only a vacancy** is promoted, which is what
 * makes a stale record harmless rather than dangerous: a remembered index that
 * now holds a remote map cannot displace it, and an index past the end of the
 * list is dropped. Both failures degrade to today's behaviour — a drop
 * rectangle where a map was — rather than to a new one.
 */
export function withLocalCompanions(
  refs: readonly PanelRef[],
  locals: readonly DeckLocal[] | undefined,
): PanelRef[] {
  if (locals === undefined || locals.length === 0) return [...refs]
  const next = [...refs]
  for (const local of locals) {
    if (!Number.isInteger(local.index) || local.index < 0 || local.index >= next.length) continue
    if (typeof local.uri !== 'string' || local.uri === '') continue
    if (next[local.index].kind !== 'vacant') continue
    next[local.index] = { kind: 'local', uri: local.uri }
  }
  return next
}

/**
 * How one companion was *drawn*, written down.
 *
 * The deck's own doctrine says the view is shared and the presentation is not
 * (see the module head of `panels/PanelDeck.ts`): every panel takes the region,
 * the level and the score from the lead, and every panel owns its transform, its
 * ramp, its clip and — since a companion gained a picker of its own — the score
 * it reads instead of the deck's. All of that is a decision a reader makes per
 * map, and until now none of it survived closing the window.
 *
 * That absence was the loudest one in a saved workspace. A deck of four
 * replicates each clipped to its own depth is *the* thing a deck is arranged
 * for, and restoring it put all four back on the lead's clip — a legal deck, a
 * plausible-looking one, and not the figure that was saved.
 *
 * ## Keyed by the file, never by the slot
 *
 * The same key {@link DeckLocal} and `StoredLane` use, and for the same reason:
 * a slot id is minted per deck (`PanelDeck`'s `nextSlotId`), so an id written
 * down today names nothing tomorrow. What a reader means by "that map" is the
 * file it was showing.
 *
 * A consequence worth stating rather than discovering: **one file open twice in
 * one deck has one look.** That is a legitimate deck — the plainest way to read
 * one map at two colour scales — and it comes back at whichever of the two clips
 * was written last. Keying on the slot would restore both and lose both the next
 * time the deck was rebuilt, which is the worse half of the trade.
 *
 * Every field is optional because every field is an *override*: a companion that
 * says nothing about its transform follows the lead, which is what a fresh one
 * has always done ({@link MapPanelProps.initialLook}).
 */
export interface DeckLook {
  uri: string
  transform?: Transform
  colormap?: string
  vmin?: number
  vmax?: number
  /**
   * The score this panel reads instead of the deck's (`MapPanel.scoreOverride`).
   *
   * Sticky by design: once a reader has said what this map's cells are, the
   * deck's later choices are the deck's business — so it is exactly the kind of
   * decision a workspace has to carry, or reopening one silently re-imposes the
   * lead's score on a companion the reader had taken off it.
   */
  score?: string
  /**
   * Whether this map divides by its distance baseline, and its smoothing token
   * (`MapPanel.expectedOwn`, `smoothOwn`) — each map's own since the *Map* card
   * sets the starred map alone (§16.2), and remembered for the score's reason.
   */
  oe?: boolean
  smooth?: string
  /**
   * This map's reading along the arms (`MapPanel.armsOwn`, §8.15): the window in
   * bins while it divides by the decay along both arms — `0` the whole
   * sequence — and `null` while it does not, which is a choice as much as a
   * window is. Absent follows the first map.
   */
  arms?: number | null
  /**
   * The window this map reads for itself rather than the deck's
   * (`MapPanel.ownPlace`, §16.3) — kept only beside `locked: false`, since a
   * window of its own is what an open chain is for.
   */
  place?: { rows: string; cols?: string }
  /**
   * Whether the chain on this panel's heading was closed.
   *
   * `false` is the interesting value and the only one that is written: a panel
   * off the lead is a panel the reader deliberately unhooked, and a restore that
   * hooked it back would move the picture on the first pan.
   */
  locked?: boolean
}

/** The transforms a stored look may name; anything else is not one this build has. */
const TRANSFORMS: readonly Transform[] = ['log1p', 'log10', 'log2', 'none']

/**
 * Untrusted, like every other stored shape: checked field by field.
 *
 * A member that fails is dropped and its neighbours are kept, which is
 * `parseWorkspaceFile`'s rule one level down: three companions with their clips
 * and one corrupt record is three companions, not a deck that refuses to open.
 * A field that fails takes only itself, for the same reason — a look with an
 * unreadable `vmax` is still a look that names a colormap.
 */
export function isDeckLook(value: unknown): value is DeckLook {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row['uri'] === 'string' && row['uri'] !== ''
}

/** One stored look with every field this build cannot read left out. */
export function readDeckLook(value: unknown): DeckLook | null {
  if (!isDeckLook(value)) return null
  const row = value as unknown as Record<string, unknown>
  const number = (key: string): number | undefined =>
    typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : undefined
  const vmin = number('vmin')
  const vmax = number('vmax')
  const transform = row['transform']
  const colormap = row['colormap']
  const score = row['score']
  return {
    uri: row['uri'] as string,
    ...(TRANSFORMS.includes(transform as Transform) ? { transform: transform as Transform } : {}),
    ...(typeof colormap === 'string' && colormap !== '' ? { colormap } : {}),
    ...(vmin === undefined ? {} : { vmin }),
    ...(vmax === undefined ? {} : { vmax }),
    ...(typeof score === 'string' && score !== '' ? { score } : {}),
    ...(typeof row['oe'] === 'boolean' ? { oe: row['oe'] } : {}),
    ...(typeof row['smooth'] === 'string' && row['smooth'] !== '' ? { smooth: row['smooth'] as string } : {}),
    ...(row['arms'] === null
      ? { arms: null }
      : Number.isInteger(row['arms']) && (row['arms'] as number) >= 0
        ? { arms: row['arms'] as number }
        : {}),
    ...(placeOf(row['place']) === null ? {} : { place: placeOf(row['place']) as { rows: string; cols?: string } }),
    ...(typeof row['locked'] === 'boolean' ? { locked: row['locked'] } : {}),
  }
}

/** A stored own window, field by field, or `null` where it is not one. */
function placeOf(value: unknown): { rows: string; cols?: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row['rows'] !== 'string' || row['rows'] === '') return null
  return {
    rows: row['rows'],
    ...(typeof row['cols'] === 'string' && row['cols'] !== '' ? { cols: row['cols'] } : {}),
  }
}

/**
 * What a map's star says, filled or empty (§16.5, §18.2).
 *
 * One function for the first map's star and every companion's, because they
 * are one radio drawn as several. A filled star is **live**: pressing it
 * leaves no map starred, which is the state in which the *Map* card sets every
 * map and no task that reads a map runs — so the sentence on it says both.
 */
export function mapStarTitle(name: string, on: boolean): string {
  return on
    ? `${name} is starred: the Map card sets it and the analyses run on it. ` +
        'Click to unstar — the card then sets every map, and only the 1D tasks can run.'
    : `Star ${name}: the Map card then sets it, and the analyses run on it.`
}

/**
 * The looks of a list, with one file's replaced.
 *
 * A helper rather than three lines at each call site because the *keying* is the
 * rule — one entry per file — and a caller that pushed instead of replacing
 * would grow the record by one member per nudge of a colour slider.
 */
export function withLook(looks: readonly DeckLook[], look: DeckLook): DeckLook[] {
  return [...looks.filter((held) => held.uri !== look.uri), look]
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
    if (ref.kind !== other.kind) return false
    return !isMapRef(ref) || ref.uri === (other as { uri: string }).uri
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

/**
 * Where the session's own cell stands in its deck, whether it is on screen
 * (§16.9), and whether it is following the deck's navigation (§16.3).
 *
 * The lead is the session's view re-parented into the grid rather than a
 * companion, so it has no member in `maps` — and it used to have no place
 * either: cell 0, always, with no grip and no ×, because "which file is this
 * session of" is not a thing a drag should change. Nor does moving it change
 * that: the session is of the same file afterwards, under the same breadcrumb.
 * What a reader arranging a figure wanted was the *picture* somewhere else, or
 * gone — a model beside the map, read alone — and a cell that could do neither
 * was the one cell of the deck that was not like the others.
 *
 * Kept in the session's memory beside the column count, not in the hash, for
 * the column count's reason: `maps` says *which* cells a deck holds, and where
 * each one stands is arrangement.
 */
export interface DeckLead {
  /** Its place in reading order among every cell of the deck, its own included. */
  at: number
  /**
   * Taken off the screen by its × — alive, and still what the others follow,
   * parked behind the grid — until its eye or the deck's bar puts it back.
   */
  hidden: boolean
  /**
   * Whether the chain on its heading was closed.
   *
   * A companion's is kept with its look (`DeckLook.locked`) and the first
   * map's is kept here, beside its place, on the same terms: `false` is the
   * one value written, since a first map the reader took off the deck is one
   * they deliberately set moving on its own, and a reload that chained it
   * again would carry every other map with it on its first pan.
   */
  locked?: boolean
}

/**
 * A stored {@link DeckLead}, checked like input, or `null`.
 *
 * Stored state outlives the code that wrote it (§8.6). A place that is not a
 * whole number from 0 is no place; one past the end of the deck it comes back
 * to is clamped where the two meet ({@link withLead}), since only there is the
 * deck's length known.
 */
export function readDeckLead(value: unknown): DeckLead | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const at = row['at']
  if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) return null
  return {
    at: Math.min(at, MAX_PANELS - 1),
    hidden: row['hidden'] === true,
    ...(row['locked'] === false ? { locked: false } : {}),
  }
}

/**
 * A deck's cells in reading order: the companions, with the lead put back at
 * its place — at the end, where a deck came back shorter than it was left.
 */
export function withLead<T, L>(cells: readonly T[], lead: L, at: number): Array<T | L> {
  const place = Math.max(0, Math.min(Math.floor(at), cells.length))
  return [...cells.slice(0, place), lead, ...cells.slice(place)]
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
export const DECK_DRAG_TYPE = 'application/x-chromosomix-deck-panel'

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
 * Indices are **flat, in reading order, lead included** — wherever the lead's
 * cell stands (§16.9) — and `null` is a cell this press opened. Say a 2 × 2
 * deck grows beside:
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
 * Nothing already placed changes row or column — both growths insert only
 * after a row's existing cells — so `out[0]` is always `0`, and a lead that
 * was moved stays in the cell the reader moved it to.
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

// ---------------------------------------------------------------------------
// Pointing (§16.3)
// ---------------------------------------------------------------------------

/**
 * Where a place pointed at on one panel's axis lands on another's.
 *
 * The deck's currency is **base pairs from each block's own start**, never
 * cells, and this is that rule written down for the one case where getting it
 * wrong is invisible: a 1 kb file and a 5 kb file answer the same region with
 * blocks of different cell counts, and a **turned** panel counts its columns in
 * half bins on top of that (`render/rotate.ts`). A unit carried across untouched
 * lands at half the position on a band beside a square, or at twice it the other
 * way — a mark that is confidently in the wrong place, which is worse than no
 * mark at all.
 *
 * Fractional out as well as in. What is being carried is a *position*, not a
 * cell: rounding it onto a cell boundary would move the mark by half a bin on
 * the coarser panel, which is visible at the zoom a reader hovers a track at,
 * and buys nothing since nothing indexes an array with it.
 *
 * `null` is **nothing here** — off the end of a shorter block — and not the
 * nearest edge. A mark clamped to the last cell would say the pointer is over a
 * place this file has, which is the one claim a deck must never make.
 */
export function carriedUnit(
  at: { unit: number; bpPerCell: number },
  theirs: { bpPerCell: number; cells: number },
): number | null {
  if (!Number.isFinite(at.unit)) return null
  const bp = at.unit * at.bpPerCell
  const unit = bp / (theirs.bpPerCell > 0 ? theirs.bpPerCell : 1)
  return unit >= 0 && unit <= theirs.cells ? unit : null
}
