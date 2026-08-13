/**
 * The three questions about where a file's bytes come from.
 *
 * The one that matters most here is the one that must **not** have changed.
 * `inferSource` is the shareability test: `Session` asks it before writing
 * `uri2` into the view state and before accepting one out of it, and the view
 * state goes into links, into the address bar, and through `state/shareLink.ts`
 * into something a reader sends a colleague. A local file name in there is a
 * private filename posted to a stranger, and a recipient's deck would try to
 * *fetch* it — against the site root on the web, against `app://viewer/` in the
 * desktop build.
 *
 * A remembered grant does not change that: this browser being able to reopen
 * `rep1.cool` says nothing about anybody else's. So the first block below is a
 * characterisation test — it pins the answers this function has always given,
 * precisely so that adding a second, more capable resolver beside it cannot
 * quietly widen the first.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { inferSource, mayResolve, resolveSource } from '@/app/resolve'
import { forgetAllHandles, rememberHandle, resetHandlesForTests } from '@/state/handles'
import { useMemoryStores } from '@/state/idb'

function stubHandle(name: string): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
    getFile: async () => new File(['bytes'], name),
  } as unknown as FileSystemFileHandle
}

beforeEach(async () => {
  useMemoryStores()
  resetHandlesForTests()
  ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () => undefined
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
  await forgetAllHandles()
})

describe('inferSource — the hash contract', () => {
  it('answers remote for http and https, and the file half only', () => {
    expect(inferSource('https://bucket.example.org/a.cool')).toEqual({
      kind: 'remote',
      url: 'https://bucket.example.org/a.cool',
    })
    expect(inferSource('http://host/a.mcool::resolutions/1000')).toEqual({
      kind: 'remote',
      url: 'http://host/a.mcool',
    })
    expect(inferSource('HTTPS://Host/A.cool')).toEqual({ kind: 'remote', url: 'HTTPS://Host/A.cool' })
  })

  it('answers null for everything else, a granted local file included', async () => {
    expect(inferSource('yeast.cool')).toBeNull()
    expect(inferSource('/home/js/yeast.cool')).toBeNull()
    expect(inferSource('s3://bucket/a.cool')).toBeNull()
    expect(inferSource('file:///home/js/a.cool')).toBeNull()

    // The load-bearing case. This browser can reopen the file; no other browser
    // can, so the answer to "is this fit to travel" is still no.
    await rememberHandle('yeast.cool', stubHandle('yeast.cool'), new File(['b'], 'yeast.cool'))
    expect(inferSource('yeast.cool')).toBeNull()
  })
})

describe('mayResolve', () => {
  it('is true for a remote file, and for a local one this browser remembers', async () => {
    expect(mayResolve('https://host/a.cool')).toBe(true)
    expect(mayResolve('a.cool')).toBe(false)
    await rememberHandle('a.cool', stubHandle('a.cool'), new File(['b'], 'a.cool'))
    expect(mayResolve('a.cool')).toBe(true)
  })
})

describe('resolveSource', () => {
  it('answers a remote URI without touching the handle store', async () => {
    // Every demo, every published session and every shared link takes this
    // path, and none of them should pay a storage read for it.
    const handle = stubHandle('unused.cool')
    const query = vi.spyOn(handle, 'queryPermission' as never)
    await rememberHandle('https://host/a.cool', handle, new File(['b'], 'unused.cool'))
    expect(await resolveSource('https://host/a.cool')).toEqual({
      kind: 'remote',
      url: 'https://host/a.cool',
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('answers a local source for a granted file', async () => {
    await rememberHandle('a.cool', stubHandle('a.cool'), new File(['b'], 'a.cool'))
    const source = await resolveSource('a.cool')
    expect(source?.kind).toBe('local')
    expect(source?.kind === 'local' && source.file.name).toBe('a.cool')
  })

  it('answers null for a local file with no grant, which is the picker', async () => {
    expect(await resolveSource('a.cool')).toBeNull()
  })
})
