// @vitest-environment jsdom
/**
 * The declared origins: where they are kept, and whose word wins.
 *
 * A task fills in an origin and the next run of the task may move it; a reader's
 * is theirs, and no run of anything moves it. That rule is the whole of the
 * store's logic, and a workspace hands a colleague origins that are theirs.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { OriginStore } from '../../src/state/origins'

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('declared origins', () => {
  it('takes a task’s origins, and moves them on the next run', () => {
    const store = new OriginStore('file.mcool')
    expect(store.fill({ chrI: 6_374_500 })).toEqual(['chrI'])
    expect(store.get('chrI')).toEqual({ at: 6_374_500, by: 'task' })
    expect(store.fill({ chrI: 6_374_000 })).toEqual(['chrI'])
    expect(store.record()).toEqual({ chrI: 6_374_000 })
  })

  it('never lets a task move an origin the reader set', () => {
    const store = new OriginStore('file.mcool')
    store.set('chrI', 1_000)
    expect(store.fill({ chrI: 6_374_500, plasmid: 20 })).toEqual(['plasmid'])
    expect(store.get('chrI')).toEqual({ at: 1_000, by: 'reader' })
  })

  it('is kept per file, and read back by the next store on it', () => {
    new OriginStore('file.mcool').fill({ chrI: 42 })
    expect(new OriginStore('file.mcool').record()).toEqual({ chrI: 42 })
    expect(new OriginStore('other.mcool').record()).toEqual({})
  })

  it('takes a workspace’s origins as the reader’s own', () => {
    const store = new OriginStore('file.mcool')
    store.replace({ chrI: 7 })
    expect(store.get('chrI')).toEqual({ at: 7, by: 'reader' })
    expect(store.fill({ chrI: 9 })).toEqual([])
  })
})
