// @vitest-environment jsdom
/**
 * The resolution, as a thing you can take hold of.
 *
 * Five rules, and each of them is a way the control could be wrong while
 * looking right:
 *
 * - it hides where there is nothing to slide along, which is every MAG;
 * - the thumb and the label agree, always — a slider whose own number
 *   contradicts its position is worse than no slider;
 * - the scale is logarithmic, so the interesting range is not crushed into a
 *   tenth of the travel;
 * - the ticks are the doublings, which is where a read actually lands;
 * - a drag asks for a resolution, and a redraw arriving mid-drag does not
 *   snatch the thumb back.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { ResolutionBar, type ResolutionState } from '@/ui/ResolutionBar'
import { setUpDom } from '../support/dom'

setUpDom()

function bar(): { it: ResolutionBar; picked: number[]; input: HTMLInputElement } {
  const picked: number[] = []
  const made = new ResolutionBar({ onPick: (bp) => picked.push(bp) })
  document.body.replaceChildren(made.el)
  return { it: made, picked, input: made.el.querySelector('.res-slider') as HTMLInputElement }
}

/** A reading at rest: what is drawn is what the window wants. */
function at(drawn: number, range: { finest: number; coarsest: number }): ResolutionState {
  return { ...range, drawn, wanted: drawn }
}

const YEAST = { finest: 1000, coarsest: 16_000 }

beforeEach(() => {
  document.body.replaceChildren()
})

describe('when there is a scale at all', () => {
  it('hides itself where the block already is the finest data in the file', () => {
    // A MAG: one bounded read at the file's own bins, and nothing finer to go
    // to. Same rule as the score picker's single entry — a control that cannot
    // be used says "you have a choice here" and then refuses to make one.
    const b = bar()
    b.it.update(at(5000, { finest: 5000, coarsest: 5000 }))
    expect(b.it.el.classList.contains('hidden')).toBe(true)
  })

  it('hides itself when it has nothing to show at all', () => {
    const b = bar()
    b.it.update(at(1000, YEAST))
    expect(b.it.el.classList.contains('hidden')).toBe(false)
    b.it.update(null)
    expect(b.it.el.classList.contains('hidden')).toBe(true)
  })

  it('appears as soon as there is more than one rung between the ends', () => {
    const b = bar()
    b.it.update(at(10_000, YEAST))
    expect(b.it.el.classList.contains('hidden')).toBe(false)
  })
})

describe('what it reads', () => {
  it('puts the thumb where its own label says, at both ends', () => {
    const b = bar()
    b.it.update(at(YEAST.coarsest, YEAST))
    expect(b.input.value).toBe('0')
    expect(b.it.el.querySelector('.res-readout')?.textContent).toBe('16 kb')

    b.it.update(at(YEAST.finest, YEAST))
    expect(b.input.value).toBe(b.input.max)
    expect(b.it.el.querySelector('.res-readout')?.textContent).toBe('1 kb')
  })

  it('is logarithmic, so a doubling is the same distance wherever it is', () => {
    const b = bar()
    const stepOf = (drawn: number): number => {
      b.it.update(at(drawn, YEAST))
      return Number(b.input.value)
    }
    const steps = [16_000, 8000, 4000, 2000, 1000].map(stepOf)
    const gaps = steps.slice(1).map((s, i) => s - steps[i])
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], -1)
  })

  it('marks every doubling, and only the doublings', () => {
    const b = bar()
    b.it.update(at(4000, YEAST))
    // 1, 2, 4, 8, 16 kb.
    expect(b.it.el.querySelectorAll('.res-tick')).toHaveLength(5)
  })

  it('says it is pending when the picture is behind the window', () => {
    const b = bar()
    b.it.update({ ...YEAST, drawn: 8000, wanted: 1000 })
    expect(b.it.el.classList.contains('is-pending')).toBe(true)
    // …and not merely because the ladder is inside its own tolerance, which is
    // the state a map sits in at rest and which would otherwise read as a
    // permanent warning.
    b.it.update({ ...YEAST, drawn: 2000, wanted: 1000 })
    expect(b.it.el.classList.contains('is-pending')).toBe(false)
  })
})

describe('what it does', () => {
  it('asks for the resolution under the thumb', () => {
    const b = bar()
    b.it.update(at(16_000, YEAST))
    b.input.value = b.input.max
    b.input.dispatchEvent(new Event('input'))
    expect(b.picked).toHaveLength(1)
    expect(b.picked[0]).toBeCloseTo(1000, 0)

    b.input.value = '0'
    b.input.dispatchEvent(new Event('input'))
    expect(b.picked[1]).toBeCloseTo(16_000, 0)
  })

  it('asks on every move rather than on release', () => {
    // The map follows the thumb, which is only affordable because a rung is a
    // replay of pixels already inflated rather than a read.
    const b = bar()
    b.it.update(at(16_000, YEAST))
    for (const value of ['200', '400', '600']) {
      b.input.value = value
      b.input.dispatchEvent(new Event('input'))
    }
    expect(b.picked).toHaveLength(3)
    expect(b.picked[0]).toBeGreaterThan(b.picked[1])
    expect(b.picked[1]).toBeGreaterThan(b.picked[2])
  })

  it('does not fight the hand that is holding it', () => {
    // The map answers a drag on the next frame, and that answer lands here. If
    // it were written into the input the thumb would spring back under the
    // pointer on every frame of the drag.
    const b = bar()
    b.it.update(at(16_000, YEAST))
    b.input.dispatchEvent(new Event('pointerdown'))
    b.input.value = '700'
    b.input.dispatchEvent(new Event('input'))
    b.it.update(at(16_000, YEAST))
    expect(b.input.value, 'still where the pointer put it').toBe('700')

    b.input.dispatchEvent(new Event('pointerup'))
    b.it.update(at(16_000, YEAST))
    expect(b.input.value, 'and it catches up once let go').toBe('0')
  })

  it('says nothing when it has no scale to say it on', () => {
    const b = bar()
    b.it.update(null)
    b.input.value = '500'
    b.input.dispatchEvent(new Event('input'))
    expect(b.picked).toHaveLength(0)
  })
})
