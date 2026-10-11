// @vitest-environment jsdom
/**
 * The log the console is a window onto (§23).
 *
 * Four things are worth pinning here, and none of them is what a row looks like.
 *
 * **A run is recorded when it runs, and ended when it ends.** The whole feature
 * turns on that pair: the drawer can only offer the command for the result on
 * screen, so a batch's other five commands and every run whose parameters were
 * changed an hour ago exist nowhere else. An entry that opened and never closed
 * is the failure mode, so the close is asserted rather than assumed.
 *
 * **What is copied out is a script.** Commands bare, everything else commented,
 * days as headings — so a day pasted into a file runs, with the afternoon around
 * it left in as the context that says what the commands were for. A single
 * misplaced `#` turns that into a file that either does nothing or runs a line
 * that was never meant to be run, and neither is visible by looking at the panel.
 *
 * **It is bounded.** `localStorage` has a five-megabyte ceiling shared with the
 * workspace record and the bucket keys, and a log that grew without limit would
 * eventually be the write that pushes one of those out. Age and count, both.
 *
 * **A window that goes away mid-job says so.** Nothing can set `interrupted`;
 * it is what `running` becomes on the way back in from storage, because the
 * alternatives are inventing a failure or a row that spins for ever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  actionCount,
  actions,
  actionsText,
  clearActions,
  dayOf,
  endAction,
  forgetActions,
  logAction,
  resetActions,
  subscribeActions,
  timeOf,
} from '@/state/actions'

const KEY = 'chromosomix:actions'

/** What a stored log looks like, so a test can plant one and reload it. */
function plant(entries: unknown[]): void {
  window.localStorage.setItem(KEY, JSON.stringify({ version: 1, entries }))
  resetActions()
}

function stored(): { version: number; entries: Array<Record<string, unknown>> } {
  return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as {
    version: number
    entries: Array<Record<string, unknown>>
  }
}

beforeEach(() => {
  window.localStorage.clear()
  resetActions()
})

afterEach(() => {
  forgetActions()
  window.localStorage.clear()
})

describe('recording', () => {
  it('opens a run and closes it with the account the result carried', () => {
    const id = logAction({
      kind: 'run',
      line: 'chromosomix insulation a.cool --window 10',
      shell: true,
      detail: ['# task: insulation v1'],
      status: 'running',
      where: 'a.cool',
    })
    expect(actions()[0].status).toBe('running')

    endAction(id, {
      status: 'ok',
      ms: 1234,
      line: 'chromosomix insulation a.cool --window 10 --balance',
      detail: ['# task: insulation v1', '# param window: 10'],
    })

    const [entry] = actions()
    expect(entry.status).toBe('ok')
    expect(entry.ms).toBe(1234)
    // Replaced, not appended beside the first: two accounts of one run is how
    // they come to disagree, and the result's own provenance is the true one.
    expect(entry.line).toBe('chromosomix insulation a.cool --window 10 --balance')
    expect(entry.detail).toEqual(['# task: insulation v1', '# param window: 10'])
    expect(entry.where).toBe('a.cool')
  })

  it('gives every entry its own line, so a batch over six maps is six lines', () => {
    for (const map of ['rep1', 'rep2', 'rep3', 'rep4', 'rep5', 'rep6']) {
      const id = logAction({
        kind: 'run',
        line: `chromosomix insulation ${map}.cool`,
        shell: true,
        status: 'running',
        where: `${map}.cool`,
      })
      endAction(id, { status: 'ok', ms: 10 })
    }
    expect(actionCount()).toBe(6)
    expect(actions().map((entry) => entry.where)).toEqual([
      'rep1.cool',
      'rep2.cool',
      'rep3.cool',
      'rep4.cool',
      'rep5.cool',
      'rep6.cool',
    ])
  })

  it('records what is not a run with its outcome already on it', () => {
    logAction({ kind: 'open', line: 'opened a.cool' })
    logAction({ kind: 'write', line: 'wrote a.tsv' })
    expect(actions().map((entry) => entry.status)).toEqual(['ok', 'ok'])
    expect(actions().map((entry) => entry.shell)).toEqual([false, false])
  })

  it('ignores an outcome for an id that is no longer held', () => {
    const id = logAction({ kind: 'run', line: 'x', status: 'running' })
    clearActions()
    // A reader who cleared the console while a job was running is not a reason
    // for the job's end to throw on its way through the runner.
    expect(() => endAction(id, { status: 'ok' })).not.toThrow()
    expect(actionCount()).toBe(0)
  })

  it('tells its listeners, and stops when one leaves', () => {
    let beats = 0
    const stop = subscribeActions(() => {
      beats++
    })
    const id = logAction({ kind: 'open', line: 'opened a.cool' })
    endAction(id, { status: 'ok' })
    expect(beats).toBe(2)
    stop()
    logAction({ kind: 'open', line: 'opened b.cool' })
    expect(beats).toBe(2)
  })
})

