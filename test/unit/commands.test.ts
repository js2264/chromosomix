/**
 * The command surface: matching, key bindings, and neighbour stepping.
 *
 * All three are pure functions behind widgets that cannot be driven here, and
 * all three have an edge case that a screenshot would not catch — a subsequence
 * that matches the wrong command, a bare letter firing while a modifier is
 * held, and a contig whose *name* contains a colon.
 */

import { describe, expect, it } from 'vitest'

import { scoreCommand } from '@/ui/CommandPalette'
import { keyLabel, matchesKeys } from '@/ui/commands'
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
 * Under Node there is no `navigator`, so `isMac()` is false and the labels come
 * out in their `Ctrl+` form — which is the form that was wrong.
 */
describe('keyLabel', () => {
  it('joins the modifier once', () => {
    // `mod` used to render as the string 'Ctrl+' and then be joined on '+',
    // so every non-Mac browser showed `Ctrl++P` in the action bar and in the
    // shortcuts dialog.
    expect(keyLabel('mod+p')).toBe('Ctrl+P')
  })

  it('upper-cases a single-character key and leaves named keys alone', () => {
    expect(keyLabel('g')).toBe('G')
    expect(keyLabel('?')).toBe('?')
    expect(keyLabel('Enter')).toBe('Enter')
  })

  it('has no stray separator anywhere', () => {
    for (const keys of ['mod+p', 'g', 'c', 'w', '[', ']', 'x', 'd', 'l', 'b', 't', '?']) {
      expect(keyLabel(keys)).not.toContain('++')
      expect(keyLabel(keys).endsWith('+')).toBe(false)
    }
  })
})
