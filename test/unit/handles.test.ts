/**
 * Grants: the permission to reopen a local file, and every way that can fail.
 *
 * The failures are the subject. A grant that works is one line; a grant that
 * *half* works is how a reader ends up looking at the wrong file with every
 * label on screen agreeing with them, which is the one outcome here that is
 * worse than the feature not existing. So most of what follows is the refusals:
 * permission withdrawn, file deleted, a second file wearing the first one's
 * name.
 *
 * The handles are hand-rolled stubs, which is this repository's habit for a
 * platform object a test runtime does not have — `FileReaderSync` in
 * `local-lazy.test.ts` and `DeadWorker` in `dom/deck.test.ts` are the same
 * shape. `idb.ts` is put into its in-memory mode, which is not a compromise:
 * that is the code path Safari's private mode and every storage-refusing
 * embedding actually take.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  allowHandles,
  forgetAllHandles,
  handleKey,
  handleRows,
  handlesSupported,
  hasHandle,
  hydrateHandles,
  knownPaths,
  rememberHandle,
  resetHandlesForTests,
  resolveHandle,
  subscribeGrants,
} from '@/state/handles'
import { useMemoryStores } from '@/state/idb'

/** A `FileSystemFileHandle` with the two behaviours this module reads. */
function stubHandle(
  name: string,
  options: {
    permission?: PermissionState
    onRequest?: PermissionState
    getFile?: () => Promise<File>
  } = {},
): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    queryPermission: vi.fn(async () => options.permission ?? 'granted'),
    requestPermission: vi.fn(async () => options.onRequest ?? 'granted'),
    getFile: options.getFile ?? (async () => new File(['bytes'], name)),
  } as unknown as FileSystemFileHandle
}

function fileNamed(name: string): File {
  return new File(['bytes'], name)
}

beforeEach(async () => {
  useMemoryStores()
  resetHandlesForTests()
  // Both halves of `handlesSupported`. jsdom has neither, and without them
  // every write below would correctly no-op and every assertion would pass for
  // the wrong reason.
  ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () => undefined
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
  await forgetAllHandles()
})

describe('handleKey', () => {
  it('is the file half, so one .mcool at five resolutions is one grant', () => {
    // The same normalisation `fileMemoryKey` applies, and for the same reason:
    // stepping through an mcool's resolutions is one file being re-addressed.
    expect(handleKey('yeast.mcool::resolutions/1000')).toBe('yeast.mcool')
    expect(handleKey('yeast.mcool::resolutions/5000')).toBe('yeast.mcool')
    expect(handleKey('yeast.cool')).toBe('yeast.cool')
  })

  it('carries no session id, because a grant is about a file and not a tab', () => {
    // Two tabs on one file share one grant. Keyed with a session id they would
    // not, and re-granting in the first would leave the second stale for no
    // reason a reader could deduce.
    expect(handleKey('rep1.cool')).toBe(handleKey('rep1.cool'))
  })
})

describe('remembering and resolving', () => {
  it('hands back a File for a grant that is still good', async () => {
    await rememberHandle('yeast.cool', stubHandle('yeast.cool'), fileNamed('yeast.cool'))
    const file = await resolveHandle('yeast.cool')
    expect(file?.name).toBe('yeast.cool')
  })

  it('answers a resolution of the same file, since the grant is on the file', async () => {
    await rememberHandle(
      'yeast.mcool::resolutions/1000',
      stubHandle('yeast.mcool'),
      fileNamed('yeast.mcool'),
    )
    expect(await resolveHandle('yeast.mcool::resolutions/5000')).not.toBeNull()
  })

  it('answers null for a file it was never given', async () => {
    expect(await resolveHandle('never-seen.cool')).toBeNull()
  })

  it('populates the synchronous set the tab strip reads', async () => {
    expect(hasHandle('yeast.cool')).toBe(false)
    await rememberHandle('yeast.cool', stubHandle('yeast.cool'), fileNamed('yeast.cool'))
    // Synchronous on purpose: `Session.tabHint` is a getter, read in a loop by
    // `App.paintTabs` on every state change.
    expect(hasHandle('yeast.cool::resolutions/1000')).toBe(true)
    expect([...knownPaths()]).toEqual(['yeast.cool'])
  })
})

