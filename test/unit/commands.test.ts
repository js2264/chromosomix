/**
 * The command surface: matching, key bindings, and neighbour stepping.
 *
 * All three are pure functions behind widgets that cannot be driven here, and
 * all three have an edge case that a screenshot would not catch — a subsequence
 * that matches the wrong command, a bare letter firing while a modifier is
 * held, and a contig whose *name* contains a colon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scoreCommand } from '@/ui/CommandPalette'
import { KEYS, keyLabel, matchesKeys, withKey } from '@/ui/commands'
import { learnKey, resetLayout } from '@/ui/keyboardLayout'
import { PLOT_OPTION_KEYS } from '@/ui/plotOptions'
import {
  AESTHETICS_PANEL,
  ANALYSIS_PANEL,
  ANNOTATION_PANEL,
  FILES_PANEL,
  GENERAL_PANEL,
} from '@/ui/SidePanel'
import { contigOf, neighbour } from '@/ui/labels'
import type { Command } from '@/ui/commands'

function command(group: string, title: string): Command {
  return { id: title, group, title, run: () => {} }
}

describe('palette matching', () => {
  const overview = command('Go', 'Whole metagenome')
  const contigs = command('Go', 'Contigs table')

  it('matches a subsequence, not just a substring', () => {
    expect(scoreCommand(overview, 'wm')).not.toBeNull()
    expect(scoreCommand(contigs, 'ctb')).not.toBeNull()
  })

  it('rejects letters that are not there in order', () => {
    expect(scoreCommand(overview, 'mw')).toBeNull()
    expect(scoreCommand(contigs, 'zz')).toBeNull()
  })

  it('prefers the tighter match', () => {
    const tight = scoreCommand(contigs, 'contigs')
    const loose = scoreCommand(contigs, 'cs')
    expect(tight).not.toBeNull()
    expect(loose).not.toBeNull()
    expect(tight as number).toBeLessThan(loose as number)
  })

  it('keeps every command when the query is empty', () => {
    expect(scoreCommand(overview, '')).toBe(0)
    expect(scoreCommand(contigs, '   ')).toBe(0)
  })

  it('searches the group as well as the title', () => {
    expect(scoreCommand(command('Help', 'About this viewer'), 'help')).not.toBeNull()
  })
})

describe('key bindings', () => {
  const press = (init: Partial<KeyboardEvent> & { caps?: boolean }): KeyboardEvent => {
    const { caps = false, ...rest } = init
    return {
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      code: '',
      getModifierState: (name: string) => name === 'CapsLock' && caps,
      ...rest,
    } as KeyboardEvent
  }

  beforeEach(() => {
    resetLayout()
  })
  afterEach(() => {
    resetLayout()
    vi.unstubAllGlobals()
  })

  it('matches a bare letter only when no modifier is held', () => {
    expect(matchesKeys(press({ key: 'g' }), 'g')).toBe(true)
    // `mod+g` belongs to the browser; taking it from a user aiming at it is rude.
    expect(matchesKeys(press({ key: 'g', ctrlKey: true }), 'g')).toBe(false)
    expect(matchesKeys(press({ key: 'g', metaKey: true }), 'g')).toBe(false)
  })

  it('is case-insensitive, so Shift+G still goes to the genomes table', () => {
    expect(matchesKeys(press({ key: 'G', shiftKey: true }), 'g')).toBe(true)
  })

  it('requires the modifier for a chord', () => {
    expect(matchesKeys(press({ key: 'p' }), 'mod+p')).toBe(false)
  })

  /**
   * The digit row by position: a reader presses the key with the 1 on it, and
   * on AZERTY that key types `&` bare and `1` only under Shift or Caps Lock.
   */
  describe('the digit row', () => {
    it('is the key with the digit on it, on QWERTY and on AZERTY, shifted or not', () => {
      // QWERTY: bare, shifted, and under Caps Lock, which leaves digits alone.
      expect(matchesKeys(press({ key: '1', code: 'Digit1' }), '1')).toBe(true)
      expect(matchesKeys(press({ key: '!', code: 'Digit1', shiftKey: true }), '1')).toBe(true)
      expect(matchesKeys(press({ key: '1', code: 'Digit1', caps: true }), '1')).toBe(true)
      // AZERTY: `&` `é` `"` `'` bare, the digits under Shift or Caps Lock.
      expect(matchesKeys(press({ key: '&', code: 'Digit1' }), '1')).toBe(true)
      expect(matchesKeys(press({ key: 'é', code: 'Digit2' }), '2')).toBe(true)
      expect(matchesKeys(press({ key: '"', code: 'Digit3' }), '3')).toBe(true)
      expect(matchesKeys(press({ key: "'", code: 'Digit4' }), '4')).toBe(true)
      expect(matchesKeys(press({ key: '4', code: 'Digit4', shiftKey: true }), '4')).toBe(true)
      expect(matchesKeys(press({ key: '4', code: 'Digit4', caps: true }), '4')).toBe(true)
      // …and not its neighbour.
      expect(matchesKeys(press({ key: 'é', code: 'Digit2' }), '1')).toBe(false)
    })

    it('takes the keypad by its digit, and not with Num Lock off', () => {
      expect(matchesKeys(press({ key: '3', code: 'Numpad3' }), '3')).toBe(true)
      // Num Lock off makes the keypad's 1 an End key, which is not a 1.
      expect(matchesKeys(press({ key: 'End', code: 'Numpad1' }), '1')).toBe(false)
    })

    it('stands down for a modifier, AltGraph included', () => {
      expect(matchesKeys(press({ key: '1', code: 'Digit1', ctrlKey: true }), '1')).toBe(false)
      expect(matchesKeys(press({ key: '¡', code: 'Digit1', altKey: true }), '1')).toBe(false)
      // AltGr and 3 on an AZERTY PC is `#`, which Windows sends as Ctrl and Alt.
      expect(matchesKeys(press({ key: '#', code: 'Digit3', ctrlKey: true, altKey: true }), '3')).toBe(false)
    })
  })

  /** The key left of 1: a backtick on QWERTY, `²` on an AZERTY PC, `@` on a French Mac. */
  describe('the key left of 1', () => {
    const on = (platform: string): void => {
      vi.stubGlobal('navigator', { platform, userAgent: platform })
    }

    it('is the place, whatever it types and whether or not Shift is held', () => {
      on('Linux x86_64')
      expect(matchesKeys(press({ key: '`', code: 'Backquote' }), '`')).toBe(true)
      expect(matchesKeys(press({ key: '~', code: 'Backquote', shiftKey: true }), '`')).toBe(true)
      expect(matchesKeys(press({ key: '²', code: 'Backquote' }), '`')).toBe(true)
      expect(matchesKeys(press({ key: '^', code: 'Backquote', caps: true }), '`')).toBe(true)
    })

    it('is IntlBackslash as well on a Mac, whose ISO keyboards report it so', () => {
      on('MacIntel')
      expect(matchesKeys(press({ key: '@', code: 'IntlBackslash' }), '`')).toBe(true)
      expect(matchesKeys(press({ key: '`', code: 'Backquote' }), '`')).toBe(true)
      // Elsewhere IntlBackslash is the `<` key beside the left Shift, and not it.
      on('Linux x86_64')
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash' }), '`')).toBe(false)
    })

    it('is never the `<` key a French or German Mac reports as Backquote', () => {
      on('MacIntel')
      expect(matchesKeys(press({ key: '<', code: 'Backquote' }), '`')).toBe(false)
      expect(matchesKeys(press({ key: '>', code: 'Backquote', shiftKey: true }), '`')).toBe(false)
      expect(matchesKeys(press({ key: '<', code: 'Backquote', ctrlKey: true }), KEYS.console)).toBe(false)
      // …which steps to the sequence before this one instead.
      expect(matchesKeys(press({ key: '<', code: 'Backquote' }), KEYS.previous)).toBe(true)
    })

    it('opens the console with Control, on a Mac too, where ⌘ and it are the system’s', () => {
      on('Linux x86_64')
      expect(matchesKeys(press({ key: '²', code: 'Backquote', ctrlKey: true }), KEYS.console)).toBe(true)
      expect(matchesKeys(press({ key: '²', code: 'Backquote', ctrlKey: true }), '`')).toBe(false)
      expect(matchesKeys(press({ key: '²', code: 'Backquote' }), KEYS.console)).toBe(false)
      on('MacIntel')
      expect(matchesKeys(press({ key: '@', code: 'IntlBackslash', ctrlKey: true }), KEYS.console)).toBe(true)
      expect(matchesKeys(press({ key: '@', code: 'IntlBackslash', metaKey: true }), KEYS.console)).toBe(false)
    })
  })

  /**
   * `-` and `+` by what they type, either half of each key: the minus is the
   * `-_` key on QWERTY and on a Mac, and the bare half of the 6 key on an AZERTY
   * PC; the plus is the `=+` key on all of them.
   */
  describe('minus and plus', () => {
    it('take the minus key with or without Shift, on QWERTY and on a Mac', () => {
      expect(matchesKeys(press({ key: '-', code: 'Minus' }), '-')).toBe(true)
      expect(matchesKeys(press({ key: '_', code: 'Minus', shiftKey: true }), '-')).toBe(true)
      // A French Mac's minus is the key QWERTY calls `=`.
      expect(matchesKeys(press({ key: '-', code: 'Equal' }), '-')).toBe(true)
      expect(matchesKeys(press({ key: '_', code: 'Equal', shiftKey: true }), '-')).toBe(true)
      expect(matchesKeys(press({ key: '-', code: 'NumpadSubtract' }), '-')).toBe(true)
    })

    it('take an AZERTY PC’s 6 key, which Shift and Caps Lock turn into a 6', () => {
      expect(matchesKeys(press({ key: '-', code: 'Digit6' }), '-')).toBe(true)
      expect(matchesKeys(press({ key: '6', code: 'Digit6', shiftKey: true }), '-')).toBe(true)
      expect(matchesKeys(press({ key: '6', code: 'Digit6', caps: true }), '-')).toBe(true)
      // Both held cancel, and the key types its minus as itself.
      expect(matchesKeys(press({ key: '-', code: 'Digit6', shiftKey: true, caps: true }), '-')).toBe(true)
      // The `_` an AZERTY PC types bare is its 8, nowhere near a minus.
      expect(matchesKeys(press({ key: '_', code: 'Digit8' }), '-')).toBe(false)
    })

    it('leave QWERTY’s 6 alone, bare or under Caps Lock once the row has said', () => {
      expect(matchesKeys(press({ key: '6', code: 'Digit6' }), '-')).toBe(false)
      // A bare digit from the row says the row types digits bare.
      learnKey(press({ key: '1', code: 'Digit1' }))
      expect(matchesKeys(press({ key: '6', code: 'Digit6', caps: true }), '-')).toBe(false)
    })

    it('leave a Belgian 6 alone, whose bare half is §', () => {
      learnKey(press({ key: '§', code: 'Digit6' }))
      expect(matchesKeys(press({ key: '6', code: 'Digit6', shiftKey: true }), '-')).toBe(false)
      // …while a French one, seen typing its minus, is the minus under Caps Lock
      // whatever the rest of the row has said.
      resetLayout()
      learnKey(press({ key: '-', code: 'Digit6' }))
      expect(matchesKeys(press({ key: '6', code: 'Digit6', caps: true }), '-')).toBe(true)
    })

    it('take the plus key with or without Shift', () => {
      expect(matchesKeys(press({ key: '=', code: 'Equal' }), '+')).toBe(true)
      expect(matchesKeys(press({ key: '+', code: 'Equal', shiftKey: true }), '+')).toBe(true)
      expect(matchesKeys(press({ key: '=', code: 'Equal', caps: true }), '+')).toBe(true)
      // A French Mac's `=+` key is the one QWERTY calls `/`.
      expect(matchesKeys(press({ key: '=', code: 'Slash' }), '+')).toBe(true)
      expect(matchesKeys(press({ key: '+', code: 'NumpadAdd' }), '+')).toBe(true)
      // A shifted `=` is a key of its own — Shift and 0 on a German keyboard.
      expect(matchesKeys(press({ key: '=', code: 'Digit0', shiftKey: true }), '+')).toBe(false)
    })

    it('stand down for a modifier: ⌘+ and Ctrl+ are the browser’s zoom', () => {
      expect(matchesKeys(press({ key: '=', code: 'Equal', ctrlKey: true }), '+')).toBe(false)
      expect(matchesKeys(press({ key: '-', code: 'Minus', metaKey: true }), '-')).toBe(false)
    })
  })

  /**
   * `<` and `>`, the sequence steps: over the comma and the full stop on
   * American and British QWERTY, Mac or PC, and a key of their own beside the
   * left Shift on AZERTY — `IntlBackslash` on a PC, `Backquote` on a Mac.
   */
  describe('the angle brackets', () => {
    const on = (platform: string): void => {
      vi.stubGlobal('navigator', { platform, userAgent: platform })
    }

    it('take QWERTY’s comma and full-stop keys, with or without Shift', () => {
      for (const platform of ['Win32', 'MacIntel']) {
        on(platform)
        expect(matchesKeys(press({ key: '<', code: 'Comma', shiftKey: true }), KEYS.previous)).toBe(true)
        expect(matchesKeys(press({ key: ',', code: 'Comma' }), KEYS.previous)).toBe(true)
        expect(matchesKeys(press({ key: '>', code: 'Period', shiftKey: true }), KEYS.next)).toBe(true)
        expect(matchesKeys(press({ key: '.', code: 'Period' }), KEYS.next)).toBe(true)
        expect(matchesKeys(press({ key: ',', code: 'Comma', caps: true }), KEYS.previous)).toBe(true)
        // …and keep the two apart.
        expect(matchesKeys(press({ key: '.', code: 'Period' }), KEYS.previous)).toBe(false)
        expect(matchesKeys(press({ key: '<', code: 'Comma', shiftKey: true }), KEYS.next)).toBe(false)
      }
    })

    it('take AZERTY’s own key, bare for `<` and shifted for `>`, on a PC and on a Mac', () => {
      on('Win32')
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash' }), KEYS.previous)).toBe(true)
      expect(matchesKeys(press({ key: '>', code: 'IntlBackslash', shiftKey: true }), KEYS.next)).toBe(true)
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash', caps: true }), KEYS.previous)).toBe(true)
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash' }), KEYS.next)).toBe(false)
      on('MacIntel')
      expect(matchesKeys(press({ key: '<', code: 'Backquote' }), KEYS.previous)).toBe(true)
      expect(matchesKeys(press({ key: '>', code: 'Backquote', shiftKey: true }), KEYS.next)).toBe(true)
    })

    it('leave AZERTY’s comma and full stop alone, which carry no mark', () => {
      on('Win32')
      // The comma is on the M key, the `;` where QWERTY has its comma, and the
      // full stop is Shift and that `;`.
      expect(matchesKeys(press({ key: ',', code: 'KeyM' }), KEYS.previous)).toBe(false)
      expect(matchesKeys(press({ key: ';', code: 'Comma' }), KEYS.previous)).toBe(false)
      expect(matchesKeys(press({ key: '.', code: 'Comma', shiftKey: true }), KEYS.next)).toBe(false)
      expect(matchesKeys(press({ key: ':', code: 'Period' }), KEYS.next)).toBe(false)
    })

    it('stand down for a modifier, AltGraph included, and walk the tabs with Control', () => {
      on('Win32')
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash', ctrlKey: true }), KEYS.previous)).toBe(false)
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash', altKey: true }), KEYS.previous)).toBe(false)
      expect(matchesKeys(press({ key: '<', code: 'IntlBackslash', ctrlKey: true }), KEYS.prevSession)).toBe(true)
      expect(matchesKeys(press({ key: '.', code: 'Period', ctrlKey: true }), KEYS.nextSession)).toBe(true)
      // AltGr is Ctrl and Alt on Windows, and is a key's third level, not a tab.
      expect(
        matchesKeys(press({ key: '<', code: 'IntlBackslash', ctrlKey: true, altKey: true }), KEYS.prevSession),
      ).toBe(false)
      // Control on a Mac too: ⌘< walks a French Mac's windows, and ⌘, is settings.
      on('MacIntel')
      expect(matchesKeys(press({ key: '<', code: 'Backquote', ctrlKey: true }), KEYS.prevSession)).toBe(true)
      expect(matchesKeys(press({ key: '<', code: 'Backquote', metaKey: true }), KEYS.prevSession)).toBe(false)
      expect(matchesKeys(press({ key: ',', code: 'Comma', metaKey: true }), KEYS.prevSession)).toBe(false)
    })
  })

  describe('the rest of the remapped keys', () => {
    it('fits on the 0 key by its place: AZERTY’s bare one types à', () => {
      expect(matchesKeys(press({ key: '0', code: 'Digit0' }), KEYS.fit)).toBe(true)
      expect(matchesKeys(press({ key: 'à', code: 'Digit0' }), KEYS.fit)).toBe(true)
      expect(matchesKeys(press({ key: ')', code: 'Digit0', shiftKey: true }), KEYS.fit)).toBe(true)
      expect(matchesKeys(press({ key: '0', code: 'Numpad0' }), KEYS.fit)).toBe(true)
      expect(matchesKeys(press({ key: '0', code: 'Digit0', metaKey: true }), KEYS.fit)).toBe(false)
    })

    it('opens the shortcuts on ?, wherever the layout puts it', () => {
      // Shift and `/` on QWERTY, Shift and the M key's comma on AZERTY.
      expect(matchesKeys(press({ key: '?', code: 'Slash', shiftKey: true }), KEYS.shortcuts)).toBe(true)
      expect(matchesKeys(press({ key: '?', code: 'KeyM', shiftKey: true }), KEYS.shortcuts)).toBe(true)
      expect(matchesKeys(press({ key: '/', code: 'Slash' }), KEYS.shortcuts)).toBe(false)
      expect(matchesKeys(press({ key: '?', code: 'Slash', shiftKey: true, ctrlKey: true }), KEYS.shortcuts)).toBe(
        false,
      )
    })

    it('gives f to the track fill, m to the breaks, e to the O/E and b to the bookmark', () => {
      expect(PLOT_OPTION_KEYS.fills).toBe('f')
      expect(PLOT_OPTION_KEYS.breaks).toBe('m')
      expect(KEYS.expected).toBe('e')
      expect(KEYS.bookmark).toBe('b')
    })
  })
})

