/**
 * A whole tab, written down.
 *
 * The URL already shares *what is being looked at* (§5.5) — one file, one view,
 * one window, one colour scale — and that is the right thing for a link. It is
 * not the right thing for a workspace: eight tracks with their colours, heights,
 * groups and limits, a set of ticked chromosomes, a dozen hand-placed marks and
 * the table filters underneath them are half an hour of work, and none of them
 * belong in an address bar. So there are two forms of the same session: a link,
 * and a file.
 *
 * Everything here is already stored somewhere — the view state in the hash, the
 * rest in `UiMemory` under this session's own key — and this module does no more
 * than gather it up and put it back. That is deliberate: a config that computed
 * its own idea of what a session is would be a second definition to keep in step
 * with the first, and the first is the one the application actually runs on.
 *
 * **A local file cannot be re-opened by name.** No browser will read a file it
 * was not handed, so a config naming one comes back as a session that knows
 * everything about itself except where its bytes are, and asks for them. That is
 * exactly what a reload already does to a dropped file (§8.6), and the same
 * `detached` machinery answers it.
 */

import { recall, remember } from './UiMemory'
import { ANALYSIS_SCOPE, type AnalysisMemory } from '../analysis/memory'
import { formatUri, parseUri } from '../uri'
import type { StoredEntry } from '../annotations/types'
import type { Bookmark } from '../annotations/bookmarks'
import type { ManualMark } from '../annotations/manual'
import type { PlotOptions } from '../render/heatmap'
import type { TableUiState } from '../ui/VirtualTable'
import type { ViewState } from '../types'

/** What the file says it is, so a stray `.json` is not read as one. */
export const CONFIG_KIND = 'metacooler.session'

/**
 * The format's own version.
 *
 * Bumped when a field changes meaning, never when one is *added*: every reader
 * below tolerates a missing key, so an older file opens in a newer viewer with
 * the parts it did not know about left at their defaults.
 */
export const CONFIG_VERSION = 1

/** How a group of tracks shares the picture; mirrors `ui/BrowserView.ts`. */
type GroupModes = Record<string, string>

export interface SessionConfig {
  kind: typeof CONFIG_KIND
  version: number
  /** When it was written, for the reader who finds four of them in a folder. */
  createdAt: string
  /** What is being looked at: the same object the URL hash carries. */
  state: ViewState
  /** Every loaded annotation, exactly as session storage keeps them (§8.6). */
  tracks: StoredEntry[]
  /** Hand-placed lines and arrowheads on the map. */
  manual: ManualMark[]
  /**
   * Saved places, with the resolution each was found at (§8.10).
   *
   * Here for the reason this whole file exists: a list of forty loci walked one
   * after another is work, it is not in the URL, and it is precisely the kind of
   * thing a reader wants to hand to somebody else along with the tracks. It is
   * also the one field here that a *recipient* can act on without the bytes —
   * coordinates mean the same thing in anybody's copy of the assembly.
   */
  bookmarks: Bookmark[]
  /** Ticked sequences, when the session is a genome browser. */
  sequences: string[]
  /** Per-group stacking and scaling, by group name. */
  groups: GroupModes
  scaling: GroupModes
  /** Whether the compared file's counts are scaled to the first's bright end. */
  compareNormalise: boolean
  /** Sort, search and column filters for the two tables. */
  tables: { genomes?: TableUiState; contigs?: TableUiState }
  /**
   * What each analysis task was last run with, by task id (§18.2).
   *
   * Carried for the reason the tracks are: reproducing a figure should be
   * opening the session and pressing Run, not remembering that the insulation
   * window was fourteen bins. The *results* are deliberately not here — a
   * per-bin vector over a metagenome is megabytes, and the recipe is the part
   * worth keeping (§18.5).
   */
  analysis: AnalysisMemory
  /**
   * The overlay preferences.
   *
   * A window-level setting rather than a session one — it lives in
   * `localStorage`, not in this session's memory — and carried all the same,
   * because a figure with the crosshair off and the names on is what the sender
   * was looking at. Applied on import for the same reason.
   */
  plot: PlotOptions
}