describe('the text it hands over', () => {
  it('is a script: commands bare, everything else commented', () => {
    logAction({ kind: 'open', line: 'opened a.cool', detail: ['# file: /data/a.cool'] })
    logAction({
      kind: 'run',
      line: 'chromosomix insulation a.cool --window 10',
      shell: true,
      notes: ['# This file is remote, and the command reads local files only.'],
      detail: ['# task: insulation v1'],
    })

    const text = actionsText({ detail: false })
    const lines = text.trimEnd().split('\n')
    // A day heading, the open as a comment, the caveat, the command.
    expect(lines[0]).toBe(`# ${dayOf(Date.now())}`)
    expect(lines.filter((line) => !line.startsWith('#'))).toEqual([
      'chromosomix insulation a.cool --window 10',
    ])
    expect(lines.some((line) => line.includes('opened a.cool'))).toBe(true)
    // The caveat rides with the command whether or not the output is asked for:
    // a command that runs and answers a slightly different question is worse
    // than one that says what it left out.
    expect(text).toContain('reads local files only')
    // …and the provenance does not, until it is.
    expect(text).not.toContain('# task: insulation v1')
    expect(actionsText({ detail: true })).toContain('# task: insulation v1')
  })

  it('puts a caveat above a command and a refusal below a line that is not one', () => {
    // The same rule read twice. A caveat qualifies a line a reader is about to
    // run, so it comes first; a refusal explains a line that is not a command at
    // all, so it comes after the thing it is about. The other way round, a run
    // the CLI cannot repeat opened with a paragraph about a command that was
    // never there — which is how it read in the field.
    logAction({
      kind: 'run',
      line: 'chromosomix insulation a.cool',
      shell: true,
      notes: ['# This file is remote.'],
    })
    logAction({
      kind: 'run',
      line: 'ran Track correlation — Yeast_ATAC.bw · loaded tracks, no contact map',
      shell: false,
      notes: ['# trackcorr reads a track; run it in the app.'],
    })
    const lines = actionsText({ detail: false }).trimEnd().split('\n')
    const caveat = lines.findIndex((line) => line.includes('This file is remote'))
    const command = lines.findIndex((line) => line.startsWith('chromosomix '))
    expect(caveat).toBeLessThan(command)
    const prose = lines.findIndex((line) => line.includes('ran Track correlation'))
    const refusal = lines.findIndex((line) => line.includes('run it in the app'))
    expect(prose).toBeLessThan(refusal)
  })

  it('writes a failure as a comment under the command it belongs to', () => {
    const id = logAction({ kind: 'run', line: 'chromosomix apa a.cool', shell: true })
    endAction(id, { status: 'failed', error: 'No loop set was chosen.' })
    const lines = actionsText({ detail: false }).trimEnd().split('\n')
    expect(lines[lines.length - 1]).toBe('# failed: No loop set was chosen.')
  })

  it('takes one day when asked for one', () => {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    plant([
      {
        id: 'old',
        at: midnight.getTime() - 26 * 60 * 60 * 1000,
        kind: 'run',
        line: 'chromosomix coverage a.cool',
        shell: true,
        status: 'ok',
      },
      {
        id: 'new',
        at: Date.now(),
        kind: 'run',
        line: 'chromosomix insulation a.cool',
        shell: true,
        status: 'ok',
      },
    ])
    const today = actionsText({ detail: false, day: dayOf(Date.now()) })
    expect(today).toContain('insulation')
    expect(today).not.toContain('coverage')
    expect(actionsText({ detail: false })).toContain('coverage')
  })

  it('is empty rather than a lone heading when nothing is held', () => {
    expect(actionsText({ detail: true })).toBe('')
  })
})

