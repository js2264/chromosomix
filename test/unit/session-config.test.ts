/**
 * One tab written down, and read back.
 *
 * The round trip is the whole contract, and the two halves are asymmetric in a
 * way worth pinning: writing gathers up what storage already holds, so it cannot
 * drift from what a reload restores; reading has to survive a file written by a
 * different build, or by a text editor, or by something else entirely.
 *
 * A tab is not a file. `state/workspace.ts` owns the file — the thing with a
 * `kind`, a list of tabs and an active index — and its own suite covers that
 * wrapper. Everything here is about one entry inside it, which is also what a
 * share link carries one of and what the durable record keeps per tab.
 */

import { describe, expect, it } from 'vitest'

import {
  CONFIG_VERSION,
  applyConfig,
  buildConfig,
  looksLikeConfig,
  parseTab,
  readTab,
  refusalMessage,
  resolveConfig,
  isRefusal,
  type ConfigRefusal,
  type SessionConfig,
} from '@/state/SessionConfig'
import { MAPS_SEPARATOR, VACANT, parseMaps, type PanelRef } from '@/panels/deck'
import { recall, remember } from '@/state/UiMemory'
import { DEFAULT_UI_PLOT_OPTIONS } from '@/ui/plotOptions'
import { COMMIT, PRODUCER } from '@/version'
import type { ViewState } from '@/types'

const STATE: ViewState = {
  uri: 'https://example.org/yeast.cool',
  view: 'region',
  region: 'IV:400,000-500,000',
  transform: 'log10',
  colormap: 'fall',
  vmin: -4,
  vmax: -1.5,
  balance: true,
}

const TRACK = {
  id: 'a1',
  card: 'linear' as const,
  kind: 'track' as const,
  label: 'ATAC',
  source: { kind: 'remote' as const, name: 'ATAC.bw', url: 'https://example.org/ATAC.bw' },
  visible: true,
  placement: { bottom: true, right: false },
  style: {
    colour: '#1f5fa9',
    size: 90,
    mode: 'area' as const,
    limits: { auto: false, min: 0, max: 12 },
    group: 'reads',
    shape: 'element' as const,
    radius: 7,
    opacity: 1,
    flip: false,
  },
}

const BOOKMARK = {
  id: 'b7',
  label: 'the loop',
  contig: 'IV',
  start: 400000,
  end: 460000,
  binsize: 1000,
}

/**
 * Through the JSON a file actually holds, and back.
 *
 * `parseTab` takes a parsed value rather than text, because the file around it
 * has already done the parsing and a second `JSON.parse` per tab would be a
 * second place for "this is not JSON" to be decided. The stringify here is not
 * ceremony: it is what turns a live object into the untrusted shape the reader
 * is written against, and it is where an unserialisable field would show up.
 */
function roundTrip(value: unknown): SessionConfig | null {
  return parseTab(JSON.parse(JSON.stringify(value)))
}

