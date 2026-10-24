/**
 * View state, its URL-hash representation, and the store that notifies the UI.
 *
 * Spec §5.5: the full view state serialises to the URL hash, so every view is a
 * link — a genome, a genome pair, a region, with its transform and colour
 * limits. That only holds if the round trip is lossless, so
 * `parseViewState(serialiseViewState(s))` is required to deep-equal `s`, and
 * the serialiser is written for that property rather than for brevity:
 *
 * - keys with no value are *omitted* rather than written empty, so a parsed
 *   state has no `undefined`-valued properties that a strict deep-equal would
 *   trip on;
 * - a key that *is* present but empty (`genome=`) round-trips as `''`;
 * - numbers go through `String`/`Number`, which is exact for IEEE doubles.
 *
 * Values that are not part of the type (a hand-edited `view=banana`) are
 * dropped rather than repaired: a shared link that names a view this build does
 * not have should land on the genomes table, not on a broken screen.
 */

import { isCompareOp } from '../render/compare'
import { parseSmooth } from '../render/smooth'
import { contigOf } from '../ui/labels'
import type { Transform, ViewKind, ViewState } from '../types'

const VIEW_KINDS: ViewKind[] = [
  'genomes',
  'cells',
  'contigs',
  'genome',
  'pair',
  'region',
  'whole',
  'overview',
  'selection',
  'browser',
]
const LEVELS = ['bin', 'contig', 'genome'] as const
const TRANSFORMS: Transform[] = ['log1p', 'log10', 'log2', 'none']

/** Serialisation order — stable so two equal states produce equal strings. */
const KEY_ORDER = [
  'uri',
  'uri2',
  'maps',
  'view',
  'genome',
  'genome2',
  'genomes',
  'region',
  'region2',
  'focus',
  'regions',
  'cells',
  'contacts',
  'locus',
  'level',
  'coarsen',
  'transform',
  'colormap',
  'vmin',
  'vmax',
  'balance',
  'score',
  'oe',
  'arms',
  'smooth',
  'op',
  'flip',
  'lower',
  'score2',
  'oe2',
  'smooth2',
  'transform2',
  'colormap2',
  'vmin2',
  'vmax2',
] as const

/** The keys a patch may remove; `uri` and `view` always exist. */
const OPTIONAL_KEYS = [
  'uri2',
  'maps',
  'genome',
  'genome2',
  'genomes',
  'region',
  'region2',
  'focus',
  'regions',
  'cells',
  'contacts',
  'locus',
  'level',
  'coarsen',
  'transform',
  'colormap',
  'vmin',
  'vmax',
  'balance',
  'score',
  'oe',
  'arms',
  'smooth',
  'op',
  'flip',
  'lower',
  'score2',
  'oe2',
  'smooth2',
  'transform2',
  'colormap2',
  'vmin2',
  'vmax2',
] as const

/**
 * Percent-encode a value, then put back the characters that are legal in a
 * fragment and make the hash readable. `&` and `=` stay encoded, which is what
 * keeps the split unambiguous.
 */