describe('the refusals', () => {
  it('forgets a grant the reader has denied, rather than asking every reload', async () => {
    await rememberHandle(
      'denied.cool',
      stubHandle('denied.cool', { permission: 'denied' }),
      fileNamed('denied.cool'),
    )
    expect(await resolveHandle('denied.cool')).toBeNull()
    expect(hasHandle('denied.cool')).toBe(false)
  })

  it('does not prompt without being told it may', async () => {
    const handle = stubHandle('ask.cool', { permission: 'prompt' })
    await rememberHandle('ask.cool', handle, fileNamed('ask.cool'))

    // The boot path. `requestPermission` without transient activation resolves
    // without ever showing a dialog, so asking there would spend nothing and
    // teach the reader the feature does not work.
    expect(await resolveHandle('ask.cool')).toBeNull()
    expect(handle.requestPermission).not.toHaveBeenCalled()
    // …and the grant is kept, because 'prompt' is not a refusal.
    expect(hasHandle('ask.cool')).toBe(true)

    // A click may ask.
    expect(await resolveHandle('ask.cool', { prompt: true })).not.toBeNull()
    expect(handle.requestPermission).toHaveBeenCalled()
  })

  it('answers null when a prompt is shown and declined', async () => {
    await rememberHandle(
      'refused.cool',
      stubHandle('refused.cool', { permission: 'prompt', onRequest: 'denied' }),
      fileNamed('refused.cool'),
    )
    expect(await resolveHandle('refused.cool', { prompt: true })).toBeNull()
  })

  it('drops a grant whose file has gone, rather than throwing', async () => {
    await rememberHandle(
      'moved.cool',
      stubHandle('moved.cool', {
        getFile: async () => {
          throw new DOMException('not found', 'NotFoundError')
        },
      }),
      fileNamed('moved.cool'),
    )
    expect(await resolveHandle('moved.cool')).toBeNull()
    // The grant is spent: keeping it would offer a file that cannot be opened.
    expect(hasHandle('moved.cool')).toBe(false)
  })

  it('refuses a different file wearing the remembered name', async () => {
    // The collision this scheme inherits from the URI scheme: a local file's URI
    // is its bare name, so `rep1.cool` from two directories is one key. Opening
    // the wrong one is worse than opening none, because every label on screen
    // would agree with it.
    await rememberHandle(
      'rep1.cool',
      stubHandle('rep1.cool', { getFile: async () => fileNamed('somethingelse.cool') }),
      fileNamed('rep1.cool'),
    )
    expect(await resolveHandle('rep1.cool')).toBeNull()
    expect(hasHandle('rep1.cool')).toBe(false)
  })

  it('allows a file that has changed under it, and keeps the row current', async () => {
    // A re-run pipeline overwriting a file somebody is reading is a legitimate
    // thing to do, and the reader asked for *that file*. Only the name decides
    // identity.
    const bigger = new File(['bytes and more bytes'], 'grown.cool', { lastModified: 42 })
    await rememberHandle(
      'grown.cool',
      stubHandle('grown.cool', { getFile: async () => bigger }),
      fileNamed('grown.cool'),
    )
    expect(await resolveHandle('grown.cool')).not.toBeNull()
    expect(handleRows()[0].size).toBe(bigger.size)
    expect(handleRows()[0].lastModified).toBe(42)
  })
})

describe('support detection', () => {
  it('needs the picker as well as the storage', async () => {
    expect(handlesSupported()).toBe(true)
    // Safari implements `FileSystemFileHandle` for the origin-private
    // filesystem and has no picker, so a check for the type alone would promise
    // a grant that can never be made.
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
    expect(handlesSupported()).toBe(false)
    resetHandlesForTests()
    await rememberHandle('x.cool', stubHandle('x.cool'), fileNamed('x.cool'))
    expect(hasHandle('x.cool')).toBe(false)
  })
})

describe('forgetAllHandles', () => {
  it('empties the memory copy as well as the store', async () => {
    await rememberHandle('a.cool', stubHandle('a.cool'), fileNamed('a.cool'))
    await rememberHandle('b.cool', stubHandle('b.cool'), fileNamed('b.cool'))
    expect(handleRows()).toHaveLength(2)
    await forgetAllHandles()
    // Without the memory half, the sweep would report success while this page
    // went on offering to reopen files whose grants it had just deleted.
    expect(handleRows()).toEqual([])
    expect(await resolveHandle('a.cool')).toBeNull()
    resetHandlesForTests()
    await hydrateHandles()
    expect(handleRows()).toEqual([])
  })
})

