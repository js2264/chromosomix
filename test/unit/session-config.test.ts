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
    remember(key, 'compare:normalise', true)
    remember(key, 'table:contigs', { filters: {}, search: 'chr', sortKey: 'length', sortDir: -1 })

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
    expect(config.sequences).toEqual(['IV', 'XII'])
    expect(config.groups).toEqual({ reads: 'overlay' })
    expect(config.scaling).toEqual({ reads: 'each' })
    expect(config.compareNormalise).toBe(true)
    expect(config.tables.contigs?.search).toBe('chr')
    // Absent rather than present-and-empty: a table nobody sorted has no state,
    // and writing one would put a default back over a later default.
    expect(config.tables.genomes).toBeUndefined()
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

    // …into a *different* tab, under a *different* name for the same file.
    applyConfig(read as NonNullable<typeof read>, 's7|dropped.cool')
    expect(recall('s7|dropped.cool', 'annotations')).toEqual([TRACK])
    expect(recall('s7|dropped.cool', 'browser:sequences')).toEqual(['IV'])
    // The exporting session's own memory is untouched by the import.
    expect(recall(key, 'annotations')).toEqual([TRACK])
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