function encode(value: string): string {
  // `,` joins the names of a selection and separates the thousands of a locus,
  // so it is in roughly half the links this app produces; leaving it as `%2C`
  // made `genomes=MAG_1%2CMAG_2` and `locus=IV:400%2C000-460%2C000` out of two
  // strings a reader would otherwise recognise at a glance. It is legal in a
  // fragment and it is not one of the two characters the split depends on.
  //
  // `|` joins the panels of a deck (§16.6) and is here for the opposite reason
  // to the comma's: it was chosen *because* RFC 3986 excludes it from URIs, so
  // it cannot occur inside one of the values it separates. Left readable for
  // the same reason the comma is — `maps=a.cool|b.cool` is a list at a glance
  // and `maps=a.cool%7Cb.cool` is not — and safely, since a URI that reaches
  // here containing one has already been escaped by `encodeURIComponent`.
  return encodeURIComponent(value)
    .replace(/%2F/g, '/')
    .replace(/%3A/g, ':')
    .replace(/%2C/g, ',')
    .replace(/%7C/g, '|')
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Serialise to the hash body (no leading `#`). */
export function serialiseViewState(state: ViewState): string {
  const parts: string[] = []
  for (const key of KEY_ORDER) {
    const value = state[key]
    if (value === undefined) continue
    parts.push(`${key}=${encode(typeof value === 'number' ? String(value) : String(value))}`)
  }
  return parts.join('&')
}

/**
 * Parse a hash (with or without the leading `#`) back into a view state.
 *
 * Returns `null` when there is no `uri` — an empty or foreign hash means "no
 * file", which is the file picker, not an error.
 */
export function parseViewState(hash: string): ViewState | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  if (body === '') return null

  const raw = new Map<string, string>()
  for (const part of body.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const key = eq < 0 ? part : part.slice(0, eq)
    const value = eq < 0 ? '' : part.slice(eq + 1)
    raw.set(decode(key), decode(value))
  }

  const uri = raw.get('uri')
  if (uri === undefined) return null

  const view = raw.get('view')
  const state: ViewState = {
    uri,
    view: isViewKind(view) ? view : 'genomes',
  }

  const uri2 = raw.get('uri2')
  if (uri2 !== undefined && uri2 !== '') state.uri2 = uri2

  // Kept as the string the hash carried rather than split here: the list is a
  // *deck*, whose vacancies and order are `panels/deck.ts`'s vocabulary, and
  // splitting it in the parser would put half of that vocabulary in a module
  // whose one job is the round trip. `parseMaps` is the reader.
  const maps = raw.get('maps')
  if (maps !== undefined && maps !== '') state.maps = maps

  const genome = raw.get('genome')
  if (genome !== undefined) state.genome = genome
  const genome2 = raw.get('genome2')
  if (genome2 !== undefined) state.genome2 = genome2
  const region = raw.get('region')
  if (region !== undefined) state.region = region
  const region2 = raw.get('region2')
  if (region2 !== undefined) state.region2 = region2
  // Empty is dropped rather than kept, as `locus` is and unlike `region`: an
  // absent focus is a view fitted to its whole block, and `focus=` would be a
  // window with no coordinates in it for the panel to refuse one row later.
  const focus = raw.get('focus')
  if (focus !== undefined && focus !== '') state.focus = focus
  const genomes = raw.get('genomes')
  if (genomes !== undefined) state.genomes = genomes
  const regions = raw.get('regions')
  if (regions !== undefined) state.regions = regions
  // Empty is dropped: `cells=` would name a selection of none, and the view it
  // reached would draw a blank map rather than the whole file the reader meant.
  const cells = raw.get('cells')
  if (cells !== undefined && cells !== '') state.cells = cells
  const locus = raw.get('locus')
  if (locus !== undefined && locus !== '') state.locus = locus
  const colormap = raw.get('colormap')
  if (colormap !== undefined) state.colormap = colormap

  // The total the maps are drawn to (§6.5), believed only as a positive whole
  // number: a link naming anything else is the files as stored, which is what
  // an unreadable value in this hash has always meant.
  const contacts = raw.get('contacts')
  if (contacts !== undefined && contacts !== '') {
    const parsed = Number(contacts)
    if (Number.isSafeInteger(parsed) && parsed > 0) state.contacts = parsed
  }

  const level = raw.get('level')
  if (level !== undefined && (LEVELS as readonly string[]).includes(level)) {
    state.level = level as 'bin' | 'contig'
  }

  // The resolution the reader **added**, in base pairs (§3.4). Believed only as
  // a positive whole number, and never re-derived here: whether this file can
  // actually be read at it is a question about the ladder that is open, which
  // this parser has not got and which `metacooler/coarsen.ts` answers where it
  // does. A link naming one the recipient's file cannot reach falls back to that
  // file's own grid, which is the behaviour every unreachable value in this hash
  // already has.
  const coarsen = raw.get('coarsen')
  if (coarsen !== undefined && coarsen !== '') {
    const parsed = Number(coarsen)
    if (Number.isInteger(parsed) && parsed > 0) state.coarsen = parsed
  }

  const transform = raw.get('transform')
  if (transform !== undefined && isTransform(transform)) state.transform = transform

  // Balanced or raw *is* part of what is being looked at, so a link carries it.
  const balance = raw.get('balance')
  if (balance !== undefined) state.balance = balance === '1' || balance === 'true'

  // Any string, like `colormap` and unlike `view`: the id is a `/pixels` column
  // name, and which columns exist is a fact about the file rather than about
  // this build, so there is no closed list to check it against. An id this file
  // has no column for is repaired by `scoreFor` (`ui/scores.ts`), which falls
  // back to the first choice — the same repair a link naming a missing genome
  // gets, and the reason dropping it here would be the worse answer.
  //
  // This was **missing** while `score` was in `KEY_ORDER` and written by the
  // serialiser, so the round trip this module's header requires was broken for
  // it: every shared link and every restored tab came back on `count`, silently,
  // however the sender had shaded it. Restoring a tab goes through the same
  // string (`app/sessions.ts`), which is what made it a reload bug as well as a
  // link bug.
  const score = raw.get('score')
  if (score !== undefined) state.score = score

  // The two derived readings, for the reason `balance` and `score` are here: a
  // recipient of a link has to see the numbers the sender saw, and "observed
  // over expected" and "the ratio of these two files" are different pictures of
  // one region rather than two ways of shading one. The normalisation needs no
  // key of its own — it is a `score`, and `ui/scores.ts` resolves it.
  const oe = raw.get('oe')
  if (oe !== undefined) state.oe = oe === '1' || oe === 'true'

  // The window along the arms, in bins, for an O/E against both of a bacterial
  // chromosome's diagonals (§8.15). A whole number or nothing: a link is a string
  // a stranger can edit, and a value this build cannot read lands on the plain
  // O/E rather than on a guess.
  const arms = raw.get('arms')
  if (arms !== undefined && /^\d{1,6}$/.test(arms)) state.arms = Number(arms)

  // Clamped to the radii this build offers rather than believed. A link is a
  // string a stranger can edit, and the filter's cost is linear in nothing a
  // reader can see — `smooth=400` would be accepted by the arithmetic and would
  // average four hundred cells either way, which on a whole-genome block is a
  // long freeze produced by a URL. Out of range is dropped rather than clamped
  // to the nearest: a hash asking for something this build does not have should
  // land on the plain map, which is what every other unrecognised value does.
  const smooth = raw.get('smooth')
  if (smooth !== undefined && smooth !== '') {
    // One key, two vocabularies: `2` is a radius and `a200` is a target for a
    // window that sizes itself. Both are believed only if this build offers
    // them, which is what `parseSmooth` answers.
    if (parseSmooth(smooth) !== null) state.smooth = smooth
  }

  const op = raw.get('op')
  if (op !== undefined && isCompareOp(op)) state.op = op

  const flip = raw.get('flip')
  if (flip !== undefined) state.flip = flip === '1' || flip === 'true'

  // A clip bound may legitimately be negative — `log10` of a balanced matrix is
  // negative throughout — so the only thing rejected here is a non-number.
  const vmin = raw.get('vmin')
  if (vmin !== undefined && vmin !== '') {
    const parsed = Number(vmin)
    if (!Number.isNaN(parsed) || vmin === 'NaN') state.vmin = parsed
  }

  const vmax = raw.get('vmax')
  if (vmax !== undefined && vmax !== '') {
    const parsed = Number(vmax)
    if (!Number.isNaN(parsed) || vmax === 'NaN') state.vmax = parsed
  }

  // The lower triangle's own reading (§5.10), on the rules each of its keys'
  // upper twins is read by: the switch and the O/E as booleans, the score as any
  // string `scoreFor` can repair, the despeckle only as a token this build
  // offers, the transform only from the list, and a clip bound only as a number.
  const lower = raw.get('lower')
  if (lower !== undefined) state.lower = lower === '1' || lower === 'true'
  const score2 = raw.get('score2')
  if (score2 !== undefined && score2 !== '') state.score2 = score2
  const oe2 = raw.get('oe2')
  if (oe2 !== undefined) state.oe2 = oe2 === '1' || oe2 === 'true'
  const smooth2 = raw.get('smooth2')
  if (smooth2 !== undefined && smooth2 !== '' && parseSmooth(smooth2) !== null) state.smooth2 = smooth2
  const transform2 = raw.get('transform2')
  if (transform2 !== undefined && isTransform(transform2)) state.transform2 = transform2
  const colormap2 = raw.get('colormap2')
  if (colormap2 !== undefined && colormap2 !== '') state.colormap2 = colormap2
  for (const key of ['vmin2', 'vmax2'] as const) {
    const bound = raw.get(key)
    if (bound === undefined || bound === '') continue
    const parsed = Number(bound)
    if (!Number.isNaN(parsed) || bound === 'NaN') state[key] = parsed
  }

  return state
}

