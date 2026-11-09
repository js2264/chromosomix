// @vitest-environment jsdom
/**
 * An embed keeps its per-file memory to itself (§21.2).
 *
 * Every frame on one origin shares that origin's `sessionStorage`, and an embed
 * keeps no tab strip, so two notebook widgets on one map started with the same
 * session id: the second recalled the first's tracks, and a frame reloaded in
 * place recalled its own under the tracks its host added again.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { resetMounting } from '@/embed'
import { recall, recallBelow, remember } from '@/state/UiMemory'

afterEach(() => {
  window.history.replaceState(null, '', '/')
  resetMounting()
  window.sessionStorage.clear()
})

describe('the memory of a file, in an embed', () => {
  it('is not written to the storage every frame of the page shares', () => {
    window.history.replaceState(null, '', '/?embed=1')
    resetMounting()
    remember('s1|https://data.example/a.cool', 'tracks', [{ uri: 'https://data.example/a.bw' }])
    expect(window.sessionStorage.length).toBe(0)
    // The frame still remembers for itself, while it lives.
    expect(recall('s1|https://data.example/a.cool', 'tracks')).toEqual([{ uri: 'https://data.example/a.bw' }])
  })

  it('does not recall what another window of the origin left there', () => {
    window.sessionStorage.setItem('chromosomix:ui:s1|https://data.example/b.cool:tracks', JSON.stringify(['x']))
    window.history.replaceState(null, '', '/?embed=1')
    resetMounting()
    expect(recall('s1|https://data.example/b.cool', 'tracks')).toBeNull()
    expect(recallBelow('s1|https://data.example/b.cool', 'tracks')).toEqual([])
  })

  it('is written to the session storage in a window of its own, as before', () => {
    resetMounting()
    remember('s2|https://data.example/c.cool', 'tracks', ['y'])
    expect(window.sessionStorage.getItem('chromosomix:ui:s2|https://data.example/c.cool:tracks')).toBe('["y"]')
  })
})
