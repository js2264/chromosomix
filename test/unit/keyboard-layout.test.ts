/**
 * What the page learns about the reader's keyboard, and from what.
 *
 * Two sources: the keystrokes the reader makes anyway, and Chromium's layout
 * map. The edges worth pinning are the ones that would teach the page a wrong
 * layout — a key read under Shift or Caps Lock as though it were bare, a layout
 * switched mid-session leaving its old digit row behind — and the one that
 * would repaint every badge on every keystroke.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bareKey,
  digitsBare,
  learnKey,
  leftOfOne,
  looksAzerty,
  onLayoutChange,
  readLayout,
  resetLayout,
} from '@/ui/keyboardLayout'

beforeEach(() => {
  resetLayout()
})

afterEach(() => {
  resetLayout()
  vi.unstubAllGlobals()
})

const press = (init: Partial<KeyboardEvent> & { caps?: boolean }): KeyboardEvent => {
  const { caps = false, ...rest } = init
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    getModifierState: (name: string) => name === 'CapsLock' && caps,
    ...rest,
  } as KeyboardEvent
}

describe('a keystroke', () => {
  it('says what its key types bare, when nothing is held', () => {
    learnKey(press({ key: '&', code: 'Digit1' }))
    expect(bareKey('Digit1')).toBe('&')
    expect(digitsBare()).toBe(false)
  })

  it('says nothing under Shift or Caps Lock, except for a letter, whose case is all they change', () => {
    // AZERTY's 2 under Shift: the key's bare half (`é`) cannot be read off it.
    learnKey(press({ key: '2', code: 'Digit2', shiftKey: true }))
    learnKey(press({ key: '2', code: 'Digit2', caps: true }))
    expect(bareKey('Digit2')).toBeUndefined()
    // AZERTY's A, on the key QWERTY calls Q, under either.
    learnKey(press({ key: 'A', code: 'KeyQ', caps: true }))
    expect(bareKey('KeyQ')).toBe('a')
    expect(looksAzerty()).toBe(true)
  })

  it('says nothing with a modifier held, AltGraph included, nor for a dead key or a name', () => {
    learnKey(press({ key: '~', code: 'Digit2', ctrlKey: true, altKey: true }))
    learnKey(press({ key: 'π', code: 'KeyP', altKey: true }))
    learnKey(press({ key: 'Dead', code: 'BracketLeft' }))
    learnKey(press({ key: 'Enter', code: 'Enter' }))
    learnKey(press({ key: 'a', code: '' }))
    expect(bareKey('Digit2')).toBeUndefined()
    expect(bareKey('KeyP')).toBeUndefined()
    expect(bareKey('BracketLeft')).toBeUndefined()
    expect(bareKey('Enter')).toBeUndefined()
  })

  it('drops the rest of the digit row when a key of it disagrees — a layout switched mid-session', () => {
    learnKey(press({ key: '&', code: 'Digit1' }))
    learnKey(press({ key: '-', code: 'Digit6' }))
    expect(digitsBare()).toBe(false)
    // Now QWERTY: a bare 2 is a digit, and AZERTY's 6 is no longer the minus.
    learnKey(press({ key: '2', code: 'Digit2' }))
    expect(digitsBare()).toBe(true)
    expect(bareKey('Digit6')).toBeUndefined()
    expect(bareKey('Digit1')).toBeUndefined()
  })
})

describe('the key left of 1', () => {
  it('is Backquote on a PC, and AZERTY’s ² where only the letters have said', () => {
    expect(leftOfOne(false)).toBeUndefined()
    learnKey(press({ key: 'z', code: 'KeyW' }))
    expect(leftOfOne(false)).toBe('²')
    learnKey(press({ key: '`', code: 'Backquote' }))
    // The key's own word wins over the guess.
    expect(leftOfOne(false)).toBe('`')
  })

  it('is IntlBackslash on a European Mac and Backquote on an American one', () => {
    learnKey(press({ key: '@', code: 'IntlBackslash' }))
    learnKey(press({ key: '<', code: 'Backquote' }))
    expect(leftOfOne(true)).toBe('@')
    resetLayout()
    learnKey(press({ key: '§', code: 'IntlBackslash' }))
    learnKey(press({ key: '`', code: 'Backquote' }))
    expect(leftOfOne(true)).toBe('`')
  })

  it('is not the `<` key a French Mac reports as Backquote, when that is all it has said', () => {
    learnKey(press({ key: '<', code: 'Backquote' }))
    expect(leftOfOne(true)).toBeUndefined()
    learnKey(press({ key: 'a', code: 'KeyQ' }))
    expect(leftOfOne(true)).toBe('@')
  })
})

describe('the browser’s own layout map', () => {
  /** Chromium's `navigator.keyboard`, holding an AZERTY PC's layout. */
  function chromium(entries: Record<string, string>): void {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Win32',
      keyboard: { getLayoutMap: () => Promise.resolve(new Map(Object.entries(entries))) },
    })
  }

  it('fills in every key at once, and asks only once', async () => {
    const asked = vi.fn(() => Promise.resolve(new Map([['Backquote', '²'], ['Digit6', '-'], ['Digit1', '&']])))
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Win32', keyboard: { getLayoutMap: asked } })
    await readLayout()
    await readLayout()
    expect(asked).toHaveBeenCalledTimes(1)
    expect(leftOfOne(false)).toBe('²')
    expect(bareKey('Digit6')).toBe('-')
  })

  it('does not overrule a key the reader has already pressed', async () => {
    learnKey(press({ key: '`', code: 'Backquote' }))
    chromium({ Backquote: '²' })
    await readLayout()
    expect(bareKey('Backquote')).toBe('`')
  })

  it('answers nothing where it is refused, which a frame not granted the map is', async () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Win32',
      keyboard: { getLayoutMap: () => Promise.reject(new DOMException('not allowed', 'SecurityError')) },
    })
    await readLayout()
    expect(leftOfOne(false)).toBeUndefined()
  })
})

describe('a listener', () => {
  it('hears when the label changes, and not on every key', () => {
    const heard = vi.fn()
    const off = onLayoutChange(heard)
    learnKey(press({ key: 'x', code: 'KeyX' }))
    expect(heard).not.toHaveBeenCalled()
    learnKey(press({ key: '²', code: 'Backquote' }))
    expect(heard).toHaveBeenCalledTimes(1)
    learnKey(press({ key: '²', code: 'Backquote' }))
    learnKey(press({ key: 'q', code: 'KeyA' }))
    expect(heard).toHaveBeenCalledTimes(1)
    off()
    learnKey(press({ key: '`', code: 'Backquote' }))
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
