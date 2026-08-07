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

import type { Transform, ViewKind, ViewState } from '../types'

const VIEW_KINDS: ViewKind[] = [
  'genomes',
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
  'view',
  'genome',
  'genome2',
  'genomes',
  'region',
  'region2',
  'regions',
  'locus',
  'level',
  'transform',
  'colormap',
  'vmin',
  'vmax',
  'balance',
  'score',
] as const

/** The keys a patch may remove; `uri` and `view` always exist. */
const OPTIONAL_KEYS = [
  'uri2',
  'genome',
  'genome2',
  'genomes',
  'region',
  'region2',
  'regions',
  'locus',
  'level',
  'transform',
  'colormap',
  'vmin',
  'vmax',
  'balance',
  'score',
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
  return encodeURIComponent(value).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%2C/g, ',')
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

  const genome = raw.get('genome')
  if (genome !== undefined) state.genome = genome
  const genome2 = raw.get('genome2')
  if (genome2 !== undefined) state.genome2 = genome2
  const region = raw.get('region')
  if (region !== undefined) state.region = region
  const region2 = raw.get('region2')
  if (region2 !== undefined) state.region2 = region2
  const genomes = raw.get('genomes')
  if (genomes !== undefined) state.genomes = genomes
  const regions = raw.get('regions')
  if (regions !== undefined) state.regions = regions
  const locus = raw.get('locus')
  if (locus !== undefined && locus !== '') state.locus = locus
  const colormap = raw.get('colormap')
  if (colormap !== undefined) state.colormap = colormap

  const level = raw.get('level')
  if (level !== undefined && (LEVELS as readonly string[]).includes(level)) {
    state.level = level as 'bin' | 'contig'
  }

  const transform = raw.get('transform')
  if (transform !== undefined && isTransform(transform)) state.transform = transform

  // Balanced or raw *is* part of what is being looked at, so a link carries it.
  const balance = raw.get('balance')
  if (balance !== undefined) state.balance = balance === '1' || balance === 'true'

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

  return state
}

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
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if ((SCALE_KEYS as readonly string[]).includes(key)) continue
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
 * `level` as the overview reads it: contigs unless the state says genomes.
 *
 * Contig × contig is the default for the reason {@link ViewState.level}'s other
 * accessor exists at all — the two levels are different accumulations of one
 * pass, and the contig picture is the one that contains the other.
 */
export function overviewLevel(state: ViewState): 'genome' | 'contig' {
  return state.level === 'genome' ? 'genome' : 'contig'
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
