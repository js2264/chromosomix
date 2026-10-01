/**
 * A feature set's **names** as categories, and the colour each one is drawn in
 * (§8.16, §25.5).
 *
 * A BED's fourth column is often not a name at all but a *class*: `A` and `B`
 * on a compartment call, `TAD` and `boundary` on a domain call, `1_TssA` …
 * `15_Quies` on a chromatin-state segmentation. Read that way, a set is a
 * colouring — every place it covers is the colour of the name over it — and
 * this module is the one mapping from a name to that colour, so that a model
 * coloured by the set and the set's own lane coloured by name cannot disagree.
 *
 * ## One mapping, kept on the set's row
 *
 * The reader's own colours ({@link NameOverrides}) are stored on the **feature
 * row's** style rather than on whatever is coloured by it, for the reason the
 * manual-annotations key writes a mark's colour to the marks' store: `A` is a
 * fact about the compartment call, and a colour picked for it on one model
 * should be the colour on the next model, and on the lane.
 *
 * ## Fitted to the file
 *
 * `render/featureInk.ts`'s rule, kept: which names earn a colour of their own
 * is decided over the **whole set**, by how many base pairs each covers, and
 * never by what a window happens to show.
 */

import type { FeatureSet } from '../annotations/types'
import { CATEGORY_PALETTE } from './meta'

/**
 * The most names a colouring tells apart, the `other` bucket included.
 *
 * Twice the twelve a field colouring stops at (`annotations/fields.ts`
 * `MAX_LEVELS`), because the sets this is for are segmentations — fifteen or
 * eighteen chromatin states is the common case and a key that folded three of
 * them into `other` would be useless for exactly the file it is asked of. Past
 * twenty-four the honest answer is still a bucket, and the key says how many
 * names it holds.
 */
export const MAX_NAMES = 24

/**
 * The override key of the `other` bucket.
 *
 * The empty string, because it is the one name no feature can be put under: a
 * feature with no name is *not coloured* rather than in a category of its
 * own, so the key cannot collide with a real name — which `'other'` could.
 */
export const OTHER_NAME = ''

/** What a bead or feature is drawn in when it falls in the `other` bucket. */
export const OTHER_NAME_COLOUR = '#5c5c5c'

/**
 * The two compartments, where a set's names are exactly `A` and `B`: red for
 * the open, active compartment and blue for the closed one — the convention
 * every compartment figure since Lieberman-Aiden 2009 has used, which a reader
 * recognises before reading the key.
 */
export const COMPARTMENT_COLOURS: Readonly<Record<string, string>> = {
  A: '#d73027',
  B: '#4575b4',
}

/**
 * The palette names are handed out from, commonest first.
 *
 * `CATEGORY_PALETTE` first — the categories' own colours everywhere else in
 * this application — **without its grey**, which on a model reads as the
 * neutral every uncovered bead is drawn in. Then Paul Tol's muted and light
 * sets, which carry on in the same spirit (distinct, legible to a colour-blind
 * reader as far as twenty-odd colours can be) to make up {@link MAX_NAMES} − 1.
 */
export const NAME_PALETTE: readonly string[] = [
  ...CATEGORY_PALETTE.filter((colour) => colour !== '#7a7a7a'),
  '#88ccee',
  '#44aa99',
  '#117733',
  '#332288',
  '#ddcc77',
  '#999933',
  '#cc6677',
  '#882255',
  '#aa4499',
  '#ee8866',
  '#bbcc33',
  '#ffaabb',
]

/** The reader's own colours, by name; {@link OTHER_NAME} for the bucket. */
export type NameOverrides = Readonly<Record<string, string>>

/** Which names a set colours by, and what was folded into `other`. */
export interface NameLevels {
  /** The names with a colour of their own, most base pairs covered first. */
  names: string[]
  /** How many distinct names went into the `other` bucket; 0 for none. */
  folded: number
}

const levelsCache = new WeakMap<FeatureSet, NameLevels>()

