/**
 * A restored track that re-opens itself, and every way it must not.
 *
 * §8.6's rule was that a local track comes back `detached` — settings intact,
 * bytes gone — because no browser re-reads a dropped file without a gesture. A
 * remembered grant (`state/handles.ts`) narrows that rule rather than replacing
 * it, and the narrowing has to be exact: where a grant answers, the reader is
 * not asked to find a file the browser can already reach; where it does not, the
 * row must land in precisely the state it landed in before, button and all.
 *
 * Eight bigWigs is the larger half of what a reload used to cost — a map is one
 * drop and the tracks are eight — so this is the path most worth pinning.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { AnnotationStore } from '@/annotations/store'
import { allowHandles, forgetAllHandles, rememberHandle, resetHandlesForTests } from '@/state/handles'
import { useMemoryStores } from '@/state/idb'
import type { StoredEntry } from '@/annotations/types'

function stubHandle(name: string, options: { getFile?: () => Promise<File> } = {}): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
    getFile: options.getFile ?? (async () => new File(['bytes'], name)),
  } as unknown as FileSystemFileHandle
}

function localRow(name: string): StoredEntry {
  return {
    id: 'a1',
    card: 'linear',
    kind: 'track',
    label: 'ATAC',
    source: { kind: 'local', name },
    visible: true,
    placement: { bottom: true },
    style: { colour: '#1f5fa9' },
  } as StoredEntry
}

/** A store nobody else is using, so the session-memory keys cannot collide. */
function freshStore(): AnnotationStore {
  const store = new AnnotationStore(`reattach-${Math.random()}.cool`)
  store.clear()
  return store
}

/** Let the loader's unawaited re-open settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  useMemoryStores()
  resetHandlesForTests()
  ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () => undefined
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
  await forgetAllHandles()
})

describe('a restored local track', () => {
  it('says so while it is reopening, rather than asking for the file', async () => {
    await rememberHandle('ATAC.bw', stubHandle('ATAC.bw'), new File(['b'], 'ATAC.bw'))
    const store = freshStore()
    new AnnotationLoader(store, null as never, []).restore([localRow('ATAC.bw')])

    // Before anything is awaited. The row is seated immediately — the re-open is
    // asynchronous, so eight tracks resolve together rather than in turn — and
    // it must not spend that moment telling the reader to go and find the file.
    const entry = store.byId('a1')
    expect(entry?.status).toBe('detached')
    expect(entry?.summary).toBe('reopening…')
    expect(entry?.summary).not.toContain('re-open')
  })

  it('keeps its id and every setting the reader chose', async () => {
    await rememberHandle('ATAC.bw', stubHandle('ATAC.bw'), new File(['b'], 'ATAC.bw'))
    const store = freshStore()
    new AnnotationLoader(store, null as never, []).restore([localRow('ATAC.bw')])
    await settle()

    const entry = store.byId('a1')
    // Through `reattach`, which is what keeps the id — so the row does not jump
    // to the bottom of the card and the colours stay on the thing they were
    // chosen for.
    expect(entry?.id).toBe('a1')
    expect(entry?.label).toBe('ATAC')
    expect(entry?.style.colour).toBe('#1f5fa9')
    expect(entry?.placement).toMatchObject({ bottom: true })
    expect(entry?.source.kind).toBe('local')
    expect(entry?.status).not.toBe('detached')
  })
})

describe('a restored local track with nothing behind it', () => {
  it('lands exactly where it always did when there is no grant', async () => {
    const store = freshStore()
    new AnnotationLoader(store, null as never, []).restore([localRow('ATAC.bw')])
    await settle()

    const entry = store.byId('a1')
    expect(entry?.status).toBe('detached')
    expect(entry?.source.kind).toBe('detached')
    expect(entry?.summary).toBe('dropped file — re-open it to draw it again')
  })

  it('falls back to the button when a grant is held but has since lapsed', async () => {
    // The case the optimistic wording has to survive: `hasHandle` says yes, the
    // file has been deleted since, and the row has already been shown as
    // reopening. It must end on the detached wording rather than sitting on
    // "reopening…" for the life of the tab.
    await rememberHandle(
      'gone.bw',
      stubHandle('gone.bw', {
        getFile: async () => {
          throw new DOMException('not found', 'NotFoundError')
        },
      }),
      new File(['b'], 'gone.bw'),
    )
    const store = freshStore()
    new AnnotationLoader(store, null as never, []).restore([localRow('gone.bw')])
    expect(store.byId('a1')?.summary).toBe('reopening…')

    await settle()
    const entry = store.byId('a1')
    expect(entry?.status).toBe('detached')
    expect(entry?.summary).toBe('dropped file — re-open it to draw it again')
  })

  it('refuses a different file that has taken the remembered name', async () => {
    await rememberHandle(
      'rep1.bw',
      stubHandle('rep1.bw', { getFile: async () => new File(['b'], 'other.bw') }),
      new File(['b'], 'rep1.bw'),
    )
    const store = freshStore()
    new AnnotationLoader(store, null as never, []).restore([localRow('rep1.bw')])
    await settle()
    expect(store.byId('a1')?.status).toBe('detached')
  })
})

describe('rows that are not a dropped file', () => {
  it('leaves a remote row to its own re-fetch', async () => {
    const store = freshStore()
    const row = {
      ...localRow('ATAC.bw'),
      source: { kind: 'remote', name: 'ATAC.bw', url: 'https://example.org/ATAC.bw' },
    } as StoredEntry
    // No client in this test, so the fetch cannot proceed — what is asserted is
    // only that the remote branch was taken and the row is not detached.
    new AnnotationLoader(store, null as never, []).restore([row])
    await settle()
    expect(store.byId('a1')?.source.kind).toBe('remote')
  })
})

describe('a restored local track whose grant asks first', () => {
  /** A handle as Chromium hands one back after a restart: known, and waiting for a click. */
  function lapsedHandle(name: string): FileSystemFileHandle {
    let state: PermissionState = 'prompt'
    return {
      kind: 'file',
      name,
      queryPermission: async () => state,
      requestPermission: async () => {
        state = 'granted'
        return state
      },
      getFile: async () => new File(['bytes'], name),
    } as unknown as FileSystemFileHandle
  }

  it('says allow access rather than re-open, since the file is one click away', async () => {
    await rememberHandle('ATAC.bw', lapsedHandle('ATAC.bw'), new File(['b'], 'ATAC.bw'))
    const store = freshStore()
    new AnnotationLoader(store, null as never, []).restore([localRow('ATAC.bw')])
    await settle()

    const entry = store.byId('a1')
    expect(entry?.status).toBe('detached')
    expect(entry?.summary).toBe('remembered file — allow access to draw it again')
  })

  it('comes back once the reader allows it, with its id and settings', async () => {
    await rememberHandle('ATAC.bw', lapsedHandle('ATAC.bw'), new File(['b'], 'ATAC.bw'))
    const store = freshStore()
    const loader = new AnnotationLoader(store, null as never, [])
    loader.restore([localRow('ATAC.bw')])
    await settle()
    expect(store.byId('a1')?.status).toBe('detached')

    // The button's click, then the retry every tab makes on hearing of it.
    expect(await allowHandles('ATAC.bw')).not.toBeNull()
    loader.refind()
    await settle()

    const entry = store.byId('a1')
    expect(entry?.id).toBe('a1')
    expect(entry?.style.colour).toBe('#1f5fa9')
    expect(entry?.source.kind).toBe('local')
    expect(entry?.status).not.toBe('detached')
  })
})