/**
 * A view state out of an object that came from outside, read as a link is.
 *
 * Every road but the address bar hands the app an *object* rather than a hash:
 * a workspace file, a share link's `#session=`, a published `?config=`, the
 * durable record a closed browser left, a patch from an embedding page. Each is
 * laid out here as the hash body it would have been and parsed back, so there
 * is one definition of a legal view state and every road takes it — a `view`
 * this build does not have lands on the file's own table, a transform it cannot
 * draw is dropped, a clip that is not a number is dropped. A workspace's state
 * used to be cast instead, and one naming `view: 'banana'` left its tab on
 * "Opening…" for good while an unknown transform threw a `RangeError` from the
 * renderer (`render/scale.ts`).
 *
 * Only the keys this build carries, and only strings, numbers and booleans
 * among them: an array or an object where a value goes would be stringified by
 * the serialiser into a legal-looking `1,2` or `[object Object]`, and a string
 * holding a lone surrogate — which JSON can spell and the URI encoder throws
 * on — would end the read rather than one key of it. Each is dropped on its
 * own, as the parser drops what it cannot read.
 *
 * `null` where no `uri` survives, which is the parser's answer too.
 */
export function viewStateOf(value: unknown): ViewState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const held = value as Record<string, unknown>
  const kept: Record<string, string | number | boolean> = {}
  for (const key of KEY_ORDER) {
    const one = held[key]
    if (typeof one === 'number' || typeof one === 'boolean') kept[key] = one
    else if (typeof one === 'string' && !LONE_SURROGATE.test(one)) kept[key] = one
  }
  return parseViewState(serialiseViewState(kept as unknown as ViewState))
}