// No storage to clear: `UiMemory` falls back to a module-level map when there
// is no `window`, which is what a node test has. Each test uses keys of its own.
describe('buildConfig', () => {
  it('gathers the view state and every scope of the session’s memory', () => {
    const key = 'build|yeast.cool'
    remember(key, 'annotations', [TRACK])
    remember(key, 'manual-annotations', [{ id: 'm1', kind: 'line', axis: 'both', at: { contig: 'IV', bp: 12 }, colour: '#000' }])
    remember(key, 'browser:sequences', ['IV', 'XII'])
    remember(key, 'browser:groups', { reads: 'overlay' })
    remember(key, 'browser:scaling', { reads: 'each' })
    remember(key, 'bookmarks', [
      { id: 'b1', label: 'anchor_A', contig: 'IV', start: 400000, end: 460000, binsize: 1000 },
    ])
    remember(key, 'compare:normalise', true)
    remember(key, 'table:contigs', { filters: {}, search: 'chr', sortKey: 'length', sortDir: -1 })
    remember(key, 'deck:starred', 'p2')
    remember(key, 'deck:columns', 3)

    const config = buildConfig({
      state: STATE,
      memoryKey: key,
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date('2026-08-05T10:00:00Z'),
    })

    expect(config.createdAt).toBe('2026-08-05T10:00:00.000Z')
    expect(config.state).toEqual(STATE)
    expect(config.tracks).toEqual([TRACK])
    expect(config.manual).toHaveLength(1)
    // Saved places (§8.10): a list of loci walked one after another is work, it is
    // not in the URL, and it is exactly the kind of thing handed to a colleague.
    expect(config.bookmarks).toEqual([
      { id: 'b1', label: 'anchor_A', contig: 'IV', start: 400000, end: 460000, binsize: 1000 },
    ])
    expect(config.sequences).toEqual(['IV', 'XII'])
    expect(config.groups).toEqual({ reads: 'overlay' })
    expect(config.scaling).toEqual({ reads: 'each' })
    expect(config.compareNormalise).toBe(true)
    expect(config.tables.contigs?.search).toBe('chr')
    // Absent rather than present-and-empty: a table nobody sorted has no state,
    // and writing one would put a default back over a later default.
    expect(config.tables.genomes).toBeUndefined()
    // The deck's furniture (§16.6). `state.maps` says which maps; these two say
    // how they were arranged and which one the Analysis column was reading, and
    // they were the two scopes this function used to walk straight past.
    expect(config.deck).toEqual({ starred: 'p2', columns: 3 })
  })

  /**
   * Which build wrote it.
   *
   * Asserted against the **imported** constant and never against a literal like
   * `'(meta)cooler 0.10.0'`. `version.ts` reads its values from a `define`
   * substitution that vitest does not apply, so the test runtime takes the
   * fallback path — a literal would pass here and fail in a real build, or the
   * reverse, and either way it would be testing the test.
   */
  it('stamps which build wrote it, the way an exported PDF does', () => {
    const config = buildConfig({
      state: STATE,
      memoryKey: 's9|provenance',
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })
    expect(config.producer).toBe(PRODUCER)
    // Absent rather than empty where there is no git behind the build — the rule
    // `buildLine()` follows, and the difference between "no commit" and "cannot
    // say".
    if (COMMIT === '') expect('commit' in config).toBe(false)
    else expect(config.commit).toBe(COMMIT)
  })

  it('describes an untouched session as an empty workspace, not as nothing', () => {
    const config = buildConfig({
      state: STATE,
      memoryKey: 's9|nothing',
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })
    expect(config.tracks).toEqual([])
    expect(config.sequences).toEqual([])
    expect(config.compareNormalise).toBe(false)
  })
})

