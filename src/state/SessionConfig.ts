/**
 * A whole tab, written down.
 *
 * **One tab, and not a file.** What a reader saves is a *workspace* — every tab
 * in the window, in one file — and `state/workspace.ts` owns that. This module
 * owns what one of its entries is, which is also what the durable record keeps
 * per tab and what a share link carries one of. Three roads, one definition.
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

import { CIRCULAR_SCOPE } from './circular'
import { recall, remember } from './UiMemory'
import { ANALYSIS_SCOPE, type AnalysisMemory } from '../analysis/memory'
import { formatUri, parseUri } from '../uri'
import { parseMaps, readDeckLook, serialiseMaps, type DeckLocal, type DeckLook } from '../panels/deck'
import type { PanelLayout } from '../ui/SidePanel'
import { COMMIT, PRODUCER } from '../version'
import type { StoredEntry } from '../annotations/types'
import type { StoredLane } from '../annotations/store'
import type { Bookmark } from '../annotations/bookmarks'
import type { ManualMark } from '../annotations/manual'
import type { PlotOptions } from '../render/heatmap'
import type { TableUiState } from '../ui/VirtualTable'
import { canonicalUrl } from '../sources/rewrite'
import type { ViewState } from '../types'
import {
  MAP_NAMES_SCOPE,
  cleanMapNames,
  readMapNames,
  resolveMapNames,
  type MapNames,
} from '../ui/mapNames'

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
  /**
   * The format's version, carried per tab.
   *
   * Kept here rather than only on the file around it because a tab is what the
   * durable record and a share link hold one of, and each of those has to be
   * able to refuse a tab from a newer build on its own.
   */
  version: number
  /** When it was written, for the reader who finds four of them in a folder. */
  createdAt: string
  /**
   * Which build wrote this — `(meta)cooler 0.10.0`, or `… desktop`.
   *
   * Byte-identical to the string every exported PDF carries in its `/Producer`
   * field (`ui/export.ts`), and deliberately so: a figure and the session that
   * made it should answer *which build* the same way, because "which build made
   * this" is the first question asked when one of them came out wrong. A flat
   * string rather than a `{name, version, target}` object, because there is no
   * consumer that wants the parts and every reader wants the line.
   *
   * Optional on the way in: a file written before this existed is still a
   * session, and it simply cannot say.
   */
  producer?: string
  /**
   * Short commit hash, when the build had a git repository behind it.
   *
   * Absent rather than empty where it is unknown — `version.ts`'s own rule, and
   * the reason `buildLine()` filters before it joins. An empty string here would
   * be a claim that the build has no commit, which is a different thing from not
   * knowing.
   */
  commit?: string
  /**
   * Which file this session was made *from*, when that file was a local one.
   *
   * Not decoration, and not for display first: it closes a hole. A config names
   * its file by URI, and for a local file that URI is the bare filename. Opening
   * one goes through the grant store, which is keyed on that bare name and whose
   * collision guard compares only the name (`state/handles.ts`) — so a config
   * received from a colleague and naming `rep1.cool` opens **this** browser's
   * `rep1.cool`, with the sender's marks, bookmarks and colour limits drawn over
   * somebody else's data and every label on screen agreeing.
   *
   * The size and the modification time are what tell the two apart. They also
   * catch the quieter case of the same file re-run through a pipeline: same
   * name, same path, different numbers.
   *
   * **It informs and never vetoes.** `handles.ts` deliberately blesses a re-run
   * overwriting a file somebody is reading — the reader asked for *that file* —
   * and nothing here can distinguish that from a different file on another
   * machine. So a mismatch is said once, where the file is asked for, and the
   * session opens.
   *
   * Absent for a remote file, whose identity is its URL, and absent from a
   * shared link, where it would be metadata about a private machine that a
   * recipient can do nothing with (`state/shareLink.ts`).
   */
  source?: { name: string; size?: number; lastModified?: number }
  /**
   * What the reader calls this tab, where they have said.
   *
   * A tab is labelled by its file, which is the right default and a poor name
   * for the thing a reader is actually doing: four tabs reading
   * `matrix_1000.mcool` off four runs are four identical labels, and the file
   * name is the one part of them that is the same. So a tab can be named, and
   * the name is part of the session rather than of the window — it travels in
   * the workspace, in the durable record and in a share link, because a
   * workspace of six tabs whose names did not come back is six tabs the reader
   * has to open one at a time to tell apart.
   *
   * Absent means *call it after the file*, which is what every tab does until
   * somebody says otherwise. Absent rather than the file's own label, so a
   * renamed file — or the same session at another resolution — keeps following
   * its file rather than being frozen at the name it had when the session was
   * saved.
   */
  name?: string
  /** What is being looked at: the same object the URL hash carries. */
  state: ViewState
  /** Every loaded annotation, exactly as session storage keeps them (§8.6). */
  tracks: StoredEntry[]
  /** Hand-placed lines, arrowheads and rectangles on the map. */
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
  /**
   * Sequences the reader has declared **circular** (SPECS §8.15).
   *
   * A declaration rather than a reading — no contact map says whether a sequence
   * joins its own ends, and no statistic reliably infers it — so it belongs with
   * the tracks somebody loaded and the marks they drew rather than in the view
   * state beside `region=`. See `state/circular.ts`.
   *
   * Optional, so a workspace written before this existed imports as what it was:
   * nothing circular.
   */
  circular?: string[]
  /** Per-group stacking and scaling, by group name. */
  groups: GroupModes
  scaling: GroupModes
  /** Whether the compared file's counts are scaled to the first's bright end. */
  compareNormalise: boolean
  /** Sort, search and column filters for the two tables. */
  tables: { genomes?: TableUiState; contigs?: TableUiState }
  /**
   * The deck's furniture: the columns it was drawn in, and which panel wears
   * the star (§16.6).
   *
   * `state.maps` says *which* maps and has always travelled in the hash; these
   * two are the arrangement around them, and they were the one part of a
   * workspace this file read nothing of. So a deck of six exported at three
   * columns came back at whatever the importing window happened to compute, and
   * the Analysis column came back pointed at the lead rather than at the map the
   * sender was measuring — both silently, because both are legal decks.
   *
   * Nothing is validated here, and that is deliberate rather than an omission:
   * `PanelDeck` already refuses a column count it cannot use (`recallColumns`,
   * which rejects `0`, `NaN` and anything above `MAX_PANELS`) and already moves
   * a star naming a slot this deck did not build back onto the lead
   * (`keepStarPresent`). A second copy of those two rules here would be a second
   * place to keep them in step with the deck they are about.
   */
  deck: { starred?: string; columns?: number; locals?: DeckLocal[]; looks?: DeckLook[] }
  /**
   * The local second file, which the hash has never carried (§11, §5.7).
   *
   * `state.uri2` names a *remote* comparison, because that is the only kind a
   * recipient could open. A local one is as much part of the session as the
   * tracks are, and as private as they are, so it travels here — where a config
   * this browser wrote, or a workspace it remembered, can put it back and a
   * shared link still cannot.
   */
  compare?: string
  /**
   * What the reader called each map, when they called it anything.
   *
   * Keyed by the *file* each name is for, which is the same key
   * `deck.looks` uses and for the same reason: a slot id is minted per deck and
   * names nothing tomorrow, while a file is what a reader recognises. Every map
   * the session was holding is in here — the one it is of, the one it was
   * compared against, and every companion — because a name is a fact about the
   * session rather than about any one of its files (`ui/mapNames.ts`).
   *
   * Carried for the reason the tab's own name is: four tabs reading
   * `matrix_1000.mcool` off four runs are four identical labels, and so are four
   * cells of a deck. Losing them on import is losing the only part of the
   * arrangement that says what the figure is *of*.
   */
  mapNames?: Record<string, string>
  /**
   * Where each track was drawn, when the answer is not "on the lead" (§16.8).
   *
   * Keyed by the *file* each companion was showing rather than by its panel id,
   * because a panel id is minted per deck and would name nothing in the window
   * that opens this. Restored as a **seed**: the store parks them and puts each
   * one back as the matching companion opens, so a deck that comes back gets its
   * arrangement and one that does not leaves the tracks on the lead.
   */
  lanes?: StoredLane[]
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
  /**
   * Which columns were folded, and how wide the open ones were.
   *
   * A window-level setting carried in a session file for {@link plot}'s reason,
   * word for word: a folded Analysis column and a 520-pixel Annotations column
   * are what the sender was looking at, and a workspace that restored twelve
   * tracks into a column the reader had folded away restored the tracks and not
   * the arrangement. See `ui/SidePanel.ts`'s `PanelState`.
   *
   * Optional on the way in, like every field added after the format shipped: a
   * config written before this existed leaves the importing window's columns
   * exactly as it found them.
   */
  panels?: PanelLayout
}