/** Half of a surrogate pair standing alone, which `encodeURIComponent` refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function isViewKind(value: string | undefined): value is ViewKind {
  return value !== undefined && (VIEW_KINDS as string[]).includes(value)
}

function isTransform(value: string): value is Transform {
  return (TRANSFORMS as string[]).includes(value)
}

/** Structural equality, used to suppress redundant re-renders and hash writes. */
export function viewStateEquals(a: ViewState | null, b: ViewState | null): boolean {
  if (a === null || b === null) return a === b
  return serialiseViewState(a) === serialiseViewState(b)
}

/**
 * The keys that change how a block is *coloured*, never which block it is.
 *
 * Exported so the render path and this module cannot drift: adding a colour
 * control means adding its key here, and forgetting to means the app rebuilds
 * the view for it — slow, but never wrong, which is the right way round.
 */
export const SCALE_KEYS = ['transform', 'colormap', 'vmin', 'vmax'] as const

/**
 * `true` when two states select the same data and differ only in how it is
 * painted, so the mounted view can repaint instead of being rebuilt.
 *
 * Stated as "every non-scale key is equal" rather than "some scale key
 * differs", because the safe answer for a key this function has never heard of
 * is `false`. A field added to {@link ViewState} that selects *data* would
 * otherwise be silently ignored by the render path, and the view would go on
 * showing the previous block — a far worse failure than an unnecessary reload.
 */
export function differsOnlyInScale(a: ViewState, b: ViewState): boolean {
  return differsOnly(a, b, SCALE_KEYS)
}

/**
 * The keys that change the **values** without changing which block is read.
 *
 * A third category between "paint it differently" and "read something else",
 * and it exists because §7.5's derivations are transforms applied *after* the
 * read: the same cells, in different units. Treated as data keys they cost a
 * worker round trip and a rebuilt view for arithmetic over an array already in
 * memory — and on a gated whole-genome map (§7.3) the rebuild puts a full pixel
 * scan back behind its button, so ticking a box makes the map disappear.
 *
 * `op` is deliberately *not* here. Which of split, ratio and difference is in
 * force decides how the panel is built — the split keeps each file's block and
 * a second key, a ratio neither — and a panel is built once, at construction.
 */
export const DERIVED_KEYS = ['oe', 'arms', 'smooth', 'flip'] as const

/**
 * The keys that name what is on screen **beside** this view (§16).
 *
 * A fourth category, and the one that is not about this block at all. `maps`
 * lists the *companions*, which have their own workers, their own blocks and
 * their own pictures — nothing in it can change what the lead is reading. The
 * deck reconciles itself from this key before the render path reaches the
 * short-circuit below, so by the time this is consulted the companions are
 * already right and the only question left is whether the lead has to be
 * rebuilt for them. It does not.
 *
 * Left out, every press of `+` and every panel closed rebuilt the lead: a
 * worker round trip, a refitted view, and the reader's pan and zoom thrown
 * away — for a change that happened in another panel. §16.9's whole gesture is
 * several of these in a row, so the cost arrived four times while a reader drew
 * a 2 × 2, and on a gated whole-genome map (§7.3) each one would have put the
 * pixel scan back behind its button.
 */
export const DECK_KEYS = ['maps'] as const

/**
 * The keys that name what is on screen **beside** the view, and outlive it.
 *
 * A navigation builds a fresh state — `{ uri, view: 'contigs' }` and nothing
 * else — because that is what a navigation *is*: the region, the genome, the
 * level and the pair all belong to the picture being left behind. These two do
 * not. `maps` is a deck of other files (§16) and `uri2` is a file blended into
 * the lower triangle (§5.7); both are things the reader put on screen *around*
 * this session, and neither has anything to do with which block is showing.
 *
 * Left out, every navigation silently took them away: clicking Chromosomes and
 * then a contig — the plainest way there is to look at another chromosome —
 * came back with the deck gone, its workers released and its link key deleted,
 * because the state that arrived had no `maps` in it and the deck reconciled
 * itself to nothing. The same for a second file blended into the square.
 *
 * Carried by {@link Session.navigate} rather than by the store, and that
 * distinction is the whole of it: the *session* carries its companions across
 * its own navigations, and the **address bar is obeyed exactly as written**. A
 * link with no `maps` in it means a deck of one, and a store that helpfully put
 * the last one back would make a pasted link show something nobody sent.
 */
export const COMPANION_KEYS = ['maps', 'uri2'] as const

/**
 * The keys that say **how the reader reads a map**, and outlive a navigation.
 *
 * Neither of these is a fact about the block. They are the shape the reader
 * wants contact maps drawn in and the units they want them measured in — the
 * same kind of answer as the crosshair or the colormap, and the only reason they
 * are in the state at all rather than in `ui/plotOptions.ts` is that they change
 * *what is drawn from the read* and therefore have to be in a link (§11).
 *
 * So a navigation must not take them away. Opening a region by dragging a box on
 * the map, or clicking through Chromosomes to another sequence, arrives with a
 * fresh state — and left to that, the band a reader had just shaped came back as
 * a square, and the departures from distance decay they were reading came back
 * as raw counts, every time they went to look at something. Which is the gesture
 * both settings are *for*: they are how you look, and looking is what a
 * navigation is.
 *
 * `op` stays out, for {@link DERIVED_KEYS}'s reason: which of split, ratio and
 * difference is in force decides which controls a panel *builds*, and those are
 * built once. Carrying it would be carrying a state the next panel is not
 * dressed for.
 *
 * Carried by {@link Session.navigate} beside {@link COMPANION_KEYS}, on the same
 * rule and with the same exception: a state that has said something about the
 * key is believed, including having said `false`.
 */