describe('the round trip', () => {
  it('survives JSON, and lands under the importing session’s own key', () => {
    const key = 'trip|yeast.cool'
    remember(key, 'annotations', [TRACK])
    remember(key, 'bookmarks', [BOOKMARK])
    remember(key, 'browser:sequences', ['IV'])
    const config = buildConfig({
      state: STATE,
      memoryKey: key,
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })

    const read = roundTrip(config)
    expect(read).not.toBeNull()
    expect(read?.state).toEqual(STATE)
    expect(read?.tracks).toEqual([TRACK])
    expect(read?.bookmarks).toEqual([BOOKMARK])

    // …into a *different* tab, under a *different* name for the same file.
    applyConfig(read as NonNullable<typeof read>, 's7|dropped.cool')
    expect(recall('s7|dropped.cool', 'annotations')).toEqual([TRACK])
    expect(recall('s7|dropped.cool', 'browser:sequences')).toEqual(['IV'])
    expect(recall('s7|dropped.cool', 'bookmarks')).toEqual([BOOKMARK])
    // The exporting session's own memory is untouched by the import.
    expect(recall(key, 'annotations')).toEqual([TRACK])
  })

  it('carries the deck’s arrangement into the importing session', () => {
    const key = 'deck|six.cool'
    remember(key, 'deck:starred', 'p4')
    remember(key, 'deck:columns', 2)
    const config = buildConfig({
      state: { ...STATE, maps: 'a.cool|b.cool' },
      memoryKey: key,
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })

    const read = roundTrip(config)
    expect(read?.deck).toEqual({ starred: 'p4', columns: 2 })
    applyConfig(read as NonNullable<typeof read>, 's3|six.cool')
    expect(recall('s3|six.cool', 'deck:starred')).toBe('p4')
    expect(recall('s3|six.cool', 'deck:columns')).toBe(2)
  })

  it('leaves an importing tab’s deck alone when the config predates the field', () => {
    // A session written before the deck's furniture travelled. The two keys must
    // be left as they are rather than cleared, because "this file says nothing
    // about a deck" and "this file says the deck has no star" are different
    // claims and only the second is a reason to forget one.
    remember('s4|old.cool', 'deck:starred', 'p1')
    remember('s4|old.cool', 'deck:columns', 4)
    const read = parseTab({ state: STATE })
    expect(read?.deck).toEqual({})
    applyConfig(read as NonNullable<typeof read>, 's4|old.cool')
    expect(recall('s4|old.cool', 'deck:starred')).toBe('p1')
    expect(recall('s4|old.cool', 'deck:columns')).toBe(4)
  })

  it('drops a star and a column count that are not ones', () => {
    // Stored state outlives the build that wrote it (§8.6), and both of these
    // reach `PanelDeck` — a `columns` of `NaN` divides the grid into no columns
    // at all, and an empty star names no map.
    const read = parseTab({ state: STATE, deck: { starred: '', columns: 'three' } })
    expect(read?.deck).toEqual({})
  })

  it('names itself nowhere, because the file around it does that once', () => {
    // The clean break. A tab used to carry its own `kind`, which made sense when
    // a file *was* a tab; now that a file holds several, a second name inside
    // every entry would be a claim with nothing to check it against and one more
    // thing to keep in step.
    const config = buildConfig({
      state: STATE,
      memoryKey: 's9|unnamed',
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })
    expect('kind' in config).toBe(false)
    expect(JSON.stringify(config)).not.toContain('metacooler.workspace')
  })
})

describe('parseTab', () => {
  it('refuses anything that is not a tab looking at something', () => {
    expect(parseTab('not a tab')).toBeNull()
    expect(parseTab(null)).toBeNull()
    expect(parseTab([])).toBeNull()
    expect(parseTab({ name: 'my-package', version: '1.0.0' })).toBeNull()
    // What identifies a tab is that it says what it is looking at — there is no
    // `kind` to check any more, so an empty state is the whole guard.
    expect(parseTab({})).toBeNull()
    expect(parseTab({ state: { view: 'region' } })).toBeNull()
  })

  it('reads a session that cannot say which build wrote it', () => {
    // Every file written before provenance existed. Absent is not empty and not
    // a broken file — it is a session that simply cannot answer.
    const read = parseTab({ state: STATE })
    expect('producer' in (read as object)).toBe(false)
    expect('commit' in (read as object)).toBe(false)
    // …and an empty string is read as the same thing, since a build with no git
    // behind it writes nothing rather than an empty hash.
    const blank = parseTab({ state: STATE, producer: '', commit: '' })
    expect('producer' in (blank as object)).toBe(false)
  })

  it('tolerates every field but the state being absent', () => {
    const read = parseTab({ state: STATE })
    expect(read?.tracks).toEqual([])
    expect(read?.manual).toEqual([])
    expect(read?.bookmarks).toEqual([])
    expect(read?.sequences).toEqual([])
    expect(read?.groups).toEqual({})
    expect(read?.compareNormalise).toBe(false)
    expect(read?.tables).toEqual({})
  })

  it('drops a sequences list that is not one', () => {
    const read = parseTab({ state: STATE, sequences: ['IV', 7, null] })
    expect(read?.sequences).toEqual(['IV'])
  })
})

/**
 * The four things a session is that a session file did not used to say.
 *
 * Each was invisible in the same way: the file opened, the tab came back, and
 * one decision the reader had made was quietly the importing window's instead.
 */