/** `{ genomes: … }` when there is one, and nothing at all when there is not. */
function tableOf(
  which: 'genomes' | 'contigs',
  value: TableUiState | null | undefined,
): { genomes?: TableUiState; contigs?: TableUiState } {
  return value === null || value === undefined ? {} : { [which]: value }
}

/** `{ starred: … }` for whichever of the four the deck actually wrote. */
function deckOf(
  starred: string | null | undefined,
  columns: number | null | undefined,
  locals?: DeckLocal[] | null,
  looks?: DeckLook[] | null,
): SessionConfig['deck'] {
  return {
    ...(Array.isArray(locals) && locals.length > 0 ? { locals } : {}),
    // An empty list is no list: a deck nobody has recoloured writes nothing
    // rather than an empty array, so `applyConfig` can tell "this session says
    // the companions are on the lead's scale" from "this session predates the
    // field" — and the second must leave the importing tab alone.
    ...(Array.isArray(looks) && looks.length > 0 ? { looks } : {}),
    // An empty star is no star, matching the guard `PanelDeck`'s constructor
    // reads it back through; a non-finite column count is not a deck anybody
    // drew, and `recallColumns` would refuse it on the way back in anyway.
    ...(typeof starred === 'string' && starred !== '' ? { starred } : {}),
    ...(typeof columns === 'number' && Number.isFinite(columns) ? { columns } : {}),
  }
}

