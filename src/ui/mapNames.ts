/**
 * What a reader calls a contact map.
 *
 * A map is labelled by its file, which is the right default and a poor name for
 * the work. Four replicates of one experiment are four maps whose labels differ
 * in a digit; two conditions dropped in to be compared are `mat_G1.mcool::1000`
 * and `mat_G2M.mcool::1000`, and every one of those characters is on the
 * picture, in the readout under the pointer, and in the exported figure — where
 * the two words that would tell a reader what they are looking at are `G1` and
 * `G2M`. A track's lane label has been editable for exactly this reason
 * (`ui/AnnotationCard.ts`), and a contact map is the largest thing anybody lays
 * over a genome.
 *
 * Three decisions are worth stating, and they are all about *where the name
 * lives*.
 *
 * **One record per session, not one note per file.** The names of every map a
 * session is holding — the one it is of, the one it is compared against, and
 * every companion of a deck — sit together under the session's own memory key,
 * keyed by the file each name is for. That is `deck:looks`'s arrangement and it
 * is chosen for its reason: a workspace is gathered from one key, so a name
 * filed under a companion's own key would be a name the saved session did not
 * contain.
 *
 * **Keyed by the file, never by the rung.** `rep2.mcool::/resolutions/1000` and
 * the same file at 5 kb are one map with one name, which is the same definition
 * `state/UiMemory.ts` keys its own storage by and the reason a change of
 * resolution keeps everything else a reader has set up. One consequence is
 * worth stating, and it is `deck:looks`'s too: one file open twice in a session
 * — as a companion of itself, or compared against itself — has one name.
 *
 * **An empty name is not a name.** Clearing the box hands the map back to its
 * file name, which is what makes a rename undoable — the same rule the tab
 * strip follows (`app/TabStrip.ts`).
 */

import { recall } from '../state/UiMemory'

import { fileLabel, splitUri } from './labels'

/** Where a session's map names live in its own memory. */
export const MAP_NAMES_SCOPE = 'map:names'

/**
 * The names a session is holding, by the file each one is for.
 *
 * The key is the path before `::` — see the header. A plain object rather than
 * a `Map` because it is written to storage as JSON and read back out of a
 * workspace file, where a `Map` is `{}`.
 */
export type MapNames = Record<string, string>

/** How long a map's name may be. Longer than any of them, shorter than a file. */
const NAME_LIMIT = 200

/**
 * A record of names, from something that claims to be one.
 *
 * Stored state outlives the code that wrote it, and a workspace file is
 * somebody else's input — so every entry is checked rather than trusted, which
 * is the rule `recall`'s own docstring states and the one every field of
 * `state/SessionConfig.ts` is read under. A value that is not a string, and a
 * name that is empty once trimmed, are dropped; what is left is a record this
 * module's own writer could have produced.
 */
export function cleanMapNames(value: unknown): MapNames {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: MapNames = {}
  for (const [path, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name !== 'string') continue
    const trimmed = name.trim().slice(0, NAME_LIMIT)
    if (path !== '' && trimmed !== '') out[path] = trimmed
  }
  return out
}

/** Read the record out of session memory, keeping only what is a name. */
export function readMapNames(key: string): MapNames {
  return cleanMapNames(recall<unknown>(key, MAP_NAMES_SCOPE))
}

/** The name the reader gave this map, or `undefined` for one they have not. */
export function mapNameIn(names: MapNames, uri: string): string | undefined {
  return names[splitUri(uri).path]
}

/**
 * The record with one map renamed, or handed back to its file name.
 *
 * A fresh object, so a caller can compare it against what it had and write only
 * when something moved — the names are read on every repaint of a card and
 * written once per rename.
 */
export function withMapName(names: MapNames, uri: string, name: string | null): MapNames {
  const path = splitUri(uri).path
  const trimmed = name === null ? '' : name.trim().slice(0, NAME_LIMIT)
  const out = { ...names }
  if (trimmed === '') delete out[path]
  else out[path] = trimmed
  return out
}

/**
 * The same record with every key put through `resolve`.
 *
 * For a config **published beside its data**, whose names may be relative to the
 * config's own URL (`state/SessionConfig.ts`'s `resolveConfig`). A key that is
 * not resolved the same way every other URI in that config is resolved is a name
 * for a file nothing will ever ask about — the same failure `lanes` and
 * `deck.looks` are resolved to avoid, and as silent, since a map with no name is
 * a map called what its file is called.
 *
 * The result is re-split, so a resolver that hands back a `file::group` URI
 * still leaves this record keyed by the *file* — which is the one thing every
 * lookup here depends on.
 */
export function resolveMapNames(names: MapNames, resolve: (uri: string) => string): MapNames {
  const out: MapNames = {}
  for (const [path, name] of Object.entries(names)) out[splitUri(resolve(path)).path] = name
  return out
}

/**
 * What to *call* this map: the reader's name where there is one, and the file's
 * where there is not.
 *
 * The one function everything on screen goes through, so a map is called the
 * same thing by the card that lists it, the readout under the pointer, the key
 * beside the colours and the caption on the exported figure.
 */
export function mapLabelIn(names: MapNames, uri: string): string {
  return mapNameIn(names, uri) ?? fileLabel(uri)
}