export const READING_KEYS = ['flip', 'oe', 'arms', 'smooth'] as const

/**
 * The keys that say **which data the file is being read through**, and outlive
 * a navigation for a different reason than {@link READING_KEYS} do.
 *
 * Two members. The cell set of an `.scool` (§3.8) is carried not
 * because it is a preference — it is the opposite, it is the subject — but
 * because a container of four thousand cells is browsed the way a file is: you
 * choose the cells once, in the cells table, and then look at chromosome 3, and
 * then a locus on it, and then back out. Dropping the set on the way into a
 * chromosome would silently re-read every cell in the file, which is both the
 * wrong picture and the most expensive read the format has. The total the maps
 * are drawn to (§6.5) is the same kind of fact: the reader draws the maps to one
 * depth once and then goes to look at things, and a chromosome opened from the
 * table at the file's own depth would be a different library under the same
 * number in the box.
 *
 * The same believe-what-was-said rule as the other two: a state that names a
 * cell set has one, including the sentinel that names all of them.
 */
export const SUBJECT_KEYS = ['cells', 'contacts'] as const

/**
 * The keys of the lower triangle's own reading (§5.10): the switch, and the
 * score, smoothing, O/E and colour scale drawn below the diagonal.
 *
 * One group because they are one thing on screen — the second tab of the Map
 * card — and because every rule about them is a rule about all of them: a second
 * file or a deck drops the lot ({@link withoutLower}), and a change to any of
 * them is told to the mounted map unless its score needs a read the map does
 * not hold, which is the router's to decide (`app/SessionRouter.ts`).
 */
export const LOWER_KEYS = [
  'lower',
  'score2',
  'oe2',
  'smooth2',
  'transform2',
  'colormap2',
  'vmin2',
  'vmax2',
] as const

/**
 * The ones a navigation carries, beside {@link READING_KEYS}: every one but the
 * clip, which is two numbers about one block, as `vmin` and `vmax` are. The
 * split is how the reader is reading maps, and opening the next chromosome is
 * looking at another one the same way.
 */
export const LOWER_READING_KEYS = [
  'lower',
  'score2',
  'oe2',
  'smooth2',
  'transform2',
  'colormap2',
] as const

/** Whether a state says anything about the lower reading. */
export function hasLower(state: ViewState): boolean {
  return LOWER_KEYS.some((key) => state[key] !== undefined)
}

/** The state with the lower reading taken out, every key of it. */
export function withoutLower(state: ViewState): ViewState {
  const out = { ...state }
  for (const key of LOWER_KEYS) delete out[key]
  return out
}

/**
 * `true` when two states select the same block and differ only in how it is
 * painted, what arithmetic is done to it, or what is drawn beside it — the
 * things a mounted view can be *told*, rather than rebuilt for.
 */
export function differsOnlyInPresentation(a: ViewState, b: ViewState): boolean {
  return differsOnly(a, b, [...SCALE_KEYS, ...DERIVED_KEYS, ...DECK_KEYS])
}

/**
 * {@link differsOnlyInPresentation}, with the **score** — and the balancing
 * written beside it — allowed to differ too.
 *
 * Not presentation keys on their own, because one score is a different read —
 * an extra `/pixels` column is other numbers from the file, and balancing is
 * the file's weights applied as it is read — while the rest are arithmetic over
 * the same cells: `VC`, `ICE`, the baseline and the correlation are each
 * computed from the block in memory (`ui/scores.ts`). Which of the two a change
 * is depends on the file — its columns, and whether it is balanced by default,
 * which is what makes `balance=1` and no `balance` the same read on one file and
 * different reads on another — so the caller, which knows the file, asks
 * whether the column and the balancing in force are the same. The lower
 * reading (§5.10) is here for the same reason: its score may be the block the
 * map holds or a second read of it, and the caller asks which.
 */
export function differsOnlyInPresentationOrScore(a: ViewState, b: ViewState): boolean {
  return differsOnly(a, b, [...SCALE_KEYS, ...DERIVED_KEYS, ...DECK_KEYS, ...LOWER_KEYS, 'score', 'balance'])
}

/**
 * `true` when two states are the same view of the same block and differ only in
 * **where the picture is standing** — which a mounted panel can be told.
 *
 * Its own predicate rather than a fourth entry in {@link differsOnlyInPresentation},
 * because what it authorises is different in kind: a scale change repaints from a
 * block in memory, and this moves a transform over one. Sharing the road would
 * mean a focus change also ran `rederive`, and a derivation change also moved the
 * view — each doing the other's work for nothing.
 *
 * The reason it exists at all is that going to a second saved place on the same
 * chromosome is not a navigation. Left to the rebuild, every bookmark in a list
 * of twenty cost a worker round trip and a re-read of a block already on
 * screen — for a change that is one zoom.
 */