describe('allowHandles — the allow access button', () => {
  it('asks for every remembered file in one press, the one pressed for first', async () => {
    const order: string[] = []
    const lapsed = (name: string): FileSystemFileHandle => {
      let state: PermissionState = 'prompt'
      return {
        kind: 'file',
        name,
        queryPermission: vi.fn(async () => state),
        requestPermission: vi.fn(async () => {
          order.push(name)
          state = 'granted'
          return state
        }),
        getFile: async () => new File(['bytes'], name),
      } as unknown as FileSystemFileHandle
    }
    await rememberHandle('ATAC.bw', lapsed('ATAC.bw'), fileNamed('ATAC.bw'))
    await rememberHandle('rep1.cool', lapsed('rep1.cool'), fileNamed('rep1.cool'))
    await rememberHandle('genes.gtf.gz.tbi', lapsed('genes.gtf.gz.tbi'), fileNamed('genes.gtf.gz.tbi'))
    const heard = vi.fn()
    subscribeGrants(heard)

    expect((await allowHandles('rep1.cool'))?.name).toBe('rep1.cool')
    expect(order[0]).toBe('rep1.cool')
    expect([...order].sort()).toEqual(['ATAC.bw', 'genes.gtf.gz.tbi', 'rep1.cool'])
    // All of them readable now without a gesture, which is what each tab's
    // retry finds — and it is told once, after the last.
    expect(await resolveHandle('ATAC.bw')).not.toBeNull()
    expect(await resolveHandle('genes.gtf.gz.tbi')).not.toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('asks about nothing else when the file pressed for is refused', async () => {
    const other = stubHandle('ATAC.bw', { permission: 'prompt', onRequest: 'granted' })
    await rememberHandle('ATAC.bw', other, fileNamed('ATAC.bw'))
    await rememberHandle(
      'rep1.cool',
      stubHandle('rep1.cool', { permission: 'prompt', onRequest: 'denied' }),
      fileNamed('rep1.cool'),
    )
    expect(await allowHandles('rep1.cool')).toBeNull()
    expect(other.requestPermission).not.toHaveBeenCalled()
  })

  it('goes on to the rest past a file that cannot be read any more, and forgets it', async () => {
    await rememberHandle('rep1.cool', stubHandle('rep1.cool', { permission: 'prompt' }), fileNamed('rep1.cool'))
    await rememberHandle(
      'gone.bw',
      stubHandle('gone.bw', {
        permission: 'prompt',
        getFile: async () => {
          throw new DOMException('gone', 'NotFoundError')
        },
      }),
      fileNamed('gone.bw'),
    )
    const later = stubHandle('later.bw', { permission: 'prompt' })
    await rememberHandle('later.bw', later, fileNamed('later.bw'))
    expect(await allowHandles('rep1.cool')).not.toBeNull()
    expect(hasHandle('gone.bw')).toBe(false)
    expect(later.requestPermission).toHaveBeenCalled()
  })

  it('asks for a grant that lapsed to "ask first", and tells every tab when it is given', async () => {
    // A restart: the row is still stored, the browser wants a click.
    const handle = stubHandle('rep1.cool', { permission: 'prompt', onRequest: 'granted' })
    await rememberHandle('rep1.cool', handle, fileNamed('rep1.cool'))
    const heard = vi.fn()
    subscribeGrants(heard)

    // The silent road, which every restore takes, asks nothing and keeps the row,
    // so the button has something to offer.
    expect(await resolveHandle('rep1.cool')).toBeNull()
    expect(handle.requestPermission).not.toHaveBeenCalled()
    expect(hasHandle('rep1.cool')).toBe(true)
    expect(heard).not.toHaveBeenCalled()

    const file = await allowHandles('rep1.cool')
    expect(file?.name).toBe('rep1.cool')
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'read' })
    // Once, so each tab retries its tracks and its waiting map once.
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('announces nothing when the reader dismisses the prompt, and keeps the row to ask again', async () => {
    await rememberHandle(
      'rep1.cool',
      stubHandle('rep1.cool', { permission: 'prompt', onRequest: 'prompt' }),
      fileNamed('rep1.cool'),
    )
    const heard = vi.fn()
    subscribeGrants(heard)
    expect(await allowHandles('rep1.cool')).toBeNull()
    expect(heard).not.toHaveBeenCalled()
    expect(hasHandle('rep1.cool')).toBe(true)
  })

  it('forgets a grant whose file has gone, so the button is not offered again', async () => {
    await rememberHandle(
      'gone.cool',
      stubHandle('gone.cool', {
        permission: 'prompt',
        onRequest: 'granted',
        getFile: async () => {
          throw new DOMException('gone', 'NotFoundError')
        },
      }),
      fileNamed('gone.cool'),
    )
    expect(await allowHandles('gone.cool')).toBeNull()
    expect(hasHandle('gone.cool')).toBe(false)
  })

  it('stops telling a listener that has let go', async () => {
    await rememberHandle(
      'rep1.cool',
      stubHandle('rep1.cool', { permission: 'prompt', onRequest: 'granted' }),
      fileNamed('rep1.cool'),
    )
    const heard = vi.fn()
    const stop = subscribeGrants(heard)
    stop()
    expect(await allowHandles('rep1.cool')).not.toBeNull()
    expect(heard).not.toHaveBeenCalled()
  })
})