/** `{ lanes: … }` when tracks were drawn on companions, and nothing when not. */
function lanesOf(lanes: StoredLane[] | null | undefined): { lanes?: StoredLane[] } {
  return Array.isArray(lanes) && lanes.length > 0 ? { lanes } : {}
}

/**
 * A `source` block, checked field by field.
 *
 * The name is the only required part: a file with no size recorded is still a
 * file this session was made from, and saying so is better than saying nothing.
 * A size or a time that is not a number is dropped rather than repaired, because
 * a wrong number here would report a mismatch against a file that matches.
 */
function sourceOf(value: unknown): { source?: SessionConfig['source'] } {
  if (typeof value !== 'object' || value === null) return {}
  const row = value as Record<string, unknown>
  if (typeof row['name'] !== 'string' || row['name'] === '') return {}
  return {
    source: {
      name: row['name'],
      ...(typeof row['size'] === 'number' && Number.isFinite(row['size'])
        ? { size: row['size'] }
        : {}),
      ...(typeof row['lastModified'] === 'number' && Number.isFinite(row['lastModified'])
        ? { lastModified: row['lastModified'] }
        : {}),
    },
  }
}

/**
 * `{ mapNames: … }` for a session whose maps were named, and nothing otherwise.
 *
 * Absent rather than empty, on {@link nameOf}'s rule: a config that says nothing
 * about names leaves the importing tab's alone, and one that says `{}` would be
 * a session asserting that none of its maps has a name.
 */
function namesOf(names: MapNames): { mapNames?: MapNames } {
  return Object.keys(names).length === 0 ? {} : { mapNames: names }
}

/** `{ compare: … }` when a local second file was open, and nothing when not. */
function compareOf(uri: string | null | undefined): { compare?: string } {
  return typeof uri === 'string' && uri !== '' ? { compare: uri } : {}
}

/**
 * A `deck.locals` list, checked member by member.
 *
 * Untrusted like every other field read here, and with one consequence worth
 * naming: a member that survives this is only *well-formed*, not *current*. An
 * index pointing past the end of the deck it arrives beside is caught where the
 * two lists meet (`Session.rememberedCompanions`), because only there is it
 * knowable which of them is the newer.
 */