/** Whether any feature in the set carries a name. */
export function hasNames(set: FeatureSet | undefined): boolean {
  if (set === undefined) return false
  return nameLevels(set).names.length > 0
}

/**
 * The set's names, ranked by base pairs covered, capped at {@link MAX_NAMES}.
 *
 * By coverage rather than by count: a compartment call has as many `A`
 * intervals as `B` ones but not as much of the genome under each, and the
 * names that cover the most are the ones a reader sees most of — they get the
 * most distinct colours. Ties go alphabetically so the answer is stable.
 */
export function nameLevels(set: FeatureSet): NameLevels {
  const known = levelsCache.get(set)
  if (known !== undefined) return known
  const cover = new Map<string, number>()
  for (let i = 0; i < set.length; i++) {
    const name = set.name[i] ?? ''
    if (name === '') continue
    cover.set(name, (cover.get(name) ?? 0) + Math.max(1, set.end[i] - set.start[i]))
  }
  const ranked = [...cover.entries()]
    .sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]))
    .map(([name]) => name)
  const levels: NameLevels =
    ranked.length > MAX_NAMES
      ? { names: ranked.slice(0, MAX_NAMES - 1), folded: ranked.length - (MAX_NAMES - 1) }
      : { names: ranked, folded: 0 }
  levelsCache.set(set, levels)
  return levels
}

/** One row of a names key. */
export interface NameLevel {
  /** The name, or {@link OTHER_NAME} for the bucket — the override key. */
  name: string
  /** What the key prints. */
  label: string
  colour: string
}

/** A resolved name colouring: a colour per name, and the key in reading order. */
export interface NamePalette {
  /** The colour a feature of this name is drawn in; `null` for no name. */
  colourOf(name: string): string | null
  /** The key: the names in natural order, then the bucket if there is one. */
  levels: NameLevel[]
}

/**
 * The colour of every name, the reader's over the default.
 *
 * The default is {@link COMPARTMENT_COLOURS} where the names are exactly `A`
 * and `B` (or one of them), and {@link NAME_PALETTE} by rank otherwise. The
 * key lists the names in natural order — `A` before `B`, `state 2` before
 * `state 10` — whatever order their colours were handed out in.
 */
export function namePalette(levels: NameLevels, overrides: NameOverrides = {}): NamePalette {
  const compartments = levels.folded === 0 && levels.names.length > 0 && levels.names.every((name) => name in COMPARTMENT_COLOURS)
  const colours = new Map<string, string>()
  levels.names.forEach((name, rank) => {
    const own = overrides[name]
    colours.set(
      name,
      own ?? (compartments ? COMPARTMENT_COLOURS[name] : NAME_PALETTE[rank % NAME_PALETTE.length]),
    )
  })
  const other = levels.folded > 0 ? (overrides[OTHER_NAME] ?? OTHER_NAME_COLOUR) : null
  const ordered = [...levels.names].sort(naturalCompare)
  const key: NameLevel[] = ordered.map((name) => ({ name, label: name, colour: colours.get(name) ?? OTHER_NAME_COLOUR }))
  if (other !== null) {
    key.push({ name: OTHER_NAME, label: otherLabel(levels.folded), colour: other })
  }
  return {
    colourOf: (name) => {
      if (name === '') return null
      return colours.get(name) ?? other
    },
    levels: key,
  }
}

/** What the key calls the bucket: how many names are in it, so it says so. */
export function otherLabel(folded: number): string {
  return `other (${folded.toLocaleString('en-US')} more name${folded === 1 ? '' : 's'})`
}

/**
 * The reader's name colours read back from a stored style: names of a sane
 * length mapped to `#rrggbb`, and nothing else.
 */
export function nameOverridesOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  let count = 0
  for (const [name, colour] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 1000) break
    if (typeof colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(colour) && name.length <= 200) {
      out[name] = colour
      count++
    }
  }
  return out
}

/** Alphabetical, with runs of digits compared as numbers. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)
}