describe('what a tab carries beyond its tracks', () => {
  it('carries the name the reader gave the tab', () => {
    const key = 'named|yeast.cool'
    remember(key, 'session:name', 'wild type')
    const config = buildConfig({
      state: STATE,
      memoryKey: key,
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })
    expect(config.name).toBe('wild type')
    expect(roundTrip(config)?.name).toBe('wild type')

    // Into the *importing* tab's key, like every other scope.
    applyConfig(config, 'other|yeast.cool')
    expect(recall<string>('other|yeast.cool', 'session:name')).toBe('wild type')
  })

  it('says nothing at all about a tab nobody has named', () => {
    const config = buildConfig({
      state: STATE,
      memoryKey: 'unnamed|yeast.cool',
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })
    // Absent rather than the file's own label: a name frozen at export time
    // would stop following the file it was named after, and `applyConfig` would
    // then write it over a tab the importing reader had named themselves.
    expect('name' in config).toBe(false)
    applyConfig(config, 'kept|yeast.cool')
    remember('kept|yeast.cool', 'session:name', 'mine')
    applyConfig(config, 'kept|yeast.cool')
    expect(recall<string>('kept|yeast.cool', 'session:name')).toBe('mine')
  })

  it('carries which columns were folded, and how wide they were', () => {
    const panels = {
      'metacooler-viewer:annotations-collapsed': { folded: false, width: 460 },
      'metacooler-viewer:analysis-collapsed': { folded: true },
    }
    const config = buildConfig({
      state: STATE,
      memoryKey: 'panels|yeast.cool',
      plot: DEFAULT_UI_PLOT_OPTIONS,
      panels,
      now: new Date(0),
    })
    expect(roundTrip(config)?.panels).toEqual(panels)
  })

  it('drops a panel record that does not say whether it is folded', () => {
    const read = parseTab({
      state: STATE,
      panels: {
        good: { folded: true },
        vague: { width: 300 },
        wrong: 7,
        // A width that is not a width is dropped on its own — the fold beside it
        // is still worth honouring.
        odd: { folded: false, width: 'wide' },
      },
    })
    expect(read?.panels).toEqual({ good: { folded: true }, odd: { folded: false } })
  })

  it('carries how each companion of a deck was drawn', () => {
    const key = 'looks|yeast.cool'
    const looks = [
      { uri: 'https://example.org/rep2.cool', transform: 'log10', vmax: 2.5, score: 'balanced' },
      { uri: 'https://example.org/rep3.cool', colormap: 'fall', locked: false },
    ]
    remember(key, 'deck:looks', looks)
    const config = buildConfig({
      state: STATE,
      memoryKey: key,
      plot: DEFAULT_UI_PLOT_OPTIONS,
      now: new Date(0),
    })
    expect(config.deck.looks).toEqual(looks)
    // A deck of four replicates each clipped to its own depth is *the* thing a
    // deck is arranged for, and it used to be the one part of it that did not
    // come back.
    expect(roundTrip(config)?.deck.looks).toEqual(looks)
  })

  it('drops the parts of a look this build cannot read, and keeps the rest', () => {
    const read = parseTab({
      state: STATE,
      deck: {
        looks: [
          { uri: 'a.cool', transform: 'arcsinh', colormap: 'fall', vmax: 'lots' },
          { uri: '', colormap: 'fall' },
          'not a look',
        ],
      },
    })
    // A transform this build has no name for would draw a blank rectangle, and a
    // clip that is not a number is a clip nothing is ever inside — both go, and
    // the ramp beside them stays. A look with no file to be about is not one.
    expect(read?.deck.looks).toEqual([{ uri: 'a.cool', colormap: 'fall' }])
  })

  it('leaves the importing tab alone where the file predates a field', () => {
    remember('older|yeast.cool', 'deck:looks', [{ uri: 'mine.cool', vmax: 9 }])
    remember('older|yeast.cool', 'session:name', 'mine')
    applyConfig(parseTab({ state: STATE }) as SessionConfig, 'older|yeast.cool')
    // The tolerance `CONFIG_VERSION`'s own comment promises for an added field:
    // an older file opens with the parts it did not know about left as they were.
    expect(recall<unknown[]>('older|yeast.cool', 'deck:looks')).toHaveLength(1)
    expect(recall<string>('older|yeast.cool', 'session:name')).toBe('mine')
  })
})

