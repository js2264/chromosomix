/**
 * What a press of `ori` keeps (§8.15).
 *
 * `ori` frames the sequence on screen another way — its origin in the middle,
 * or its first base at the corner — and every other navigation starts from the
 * file's own score. A reader who had picked `arm decay` and pressed `ori` to see
 * the two diagonals as an X was put back on balanced counts, and had to pick the
 * score again after every press.
 */

import { describe, expect, it } from 'vitest'

import { keepingScore } from '../../src/app/Session'
import type { ViewState } from '../../src/types'

const URI = 'https://example.org/PAK.mcool::/resolutions/8000'

function state(over: Partial<ViewState> = {}): ViewState {
  return { uri: URI, view: 'region', region: 'LR657304.1', ...over } as ViewState
}

describe('a press of ori', () => {
  it('keeps the score, and the balancing that is the other half of it', () => {
    const held = state({ score: 'armbaseline', balance: false, oe: true })
    const next = keepingScore(held, { uri: URI, view: 'region', region: 'LR657304.1:3197937-3197935' })
    expect(next.score).toBe('armbaseline')
    expect(next.balance).toBe(false)
    expect(next.region).toBe('LR657304.1:3197937-3197935')
    // Nothing else is its business: the O/E is carried by every navigation,
    // and that is `Session.navigate`'s.
    expect('oe' in next).toBe(false)
  })

  it('adds nothing to a map on the file’s own score', () => {
    const next = keepingScore(state(), { uri: URI, view: 'region', region: 'LR657304.1' })
    expect('score' in next).toBe(false)
    expect('balance' in next).toBe(false)
  })

  it('believes a state that has said something about either key', () => {
    const held = state({ score: 'armbaseline', balance: false })
    const next = keepingScore(held, { uri: URI, view: 'region', region: 'LR657304.1', score: 'ice' })
    expect(next.score).toBe('ice')
    expect(next.balance).toBe(false)
  })

  it('keeps nothing into another file, or from nothing', () => {
    const held = state({ score: 'armbaseline', balance: false })
    const other = keepingScore(held, { uri: 'https://example.org/E_coli.mcool', view: 'region', region: 'chr' })
    expect('score' in other).toBe(false)
    const fresh = keepingScore(null, { uri: URI, view: 'region', region: 'LR657304.1' })
    expect('score' in fresh).toBe(false)
  })
})
