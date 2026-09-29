/**
 * The rail's labels (SPECS §27.3): each at the height of what it concerns,
 * pushed apart so no two overlap, and kept inside the rail — the one piece of
 * the rail that is arithmetic rather than drawing.
 */

import { describe, expect, it } from 'vitest'

import { packLabels } from '../../src/edit/rail'

describe('the rail’s labels', () => {
  it('sit centred on what they concern where there is room', () => {
    expect(packLabels([100, 300], 600, 20, 3)).toEqual([90, 290])
  })

  it('push apart where two would overlap, in the order they stand', () => {
    const tops = packLabels([100, 105, 110], 600, 20, 3)
    expect(tops).toEqual([90, 113, 136])
  })

  it('stay inside the rail, the last few pushed back up above the ones after them', () => {
    const tops = packLabels([590, 595, 598], 600, 20, 3)
    expect(tops).toEqual([534, 557, 580])
    expect(packLabels([-40], 600, 20, 3)).toEqual([0])
  })

  it('keep each label with its own item, whatever order they come in', () => {
    const tops = packLabels([300, 100], 600, 20, 3)
    expect(tops).toEqual([290, 90])
  })
})