/**
 * A session published beside its data, rather than exported from a tab.
 *
 * The asymmetry that makes this necessary: an exported session names the URLs
 * the tab it came from was reading, and those are absolute by construction. A
 * session that ships *with* the files it names cannot be — the same directory
 * is served from `/` in dev, `/<repo>/` on Pages and a third origin in the
 * desktop build — so it names them relatively and this is where they are made
 * real again.
 */
/** A ref's URI, or `undefined` for a vacancy — which has none by construction. */
function uriOf(ref: PanelRef | undefined): string | undefined {
  return ref === undefined || ref.kind === 'vacant' ? undefined : ref.uri
}

describe('resolveConfig', () => {
  const base = 'https://example.org/app/demo/workspace.metacooler.json'
  const relative = parseTab({
    state: { uri: 'yeast.cool', view: 'region', region: 'IV' },
    tracks: [
      { ...TRACK, source: { kind: 'remote', name: 'ATAC.bw', url: 'ATAC.bw' } },
      { ...TRACK, id: 'a2', source: { kind: 'local', name: 'dropped.bw' } },
    ],
  })

  it('resolves what a config names against where the config is', () => {
    const config = resolveConfig(relative as NonNullable<typeof relative>, base)
    expect(config.state.uri).toBe('https://example.org/app/demo/yeast.cool')
    expect(config.tracks[0].source.url).toBe('https://example.org/app/demo/ATAC.bw')
    // A local track has no URL to resolve and must not grow one.
    expect(config.tracks[1].source).toEqual({ kind: 'local', name: 'dropped.bw' })
  })

  it('leaves an exported session exactly as it was', () => {
    const exported = parseTab({ state: STATE, tracks: [TRACK] })
    const config = resolveConfig(exported as NonNullable<typeof exported>, base)
    expect(config.state.uri).toBe(STATE.uri)
    expect(config.tracks[0].source.url).toBe(TRACK.source.url)
  })

  it('resolves the file half of a `file::group` URI and keeps the group', () => {
    const collection = parseTab({ state: { uri: 'mock.mmetacool::entries/1000', view: 'genomes' } })
    expect(resolveConfig(collection as NonNullable<typeof collection>, base).state.uri).toBe(
      'https://example.org/app/demo/mock.mmetacool::/entries/1000',
    )
  })

  it('resolves the compared file too', () => {
    const pair = parseTab({ state: { uri: 'a.cool', uri2: 'b.cool', view: 'region' } })
    expect(resolveConfig(pair as NonNullable<typeof pair>, base).state.uri2).toBe(
      'https://example.org/app/demo/b.cool',
    )
  })

  /**
   * The deck, which is the half a published session used to lose entirely.
   *
   * `state.maps` was not resolved at all, so a session published beside its data
   * handed `PanelDeck.build` a bare `rep2.cool` — fetched against the *site
   * root* on the web and against `app://viewer/` in the desktop build. The
   * companion cell simply failed to load, and it read as a broken deck rather
   * than as an unresolved name.
   */
  const deckConfig = (over: Record<string, unknown> = {}) =>
    parseTab({
      state: {
        uri: 'lead.cool',
        view: 'region',
        maps: `rep2.cool${MAPS_SEPARATOR}${VACANT}${MAPS_SEPARATOR}https://other.org/rep4.cool`,
      },
      ...over,
    }) as SessionConfig

  it('resolves every map of a deck, and leaves a vacancy vacant', () => {
    const refs = parseMaps(resolveConfig(deckConfig(), base).state.maps)
    expect(refs).toEqual([
      { kind: 'remote', uri: 'https://example.org/app/demo/rep2.cool' },
      { kind: 'vacant' },
      // Already absolute: an exported session is untouched, and a published one
      // may legitimately mix the two.
      { kind: 'remote', uri: 'https://other.org/rep4.cool' },
    ])
  })

  it('keeps a map name that contains an escaped separator intact', () => {
    // The reason this goes through `parseMaps`/`serialiseMaps` rather than a
    // second `|` split written here: a raw pipe separates and `%7C` inside a
    // member is data, and a second copy of that rule fails by resolving to a
    // *different number of maps* than were written.
    const odd = parseTab({
      state: { uri: 'lead.cool', view: 'region', maps: 'we%7Cird.cool' },
    }) as SessionConfig
    expect(parseMaps(resolveConfig(odd, base).state.maps)).toEqual([
      { kind: 'remote', uri: 'https://example.org/app/demo/we|ird.cool' },
    ])
  })

  it('puts a lane on the same map the deck resolved', () => {
    // Written as a property rather than against a literal, because the failure
    // it guards is *both halves disagreeing*: a `StoredLane.uri` is matched
    // against the companion's file URI by string equality in `adoptHome`, so
    // resolving `maps` and not `lanes` puts every placed track on the lead —
    // a perfectly legal lane, drawn without complaint, and wrong.
    const withLanes = deckConfig({
      lanes: [{ track: 'a1', uri: 'rep2.cool', placement: { bottom: true }, borrowedLead: true }],
    })
    const out = resolveConfig(withLanes, base)
    expect(out.lanes?.[0].uri).toBe(uriOf(parseMaps(out.state.maps)[0]))
    expect(out.lanes?.[0].uri).toBe('https://example.org/app/demo/rep2.cool')
  })

  it('puts a companion’s scale on the same map the deck resolved', () => {
    // The lane's property one field down, and the same failure if it drifts: a
    // `DeckLook.uri` is matched against the companion's file URI, so resolving
    // `maps` and not `looks` restores four replicates onto the lead's clip —
    // legal, silent, and not the figure that was saved.
    const withLooks = deckConfig({
      deck: { looks: [{ uri: 'rep2.cool', vmax: 2.5 }] },
    })
    const out = resolveConfig(withLooks, base)
    expect(out.deck.looks?.[0].uri).toBe(uriOf(parseMaps(out.state.maps)[0]))
    expect(out.deck.looks?.[0].vmax).toBe(2.5)
  })

  it('drops the private names a recipient could only mistake for their own', () => {
    // `compare` and `deck.locals` are bare local filenames. Resolved, they would
    // mint a URL for a file that was never published; left alone, they reach
    // `resolveHandle`, whose grants are keyed on the bare name and whose guard
    // compares only `file.name` — so a recipient who has ever granted their own
    // `rep2.cool` opens *their* file in the sender's slot, with every label on
    // screen agreeing. Dropping costs only a label: `~` still holds the slot.
    const private_ = deckConfig({
      compare: 'secret.cool',
      deck: { starred: 'p2', columns: 3, locals: [{ index: 0, uri: 'rep2.cool' }] },
    })
    const out = resolveConfig(private_, base)
    expect(out.compare).toBeUndefined()
    expect('compare' in out).toBe(false)
    expect(out.deck.locals).toBeUndefined()
    // The arrangement is not private and is kept.
    expect(out.deck).toEqual({ starred: 'p2', columns: 3 })
    // …and the slot the dropped companion held is still there.
    expect(parseMaps(out.state.maps)).toHaveLength(3)
  })

  it('keeps a local track, because dropping one would lose the row', () => {
    // The rule that decides both cases above: a private name is stripped only
    // where the structure survives without it. A recipient silently receiving
    // seven tracks where eight were sent is the failure `~` exists to prevent.
    const config = resolveConfig(relative as NonNullable<typeof relative>, base)
    expect(config.tracks).toHaveLength(2)
    expect(config.tracks[1].source).toEqual({ kind: 'local', name: 'dropped.bw' })
  })
})

