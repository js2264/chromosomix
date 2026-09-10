// @vitest-environment jsdom
/**
 * The `−  90  +` box, and the one thing about it that is not cosmetic: what an
 * *emptied* box means.
 *
 * It means "I have not decided yet", and the control has always said so in a
 * comment — an unreadable box is put back rather than obeyed. It did not do it.
 * The guard tested `Number.isFinite(Number(input.value))`, and `Number('')` is
 * 0, which is finite: clearing the track-height box therefore committed
 * `clamp(0)`, and every lane in the stack collapsed to the twelve-pixel floor.
 * Clearing the transparency box (`ui/AnnotationCard.ts`, same control, floor 0)
 * restyled every annotation to opacity 1 the same way.
 *
 * A `type="number"` input makes it worse rather than better: it reports an empty
 * string for a cleared box *and* for everything it could not parse — `abc`,
 * `1e`, `--` — so the guard was not weak, it was dead. The cases here are the
 * ones that used to change the picture and now do not.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_HEIGHT, stepperField, trackHeightField } from '@/ui/trackControls'
import { setUpDom } from '../support/dom'

beforeEach(() => {
  setUpDom()
})

/** A stepper over a number somebody else holds, and what it committed. */
function made(read: () => number | null = () => 90): {
  box: HTMLInputElement
  applied: number[]
} {
  const applied: number[] = []
  const row = stepperField({
    label: 'track height',
    title: 'Height for every track, in pixels.',
    step: 1,
    min: 12,
    max: 400,
    read,
    apply: (value) => applied.push(value),
  })
  document.body.appendChild(row)
  return { box: row.querySelector('input') as HTMLInputElement, applied }
}

/** Leave the field, which is one of the two ways a value is committed. */
function leave(box: HTMLInputElement): void {
  box.dispatchEvent(new Event('change'))
}

describe('an emptied box', () => {
  it('is put back rather than obeyed', () => {
    const { box, applied } = made()
    expect(box.value).toBe('90')
    box.value = ''
    leave(box)
    // The floor — `clamp(Number(''))` — is what this used to apply.
    expect(applied).toEqual([])
    expect(box.value).toBe('90')
  })

  it('is put back on Enter too, with the caret still in it', () => {
    const { box, applied } = made()
    document.body.appendChild(box)
    box.focus()
    box.value = ''
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    // Written straight into the box: going through `sync`, which leaves a
    // focused box alone, would make the refusal invisible on the one road that
    // does not move the focus.
    expect(applied).toEqual([])
    expect(box.value).toBe('90')
  })

  it('is what a `type="number"` box reports for anything it could not parse', () => {
    const { box, applied } = made()
    // jsdom sanitises exactly as a browser does: the value of a number input is
    // '' for 'abc', so this is the same case arriving by a different road.
    box.value = 'abc'
    expect(box.value).toBe('')
    leave(box)
    expect(applied).toEqual([])
    expect(box.value).toBe('90')
  })

  it('leaves a box alone whose number nobody holds', () => {
    const { box, applied } = made(() => null)
    box.value = ''
    leave(box)
    expect(applied).toEqual([])
    expect(box.value).toBe('')
  })
})

describe('a box with a number in it', () => {
  it('still commits, clamped', () => {
    const { box, applied } = made()
    box.value = '150'
    leave(box)
    expect(applied).toEqual([150])
    box.value = '4000'
    leave(box)
    expect(applied).toEqual([150, 400])
  })
})

describe('the track height field', () => {
  it('does not collapse the stack to the floor when its box is cleared', () => {
    const seen: number[] = []
    const row = trackHeightField((px) => seen.push(px))
    document.body.appendChild(row)
    const box = row.querySelector('input') as HTMLInputElement
    expect(box.value).toBe(String(DEFAULT_TRACK_HEIGHT))
    box.value = ''
    leave(box)
    // `[12]` — every track in the stack restyled to the minimum — is what a
    // reader used to get for pressing Delete and tabbing away.
    expect(seen).toEqual([])
    expect(box.value).toBe(String(DEFAULT_TRACK_HEIGHT))
  })
})
