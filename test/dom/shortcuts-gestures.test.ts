// @vitest-environment jsdom
/**
 * The shortcuts dialog's table of what a hand does on a contact map (§7.2,
 * §8.9, §16.9).
 *
 * It is the one hand-written table in that dialog — the keys come from the
 * command registry, the gestures belong to the canvas and are not commands —
 * so it is the one that goes stale when a gesture changes, and it had: a
 * sideways scroll was still said to slide the map *left and right* a release
 * after it learned to follow the diagonal, a lane was resized by an edge it
 * does not have, and a file dropped above or left of the map was said not to
 * land there. What is pinned here is what the map does now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openShortcuts } from '@/ui/dialogs'
import type { Modal } from '@/ui/Modal'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let modal: Modal | null = null

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  modal?.close()
  modal = null
  teardown()
})

/** The map's table as `gesture → what it does`, as a reader reads it. */
function mapGestures(): Map<string, string> {
  modal = openShortcuts([])
  const section = all<HTMLElement>(document.body, '.shortcut-gestures .shortcut-group').find(
    (node) => node.querySelector('h3')?.textContent === 'On a contact map',
  )
  if (section === undefined) throw new Error('no table for the map')
  return new Map(
    all<HTMLElement>(section, '.shortcut-row').map((row) => [
      row.querySelector('.kbd')?.textContent ?? '',
      row.querySelector('.shortcut-text')?.textContent ?? '',
    ]),
  )
}

describe('the map’s gestures', () => {
  it('says a sideways scroll slides along the diagonal, and where it does not', () => {
    const slide = mapGestures().get('two fingers sideways') ?? ''
    expect(slide).toMatch(/along the diagonal/)
    expect(slide).toMatch(/turned map/)
    expect(slide).not.toMatch(/left and right/)
  })

  it('lists Shift alone, which zooms to the stretch it spans', () => {
    const gestures = [...mapGestures()]
    const shift = gestures.find(([keys]) => /^(⇧|Shift) \+ drag$/.test(keys))
    expect(shift?.[1]).toMatch(/on the diagonal/)
  })

  it('resizes a lane by its far edge, and moves its ceiling by a drag across it', () => {
    const gestures = mapGestures()
    expect(gestures.has('drag a lane’s far edge')).toBe(true)
    expect(gestures.has('drag a lane’s inner edge')).toBe(false)
    expect(gestures.get('drag across a lane')).toMatch(/ceiling/)
  })

  it('takes a file on any edge, and sends a lane’s grip to a tracks cell too', () => {
    const gestures = mapGestures()
    expect(gestures.has('drop a file on an edge of the map')).toBe(true)
    expect(gestures.get('drag a lane’s grip')).toMatch(/tracks cell/)
  })
})
