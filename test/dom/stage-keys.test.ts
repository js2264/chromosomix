// @vitest-environment jsdom
/**
 * A stage's keys (SPECS §26.4): answered only while the stage is the dialog on
 * top, and never a field's, an open menu's or a focused button's Space.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeMenu, openMenu } from '@/ui/Menu'
import { stageKeys } from '@/ui/stageKeys'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  closeMenu()
  teardown()
})

/** A stage in a dialog, listening, and the keys it heard. */
function stage(): { root: HTMLElement; heard: string[]; stop: () => void; backdrop: HTMLElement } {
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  const root = document.createElement('div')
  backdrop.appendChild(root)
  document.body.appendChild(backdrop)
  const heard: string[] = []
  const stop = stageKeys(root, {
    down: (event) => {
      heard.push(event.key)
      return event.key !== 'q'
    },
  })
  return { root, heard, stop, backdrop }
}

function press(key: string, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('a stage’s keys', () => {
  it('leave Enter to a focused button and the arrows to a focused grip', () => {
    const { root, heard } = stage()
    const close = document.createElement('button')
    const grip = document.createElement('div')
    grip.setAttribute('role', 'separator')
    grip.tabIndex = 0
    root.append(close, grip)
    expect(press('Enter', close).defaultPrevented).toBe(false)
    expect(press('ArrowLeft', grip).defaultPrevented).toBe(false)
    // Elsewhere they are the stage's.
    press('Enter', root)
    press('ArrowLeft', close)
    expect(heard).toEqual(['Enter', 'ArrowLeft'])
  })

  it('are answered while the stage is on top, and taken whole when the stage takes them', () => {
    const { heard } = stage()
    expect(press('m').defaultPrevented).toBe(true)
    // A key the stage leaves goes on as it came.
    expect(press('q').defaultPrevented).toBe(false)
    expect(heard).toEqual(['m', 'q'])
  })

  it('are not the stage’s in a field, under an open menu, or as a focused button’s Space', () => {
    const { root, heard } = stage()
    const box = document.createElement('input')
    root.appendChild(box)
    press('m', box)
    const button = document.createElement('button')
    root.appendChild(button)
    press(' ', button)
    openMenu(10, 10, [{ label: 'merge', run: () => {} }])
    press('ArrowDown')
    closeMenu()
    press('ArrowDown')
    expect(heard).toEqual(['ArrowDown'])
  })

  it('stand down under a dialog stacked over the stage, and stop with the stage', () => {
    const { heard, stop } = stage()
    const over = document.createElement('div')
    over.className = 'modal-backdrop'
    document.body.appendChild(over)
    press('m')
    over.remove()
    press('n')
    stop()
    press('b')
    expect(heard).toEqual(['n'])
  })
})
