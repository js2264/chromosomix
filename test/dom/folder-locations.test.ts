// @vitest-environment jsdom
/**
 * Folders kept by the installed app, and the files found in them again (§20.6).
 *
 * A folder connected in the installed app is kept across restarts, and a file
 * opened from it is remembered by the folder it was in and its path there — so
 * a session, or a workspace exported from one, finds the file again without
 * anybody being asked for it. In a browser tab none of that is written down: a
 * folder lasts the visit, and no path leaves the page.
 *
 * The directory handles are hand-rolled stand-ins, as in `handles.test.ts` and
 * `browse-folders.test.ts`, and the stores run in their in-memory mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleFolder } from '@/browse/local'
import { installedApp } from '@/installed'
import {
  directoriesKept,
  forgetAllDirectories,
  rememberDirectory,
  resetDirectoriesForTests,
  storedDirectoryNames,
} from '@/state/directories'
import { forgetAllHandles, resetHandlesForTests } from '@/state/handles'
import { useMemoryStores } from '@/state/idb'
import {
  adoptFolders,
  foldersOf,
  hasLocation,
  locationOf,
  missingFolders,
  noteLocation,
  resetLocationsForTests,
  resolveLocal,
  resolveLocated,
} from '@/state/locations'
import { buildConfig, localNamesOf, parseTab, resolveConfig } from '@/state/SessionConfig'
import { forSharing } from '@/state/shareLink'
import { openedAs, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let undoMode = (): void => {}

/** Open as the installed app or as a tab, undoing the last. */
function runAs(mode: 'app' | 'tab'): void {
  undoMode()
  undoMode = openedAs(mode)
}

/** A directory called `name` holding these paths, with the members this app reads. */
function directory(name: string, paths: readonly string[], at = ''): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: at === '' ? name : at.split('/').filter(Boolean).pop(),
    queryPermission: vi.fn(async () => 'granted'),
    requestPermission: vi.fn(async () => 'granted'),
    entries: async function* () {},
    async getDirectoryHandle(part: string) {
      if (!paths.some((path) => path.startsWith(`${at}${part}/`))) throw new Error('not found')
      return directory(name, paths, `${at}${part}/`)
    },
    async getFileHandle(file: string) {
      const full = `${at}${file}`
      if (!paths.includes(full)) throw new Error('not found')
      return { kind: 'file', name: file, async getFile() { return new File(['bytes'], file) } }
    },
  } as unknown as FileSystemDirectoryHandle
}

const RUN2 = ['hic/rep1.cool', 'chip/peaks.bed.gz', 'chip/peaks.bed.gz.tbi']

beforeEach(async () => {
  teardown = setUpDom()
  useMemoryStores()
  window.localStorage.clear()
  resetDirectoriesForTests()
  resetHandlesForTests()
  resetLocationsForTests()
  // The two halves of `directoriesSupported`, which jsdom has neither of.
  ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = () => undefined
  ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () => undefined
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
  await forgetAllDirectories()
  await forgetAllHandles()
})

afterEach(() => {
  undoMode()
  undoMode = () => {}
  teardown()
})

/** Connect `run2` and pick a file out of it, as the Files column does. */
async function pickFrom(path: string): Promise<void> {
  const handle = directory('run2', RUN2)
  await rememberDirectory('dir:1', handle, 'run2')
  const folder = handleFolder('dir:1', 'run2', handle, directoriesKept())
  const name = path.split('/').pop() ?? path
  noteLocation(await folder.pick({ kind: 'file', name, path, size: null }))
}

describe('which is the installed app', () => {
  it('is the site opened as an app, and not the same site in a tab', () => {
    runAs('app')
    expect(installedApp()).toBe(true)
    runAs('tab')
    expect(installedApp()).toBe(false)
  })

  it('is a home-screen app on Safari, which says so on its own flag', () => {
    runAs('tab')
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true })
    expect(installedApp()).toBe(true)
    Object.defineProperty(window.navigator, 'standalone', { value: undefined, configurable: true })
  })
})

describe('a folder connected in a browser tab', () => {
  beforeEach(() => runAs('tab'))

  it('lasts the visit: held, listed as transient, and written nowhere', async () => {
    expect(directoriesKept()).toBe(false)
    const handle = directory('run2', RUN2)
    await rememberDirectory('dir:1', handle, 'run2')
    expect(await storedDirectoryNames()).toEqual([])
    const folder = handleFolder('dir:1', 'run2', handle, directoriesKept())
    expect(folder.durable).toBe(false)
    expect(folder.transient).toBe('visit')
  })

  it('writes no file’s place into storage or into a workspace', async () => {
    await pickFrom('hic/rep1.cool')
    // Known for the visit — the folder is connected, so the file is reachable.
    expect(hasLocation('rep1.cool')).toBe(true)
    expect(window.localStorage.getItem('chromosomix:locations')).toBeNull()
    expect(foldersOf(['rep1.cool'])).toEqual([])
  })

  it('takes no place from a workspace either', () => {
    adoptFolders([{ id: 'dir:9', name: 'run2', files: { 'rep1.cool': 'hic/rep1.cool' } }])
    expect(hasLocation('rep1.cool')).toBe(false)
  })
})

