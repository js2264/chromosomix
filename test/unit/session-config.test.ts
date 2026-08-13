/**
 * A session written to a file, and read back.
 *
 * The round trip is the whole contract, and the two halves are asymmetric in a
 * way worth pinning: writing gathers up what storage already holds, so it cannot
 * drift from what a reload restores; reading has to survive a file written by a
 * different build, or by a text editor, or by something else entirely.
 */

import { describe, expect, it } from 'vitest'

import {
  CONFIG_KIND,
  CONFIG_VERSION,
  applyConfig,
  buildConfig,
  configFileName,
  looksLikeConfig,
  parseConfig,
  readConfig,
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

    expect(config.kind).toBe(CONFIG_KIND)
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

    const read = parseConfig(JSON.stringify(config, null, 2))
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

    const read = parseConfig(JSON.stringify(config))
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
    const read = parseConfig(JSON.stringify({ kind: CONFIG_KIND, state: STATE }))
    expect(read?.deck).toEqual({})
    applyConfig(read as NonNullable<typeof read>, 's4|old.cool')
    expect(recall('s4|old.cool', 'deck:starred')).toBe('p1')
    expect(recall('s4|old.cool', 'deck:columns')).toBe(4)
  })

  it('drops a star and a column count that are not ones', () => {
    // Stored state outlives the build that wrote it (§8.6), and both of these
    // reach `PanelDeck` — a `columns` of `NaN` divides the grid into no columns
    // at all, and an empty star names no map.
    const read = parseConfig(
      JSON.stringify({ kind: CONFIG_KIND, state: STATE, deck: { starred: '', columns: 'three' } }),
    )
    expect(read?.deck).toEqual({})
  })
})