/** `{ genomes: … }` when there is one, and nothing at all when there is not. */
function tableOf(
  which: 'genomes' | 'contigs',
  value: TableUiState | null | undefined,
): { genomes?: TableUiState; contigs?: TableUiState } {
  return value === null || value === undefined ? {} : { [which]: value }
}

/** The `UiMemory` scopes one session's workspace is spread across. */
const SCOPES = {
  tracks: 'annotations',
  manual: 'manual-annotations',
  bookmarks: 'bookmarks',
  sequences: 'browser:sequences',
  groups: 'browser:groups',
  scaling: 'browser:scaling',
  normalise: 'compare:normalise',
  genomes: 'table:genomes',
  contigs: 'table:contigs',
  analysis: ANALYSIS_SCOPE,
} as const

/**
 * Gather a session up.
 *
 * Read out of storage rather than off the live objects, and that is the whole
 * trick: every store here persists on each change, so what storage holds *is*
 * the session, and a config built from it cannot drift from what a reload would
 * restore. The one thing not in there is the view state, which lives in the hash.
 */
export function buildConfig(options: {
  state: ViewState
  memoryKey: string
  plot: PlotOptions
  now: Date
}): SessionConfig {
  const key = options.memoryKey
  return {
    kind: CONFIG_KIND,
    version: CONFIG_VERSION,
    createdAt: options.now.toISOString(),
    state: options.state,
    tracks: recall<StoredEntry[]>(key, SCOPES.tracks) ?? [],
    manual: recall<ManualMark[]>(key, SCOPES.manual) ?? [],
    bookmarks: recall<Bookmark[]>(key, SCOPES.bookmarks) ?? [],
    sequences: recall<string[]>(key, SCOPES.sequences) ?? [],
    groups: recall<GroupModes>(key, SCOPES.groups) ?? {},
    scaling: recall<GroupModes>(key, SCOPES.scaling) ?? {},
    compareNormalise: recall<boolean>(key, SCOPES.normalise) ?? false,
    tables: {
      ...tableOf('genomes', recall<TableUiState>(key, SCOPES.genomes)),
      ...tableOf('contigs', recall<TableUiState>(key, SCOPES.contigs)),
    },
    analysis: recall<AnalysisMemory>(key, SCOPES.analysis) ?? {},
    plot: options.plot,
  }
}

/**
 * Put a config back, under the key the *importing* session will read.
 *
 * Re-keyed rather than replayed: the memory key is `<session id>|<uri>`, so a
 * config exported from tab 3 and opened in tab 7 would otherwise write eight
 * tracks into a workspace nobody is looking at. And the URI is the one the file
 * is actually being opened under, which for a local file is whatever the reader
 * dropped — the same session under a renamed file is still that session.
 *
 * Written *before* the file opens, because `setUpAnnotations` reads these on its
 * way up: this is what makes the tracks arrive with the view rather than a
 * gesture later.
 */
export function applyConfig(config: SessionConfig, memoryKey: string): void {
  const key = memoryKey
  remember(key, SCOPES.tracks, config.tracks)
  remember(key, SCOPES.manual, config.manual)
  remember(key, SCOPES.bookmarks, config.bookmarks)
  remember(key, SCOPES.sequences, config.sequences)
  remember(key, SCOPES.groups, config.groups)
  remember(key, SCOPES.scaling, config.scaling)
  remember(key, SCOPES.normalise, config.compareNormalise)
  if (config.tables.genomes !== undefined) remember(key, SCOPES.genomes, config.tables.genomes)
  if (config.tables.contigs !== undefined) remember(key, SCOPES.contigs, config.tables.contigs)
  // Absent from every config written before §18 existed, and a missing key is
  // an empty workspace rather than a broken one — the same tolerance every
  // field above is read with.
  if (config.analysis !== undefined) remember(key, SCOPES.analysis, config.analysis)
}

/**
 * Read a config out of a file's text, or refuse it.
 *
 * Deliberately forgiving about *fields* and strict about *identity*: anything
 * missing falls back to an empty workspace, but a JSON file that does not say it
 * is one of these is not one — a reader who drops a `package.json` on the page
 * should be told it is not a session rather than watched as their tab is
 * replaced by an empty one.
 */