/**
 * The one check that belongs to a file's *identity* rather than to a field.
 *
 * `CONFIG_VERSION`'s docstring says the number is bumped only when a field
 * **changes meaning** — so the single situation it exists for is a file whose
 * `vmin` might be a percentile where this build reads a log10 value. Reading on
 * would draw that with every label on screen agreeing, which is the outcome this
 * codebase refuses everywhere else. Nothing acted on it until now.
 */
describe('the version gate', () => {
  const at = (version: unknown, over: Record<string, unknown> = {}) => ({
    version,
    state: STATE,
    ...over,
  })

  it('refuses a session from a newer build, and says what it is', () => {
    const read = readTab(at(CONFIG_VERSION + 1, { producer: '(meta)cooler 9.9.9' }))
    expect(isRefusal(read)).toBe(true)
    expect(read).toMatchObject({
      reason: 'newer',
      version: CONFIG_VERSION + 1,
      producer: '(meta)cooler 9.9.9',
    })
  })

  it('names both formats and the build, rather than blaming the file', () => {
    const read = readTab(at(CONFIG_VERSION + 1, { producer: '(meta)cooler 9.9.9' }))
    const message = refusalMessage(read as ConfigRefusal, 'figure3.metacooler.json')
    expect(message).toContain('figure3.metacooler.json')
    expect(message).toContain('(meta)cooler 9.9.9')
    expect(message).toContain(`format ${CONFIG_VERSION + 1}`)
    expect(message).toContain(`format ${CONFIG_VERSION}`)
    // The fix is to the viewer, not to the file — so the sentence must not send
    // the reader off to inspect the JSON.
    expect(message).toContain('Update the viewer')
    expect(message).not.toContain('not a saved workspace')
  })

  it('still refuses legibly when the newer file cannot say which build wrote it', () => {
    const read = readTab(at(CONFIG_VERSION + 1))
    expect(refusalMessage(read as ConfigRefusal, 'x.json')).toContain(
      `format ${CONFIG_VERSION + 1}`,
    )
  })

  it('tolerates this format and every older one', () => {
    // Forward tolerance for *added* fields is the promise; a lower number is an
    // older file and must keep opening. Pinned so whoever writes the first
    // migration sees exactly what they are changing.
    expect(isRefusal(readTab(at(CONFIG_VERSION)))).toBe(false)
    expect(isRefusal(readTab(at(0)))).toBe(false)
    expect(isRefusal(readTab(at(undefined)))).toBe(false)
    expect(isRefusal(readTab(at('two')))).toBe(false)
  })

  it('says a tab that is not one is not a workspace, in the file’s own words', () => {
    // A tab has no vocabulary of its own for this: it is only ever read out of a
    // file, so the sentence the reader sees has to be about the file they
    // dropped. `state/workspace.ts` covers the other two reasons, which are the
    // wrapper's to detect.
    expect(readTab({ name: 'my-package' })).toEqual({ reason: 'not-a-workspace' })
    expect(refusalMessage({ reason: 'not-json' }, 'x.json')).toContain('not a JSON file')
  })

  it('is inherited by the road that can only take a null', () => {
    // The durable record has nowhere to put a reason, so it keeps calling
    // `parseTab` — and it is precisely the one that would otherwise silently
    // misread a tab written by a newer build.
    expect(parseTab(at(CONFIG_VERSION + 1))).toBeNull()
    expect(parseTab(at(CONFIG_VERSION))).not.toBeNull()
  })
})

describe('looksLikeConfig', () => {
  it('is a hint about which files are worth opening, and nothing stronger', () => {
    expect(looksLikeConfig('workspace-2026-08-05-1000.metacooler.json')).toBe(true)
    // Any JSON is worth *reading* — `parseWorkspaceFile` is what refuses it —
    // because a reader who renames the file should still be able to open it.
    expect(looksLikeConfig('whatever.json')).toBe(true)
    expect(looksLikeConfig('yeast.cool')).toBe(false)
  })
})