function localsOf(value: unknown): DeckLocal[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).filter((local): local is DeckLocal => {
    if (typeof local !== 'object' || local === null) return false
    const row = local as Partial<DeckLocal>
    return (
      typeof row.uri === 'string' &&
      row.uri !== '' &&
      typeof row.index === 'number' &&
      Number.isInteger(row.index) &&
      row.index >= 0
    )
  })
}

/**
 * Where a tab's name lives in session memory; see {@link SessionConfig.name}.
 *
 * Exported because `Session` writes it and this module reads it, and a string
 * literal in both places is one that drifts the first time either moves — with
 * nothing failing, since a scope nobody writes simply reads back empty.
 */
export const SESSION_NAME_SCOPE = 'session:name'

/** The `UiMemory` scopes one session's workspace is spread across. */
const SCOPES = {
  tracks: 'annotations',
  manual: 'manual-annotations',
  bookmarks: 'bookmarks',
  sequences: 'browser:sequences',
  circular: CIRCULAR_SCOPE,
  groups: 'browser:groups',
  scaling: 'browser:scaling',
  normalise: 'compare:normalise',
  genomes: 'table:genomes',
  contigs: 'table:contigs',
  analysis: ANALYSIS_SCOPE,
  starred: 'deck:starred',
  columns: 'deck:columns',
  locals: 'deck:locals',
  compareLocal: 'compare:local',
  mapNames: MAP_NAMES_SCOPE,
  lanes: 'deck:lanes',
  looks: 'deck:looks',
  name: SESSION_NAME_SCOPE,
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
  /**
   * How the window's columns stood, when the caller is a window that has any.
   *
   * Passed in beside {@link plot} rather than recalled, and for its reason: both
   * are the *window's* preferences rather than this session's, so neither is in
   * the per-session memory this function otherwise reads from. Absent for a
   * caller with no columns — the CLI is one — where a layout would be an
   * invention rather than a reading.
   */
  panels?: PanelLayout
  now: Date
  /**
   * The local file this session is of, when it is one — see {@link
   * SessionConfig.source}. Passed in rather than read out of storage, which is
   * the one exception to this function's own rule, because the identity of a
   * `File` is not something any store holds: it is on the object the drop
   * handed over, and nowhere else.
   */
  source?: { name: string; size?: number; lastModified?: number }
}): SessionConfig {
  const key = options.memoryKey
  return {
    version: CONFIG_VERSION,
    createdAt: options.now.toISOString(),
    // Stamped always, and the commit only where there is one. See the fields'
    // own docstrings for why absent beats empty.
    producer: PRODUCER,
    ...(COMMIT === '' ? {} : { commit: COMMIT }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...nameOf(recall<string>(key, SCOPES.name)),
    state: options.state,
    tracks: recall<StoredEntry[]>(key, SCOPES.tracks) ?? [],
    manual: recall<ManualMark[]>(key, SCOPES.manual) ?? [],
    bookmarks: recall<Bookmark[]>(key, SCOPES.bookmarks) ?? [],
    sequences: recall<string[]>(key, SCOPES.sequences) ?? [],
    ...circularOf(recall<string[]>(key, SCOPES.circular)),
    groups: recall<GroupModes>(key, SCOPES.groups) ?? {},
    scaling: recall<GroupModes>(key, SCOPES.scaling) ?? {},
    compareNormalise: recall<boolean>(key, SCOPES.normalise) ?? false,
    tables: {
      ...tableOf('genomes', recall<TableUiState>(key, SCOPES.genomes)),
      ...tableOf('contigs', recall<TableUiState>(key, SCOPES.contigs)),
    },
    analysis: recall<AnalysisMemory>(key, SCOPES.analysis) ?? {},
    deck: deckOf(
      recall<string>(key, SCOPES.starred),
      recall<number>(key, SCOPES.columns),
      recall<DeckLocal[]>(key, SCOPES.locals),
      recall<DeckLook[]>(key, SCOPES.looks),
    ),
    ...compareOf(recall<string>(key, SCOPES.compareLocal)),
    ...namesOf(readMapNames(key)),
    ...lanesOf(recall<StoredLane[]>(key, SCOPES.lanes)),
    plot: options.plot,
    ...(options.panels === undefined ? {} : { panels: options.panels }),
  }
}

/**
 * `{ circular: … }` for a file with a declared circular sequence, else nothing.
 *
 * Absent rather than empty, on the rule the fields around it follow: a config
 * that carries the key means *these and no others*, and one that does not means
 * *this build had nothing to say*, which is what an older workspace is.
 */
function circularOf(names: string[] | null): { circular?: string[] } {
  return Array.isArray(names) && names.length > 0 ? { circular: names } : {}
}

/** `{ name: … }` for a tab the reader has named, and nothing for one they have not. */
function nameOf(name: string | null | undefined): { name?: string } {
  return typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {}
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
  // Only where the config carries it, on the rule the deck's fields below use:
  // a workspace written before circularity existed must leave whatever this tab
  // already declared alone rather than clearing it.
  if (config.circular !== undefined) remember(key, SCOPES.circular, config.circular)
  remember(key, SCOPES.groups, config.groups)
  remember(key, SCOPES.scaling, config.scaling)
  remember(key, SCOPES.normalise, config.compareNormalise)
  if (config.tables.genomes !== undefined) remember(key, SCOPES.genomes, config.tables.genomes)
  if (config.tables.contigs !== undefined) remember(key, SCOPES.contigs, config.tables.contigs)
  // Absent from every config written before §18 existed, and a missing key is
  // an empty workspace rather than a broken one — the same tolerance every
  // field above is read with.
  if (config.analysis !== undefined) remember(key, SCOPES.analysis, config.analysis)
  // Each written only when the config carries it, so importing a session from
  // before these two existed leaves whatever this tab already had rather than
  // clearing the deck's arrangement to nothing.
  if (config.deck?.starred !== undefined) remember(key, SCOPES.starred, config.deck.starred)
  if (config.deck?.columns !== undefined) remember(key, SCOPES.columns, config.deck.columns)
  if (config.deck?.locals !== undefined) remember(key, SCOPES.locals, config.deck.locals)
  if (config.deck?.looks !== undefined) remember(key, SCOPES.looks, config.deck.looks)
  if (config.compare !== undefined) remember(key, SCOPES.compareLocal, config.compare)
  // On the same rule as the three lines above: a config written before maps
  // could be named must leave the names this tab already has alone rather than
  // clearing every map back to its file.
  if (config.mapNames !== undefined) remember(key, SCOPES.mapNames, config.mapNames)
  if (config.lanes !== undefined) remember(key, SCOPES.lanes, config.lanes)
  // Written only when the config names one, on the rule the three lines above
  // follow: importing a session from before tabs could be named must leave a tab
  // the reader has already named alone rather than clearing it back to its file.
  if (config.name !== undefined) remember(key, SCOPES.name, config.name)
}

/**
 * Why a file that is not a session is not one.
 *
 * A typed answer rather than `null`, because the three cases want three
 * different sentences and a bare `null` made two of them **false**: a file from
 * a newer build landed the reader on "is a JSON file but not a saved workspace",
 * and a link from one on "may have been cut short in transit". Both send
 * somebody to inspect the wrong thing — the file, or their network — when what
 * is actually wrong is the build they are holding.
 */
export type ConfigRefusal =
  | { reason: 'not-json' }
  | { reason: 'not-a-workspace' }
  /**
   * A JSON file that is not a **store** (§24.1, `state/store.ts`).
   *
   * Its own reason rather than a second use of `not-a-workspace`, on the
   * argument the docstring above makes about the other two: the two formats
   * arrive through different doors and are written by different things — a
   * workspace by the save button, a store by `scripts/make_store.py` or by hand —
   * so a reader who pasted a workspace URL into the store box has to be told
   * which of the two they are holding. One sentence saying "not a workspace"
   * about a file that *is* one sends them to inspect the wrong thing.
   */
  | { reason: 'not-a-store' }
  | { reason: 'newer'; version: number; producer?: string }

/**
 * `true` when a reader answered with a refusal rather than the thing asked for.
 *
 * Takes any object, because there are two readers now — one for a tab and one
 * for the file around it — and both answer with the same refusals. Narrowing it
 * to one of them would mean a second identical guard for the other.
 */
export function isRefusal<T extends object>(value: T | ConfigRefusal): value is ConfigRefusal {
  return 'reason' in value
}

/**
 * What to tell the reader, in one sentence, about a file that was refused.
 *
 * A pure function so the wording is testable without a `Session` and identical
 * on all three roads a config travels — a dropped file, a fetched URL, and the
 * CLI. `label` is what the reader calls the thing: a file name, or a URL.
 */
export function refusalMessage(refusal: ConfigRefusal, label: string): string {
  if (refusal.reason === 'not-json') {
    return `${label} is not a JSON file, so it is not a saved workspace.`
  }
  if (refusal.reason === 'newer') {
    // Names both numbers and the build, because the fix is not to the file: it
    // is to update the viewer, or to save the session again from this one.
    const from = refusal.producer === undefined ? '' : ` — ${refusal.producer}`
    return (
      `${label} was saved by a newer version of the viewer${from}, in workspace format ` +
      `${refusal.version}. This build reads format ${CONFIG_VERSION}. Update the viewer, or ` +
      'ask for the session to be saved again from this one.'
    )
  }
  if (refusal.reason === 'not-a-store') {
    // Names the shape rather than only the failure, because a store is the one of
    // these formats a reader may well be about to write by hand — it is four
    // keys over a list — and "not a store" with nothing after it is a message
    // they can do nothing with.
    return (
      `${label} is a JSON file but not a store — it does not name itself as one. ` +
      'A store declares {"kind": "metacooler.store", "version": 1, "entries": [...]}, and ' +
      'scripts/make_store.py writes one.'
    )
  }
  return (
    `${label} is a JSON file but not a saved workspace — it does not name itself as one. ` +
    'A workspace is written by the save button in the top bar.'
  )
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
export function readTab(parsed: unknown): SessionConfig | ConfigRefusal {
  if (typeof parsed !== 'object' || parsed === null) return { reason: 'not-a-workspace' }
  const row = parsed as Record<string, unknown>
  // No `kind` on a tab: the *file* names itself once, and a second name inside
  // every entry would be a claim to keep in step with nothing. What identifies a
  // tab is that it says what it is looking at.
  const state = row['state']
  if (typeof state !== 'object' || state === null) return { reason: 'not-a-workspace' }
  const uri = (state as Record<string, unknown>)['uri']
  if (typeof uri !== 'string' || uri === '') return { reason: 'not-a-workspace' }

  // The one check that belongs to *identity* rather than to a field, and the
  // reason it is here rather than among the tolerant reads below. `version` is
  // not a value this format carries; it is a claim about what every other value
  // in the file **means**. A bump says a field this build reads means something
  // else now, and nothing in a v1 build can know which field moved — so reading
  // on would be drawing somebody's `vmin` as a log10 value when they wrote a
  // percentile, with every label on screen agreeing.
  //
  // Deliberately no "open anyway". The button would be an offer to be silently
  // wrong, and the honest fix when a bump finally happens is a `migrate(row,
  // from)` call on this line rather than a way past it.
  const version = typeof row['version'] === 'number' ? row['version'] : CONFIG_VERSION
  if (version > CONFIG_VERSION) {
    const producer = row['producer']
    return {
      reason: 'newer',
      version,
      ...(typeof producer === 'string' && producer !== '' ? { producer } : {}),
    }
  }

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
  const deck = record(row['deck']) as Record<string, unknown>

  return {
    version,
    // Read tolerantly, like every other field: a session written before these
    // existed is still a session, and one written by a build that could not
    // find its own git repository is too.
    ...(typeof row['producer'] === 'string' && row['producer'] !== ''
      ? { producer: row['producer'] }
      : {}),
    ...(typeof row['commit'] === 'string' && row['commit'] !== ''
      ? { commit: row['commit'] }
      : {}),
    ...sourceOf(row['source']),
    ...nameOf(typeof row['name'] === 'string' ? row['name'] : undefined),
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
    // Absent from every config written before the deck's furniture was carried,
    // and read as "this deck was never arranged" rather than as a broken file —
    // the same tolerance `analysis` above is read with.
    deck: deckOf(
      typeof deck['starred'] === 'string' ? deck['starred'] : undefined,
      typeof deck['columns'] === 'number' ? deck['columns'] : undefined,
      localsOf(deck['locals']),
      looksOf(deck['looks']),
    ),
    ...compareOf(typeof row['compare'] === 'string' ? row['compare'] : undefined),
    // Through `ui/mapNames.ts`'s own reader rather than a second one here, on
    // `looksOf`'s rule: what a name is — and how long, and what an empty one
    // means — belongs beside the store that keeps them.
    ...namesOf(cleanMapNames(row['mapNames'])),
    ...lanesOf(Array.isArray(row['lanes']) ? (row['lanes'] as StoredLane[]) : undefined),
    plot: (typeof row['plot'] === 'object' && row['plot'] !== null
      ? row['plot']
      : {}) as PlotOptions,
    ...panelsOf(row['panels']),
  }
}

/**
 * A `deck.looks` list, checked member by member.
 *
 * Through `panels/deck.ts`'s own reader rather than a second one written here,
 * on `resolveConfig`'s rule about `parseMaps`: the deck owns what a look is, and
 * a validator that drifted from it would restore a companion onto a transform
 * this build has no name for and draw a blank rectangle.
 */
function looksOf(value: unknown): DeckLook[] {
  if (!Array.isArray(value)) return []
  const out: DeckLook[] = []
  for (const entry of value as unknown[]) {
    const look = readDeckLook(entry)
    if (look !== null) out.push(look)
  }
  return out
}

/**
 * A `panels` record, checked column by column.
 *
 * Keys are not checked against the five columns this build has: a key naming a
 * panel that does not exist is simply never asked for, and refusing the whole
 * record over one would lose a layout to a column that was renamed.
 */
function panelsOf(value: unknown): { panels?: PanelLayout } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: PanelLayout = {}
  for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
    if (typeof held !== 'object' || held === null) continue
    const row = held as Record<string, unknown>
    if (typeof row['folded'] !== 'boolean') continue
    const width = row['width']
    out[key] = {
      folded: row['folded'],
      ...(typeof width === 'number' && Number.isFinite(width) && width > 0 ? { width } : {}),
    }
  }
  return Object.keys(out).length === 0 ? {} : { panels: out }
}

