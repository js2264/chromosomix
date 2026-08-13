/**
 * The durable workspace: the record that survives the browser being closed.
 *
 * Two properties matter here and they pull in opposite directions. Writing has
 * to be *lossless* — a tab that comes back missing its tracks is worse than a
 * tab that does not come back at all, because the reader believes the first one.
 * Reading has to be *suspicious* — this record outlives the build that wrote it
 * by design, so it is the same untrusted input a URL hash is, and anything that
 * does not check out is dropped rather than repaired.
 *
 * No storage to install: `state/idb.ts` falls back to a module-level map when
 * there is no `indexedDB`, which is what a node test has. That fallback *is* the
 * code path a reader in Safari's private mode takes, so exercising it is not a
 * compromise.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  WORKSPACE_VERSION,
  flushWorkspace,
  forgetWorkspace,
  readWorkspace,
  summariseWorkspace,
  writeWorkspace,
  type Workspace,
} from '@/state/workspace'
import { STORES, store } from '@/state/idb'
import { CONFIG_KIND, buildConfig } from '@/state/SessionConfig'
import { remember } from '@/state/UiMemory'
import { DEFAULT_UI_PLOT_OPTIONS } from '@/ui/plotOptions'
import type { ViewState } from '@/types'

const STATE: ViewState = {
  uri: 'https://example.org/yeast.cool',
  view: 'region',
  region: 'IV:400,000-500,000',
}

function configFor(uri: string, key: string) {
  return buildConfig({
    state: { ...STATE, uri },
    memoryKey: key,
    plot: DEFAULT_UI_PLOT_OPTIONS,
    now: new Date('2026-08-13T09:00:00Z'),
  })
}

function workspaceOf(...uris: string[]): Workspace {
  return {
    version: WORKSPACE_VERSION,
    savedAt: '2026-08-13T09:00:00.000Z',
    sessions: uris.map((uri, index) => ({
      id: `s${index + 1}`,
      config: configFor(uri, `ws${index}|${uri}`),
    })),
    active: 's1',
  }
}

beforeEach(async () => {
  await forgetWorkspace()
})

describe('the round trip', () => {
  it('brings back every tab, its file and its workspace', async () => {
    const key = 'ws0|yeast.cool'
    remember(key, 'annotations', [
      {
        id: 'a1',
        card: 'linear',
        kind: 'track',
        label: 'ATAC',
        source: { kind: 'remote', name: 'ATAC.bw', url: 'https://example.org/ATAC.bw' },
        visible: true,
        placement: { bottom: true },
        style: { colour: '#1f5fa9' },
      },
    ])
    remember(key, 'bookmarks', [
      { id: 'b1', label: 'the loop', contig: 'IV', start: 4e5, end: 4.6e5, binsize: 1000 },
    ])

    writeWorkspace({
      version: WORKSPACE_VERSION,
      savedAt: '2026-08-13T09:00:00.000Z',
      sessions: [{ id: 's1', config: configFor('yeast.cool', key) }],
      active: 's1',
    })
    await flushWorkspace()

    const read = await readWorkspace()
    expect(read?.sessions).toHaveLength(1)
    expect(read?.sessions[0].id).toBe('s1')
    expect(read?.sessions[0].config.state.uri).toBe('yeast.cool')
    expect(read?.sessions[0].config.tracks).toHaveLength(1)
    expect(read?.sessions[0].config.bookmarks[0].label).toBe('the loop')
    expect(read?.active).toBe('s1')
  })

  it('is not written until it is flushed, so a drag does not write per frame', async () => {
    writeWorkspace(workspaceOf('a.cool'))
    // The debounce is the point: `App.remember()` fires on every state change,
    // and a full multi-tab config per frame would put IndexedDB behind the drag.
    expect(await store(STORES.workspace).get('current')).toBeNull()
    await flushWorkspace()
    expect(await readWorkspace()).not.toBeNull()
  })

  it('keeps only the last workspace handed to it while waiting', async () => {
    writeWorkspace(workspaceOf('first.cool'))
    writeWorkspace(workspaceOf('second.cool', 'third.cool'))
    await flushWorkspace()
    const read = await readWorkspace()
    expect(read?.sessions.map((session) => session.config.state.uri)).toEqual([
      'second.cool',
      'third.cool',
    ])
  })
})

describe('readWorkspace', () => {
  /** Put a record in directly, bypassing the writer's own shape. */
  async function seed(value: unknown): Promise<void> {
    await store(STORES.workspace).set('current', value)
  }

  it('answers null for anything that is not a record', async () => {
    expect(await readWorkspace()).toBeNull()
    await seed('a string')
    expect(await readWorkspace()).toBeNull()
    await seed([])
    expect(await readWorkspace()).toBeNull()
  })

  it('answers null rather than an empty workspace when no session survives', async () => {
    // An empty record and no record are the same thing to the caller — there is
    // nothing to offer — and collapsing them here means the restore card has one
    // condition to test rather than two.
    await seed({ version: 1, sessions: [], active: null })
    expect(await readWorkspace()).toBeNull()
  })

  it('drops a session whose config is not one, and keeps its neighbours', async () => {
    const good = configFor('good.cool', 'wsA|good.cool')
    await seed({
      version: 1,
      savedAt: '',
      sessions: [
        { id: 's1', config: { name: 'my-package', version: '1.0.0' } },
        { id: 's2', config: good },
        { id: 's3' },
        { id: '', config: good },
        'not an object',
      ],
      active: 's2',
    })
    const read = await readWorkspace()
    expect(read?.sessions.map((session) => session.id)).toEqual(['s2'])
    expect(read?.sessions[0].config.kind).toBe(CONFIG_KIND)
  })

  it('drops a duplicate id rather than seating two tabs on one memory key', async () => {
    const config = configFor('twice.cool', 'wsB|twice.cool')
    await seed({
      version: 1,
      savedAt: '',
      sessions: [
        { id: 's1', config },
        { id: 's1', config },
      ],
      active: 's1',
    })
    expect((await readWorkspace())?.sessions).toHaveLength(1)
  })

  it('forgets an active id that names no surviving tab', async () => {
    await seed({
      version: 1,
      savedAt: '',
      sessions: [{ id: 's1', config: configFor('a.cool', 'wsC|a.cool') }],
      active: 's9',
    })
    expect((await readWorkspace())?.active).toBeNull()
  })

  it('defaults a missing version and savedAt rather than refusing the record', async () => {
    // The tolerance every field of a `SessionConfig` is read with, applied one
    // level up: a record written before either field existed is still a set of
    // tabs somebody had open.
    await seed({ sessions: [{ id: 's1', config: configFor('a.cool', 'wsD|a.cool') }] })
    const read = await readWorkspace()
    expect(read?.version).toBe(WORKSPACE_VERSION)
    expect(read?.savedAt).toBe('')
    expect(read?.sessions).toHaveLength(1)
  })
})