export function differsOnlyInFocus(a: ViewState, b: ViewState): boolean {
  return a.focus !== b.focus && differsOnly(a, b, ['focus'])
}

function differsOnly(a: ViewState, b: ViewState, allowed: readonly string[]): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (allowed.includes(key)) continue
    if (a[key as keyof ViewState] !== b[key as keyof ViewState]) return false
  }
  return true
}

/**
 * `level` as a bin-axis view reads it: bins unless the state says contigs.
 *
 * The hash is untrusted and one key serves two vocabularies, so `level=genome`
 * — legal, and meaningful in the overview — reaches these views too. It lands on
 * `bin` rather than being rejected: a link that named a level this view has no
 * axis for still names a genome, a pair or a region, and showing it at the
 * default level is the answer closest to what was asked for.
 */
export function matrixLevel(state: ViewState): 'bin' | 'contig' {
  return state.level === 'contig' ? 'contig' : 'bin'
}

/**
 * `level` as the whole-file view of a metagenome reads it: bins unless the state
 * says otherwise.
 *
 * `bin` is the odd one of the three and the default anyway. It is the only one
 * that is not an accumulation over pairs of *units* — it is the pooled
 * whole-file read `WholeView` already makes, the same picture as ticking every
 * genome in the table — and it is the one that is legible on a real assembly. A
 * contig cell sums a rectangle of `length × length` and a metagenome's contigs
 * span several orders of magnitude, so the contig axis spends its width on the
 * shortest sequences and its colour range on the longest; bin cells all cover
 * the same area, so one scale fits the whole picture. Landing on the readable
 * one is worth more than landing on the one that contains the others.
 *
 * It is a *level* rather than a view of its own because it answers the same
 * question on a third axis, and because a reader who switched away from it has
 * to find the way back in the control they left it in — so the shell routes on
 * it (`Session.mountOverview`) instead of the reader navigating.
 *
 * Which makes this the one place `level` is read whole: every value of the key
 * means something here, so nothing is folded onto a default.
 */
export function overviewLevel(state: ViewState): 'genome' | 'contig' | 'bin' {
  if (state.level === 'genome') return 'genome'
  return state.level === 'contig' ? 'contig' : 'bin'
}

/** What a `selection` view is of: several genomes, or several contigs. */
export interface UnitSelection {
  kind: 'genome' | 'contig'
  names: string[]
}

/**
 * The selection a state carries, or `null` where it names none.
 *
 * Genomes win over contigs when a hand-edited hash carries both, because the
 * genomes table is the coarser choice and a link that says two things should
 * resolve to one rather than to an error. Empty names are dropped, so a
 * trailing comma is not a sequence called `''`.
 */
export function selectionOf(state: ViewState): UnitSelection | null {
  const genomes = splitNames(state.genomes)
  if (genomes.length > 0) return { kind: 'genome', names: genomes }
  const regions = splitNames(state.regions)
  return regions.length > 0 ? { kind: 'contig', names: regions } : null
}

function splitNames(value: string | undefined): string[] {
  if (value === undefined || value === '') return []
  return value.split(',').map((name) => name.trim()).filter((name) => name !== '')
}

// ---------------------------------------------------------------------------
// The cell set of an .scool (§3.8)
// ---------------------------------------------------------------------------

/** What `cells` is written as when the selection is the whole file. */
export const ALL_CELLS = '*'

/**
 * The cells a state names, or `null` for every cell in the file.
 *
 * `null` covers both spellings of "all of them" — the key absent, and the key
 * present as `*` — because they mean the same picture and the reader arrives at
 * them by different routes: an scool opened fresh has no key at all, and one
 * whose reader pressed *sum all* has the sentinel. A single answer here is what
 * keeps the two from drifting into two behaviours.
 */
export function cellsOf(state: ViewState): string[] | null {
  const value = state.cells
  if (value === undefined || value === ALL_CELLS) return null
  const names = splitNames(value)
  return names.length > 0 ? names : null
}

/**
 * Write a cell set into a state patch.
 *
 * `null`, and any set that is the whole file, is written as the sentinel rather
 * than enumerated: four thousand cell names is not a URL, and "every cell" is
 * the one selection whose meaning does not depend on the file's contents — so
 * the sentinel survives being shared where the enumeration could not.
 */
export function cellsPatch(names: readonly string[] | null, total: number): { cells?: string } {
  if (names === null || names.length === 0 || names.length >= total) return { cells: ALL_CELLS }
  return { cells: names.join(',') }
}

// ---------------------------------------------------------------------------
// The view, as a set of sequences
// ---------------------------------------------------------------------------