export function parseConfig(text: string): SessionConfig | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  if (row['kind'] !== CONFIG_KIND) return null
  const state = row['state']
  if (typeof state !== 'object' || state === null) return null
  const uri = (state as Record<string, unknown>)['uri']
  if (typeof uri !== 'string' || uri === '') return null

  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
  const record = (value: unknown): GroupModes =>
    typeof value === 'object' && value !== null ? (value as GroupModes) : {}
  const table = (value: unknown): TableUiState | undefined =>
    typeof value === 'object' && value !== null ? (value as TableUiState) : undefined
  // Its own narrowing rather than `record`'s: a `GroupModes` is one level deep
  // and this is two, so the cast the others share would be a lie that TypeScript
  // is right to refuse.
  const analysisRecord = (value: unknown): AnalysisMemory =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as AnalysisMemory)
      : {}
  const tables = record(row['tables']) as Record<string, unknown>

  return {
    kind: CONFIG_KIND,
    version: typeof row['version'] === 'number' ? row['version'] : CONFIG_VERSION,
    createdAt: typeof row['createdAt'] === 'string' ? row['createdAt'] : '',
    state: state as ViewState,
    tracks: list<StoredEntry>(row['tracks']),
    manual: list<ManualMark>(row['manual']),
    // Absent from every config written before §8.10, and read as no saved places
    // rather than as a broken file — the same tolerance every field here has.
    bookmarks: list<Bookmark>(row['bookmarks']),
    sequences: list<string>(row['sequences']).filter((name) => typeof name === 'string'),
    groups: record(row['groups']),
    scaling: record(row['scaling']),
    // Absent from every config written before §18 and read as an empty
    // workspace, which is the tolerance `CONFIG_VERSION`'s comment promises for
    // an *added* field: an older file opens in a newer viewer with the parts it
    // did not know about left at their defaults.
    analysis: analysisRecord(row['analysis']),
    compareNormalise: row['compareNormalise'] === true,
    tables: {
      ...tableOf('genomes', table(tables['genomes'])),
      ...tableOf('contigs', table(tables['contigs'])),
    },
    plot: (typeof row['plot'] === 'object' && row['plot'] !== null
      ? row['plot']
      : {}) as PlotOptions,
  }
}

/** `true` when a file name is worth reading as a config before anything else. */
export function looksLikeConfig(name: string): boolean {
  return /\.json$/i.test(name)
}

/**
 * Point a config's file names at wherever the config itself was found.
 *
 * An *exported* session names absolute URLs, because that is what the tab it
 * came from was reading. A config **published beside its data** should not: a
 * folder of data is a thing that gets copied — to a bucket, to a colleague's
 * bucket, to a directory served off a laptop — and a session naming one of
 * those absolutely is right in exactly one of them. So a relative name here
 * means *the file next to this config*, resolved against the config's own URL —
 * the same rule an `<img src>` in a page follows, and the reason `demo/yeast/`
 * is a directory anyone can copy anywhere.
 *
 * Absolute URIs are left exactly as they are, so an exported session is
 * untouched by this and a config may mix the two: a published session naming a
 * bucket alongside the tracks beside it is a reasonable thing to write.
 *
 * The `::entries/rep1` half of a URI is not part of the resolution — it names a
 * group *inside* the file — so it is split off, and put back on, by the reader's
 * own parser rather than by a second one written here.
 */
export function resolveConfig(config: SessionConfig, base: string): SessionConfig {
  const at = (uri: string): string => {
    let parsed
    try {
      parsed = parseUri(uri)
    } catch {
      // A URI with no file half is not one this can repair; `parseConfig`
      // already refused an empty `state.uri`, so this is a track naming nothing.
      return uri
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(parsed.path)) return uri
    return formatUri(new URL(parsed.path, base).href, parsed.group)
  }
  return {
    ...config,
    state: {
      ...config.state,
      uri: at(config.state.uri),
      ...(config.state.uri2 === undefined ? {} : { uri2: at(config.state.uri2) }),
    },
    tracks: config.tracks.map((track) =>
      track.source.kind !== 'remote' || track.source.url === undefined
        ? track
        : { ...track, source: { ...track.source, url: at(track.source.url) } },
    ),
  }
}

/** What one is called on the way out. */
export function configFileName(base: string, stamp: string): string {
  return `${base}-${stamp}.metacooler.json`
}