describe('a folder connected in the installed app', () => {
  beforeEach(() => runAs('app'))

  it('is kept, and is a connection rather than a visit', async () => {
    expect(directoriesKept()).toBe(true)
    await rememberDirectory('dir:1', directory('run2', RUN2), 'run2')
    expect(await storedDirectoryNames()).toEqual(['run2'])
  })

  it('remembers where a file opened from it is — and its index beside it', async () => {
    await pickFrom('chip/peaks.bed.gz')
    expect(locationOf('peaks.bed.gz')).toEqual({ folder: 'dir:1', name: 'run2', path: 'chip/peaks.bed.gz' })
    expect(locationOf('peaks.bed.gz.tbi')).toEqual({
      folder: 'dir:1',
      name: 'run2',
      path: 'chip/peaks.bed.gz.tbi',
    })
    // …across a restart, which is the point of keeping it.
    resetLocationsForTests()
    expect(locationOf('peaks.bed.gz')?.path).toBe('chip/peaks.bed.gz')
  })

  it('finds the file there again, with no grant for the file itself', async () => {
    await pickFrom('hic/rep1.cool')
    const file = await resolveLocal('rep1.cool')
    expect(file?.name).toBe('rep1.cool')
  })

  it('writes the folders a session’s files are in into its workspace, and none into a link', async () => {
    await pickFrom('hic/rep1.cool')
    await pickFrom('chip/peaks.bed.gz')
    const config = buildConfig({
      state: { uri: 'rep1.cool', view: 'region', region: 'IV' },
      memoryKey: 'test',
      plot: {} as never,
      now: new Date(0),
    })
    expect(config.folders).toEqual([
      { id: 'dir:1', name: 'run2', files: { 'rep1.cool': 'hic/rep1.cool' } },
    ])
    // Read back as written.
    const read = parseTab(JSON.parse(JSON.stringify(config)))
    expect(read?.folders).toEqual(config.folders)
    // A share link and a workspace published at a URL carry no path of anybody's.
    expect(forSharing(config).folders).toBeUndefined()
    expect(resolveConfig(config, 'https://example.org/ws/').folders).toBeUndefined()
  })

  it('names every local file a session holds, and no remote one', () => {
    const config = buildConfig({
      state: { uri: 'rep1.mcool::resolutions/1000', view: 'region', region: 'IV' },
      memoryKey: 'names',
      plot: {} as never,
      now: new Date(0),
    })
    const withTracks = {
      ...config,
      compare: 'rep2.cool',
      tracks: [
        { source: { kind: 'local', name: 'peaks.bed' } },
        { source: { kind: 'remote', name: 'atac.bw', url: 'https://example.org/atac.bw' } },
      ] as never,
    }
    expect(localNamesOf(withTracks)).toEqual(['rep1.mcool', 'rep2.cool', 'peaks.bed'])
  })

  describe('a workspace opened by another installation', () => {
    it('finds its files in a folder of the same name, by their paths', async () => {
      // This installation connected `run2` under its own id.
      await rememberDirectory('dir:local', directory('run2', RUN2), 'run2')
      adoptFolders([{ id: 'dir:theirs', name: 'run2', files: { 'rep1.cool': 'hic/rep1.cool' } }])
      expect((await resolveLocated('rep1.cool'))?.name).toBe('rep1.cool')
    })

    it('says which folders to connect where it has none of them', async () => {
      const records = [{ id: 'dir:theirs', name: 'run7', files: { 'rep1.cool': 'hic/rep1.cool' } }]
      adoptFolders(records)
      expect(missingFolders(records).map((record) => record.name)).toEqual(['run7'])
      expect(await resolveLocated('rep1.cool')).toBeNull()
      // …and once a folder holding it is connected, under any name, finds it.
      await rememberDirectory('dir:new', directory('renamed', RUN2), 'renamed')
      expect((await resolveLocated('rep1.cool'))?.name).toBe('rep1.cool')
    })

    it('keeps a place this installation already knows over the workspace’s', async () => {
      await pickFrom('hic/rep1.cool')
      adoptFolders([{ id: 'dir:theirs', name: 'other', files: { 'rep1.cool': 'elsewhere/rep1.cool' } }])
      expect(locationOf('rep1.cool')?.path).toBe('hic/rep1.cool')
    })

    it('refuses a file that is not where the workspace says', async () => {
      await rememberDirectory('dir:local', directory('run2', RUN2), 'run2')
      adoptFolders([{ id: 'dir:theirs', name: 'run2', files: { 'rep1.cool': 'hic/missing.cool' } }])
      expect(await resolveLocated('rep1.cool')).toBeNull()
    })
  })
})
