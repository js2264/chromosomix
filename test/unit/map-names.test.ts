/**
 * What a reader calls a contact map.
 *
 * The store is small and its three decisions are all silent when wrong, which
 * is what these pin:
 *
 * - **the key is the file, not the rung**, so a name survives a change of
 *   resolution the way every other per-file fact does — keyed by the URI it was
 *   typed under, a reader who renamed a map at 1 kb would find it back to its
 *   file name at 5 kb, and only there;
 * - **an empty name is not a name**, which is what makes a rename undoable and
 *   what stops a row whose label is a blank box;
 * - **what comes back out of storage is untrusted**, because it outlives the
 *   build that wrote it and because a workspace file is somebody else's input.
 */

import { describe, expect, it } from 'vitest'

import {
  cleanMapNames,
  mapLabelIn,
  mapNameIn,
  withMapName,
  type MapNames,
} from '@/ui/mapNames'

const AT_1KB = 'https://example.org/rep1.mcool::/resolutions/1000'
const AT_5KB = 'https://example.org/rep1.mcool::/resolutions/5000'

describe('naming a map', () => {
  it('names the file, so the name survives a change of resolution', () => {
    const names = withMapName({}, AT_1KB, 'G1 phase')
    expect(mapNameIn(names, AT_1KB)).toBe('G1 phase')
    expect(mapNameIn(names, AT_5KB)).toBe('G1 phase')
    expect(mapNameIn(names, 'https://example.org/rep2.mcool::/resolutions/1000')).toBeUndefined()
  })

  it('hands a map back to its file name when the box is emptied', () => {
    const named = withMapName({}, AT_1KB, 'G1 phase')
    expect(mapLabelIn(named, AT_1KB)).toBe('G1 phase')
    for (const cleared of [null, '', '   ']) {
      const back = withMapName(named, AT_1KB, cleared)
      expect(mapNameIn(back, AT_1KB)).toBeUndefined()
      expect(mapLabelIn(back, AT_1KB)).toBe('rep1.mcool::1000')
    }
  })

  it('falls back to the file label for a map nobody has named', () => {
    expect(mapLabelIn({}, AT_1KB)).toBe('rep1.mcool::1000')
    expect(mapLabelIn({}, 'rep2.cool')).toBe('rep2.cool')
  })

  it('leaves the record it was given alone', () => {
    const held: MapNames = { 'https://example.org/rep1.mcool': 'G1 phase' }
    const next = withMapName(held, 'https://example.org/rep2.cool', 'G2/M phase')
    expect(held).toEqual({ 'https://example.org/rep1.mcool': 'G1 phase' })
    expect(Object.keys(next)).toHaveLength(2)
  })

  it('trims what was typed, since a name is what is drawn', () => {
    expect(mapNameIn(withMapName({}, AT_1KB, '  G1 phase  '), AT_1KB)).toBe('G1 phase')
  })

  it('does not let a name grow past what a heading can hold', () => {
    const long = 'x'.repeat(500)
    const name = mapNameIn(withMapName({}, AT_1KB, long), AT_1KB)
    expect(name?.length).toBe(200)
  })
})

describe('reading names back', () => {
  it('keeps what is a name and drops what is not', () => {
    expect(
      cleanMapNames({
        'rep1.mcool': 'G1 phase',
        'rep2.mcool': '   ',
        'rep3.mcool': 42,
        'rep4.mcool': null,
        '': 'nowhere',
        'rep5.mcool': '  G2/M phase  ',
      }),
    ).toEqual({ 'rep1.mcool': 'G1 phase', 'rep5.mcool': 'G2/M phase' })
  })

  it('reads anything that is not a record as no names at all', () => {
    for (const value of [null, undefined, 7, 'G1 phase', ['G1 phase']]) {
      expect(cleanMapNames(value)).toEqual({})
    }
  })
})
