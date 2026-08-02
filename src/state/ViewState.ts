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

const VIEW_KINDS: ViewKind[] = ['genomes', 'contigs', 'genome', 'pair', 'region', 'whole']
const LEVELS = ['bin', 'contig'] as const
const TRANSFORMS: Transform[] = ['log1p', 'log10', 'none']

/** Serialisation order — stable so two equal states produce equal strings. */
const KEY_ORDER = [
  'uri',
  'view',
  'genome',
  'genome2',
  'region',
  'region2',
  'level',
  'transform',
  'colormap',
  'vmin',
  'vmax',
  'balance',
] as const

/** The keys a patch may remove; `uri` and `view` always exist. */
const OPTIONAL_KEYS = [
  'genome',
  'genome2',
  'region',
  'region2',
  'level',
  'transform',
  'colormap',
  'vmin',
  'vmax',
  'balance',
] as const

/**
 * Percent-encode a value, then put back the characters that are legal in a
 * fragment and make the hash readable. `&` and `=` stay encoded, which is what
 * keeps the split unambiguous.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, '/').replace(/%3A/g, ':')
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

  const genome = raw.get('genome')
  if (genome !== undefined) state.genome = genome
  const genome2 = raw.get('genome2')
  if (genome2 !== undefined) state.genome2 = genome2
  const region = raw.get('region')
  if (region !== undefined) state.region = region
  const region2 = raw.get('region2')
  if (region2 !== undefined) state.region2 = region2
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

/** A view state naming a file but nothing inside it — the landing view (§5.1). */
export function landingState(uri: string, view: ViewKind = 'genomes'): ViewState {
  return { uri, view }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ViewListener = (state: ViewState | null) => void

/**
 * A subscribe/notify store over one {@link ViewState}, optionally bound to the
 * address bar.
 *
 * Navigation uses `pushState` rather than assigning `location.hash`, so the
 * browser's back button walks the breadcrumb (§5.5) instead of just undoing the
 * last colour-scale tweak — those go through `patch(..., { replace: true })`.
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
    this.writeHash(options.replace === true)
    this.notify()
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

  private notify(): void {
    for (const listener of this.listeners) listener(this.current)
  }

  private hashWriting = false

  private writeHash(replace: boolean): void {
    if (!this.bound) return
    const hash = this.current === null ? '' : `#${serialiseViewState(this.current)}`
    if (window.location.hash === hash) return
    this.hashWriting = true
    const url = `${window.location.pathname}${window.location.search}${hash}`
    if (replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    this.hashWriting = false
  }

  private bound = false

  /**
   * Two-way bind to the address bar. Reads the current hash immediately, then
   * follows `popstate` (back/forward) and `hashchange` (a hand-edited or pasted
   * URL). Returns an unbind function.
   */
  connectHash(): () => void {
    this.bound = true
    const read = (): void => {
      if (this.hashWriting) return
      const parsed = parseViewState(window.location.hash)
      if (viewStateEquals(parsed, this.current)) return
      this.current = parsed
      this.notify()
    }
    window.addEventListener('popstate', read)
    window.addEventListener('hashchange', read)
    read()
    return () => {
      this.bound = false
      window.removeEventListener('popstate', read)
      window.removeEventListener('hashchange', read)
    }
  }
}