describe('stepping to a neighbour', () => {
  const names = ['a', 'b', 'c']

  it('walks the list and stops at both ends rather than wrapping', () => {
    expect(neighbour(names, 'a', 1)).toBe('b')
    expect(neighbour(names, 'c', -1)).toBe('b')
    expect(neighbour(names, 'c', 1)).toBeNull()
    expect(neighbour(names, 'a', -1)).toBeNull()
  })

  it('has no neighbour for a name that is not in the list', () => {
    expect(neighbour(names, 'zzz', 1)).toBeNull()
  })

  it('finds the contig a region names, with or without coordinates', () => {
    const contigs = ['NODE_1', 'NODE_2']
    expect(contigOf('NODE_1', contigs)).toBe('NODE_1')
    expect(contigOf('NODE_1:1000-2000', contigs)).toBe('NODE_1')
    expect(contigOf('NODE_9:1-2', contigs)).toBeNull()
  })

  it('prefers a contig whose own name contains a colon', () => {
    // A file may legally carry `NODE_1:2` as a name; reading it as coordinates
    // on `NODE_1` would step through the wrong list.
    expect(contigOf('NODE_1:2', ['NODE_1', 'NODE_1:2'])).toBe('NODE_1:2')
  })
})

/**
 * `mod` renders as ⌘ on a Mac and as `Ctrl` everywhere else, so the platform is
 * stubbed rather than inherited.
 *
 * It used to be inherited, on the stated reasoning that "under Node there is no
 * `navigator`, so `isMac()` is false". That was true when it was written and is
 * not any more: Node grew a `navigator` global, and on macOS it reports
 * `platform: 'MacIntel'` — the browser's own string. So the suite passed on a
 * Linux CI runner and failed on the machine of anyone developing on a Mac, which
 * is the worst shape a failure can have, and it failed in `preversion`, which
 * meant it blocked a release rather than a commit.
 *
 * Stubbing also buys the half that was never covered: the Mac form. The bug
 * these exist for is a separator applied to the wrong branch, and one branch
 * cannot show that.
 */