/**
 * A view state and a tick box are the same decision, read in the two directions.
 *
 * The Sequences card in the General column is the picker a cooler's map is
 * steered from (`ui/SequenceCard.ts`): none ticked is the whole genome, one is
 * that chromosome's block, several are those chromosomes against each other.
 * Those are three of §5.5's view kinds, so *which sequences are drawn* is a
 * question the state already answers — and the card must not keep a second
 * answer beside it, or the breadcrumb, the Chromosomes table, the back button
 * and a pasted link would each move the picture without moving the ticks.
 *
 * So the pair below is the whole of the binding, and they are here rather than
 * in the session because a round trip through them is the property worth
 * pinning: {@link sequencesShown} of {@link viewForSequences} is the identity on
 * every set of names a card can hold.
 */

/**
 * Which sequences this view is a picture of, or `null` where it is a picture of
 * none of them.
 *
 * `null` is not "no sequences" — that is `[]`, the whole genome — it is *do not
 * ask*: a table view draws no map, so there is nothing for the ticks to
 * disagree with and clearing them would throw away a selection a reader is
 * halfway through making on the way to one.
 *
 * A region narrowed to coordinates is still a picture of its sequence, so the
 * suffix is stripped — and stripped against the file's own names, since a contig
 * may legally be called `NODE_1:2` (`ui/labels.ts`).
 */
export function sequencesShown(state: ViewState, names: readonly string[]): string[] | null {
  // The list itself, not a copy of it. `contigOf` holds its name index against
  // the array's own identity (§5.9), and a fresh copy per call is a fresh index
  // per call — which on a 154 k-contig file is most of a second, in a function
  // the card calls on every render.
  const known = names
  switch (state.view) {
    case 'whole':
    case 'overview':
      return []
    case 'region': {
      // Both axes of a two-axis view. `chrI × chrII` is a picture of two
      // sequences by any reading, and the card is the one place a reader can
      // see that without parsing the crumb.
      const on = [state.region, state.region2]
        .map((region) => (region === undefined ? null : contigOf(region, known)))
        .filter((name): name is string => name !== null)
      return [...new Set(on)]
    }
    case 'selection': {
      const selection = selectionOf(state)
      return selection === null || selection.kind !== 'contig' ? null : selection.names
    }
    default:
      return null
  }
}

/**
 * The view that draws exactly these sequences — {@link sequencesShown} run
 * backwards.
 *
 * `whole` is the file's own answer to "all of them", which is not the same view
 * on the two layouts: a cooler reads its whole map in one bounded read and a
 * metagenome scans for one (§7.3). The caller knows which; this does not.
 *
 * Nothing else about the state is carried, because a navigation is a fresh state
 * by design (`Session.navigate`) — and the coordinates of a region view are
 * dropped deliberately: a reader who has just asked for a second chromosome is
 * no longer looking at a window inside the first.
 */
export function viewForSequences(
  uri: string,
  names: readonly string[],
  whole: 'whole' | 'overview',
): ViewState {
  if (names.length === 0) return { uri, view: whole }
  if (names.length === 1) return { uri, view: 'region', region: names[0] }
  return { uri, view: 'selection', regions: names.join(',') }
}

// ---------------------------------------------------------------------------
// The view, as a set of genomes or of one genome's contigs
// ---------------------------------------------------------------------------

/**
 * What a metagenome's Sequences card lists: its genomes, or one genome's contigs.
 *
 * A metacool has two units where a cooler has one, so the card has two lists
 * and the view decides which: a picture of genomes — the whole metagenome, a
 * pair, several ticked — lists genomes; a picture inside one genome — the
 * genome itself, one of its contigs, several of them — lists that genome's
 * contigs. Read off the state and nothing else, so a pasted link rebuilds the
 * same card as the session that made it.
 */
export type MetaScope = { kind: 'genomes' } | { kind: 'contigs'; genome: string }

/**
 * Which list a view is a picture from, or `null` where it says nothing — a
 * table, the browser — and the card should stay as it is.
 *
 * A contig view that does not carry its genome (opened from the Contigs table,
 * or a pair's cell) is placed by `genomeOf`, and only when every contig in it
 * belongs to the same one: a block between two genomes' contigs is not a
 * picture inside either.
 */
export function metaScopeOf(
  state: ViewState,
  contigs: readonly string[],
  genomeOf: (contig: string) => string | undefined,
): MetaScope | null {
  const inside = (names: readonly string[]): MetaScope | null => {
    const genome = state.genome ?? commonGenome(names, genomeOf)
    return genome === undefined ? null : { kind: 'contigs', genome }
  }
  switch (state.view) {
    case 'whole':
    case 'overview':
    case 'pair':
      return { kind: 'genomes' }
    case 'genome':
      return state.genome === undefined ? null : { kind: 'contigs', genome: state.genome }
    // Through `sequencesShown`, which strips coordinates against the file's own
    // names — a contig may be called `NODE_1:2`.
    case 'region':
      return inside(sequencesShown(state, contigs) ?? [])
    case 'selection': {
      const selection = selectionOf(state)
      if (selection === null) return null
      return selection.kind === 'genome' ? { kind: 'genomes' } : inside(selection.names)
    }
    default:
      return null
  }
}

