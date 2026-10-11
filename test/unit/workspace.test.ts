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
  WORKSPACE_KIND,
  WORKSPACE_VERSION,
  buildWorkspaceFile,
  flushWorkspace,
  forgetWorkspace,
  parseWorkspaceFile,
  readWorkspace,
  recordAction,
  seatWorkspace,
  summariseWorkspace,
  workspaceFileName,
  writeWorkspace,
  type Workspace,
} from '@/state/workspace'
import { STORES, store } from '@/state/idb'
import {
  CONFIG_VERSION,
  buildConfig,
  isRefusal,
  refusalMessage,
  type ConfigRefusal,
} from '@/state/SessionConfig'
import { remember } from '@/state/UiMemory'
import { COMMIT, PRODUCER } from '@/version'
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
    expect(read?.sessions[0].config.state.uri).toBe('good.cool')
  })

  it('reads a record that names no kind, because a record never carried one', async () => {
    // The regression a clean break invites. The *file* names itself and is
    // refused when it does not; a record is private to this browser, was written
    // by this build, and has never had a `kind` in it — neither around the tabs
    // nor inside one. Demanding one here would refuse every record already on
    // disk, and the symptom would not be an error: it would be the restore
    // banner quietly never appearing again, which reads exactly like "there was
    // nothing to restore".
    await seed({
      version: 1,
      savedAt: '2026-08-13T09:00:00.000Z',
      sessions: [{ id: 's1', config: configFor('kindless.cool', 'wsG|kindless.cool') }],
      active: 's1',
    })
    const read = await readWorkspace()
    expect(read?.sessions).toHaveLength(1)
    expect(JSON.stringify(read)).not.toContain(WORKSPACE_KIND)
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

/**
 * When the record may be written, and when it must be left alone.
 *
 * A pure function for a rule that cost a real bug: **a window with nothing open
 * is two different facts.** After the reader closes their last tab it means
 * *forget this*; during startup it means *nothing has been restored yet*, and
 * acting on it there deletes the record while the read that would have offered
 * it back is still in flight. That race resolves differently on a warm cache
 * than a cold one, so the symptom is a workspace that vanishes on some loads and
 * not others, with nothing in the console either way.
 */
describe('recordAction', () => {
  it('waits until the boot has decided about a previous workspace', () => {
    // The bug. An empty startup window must not answer a question nobody has
    // asked it yet.
    expect(recordAction({ settled: false, offering: false, tabs: 0 })).toBe('wait')
    expect(recordAction({ settled: false, offering: false, tabs: 3 })).toBe('wait')
  })

  it('waits while the offer is on screen, whatever the window holds', () => {
    // Forgetting here would delete the very thing the reader is being asked
    // about, between the question and their answer.
    expect(recordAction({ settled: true, offering: true, tabs: 0 })).toBe('wait')
    expect(recordAction({ settled: true, offering: true, tabs: 2 })).toBe('wait')
  })

  it('forgets an emptied window once the question is settled', () => {
    // Now it does mean "I am finished": offering these back next week would be
    // offering the reader nothing.
    expect(recordAction({ settled: true, offering: false, tabs: 0 })).toBe('forget')
  })

  it('writes whenever there is something to write', () => {
    expect(recordAction({ settled: true, offering: false, tabs: 1 })).toBe('write')
    expect(recordAction({ settled: true, offering: false, tabs: 12 })).toBe('write')
  })
})

/**
 * The workspace as a file, which is the one artifact that leaves this browser.
 *
 * Everything above is private to one machine and can afford to be forgiving.
 * This is not: it is written on one computer and opened on another, possibly by
 * a different build, possibly after somebody has edited it in a text editor. So
 * it names itself, it says which build wrote it, and it refuses rather than
 * guesses — while still being forgiving about the *tabs* inside it, because
 * nine good tabs and one corrupt one is nine tabs.
 */
describe('the workspace file', () => {
  const tabs = [
    configFor('one.cool', 'wf1|one.cool'),
    configFor('two.cool', 'wf2|two.cool'),
    configFor('three.cool', 'wf3|three.cool'),
  ]
  const written = (active = 1) => buildWorkspaceFile(tabs, active, new Date('2026-08-13T09:00:00Z'))

  it('carries every tab and remembers which was in front', () => {
    const file = written()
    expect(file.kind).toBe('chromosomix.workspace')
    expect(file.tabs).toHaveLength(3)
    expect(file.tabs.map((tab) => tab.state.uri)).toEqual(['one.cool', 'two.cool', 'three.cool'])
    expect(file.active).toBe(1)
    expect(file.createdAt).toBe('2026-08-13T09:00:00.000Z')
  })

  it('names the active tab by index rather than by session id', () => {
    // The one real difference from the record above. A sender's `s1` means
    // nothing in a recipient's window and would *collide* with a tab they
    // already have; `applyConfig` re-keys on import anyway, so an id in a file
    // would be a private tab identity published for the benefit of nobody.
    expect(JSON.stringify(written())).not.toContain('"id":"s1"')
    expect(typeof written().active).toBe('number')
  })

  /**
   * Which build wrote it.
   *
   * Against the **imported** constants and never a literal: `version.ts` reads
   * its values from a `define` substitution that vitest does not apply, so a
   * literal would pass here and fail in a real build, or the reverse.
   */
  it('stamps which build wrote it, the way an exported PDF does', () => {
    const file = written()
    expect(file.producer).toBe(PRODUCER)
    if (COMMIT === '') expect('commit' in file).toBe(false)
    else expect(file.commit).toBe(COMMIT)
  })

  it('clamps an active index that names no tab', () => {
    // A window has to open on something, and an index past the end is a state
    // nothing else in the app produces.
    expect(buildWorkspaceFile(tabs, 9, new Date(0)).active).toBe(0)
    expect(buildWorkspaceFile(tabs, -1, new Date(0)).active).toBe(0)
    expect(buildWorkspaceFile([], 0, new Date(0)).active).toBe(-1)
  })

  it('round-trips through the text that actually gets saved', () => {
    const read = parseWorkspaceFile(JSON.stringify(written(2), null, 2))
    expect(isRefusal(read)).toBe(false)
    const file = read as ReturnType<typeof written>
    expect(file.tabs.map((tab) => tab.state.uri)).toEqual(['one.cool', 'two.cool', 'three.cool'])
    expect(file.active).toBe(2)
    expect(file.producer).toBe(PRODUCER)
  })

  it('tells apart broken JSON, foreign JSON, and a file from a newer build', () => {
    // Three different sentences for three different situations, which is the
    // whole reason these are refusals rather than `null`. A bare null landed the
    // reader on "is a JSON file but not a saved workspace" for a file from a
    // newer build — false, and it sends them to inspect the wrong thing.
    expect(parseWorkspaceFile('not json at all')).toEqual({ reason: 'not-json' })
    expect(parseWorkspaceFile('[]')).toEqual({ reason: 'not-a-workspace' })
    expect(parseWorkspaceFile(JSON.stringify({ name: 'my-package' }))).toEqual({
      reason: 'not-a-workspace',
    })
    // Right shape, wrong family: the guard that stops some other application's
    // JSON opening as a window full of tabs.
    expect(
      parseWorkspaceFile(JSON.stringify({ tabs: [{ state: { uri: 'a.cool' } }], active: 0 })),
    ).toEqual({ reason: 'not-a-workspace' })

    const newer = parseWorkspaceFile(
      JSON.stringify({
        kind: 'chromosomix.workspace',
        version: CONFIG_VERSION + 1,
        producer: 'chromosomix 9.9.9',
        active: 0,
        tabs: [{ state: { uri: 'a.cool' } }],
      }),
    )
    expect(newer).toMatchObject({ reason: 'newer', version: CONFIG_VERSION + 1 })
    const message = refusalMessage(newer as ConfigRefusal, 'figure3.chromosomix.json')
    expect(message).toContain('chromosomix 9.9.9')
    expect(message).toContain('Update the viewer')
  })

  it('keeps the good tabs when one of them is not a tab', () => {
    // Nine good tabs and one corrupt one is nine tabs, not an error screen: the
    // reader loses what was actually lost and nothing more.
    const read = parseWorkspaceFile(
      JSON.stringify({
        kind: 'chromosomix.workspace',
        version: CONFIG_VERSION,
        active: 2,
        tabs: [{ state: { uri: 'good.cool' } }, { name: 'my-package' }, null, 'nope'],
      }),
    )
    expect(isRefusal(read)).toBe(false)
    const file = read as ReturnType<typeof written>
    expect(file.tabs).toHaveLength(1)
    // The index named a tab that did not survive, and a window still opens on
    // something rather than on nothing.
    expect(file.active).toBe(0)
  })

  it('refuses a file whose every tab was dropped', () => {
    // Nothing to open: better to say so than to hand the shell an empty window
    // it would fill with a picker, which looks like the file having worked.
    expect(
      parseWorkspaceFile(
        JSON.stringify({ kind: 'chromosomix.workspace', version: 1, active: 0, tabs: [] }),
      ),
    ).toEqual({ reason: 'not-a-workspace' })
  })

  it('is named for what it is, without claiming how many tabs are in it', () => {
    // The count would be wrong the moment anybody edits the file, and nothing
    // routes on the name anyway — the `kind` inside is what decides. The
    // `.chromosomix.json` suffix stays so the family stays recognisable.
    expect(workspaceFileName('2026-08-13-0900')).toBe('workspace-2026-08-13-0900.chromosomix.json')
  })
})

/**
 * Where a dropped workspace's tabs go.
 *
 * A pure function for `recordAction`'s reason: the rules are small, each guards
 * a failure that is silent when it happens, and none of them needs a DOM.
 */
describe('seatWorkspace', () => {
  it('consumes the picker a fresh window opens with', () => {
    // Dropping a workspace onto an empty window should not leave the picker
    // sitting beside the imports.
    expect(seatWorkspace({ open: 0, emptyTab: true, incoming: 3, max: 12 })).toEqual({
      consumeEmpty: true,
      take: 3,
      dropped: 0,
    })
  })

  it('keeps every tab a populated window already has', () => {
    // `Session.dropFiles` states the doctrine this follows: adds rather than
    // replaces in every case it can. Closing six open tabs with no message and
    // no undo is what the startup offer is *allowed* to do, having asked.
    expect(seatWorkspace({ open: 6, emptyTab: false, incoming: 3, max: 12 })).toEqual({
      consumeEmpty: false,
      take: 3,
      dropped: 0,
    })
  })

  it('takes what fits and counts what does not', () => {
    // Twelve is a memory limit rather than a rendering one, and a partial import
    // is useful where an abort loses everything — so the overflow is counted so
    // it can be named, rather than dropped in silence.
    expect(seatWorkspace({ open: 10, emptyTab: false, incoming: 5, max: 12 })).toEqual({
      consumeEmpty: false,
      take: 2,
      dropped: 3,
    })
    expect(seatWorkspace({ open: 12, emptyTab: false, incoming: 2, max: 12 })).toEqual({
      consumeEmpty: false,
      take: 0,
      dropped: 2,
    })
  })

  it('does not consume an empty tab that is sitting beside real ones', () => {
    // A picker open beside six loaded tabs is a tab the reader opened on
    // purpose, and is about to drop a file into.
    expect(seatWorkspace({ open: 2, emptyTab: true, incoming: 1, max: 12 }).consumeEmpty).toBe(false)
  })
})