describe('keyLabel', () => {
  const on = (platform: string): void => {
    vi.stubGlobal('navigator', { platform, userAgent: platform })
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('joins the modifier once', () => {
    // `mod` used to render as the string 'Ctrl+' and then be joined on '+',
    // so every non-Mac browser showed `Ctrl++P` in the action bar and in the
    // shortcuts dialog.
    on('Linux x86_64')
    expect(keyLabel('mod+p')).toBe('Ctrl+P')
  })

  // The Mac form is joined on the empty string, because ⌘ is a prefix rather
  // than a word: `⌘+P` is not how the shortcut is written anywhere on the
  // platform.
  it('writes the Mac modifier without a separator', () => {
    on('MacIntel')
    expect(keyLabel('mod+p')).toBe('⌘P')
  })

  it('upper-cases a single-character key and leaves named keys alone', () => {
    expect(keyLabel('g')).toBe('G')
    expect(keyLabel('?')).toBe('?')
    expect(keyLabel('Enter')).toBe('Enter')
  })

  it('prints the minus as a minus sign, and a lone plus as itself', () => {
    expect(keyLabel(KEYS.coarser)).toBe('−')
    expect(keyLabel(KEYS.finer)).toBe('+')
  })

  it('prints the steps as their marks, and the tabs with Control on both platforms', () => {
    expect(keyLabel(KEYS.previous)).toBe('<')
    expect(keyLabel(KEYS.next)).toBe('>')
    on('Linux x86_64')
    expect(keyLabel(KEYS.nextSession)).toBe('Ctrl+>')
    on('MacIntel')
    expect(keyLabel(KEYS.prevSession)).toBe('⌃<')
  })

  /**
   * The key left of 1 prints what the reader's keyboard has there, which the
   * page learns from the layout (`ui/keyboardLayout.ts`) — and *backtick*, the
   * commonest, until it has.
   */
  describe('the key left of 1', () => {
    beforeEach(() => {
      resetLayout()
    })
    afterEach(() => {
      resetLayout()
    })
    const learn = (key: string, code: string): void =>
      learnKey({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent)

    it('says backtick, and where it is, before the keyboard has said anything', () => {
      on('Linux x86_64')
      expect(keyLabel(FILES_PANEL.keys)).toBe('backtick')
      expect(keyLabel(KEYS.console)).toBe('Ctrl+backtick')
      expect(withKey('Files panel', FILES_PANEL.keys)).toBe('Files panel (backtick, the key left of 1)')
      on('MacIntel')
      expect(keyLabel(KEYS.console)).toBe('⌃backtick')
    })

    it('says ² on an AZERTY PC, from the key itself or from the letters', () => {
      on('Linux x86_64')
      learn('²', 'Backquote')
      expect(keyLabel(FILES_PANEL.keys)).toBe('²')
      expect(keyLabel(KEYS.console)).toBe('Ctrl+²')
      resetLayout()
      // `a` on the key QWERTY calls Q is AZERTY, whose PC has `²` there.
      learn('a', 'KeyQ')
      expect(keyLabel(FILES_PANEL.keys)).toBe('²')
    })

    it('says @ on a French Mac, whose ISO keyboard calls the key IntlBackslash', () => {
      on('MacIntel')
      learn('<', 'Backquote')
      learn('@', 'IntlBackslash')
      expect(keyLabel(FILES_PANEL.keys)).toBe('@')
      expect(keyLabel(KEYS.console)).toBe('⌃@')
      resetLayout()
      learn('a', 'KeyQ')
      expect(keyLabel(FILES_PANEL.keys)).toBe('@')
    })

    it('says backtick on an American Mac, whose layout has § on a key it has not got', () => {
      on('MacIntel')
      learn('`', 'Backquote')
      learn('§', 'IntlBackslash')
      expect(keyLabel(FILES_PANEL.keys)).toBe('backtick')
    })
  })

  // On both platforms, since the separator is exactly what differs between them.
  it('has no stray separator anywhere', () => {
    for (const platform of ['Linux x86_64', 'MacIntel']) {
      on(platform)
      for (const keys of ['mod+p', 'g', 'c', 'w', '<', '>', 'ctrl+<', 'x', 'd', 'l', '0', '1', 't', '?', '-', 'ctrl+`']) {
        expect(keyLabel(keys)).not.toContain('++')
        expect(keyLabel(keys).endsWith('+')).toBe(false)
      }
    }
  })
})

/**
 * The two key tables, checked against each other.
 *
 * Every binding in this app now comes from one of exactly two objects — `KEYS`
 * for the actions, `PLOT_OPTION_KEYS` for the overlays — precisely so that the
 * buttons can print what the key handler will do. That only holds while the two
 * agree, and the failure mode when they do not is silent: two commands claim
 * one letter, the key handler runs whichever it reaches first, and the other
 * button's tooltip promises something that never happens. Both were rebound in
 * the same change that added the tooltips (`s` from autoscale to stretch, `y`
 * to autoscale), which is exactly the kind of edit this catches.
 */
describe('the key tables', () => {
  // The panel folds are the third source: their keys live on the column specs,
  // beside the names and widths, and are printed beside each column's heading.
  const PANELS = [FILES_PANEL, GENERAL_PANEL, ANNOTATION_PANEL, AESTHETICS_PANEL, ANALYSIS_PANEL]
  const bindings = [
    ...Object.entries(KEYS),
    ...Object.entries(PLOT_OPTION_KEYS),
    ...PANELS.map((spec) => [`${spec.title} panel`, spec.keys] as const),
  ]

  it('binds each key to one action', () => {
    const seen = new Map<string, string>()
    for (const [name, keys] of bindings) {
      const already = seen.get(keys)
      expect(already, `${name} and ${String(already)} both claim ${keys}`).toBeUndefined()
      seen.set(keys, name)
    }
  })

  it('has a label for every binding, with no stray separator', () => {
    for (const [, keys] of bindings) {
      expect(keys).not.toBe('')
      expect(keyLabel(keys)).not.toContain('++')
      // `+` is a key as well as the joint: its own label ends on it, and that
      // is the one label that may.
      if (keys !== KEYS.finer) expect(keyLabel(keys).endsWith('+')).toBe(false)
    }
  })

  // A bare key typed into a filter box has to reach the box. The guard for that
  // is `isTypingTarget`, and it is only consulted for bindings without a
  // modifier — so a *chord* is the only kind of binding that may also be a
  // character somebody types. The digit row is the columns', in the order they
  // stand, and `0`, at its far end, refits the picture from anywhere.
  it('gives the digit row to the columns, and 0 to the refit', () => {
    const digits = bindings.filter(([, keys]) => /^\d$/.test(keys))
    expect(digits.map(([name, keys]) => `${keys} ${name}`)).toEqual([
      '0 fit',
      '1 General panel',
      '2 Annotations panel',
      '3 Aesthetics panel',
      '4 Analysis panel',
    ])
  })

  it('folds Files on the key left of 1, and opens the console with Control on it', () => {
    expect(FILES_PANEL.keys).toBe('`')
    expect(KEYS.console).toBe('ctrl+`')
  })
})
