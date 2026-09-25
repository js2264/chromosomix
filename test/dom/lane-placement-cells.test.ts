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
    expect(onCell.map((button) => `${button.dataset.edge}:${button.disabled ? 'off' : 'on'}`)).toEqual([
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

/**
 * The control as it is drawn (§8.1): four marks of the map — a dashed square
 * with one edge solid — rather than four words, and in a deck on the same line
 * as the name of the map they place the track on.
 */
describe('the four edges', () => {
  function placed(maps: Array<{ id: string; label: string }>) {
    const held = store()
    const entry = held.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
    })
    const field = placementField(held, entry, maps)
    document.body.append(field)
    return { held, entry, field }
  }

  it('are marks named for their edge, not words', () => {
    const { field } = placed([{ id: 'lead', label: '' }])
    const buttons = all<HTMLButtonElement>(field, '.ann-place')
    expect(buttons.map((button) => button.dataset.edge)).toEqual(['top', 'right', 'bottom', 'left'])
    for (const button of buttons) {
      expect(button.textContent).toBe('')
      expect(button.querySelector('svg')).not.toBeNull()
      // The word is still its name, for whoever cannot see the mark.
      expect(button.getAttribute('aria-label')).toBe(button.dataset.edge)
    }
    // A loaded track opens on the bottom.
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false'])
  })

  it('sit beside the label with one map, and on each map’s own line in a deck', () => {
    const one = placed([{ id: 'lead', label: '' }]).field
    expect(one.classList.contains('is-named')).toBe(false)
    expect(one.querySelector('.ann-place-map')).toBeNull()
    const deck = placed([
      { id: 'lead', label: 'rep1.cool' },
      { id: 'p2', label: 'rep2.cool' },
    ]).field
    expect(deck.classList.contains('is-named')).toBe(true)
    const lines = all<HTMLElement>(deck, '.ann-place-map')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      // The name and its four marks are one line's two children.
      expect(Array.from(line.children).map((child) => child.className)).toEqual(['ann-place-name', 'ann-places'])
      expect(all(line, '.ann-place')).toHaveLength(4)
    }
  })

  it('put the track on the edge pressed, on the map whose line it is', () => {
    const { held, entry, field } = placed([
      { id: 'lead', label: 'rep1.cool' },
      { id: 'p2', label: 'rep2.cool' },
    ])
    const second = all<HTMLElement>(field, '.ann-place-map')[1]
    second?.querySelector<HTMLButtonElement>('[data-edge="left"]')?.click()
    expect(held.laneFor(entry.id, 'p2')?.placement.left).toBe(true)
  })
})
