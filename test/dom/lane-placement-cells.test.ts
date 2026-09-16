// @vitest-environment jsdom

/**
 * The location control over a deck with cells that are not maps (§25.3).
 *
 * A tracks cell is a place a track can be put, with one edge; the other three
 * buttons on its row are greyed rather than missing, so every row keeps the
 * same shape. A structure is a row and never a lane, so it is placed nowhere
 * on import and the control is not offered for it.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { placementField } from '@/ui/lanePlacement'
import { all } from '../support/dom'

afterEach(() => {
  document.body.replaceChildren()
})

function store(): AnnotationStore {
  return new AnnotationStore(`placement-${Math.random()}.cool`, { persist: false })
}

describe('placing a track on a tracks cell', () => {
  it('offers the bottom edge and greys the others, saying why', () => {
    const held = store()
    const entry = held.begin({
      card: 'linear',
      kind: 'segments',
      source: { kind: 'local', file: new File(['chr1\t0\t10\n'], 'a.bed'), name: 'a.bed' },
    })
    const field = placementField(held, entry, [
      { id: 'lead', label: 'lead.cool' },
      { id: 'p2', label: 'tracks', edges: ['bottom'] },
    ])
    document.body.append(field)
    const rows = all<HTMLElement>(field, '.ann-places')
    expect(rows).toHaveLength(2)
    const onMap = all<HTMLButtonElement>(rows[0]!, '.ann-place')
    expect(onMap.every((button) => !button.disabled)).toBe(true)
    const onCell = all<HTMLButtonElement>(rows[1]!, '.ann-place')
    expect(onCell.map((button) => `${button.textContent}:${button.disabled ? 'off' : 'on'}`)).toEqual([
      'top:off',
      'right:off',
      'bottom:on',
      'left:off',
    ])
    expect(onCell[0]?.title).toMatch(/no top edge/)
    // The one live button puts the track on the cell.
    onCell[2]?.click()
    expect(held.mapsDrawing(entry.id)).toContain('p2')
  })

  it('places a structure row nowhere, and a track on the lead', () => {
    const held = store()
    const track = held.begin({
      card: 'linear',
      kind: 'segments',
      source: { kind: 'local', file: new File(['chr1\t0\t10\n'], 'a.bed'), name: 'a.bed' },
    })
    const model = held.begin({
      card: 'linear',
      kind: 'structure',
      source: { kind: 'local', file: new File(['chr1\t0\t0.1\t0.2\t0.3\n'], 'm.g3d'), name: 'm.g3d' },
    })
    expect(held.mapsDrawing(track.id)).toEqual(['lead'])
    expect(held.mapsDrawing(model.id)).toEqual([])
  })
})