/**
 * The same read, for the road that has nowhere to put a reason.
 *
 * The durable record arrives somewhere that can only show or not show a thing,
 * so it takes the `null` and inherits every refusal above — including the
 * version gate, which is the point: it would otherwise be the one road that
 * silently misread a tab from a newer build.
 */
export function parseTab(parsed: unknown): SessionConfig | null {
  const read = readTab(parsed)
  return isRefusal(read) ? null : read
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
 *
 * ## It also *drops* two fields, which is not the same job
 *
 * This function is reached from exactly two places, and both mean **this config
 * arrived from somewhere that is not this machine**. That is the strongest
 * signal available about a name, and it licenses more than resolution: a
 * *private* name — one that can only ever have meant a file on the sender's own
 * disk — is removed rather than repaired.
 *
 * `compare` and `deck.locals` are both bare local filenames, and leaving them is
 * the worst of the three options. `Session` resolves them through
 * `resolveSource` → `resolveHandle`, where a grant is keyed on the bare name and
 * the collision guard compares only `file.name` (`state/handles.ts`). So a
 * recipient who has ever granted their own `rep2.cool` opens **their** file in
 * the sender's slot, with every label on screen agreeing with them. Resolving
 * the names instead would mint a URL for a file that was never published — a 404
 * where an honest drop rectangle used to be.
 *
 * Dropping costs only a *label*: `state.maps` still carries `~` for the slot, so
 * the count, the order and the drop rectangle all survive (§16.6).
 *
 * The rule that decides all of this, and the reason a *local track* is kept:
 * **a private name is stripped only where the structure survives without it.**
 * A dropped companion costs a label; a dropped track costs the row, and a
 * recipient silently receiving seven tracks where eight were sent is the exact
 * failure the `~` placeholder exists to prevent.
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
    // Canonicalised either way, because both roads end in a URI this session
    // will open and write into its own links (SPECS §24.5). A published
    // workspace may name `gs://` or a Drive share link absolutely, and one
    // resolved against a config's own URL cannot become either — but running the
    // table over both is one call and keeps the rule *every URI is canonical*
    // true without a caller having to know which branch it took.
    if (/^[a-z][a-z0-9+.-]*:/i.test(parsed.path)) return canonicalUrl(uri)
    return canonicalUrl(formatUri(new URL(parsed.path, base).href, parsed.group))
  }

  // Through the deck's own pair, never a second `|` splitter written here. The
  // escaping invariant — a raw pipe separates, `%7C` inside a member is data —
  // lives in `panels/deck.ts`, and its comment says what a second copy costs: a
  // config that resolves to a *different number of maps* than were written, with
  // no error anywhere. Two normalisations come with the reuse and are both
  // already applied downstream by `Session.syncDeck`: empty segments are
  // dropped, and the list is capped at `MAX_PANELS - 1`.
  const maps =
    config.state.maps === undefined
      ? undefined
      : serialiseMaps(
          parseMaps(config.state.maps).map((ref) =>
            ref.kind === 'remote' ? { ...ref, uri: at(ref.uri) } : ref,
          ),
        )

  // `deck` minus its `locals`, keeping the arrangement. Written out rather than
  // spread-and-delete so the omission is visible at the call site.
  // `?? {}` for the reason `forSharing` has one: this takes whatever it is
  // handed, and refusing to resolve a published session because it omits a field
  // would be a worse failure than the one being fixed.
  const held = config.deck ?? {}
  const deck: SessionConfig['deck'] = {
    ...(held.starred === undefined ? {} : { starred: held.starred }),
    ...(held.columns === undefined ? {} : { columns: held.columns }),
    // Resolved and **kept**, where `locals` beside it is dropped, and the rule
    // that separates them is the one stated above: a private name is stripped
    // only where the structure survives without it. A look is keyed on the file
    // it describes, so a look whose key was stripped is not a look at all — and
    // the thing it would restore onto a recipient's same-named file is a colour
    // clip, which is a picture rather than a door. The same trade `lanes` makes
    // one field down, and through the same `at()`.
    ...(held.looks === undefined
      ? {}
      : { looks: held.looks.map((look) => ({ ...look, uri: at(look.uri) })) }),
  }

  const resolved: SessionConfig = {
    ...config,
    state: {
      ...config.state,
      uri: at(config.state.uri),
      ...(config.state.uri2 === undefined ? {} : { uri2: at(config.state.uri2) }),
      ...(maps === undefined ? {} : { maps }),
    },
    tracks: config.tracks.map((track) =>
      track.source.kind !== 'remote' || track.source.url === undefined
        ? track
        : { ...track, source: { ...track.source, url: at(track.source.url) } },
    ),
    deck,
    // Through the **same** `at()` as `maps`, and that pairing is load-bearing: a
    // `StoredLane.uri` is the companion's file URI and `adoptHome` matches it by
    // string equality, so resolving one and not the other puts every placed
    // track on the lead — which is a perfectly legal lane, so nothing reports
    // anything and the deck simply comes back wrong.
    ...(config.lanes === undefined
      ? {}
      : { lanes: config.lanes.map((lane) => ({ ...lane, uri: at(lane.uri) })) }),
    // Through the same `at()` for the same reason: a name is keyed on the file
    // it is for, so one left relative names a file nothing will ever ask about.
    ...(config.mapNames === undefined
      ? {}
      : namesOf(resolveMapNames(config.mapNames, at))),
  }
  // Deleted rather than set to `undefined`, so the field is *absent* exactly as
  // `parseConfig` leaves it for a config that never had one — a key present and
  // holding nothing is a third state, and every reader here treats absence as
  // the answer.
  delete resolved.compare
  return resolved
}


