/**
 * The command surface: matching, key bindings, and neighbour stepping.
 *
 * All three are pure functions behind widgets that cannot be driven here, and
 * all three have an edge case that a screenshot would not catch — a subsequence
 * that matches the wrong command, a bare letter firing while a modifier is
 * held, and a contig whose *name* contains a colon.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { scoreCommand } from '@/ui/CommandPalette'
import { KEYS, keyLabel, matchesKeys } from '@/ui/commands'
import { PLOT_OPTION_KEYS } from '@/ui/plotOptions'
import { AESTHETICS_PANEL, ANNOTATION_PANEL, GENERAL_PANEL } from '@/ui/SidePanel'
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
  const press = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent

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

  // On both platforms, since the separator is exactly what differs between them.
  it('has no stray separator anywhere', () => {
    for (const platform of ['Linux x86_64', 'MacIntel']) {
      on(platform)
      for (const keys of ['mod+p', 'g', 'c', 'w', '[', ']', 'x', 'd', 'l', 'b', 't', '?']) {
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
  const bindings = [
    ...Object.entries(KEYS),
    ...Object.entries(PLOT_OPTION_KEYS),
    ...[GENERAL_PANEL, ANNOTATION_PANEL, AESTHETICS_PANEL].map(
      (spec) => [`${spec.title} panel`, spec.keys] as const,
    ),
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
      expect(keyLabel(keys).endsWith('+')).toBe(false)
    }
  })

  // A bare letter typed into a filter box has to reach the box. The guard for
  // that is `isTypingTarget`, and it is only consulted for bindings without a
  // modifier — so a *chord* is the only kind of binding that may also be a
  // character somebody types. Nothing here should be a bare digit, either: the
  // canvas answers 0 itself, from its own handler.
  it('leaves the digits to the canvas', () => {
    for (const [name, keys] of bindings) {
      expect(/^\d$/.test(keys), `${name} claims a digit`).toBe(false)
    }
  })
})