describe('forgetWorkspace', () => {
  it('drops a write that is still waiting, so the record does not come back', async () => {
    // "Start fresh" pressed while a debounce is in flight. Without this the
    // timer would put the workspace straight back a moment later, and the reader
    // would have watched the app ignore them.
    writeWorkspace(workspaceOf('a.cool'))
    await forgetWorkspace()
    await flushWorkspace()
    expect(await readWorkspace()).toBeNull()
  })
})

describe('summariseWorkspace', () => {
  it('counts the tabs, names the files and totals the tracks', async () => {
    const key = 'wsE|two.cool'
    remember(key, 'annotations', [
      { id: 'a1', card: 'linear', kind: 'track', label: 'A', source: { kind: 'remote', name: 'A.bw', url: 'https://e.org/A.bw' }, visible: true, placement: { bottom: true }, style: {} },
      { id: 'a2', card: 'linear', kind: 'track', label: 'B', source: { kind: 'remote', name: 'B.bw', url: 'https://e.org/B.bw' }, visible: true, placement: { bottom: true }, style: {} },
    ])
    const summary = summariseWorkspace({
      version: WORKSPACE_VERSION,
      savedAt: '',
      sessions: [
        { id: 's1', config: configFor('one.cool', 'wsF|one.cool') },
        { id: 's2', config: configFor('two.cool', key) },
      ],
      active: 's1',
    })
    expect(summary).toEqual({ tabs: 2, files: ['one.cool', 'two.cool'], tracks: 2 })
  })
})