describe('what is kept', () => {
  it('survives a reload', () => {
    vi.useFakeTimers()
    try {
      logAction({ kind: 'open', line: 'opened a.cool' })
      // Debounced, because a batch over thirty maps starts and ends sixty times
      // in a few minutes and each of those would otherwise serialise the lot.
      vi.advanceTimersByTime(500)
      expect(stored().entries).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // The reload itself: the copy in memory goes, and what comes back is what
    // was written.
    resetActions()
    expect(actions().map((entry) => entry.line)).toEqual(['opened a.cool'])
  })

  it('turns a run the window walked out on into an interruption', () => {
    plant([
      {
        id: 'a',
        at: Date.now(),
        kind: 'run',
        line: 'chromosomix compartments a.cool',
        shell: true,
        status: 'running',
      },
    ])
    // Not `failed`, which would be inventing one, and not `running`, which would
    // spin for the life of the tab.
    expect(actions()[0].status).toBe('interrupted')
  })

  it('drops anything older than a week', () => {
    const day = 24 * 60 * 60 * 1000
    plant([
      { id: 'old', at: Date.now() - 8 * day, kind: 'open', line: 'opened old.cool', status: 'ok' },
      { id: 'new', at: Date.now() - 2 * day, kind: 'open', line: 'opened new.cool', status: 'ok' },
    ])
    expect(actions().map((entry) => entry.id)).toEqual(['new'])
  })

  it('keeps the newest five hundred and no more', () => {
    const at = Date.now()
    plant(
      Array.from({ length: 520 }, (_, index) => ({
        id: `e${index}`,
        at: at - (520 - index) * 1000,
        kind: 'open',
        line: `opened ${index}.cool`,
        status: 'ok',
      })),
    )
    const held = actions()
    expect(held).toHaveLength(500)
    // The oldest go, not the newest: a console that dropped what just happened
    // would be a console that answers about last week and not about this hour.
    expect(held[0].id).toBe('e20')
    expect(held[held.length - 1].id).toBe('e519')
  })

  it('refuses a stored row it cannot read, and keeps the ones it can', () => {
    plant([
      { id: 'good', at: Date.now(), kind: 'open', line: 'opened a.cool', status: 'ok' },
      { id: 'no-kind', at: Date.now(), kind: 'sideways', line: 'x', status: 'ok' },
      { at: Date.now(), kind: 'open', line: 'no id', status: 'ok' },
      'not an object',
    ])
    expect(actions().map((entry) => entry.id)).toEqual(['good'])
  })

  it('reads nothing from a record written under another version', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 99,
        entries: [{ id: 'a', at: Date.now(), kind: 'open', line: 'x', status: 'ok' }],
      }),
    )
    resetActions()
    expect(actions()).toEqual([])
  })
})

describe('two windows', () => {
  it('joins what the other one wrote rather than deleting it', () => {
    vi.useFakeTimers()
    try {
      // This window's morning…
      logAction({ kind: 'open', line: 'opened mine.cool' })
      vi.advanceTimersByTime(500)
      // …and another window's, landing on the disk underneath it.
      const held = stored().entries
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          version: 1,
          entries: [
            { id: 'theirs', at: Date.now() - 60_000, kind: 'run', line: 'chromosomix coverage b.cool', shell: true, status: 'ok' },
            ...held,
          ],
        }),
      )
      // The next write from here must not be this window deleting their morning.
      logAction({ kind: 'write', line: 'wrote a.tsv' })
      vi.advanceTimersByTime(500)
      expect(stored().entries.map((row) => row['line'])).toEqual([
        'chromosomix coverage b.cool',
        'opened mine.cool',
        'wrote a.tsv',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a clear made in the other window as a clear', () => {
    logAction({ kind: 'open', line: 'opened mine.cool' })
    // `storage` fires in every document but the one that wrote, so this is what
    // the other window pressing **clear** looks like from here. An empty list is
    // a decision about the record, not a window with nothing to say.
    window.localStorage.setItem(KEY, JSON.stringify({ version: 1, entries: [] }))
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    expect(actions()).toEqual([])
  })

  it('joins the other window\u2019s lines in when it hears about them', () => {
    logAction({ kind: 'open', line: 'opened mine.cool' })
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'theirs', at: Date.now() - 60_000, kind: 'open', line: 'opened theirs.cool', status: 'ok' },
        ],
      }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    expect(actions().map((entry) => entry.line)).toEqual(['opened theirs.cool', 'opened mine.cool'])
  })
})

describe('forgetting', () => {
  it('empties the list and writes that through at once', () => {
    logAction({ kind: 'open', line: 'opened a.cool' })
    clearActions()
    expect(actions()).toEqual([])
    // Written rather than left on the debounce: this is the one change a reader
    // makes and then closes the tab, and it must not come back next visit.
    expect(stored().entries).toEqual([])
  })

  it('drops the key as well, so the sweep leaves nothing behind', () => {
    logAction({ kind: 'open', line: 'opened a.cool' })
    forgetActions()
    expect(window.localStorage.getItem(KEY)).toBeNull()
    // And the copy in memory, without which the next recorded line would write
    // the whole list straight back out.
    expect(actions()).toEqual([])
  })
})

describe('the two stamps', () => {
  it('cuts a day in local time, so a log read at 00:30 is still that morning', () => {
    const when = new Date(2026, 8, 11, 0, 30, 0)
    expect(dayOf(when.getTime())).toBe('2026-09-11')
    expect(timeOf(when.getTime())).toBe('00:30:00')
  })
})
