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
  applyConfig,
  buildConfig,
  configFileName,
  looksLikeConfig,
  parseConfig,
  resolveConfig,
} from '@/state/SessionConfig'
import { recall, remember } from '@/state/UiMemory'
import { DEFAULT_UI_PLOT_OPTIONS } from '@/ui/plotOptions'
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