function commonGenome(
  names: readonly string[],
  genomeOf: (contig: string) => string | undefined,
): string | undefined {
  if (names.length === 0) return undefined
  const genomes = new Set(names.map(genomeOf))
  const [only] = genomes
  return genomes.size === 1 ? only : undefined
}

/**
 * Which names in `scope`'s list this view is a picture of — {@link sequencesShown}
 * for a metagenome, with the same `null` for *do not ask*.
 *
 * `contigs` is the file's own name column, for the reason `sequencesShown`
 * takes one: a contig may be called `NODE_1:2`.
 */
export function metaShown(
  state: ViewState,
  scope: MetaScope,
  contigs: readonly string[],
): string[] | null {
  if (scope.kind === 'genomes') {
    switch (state.view) {
      case 'whole':
      case 'overview':
        return []
      case 'pair':
        return [...new Set([state.genome, state.genome2])].filter(
          (name): name is string => name !== undefined,
        )
      case 'selection': {
        const selection = selectionOf(state)
        return selection?.kind === 'genome' ? selection.names : null
      }
      default:
        return null
    }
  }
  switch (state.view) {
    case 'genome':
      return []
    case 'region':
    case 'selection':
      return sequencesShown(state, contigs)
    default:
      return null
  }
}

/**
 * The view that draws exactly these names of `scope`'s list —
 * {@link metaShown} run backwards.
 *
 * **One genome ticked is a selection of one**, not the genome view. The genome
 * view is a picture *inside* the genome and lists its contigs, so a tick that
 * went there would swap the list out from under the reader halfway through
 * ticking a second genome. Opening a genome is the name's click, as it is on
 * every row of this card.
 *
 * Inside a genome the genome rides along on every view, which is what keeps the
 * list — and the crumb — on it: none ticked is the genome itself, one is that
 * contig, several are those contigs against each other.
 */
export function viewForMeta(
  uri: string,
  scope: MetaScope,
  names: readonly string[],
): ViewState {
  if (scope.kind === 'genomes') {
    return names.length === 0
      ? { uri, view: 'overview' }
      : { uri, view: 'selection', genomes: names.join(',') }
  }
  const genome = scope.genome
  if (names.length === 0) return { uri, view: 'genome', genome }
  if (names.length === 1) return { uri, view: 'region', region: names[0], genome }
  return { uri, view: 'selection', regions: names.join(','), genome }
}

/** A view state naming a file but nothing inside it — the landing view (§5.1). */
export function landingState(uri: string, view: ViewKind = 'genomes'): ViewState {
  return { uri, view }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * How a state arrived, which is not the same question as what it is.
 *
 * `replace` is the difference between a navigation and a nudge: the browser's
 * back button should walk the breadcrumb (§5.5), not undo the last colour-scale
 * tweak. The store does not act on it — it has no address bar of its own any
 * more — it passes it to whoever does.
 */
export interface ViewChange {
  replace: boolean
}

export type ViewListener = (state: ViewState | null, change: ViewChange) => void

/**
 * A subscribe/notify store over one {@link ViewState}.
 *
 * Deliberately *not* bound to the address bar. There is one address bar and
 * there may be several of these — one per open session — so the binding belongs
 * to whatever knows which session is on screen. Sessions are then identical
 * whether they are the visible one or not, which is what stops a background tab
 * from writing the hash.
 */
export class ViewStore {
  private current: ViewState | null
  private readonly listeners = new Set<ViewListener>()

  constructor(initial: ViewState | null = null) {
    this.current = initial
  }

  get state(): ViewState | null {
    return this.current
  }

  /** Replace the whole state. No-op when nothing actually changed. */
  set(next: ViewState | null, options: { replace?: boolean } = {}): void {
    if (viewStateEquals(next, this.current)) return
    this.current = next
    this.notify({ replace: options.replace === true })
  }

  /**
   * Merge a partial update into the current state.
   *
   * An explicitly `undefined` value *removes* the key rather than storing an
   * undefined one — "auto vmax" has to erase `vmax` from the hash, not write
   * `vmax=undefined`, or the round trip stops being lossless.
   */
  patch(partial: Partial<ViewState>, options: { replace?: boolean } = {}): void {
    if (this.current === null) return
    const next: ViewState = { ...this.current, ...partial }
    for (const key of OPTIONAL_KEYS) {
      if (key in partial && partial[key] === undefined) delete next[key]
    }
    this.set(next, options)
  }

  subscribe(listener: ViewListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Adopt a state without telling anybody.
   *
   * For a restored tab, and for that alone: the state is what the session
   * *will* show, and rendering it now would open a file nobody has asked to
   * look at. The shell notifies itself once, when the tab is clicked.
   */
  adopt(next: ViewState | null): void {
    this.current = next
  }

  private notify(change: ViewChange): void {
    for (const listener of this.listeners) listener(this.current, change)
  }
}