describe('parseConfig', () => {
  it('refuses anything that does not name itself a session', () => {
    expect(parseConfig('not json at all')).toBeNull()
    expect(parseConfig('[]')).toBeNull()
    expect(parseConfig(JSON.stringify({ name: 'my-package', version: '1.0.0' }))).toBeNull()
    // Right kind, no state to open: there would be nothing to show.
    expect(parseConfig(JSON.stringify({ kind: CONFIG_KIND }))).toBeNull()
    expect(parseConfig(JSON.stringify({ kind: CONFIG_KIND, state: { view: 'region' } }))).toBeNull()
  })

  it('reads a session that cannot say which build wrote it', () => {
    // Every file written before provenance existed. Absent is not empty and not
    // a broken file — it is a session that simply cannot answer.
    const read = parseConfig(JSON.stringify({ kind: CONFIG_KIND, state: STATE }))
    expect('producer' in (read as object)).toBe(false)
    expect('commit' in (read as object)).toBe(false)
    // …and an empty string is read as the same thing, since a build with no git
    // behind it writes nothing rather than an empty hash.
    const blank = parseConfig(
      JSON.stringify({ kind: CONFIG_KIND, state: STATE, producer: '', commit: '' }),
    )
    expect('producer' in (blank as object)).toBe(false)
  })

  it('tolerates every field but the state being absent', () => {
    const read = parseConfig(JSON.stringify({ kind: CONFIG_KIND, state: STATE }))
    expect(read?.tracks).toEqual([])
    expect(read?.manual).toEqual([])
    expect(read?.bookmarks).toEqual([])
    expect(read?.sequences).toEqual([])
    expect(read?.groups).toEqual({})
    expect(read?.compareNormalise).toBe(false)
    expect(read?.tables).toEqual({})
  })

  it('drops a sequences list that is not one', () => {
    const read = parseConfig(
      JSON.stringify({ kind: CONFIG_KIND, state: STATE, sequences: ['IV', 7, null] }),
    )
    expect(read?.sequences).toEqual(['IV'])
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
  const base = 'https://example.org/app/demo/session.metacooler.json'
  const relative = parseConfig(
    JSON.stringify({
      kind: CONFIG_KIND,
      state: { uri: 'yeast.cool', view: 'region', region: 'IV' },
      tracks: [
        { ...TRACK, source: { kind: 'remote', name: 'ATAC.bw', url: 'ATAC.bw' } },
        { ...TRACK, id: 'a2', source: { kind: 'local', name: 'dropped.bw' } },
      ],
    }),
  )

  it('resolves what a config names against where the config is', () => {
    const config = resolveConfig(relative as NonNullable<typeof relative>, base)
    expect(config.state.uri).toBe('https://example.org/app/demo/yeast.cool')
    expect(config.tracks[0].source.url).toBe('https://example.org/app/demo/ATAC.bw')
    // A local track has no URL to resolve and must not grow one.
    expect(config.tracks[1].source).toEqual({ kind: 'local', name: 'dropped.bw' })
  })

  it('leaves an exported session exactly as it was', () => {
    const exported = parseConfig(
      JSON.stringify({ kind: CONFIG_KIND, state: STATE, tracks: [TRACK] }),
    )
    const config = resolveConfig(exported as NonNullable<typeof exported>, base)
    expect(config.state.uri).toBe(STATE.uri)
    expect(config.tracks[0].source.url).toBe(TRACK.source.url)
  })

  it('resolves the file half of a `file::group` URI and keeps the group', () => {
    const collection = parseConfig(
      JSON.stringify({
        kind: CONFIG_KIND,
        state: { uri: 'mock.mmetacool::entries/1000', view: 'genomes' },
      }),
    )
    expect(resolveConfig(collection as NonNullable<typeof collection>, base).state.uri).toBe(
      'https://example.org/app/demo/mock.mmetacool::/entries/1000',
    )
  })

  it('resolves the compared file too', () => {
    const pair = parseConfig(
      JSON.stringify({
        kind: CONFIG_KIND,
        state: { uri: 'a.cool', uri2: 'b.cool', view: 'region' },
      }),
    )
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
    parseConfig(
      JSON.stringify({
        kind: CONFIG_KIND,
        state: {
          uri: 'lead.cool',
          view: 'region',
          maps: `rep2.cool${MAPS_SEPARATOR}${VACANT}${MAPS_SEPARATOR}https://other.org/rep4.cool`,
        },
        ...over,
      }),
    ) as SessionConfig

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
    const odd = parseConfig(
      JSON.stringify({
        kind: CONFIG_KIND,
        state: { uri: 'lead.cool', view: 'region', maps: 'we%7Cird.cool' },
      }),
    ) as SessionConfig
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
  const at = (version: unknown, over: Record<string, unknown> = {}) =>
    JSON.stringify({ kind: CONFIG_KIND, version, state: STATE, ...over })

  it('refuses a session from a newer build, and says what it is', () => {
    const read = readConfig(at(CONFIG_VERSION + 1, { producer: '(meta)cooler 9.9.9' }))
    expect(isRefusal(read)).toBe(true)
    expect(read).toMatchObject({
      reason: 'newer',
      version: CONFIG_VERSION + 1,
      producer: '(meta)cooler 9.9.9',
    })
  })

  it('names both formats and the build, rather than blaming the file', () => {
    const read = readConfig(at(CONFIG_VERSION + 1, { producer: '(meta)cooler 9.9.9' }))
    const message = refusalMessage(read as ConfigRefusal, 'figure3.metacooler.json')
    expect(message).toContain('figure3.metacooler.json')
    expect(message).toContain('(meta)cooler 9.9.9')
    expect(message).toContain(`format ${CONFIG_VERSION + 1}`)
    expect(message).toContain(`format ${CONFIG_VERSION}`)
    // The fix is to the viewer, not to the file — so the sentence must not send
    // the reader off to inspect the JSON.
    expect(message).toContain('Update the viewer')
    expect(message).not.toContain('not a saved session')
  })

  it('still refuses legibly when the newer file cannot say which build wrote it', () => {
    const read = readConfig(at(CONFIG_VERSION + 1))
    expect(refusalMessage(read as ConfigRefusal, 'x.json')).toContain(
      `format ${CONFIG_VERSION + 1}`,
    )
  })

  it('tolerates this format and every older one', () => {
    // Forward tolerance for *added* fields is the promise; a lower number is an
    // older file and must keep opening. Pinned so whoever writes the first
    // migration sees exactly what they are changing.
    expect(isRefusal(readConfig(at(CONFIG_VERSION)))).toBe(false)
    expect(isRefusal(readConfig(at(0)))).toBe(false)
    expect(isRefusal(readConfig(at(undefined)))).toBe(false)
    expect(isRefusal(readConfig(at('two')))).toBe(false)
  })

  it('tells apart JSON that is broken from JSON that is not a session', () => {
    expect(readConfig('not json at all')).toEqual({ reason: 'not-json' })
    expect(readConfig(JSON.stringify({ name: 'my-package' }))).toEqual({ reason: 'not-a-session' })
    expect(refusalMessage({ reason: 'not-json' }, 'x.json')).toContain('not a JSON file')
  })

  it('is inherited by the two roads that can only take a null', () => {
    // A share link and the durable record have nowhere to put a reason, so they
    // keep calling `parseConfig` — and they are precisely the two that would
    // otherwise silently misread a file from a newer build.
    expect(parseConfig(at(CONFIG_VERSION + 1))).toBeNull()
    expect(parseConfig(at(CONFIG_VERSION))).not.toBeNull()
  })
})

describe('naming one', () => {
  it('says what it is, twice', () => {
    expect(configFileName('yeast', '2026-08-05-1000')).toBe(
      'yeast-2026-08-05-1000.metacooler.json',
    )
    expect(looksLikeConfig('yeast-2026-08-05-1000.metacooler.json')).toBe(true)
    // Any JSON is worth *reading* — `parseConfig` is what refuses it — because a
    // reader who renames the file should still be able to open it.
    expect(looksLikeConfig('whatever.json')).toBe(true)
    expect(looksLikeConfig('yeast.cool')).toBe(false)
  })
})
