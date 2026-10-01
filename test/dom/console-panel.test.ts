// @vitest-environment jsdom
/**
 * The console panel: the bottom drawer, and what a row of it says (§23).
 *
 * What is asserted here is the half a reader can see, and it is the half the
 * Analysis drawer already argued for: this is a **place to work, not a
 * question**. So it takes no backdrop and no keyboard, Escape puts it down
 * rather than cancelling anything, and closing it stops nothing — the log goes
 * on filling behind it, which is what makes closing it safe to do.
 *
 * Three of the tests are about a promise made in prose elsewhere and only
 * keepable here. **Every run is a row**, so a batch over six maps is six rows
 * rather than one: the panel paints what the log holds and the log holds one
 * entry per job. **The provenance toggle is the choice between a script and an
 * archive**, and it governs the clipboard as well as the screen — a reader who
 * turns it off to paste clean commands must not find eleven `#` lines per
 * command on their clipboard anyway. And **a day is the unit**, because "what
 * did I run on Tuesday" is the question the panel exists for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConsolePanel } from '@/ui/ConsolePanel'
import { endAction, forgetActions, logAction, resetActions } from '@/state/actions'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let copied: string[]
let restoreClipboard: () => void
let restoreDownloads: () => void
/**
 * Every panel a test mounted.
 *
 * A console listens on `window` for its Escape and its resize, and in the
 * application there is exactly one of them for the life of the page. A test file
 * mounts a dozen, so each is put down after its own test — without which the
 * *previous* test's panel is still listening and still open, and the one that
 * asks whether a closed console leaves Escape alone gets its answer from a panel
 * that no longer belongs to anybody.
 */
const mounted: ConsolePanel[] = []
let saved: Array<{ name: string; blob: Blob }>

/** jsdom has no clipboard; what is asserted is the text the panel handed over. */
function captureClipboard(): () => void {
  const nav = navigator as unknown as { clipboard?: { writeText(text: string): Promise<void> } }
  const real = nav.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text)
        return Promise.resolve()
      },
    },
  })
  return () => {
    if (real === undefined) delete nav.clipboard
    else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: real })
  }
}

/** What `downloadBlob` would have handed the browser; jsdom has no object URLs. */
function captureDownloads(): () => void {
  let pending: Blob | null = null
  const urls = URL as unknown as {
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
  }
  const realCreate = urls.createObjectURL
  const realRevoke = urls.revokeObjectURL
  const realClick = HTMLAnchorElement.prototype.click
  urls.createObjectURL = (blob: Blob) => {
    pending = blob
    return 'blob:test'
  }
  urls.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (pending !== null) saved.push({ name: this.download, blob: pending })
    pending = null
  }
  return () => {
    urls.createObjectURL = realCreate
    urls.revokeObjectURL = realRevoke
    HTMLAnchorElement.prototype.click = realClick
  }
}

/** The panel, inside the `.app-body` it measures its height against. */
function mount(): ConsolePanel {
  const body = document.createElement('div')
  body.className = 'app-body'
  document.body.appendChild(body)
  const panel = new ConsolePanel()
  body.appendChild(panel.el)
  mounted.push(panel)
  return panel
}

function rows(panel: ConsolePanel): HTMLElement[] {
  return Array.from(panel.el.querySelectorAll<HTMLElement>('.console-row'))
}

function textOf(node: HTMLElement, selector: string): string {
  return node.querySelector(selector)?.textContent ?? ''
}

function press(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function findButton(panel: ConsolePanel, label: string): HTMLButtonElement {
  const found = Array.from(panel.el.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === label,
  )
  if (found === undefined) throw new Error(`no ${label} button`)
  return found
}

/** One finished run, as the runner would have recorded it. */
function run(map: string, task = 'insulation'): void {
  const id = logAction({
    kind: 'run',
    line: `metacooler-run ${task} ${map} --window 10`,
    shell: true,
    detail: [`# task: ${task} v1`, '# param window: 10'],
    status: 'running',
    where: map,
  })
  endAction(id, { status: 'ok', ms: 1400 })
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  resetActions()
  copied = []
  saved = []
  restoreClipboard = captureClipboard()
  restoreDownloads = captureDownloads()
})

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.destroy()
  restoreDownloads()
  restoreClipboard()
  forgetActions()
  window.localStorage.clear()
  teardown()
})

describe('opening and closing', () => {
  it('starts closed, opens on its button and closes again', () => {
    const panel = mount()
    expect(panel.isOpen).toBe(false)
    expect(panel.el.classList.contains('collapsed')).toBe(true)

    panel.toggle.click()
    expect(panel.isOpen).toBe(true)
    expect(panel.el.classList.contains('collapsed')).toBe(false)

    panel.toggle.click()
    expect(panel.isOpen).toBe(false)
  })

  it('is put down by Escape, and by the ✕, and neither stops the recording', () => {
    const panel = mount()
    panel.toggle.click()
    press('Escape')
    expect(panel.isOpen).toBe(false)

    // The whole reason Escape is safe here: the log is not the panel.
    run('a.cool')
    panel.toggle.click()
    expect(rows(panel)).toHaveLength(1)

    panel.el.querySelector<HTMLButtonElement>('.btn-close')?.click()
    expect(panel.isOpen).toBe(false)
  })

  it('leaves an Escape alone that something in front of it has answered', () => {
    const panel = mount()
    panel.toggle.click()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    // A marquee on the map, a caret in a search box, an open dropdown: each
    // answers Escape first, and the panel under them must not go with it.
    expect(panel.isOpen).toBe(true)
  })

  it('does not answer Escape while it is closed', () => {
    // Mounted and left closed: the listener is on `window` for the panel's whole
    // life, so a console nobody has opened must not be swallowing the key the
    // rest of the application is dismissed by.
    mount()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('remembers being open across a mount, like a column remembers its fold', () => {
    const first = mount()
    first.toggle.click()
    first.destroy()
    const second = mount()
    expect(second.isOpen).toBe(true)
  })
})

describe('the rows', () => {
  it('gives a run over six maps six rows, one per map', () => {
    for (const map of ['rep1', 'rep2', 'rep3', 'rep4', 'rep5', 'rep6']) run(`${map}.cool`)
    const panel = mount()
    panel.toggle.click()
    const painted = rows(panel)
    expect(painted).toHaveLength(6)
    expect(painted.map((row) => textOf(row, '.console-where'))).toEqual([
      'rep1.cool',
      'rep2.cool',
      'rep3.cool',
      'rep4.cool',
      'rep5.cool',
      'rep6.cool',
    ])
  })

  it('marks a row by what happened to it, and prints a failure in full', () => {
    const id = logAction({ kind: 'run', line: 'metacooler-run apa a.cool', shell: true, status: 'running' })
    const panel = mount()
    panel.toggle.click()
    expect(rows(panel)[0].classList.contains('is-running')).toBe(true)

    endAction(id, { status: 'failed', error: 'No loop set was chosen.' })
    const row = rows(panel)[0]
    expect(row.classList.contains('is-failed')).toBe(true)
    // In full: a truncated message is a bug report nobody can act on.
    expect(textOf(row, '.console-error')).toBe('No loop set was chosen.')
    // The command stays the command it was, failure or not.
    expect(textOf(row, '.console-line')).toBe('metacooler-run apa a.cool')
  })

  it('names the state on its mark in the words every surface uses (§26.7)', () => {
    // One run that finished, and one this window was watching when it went
    // away — stored `running`, and read back by a window that never saw it
    // end, so it comes back interrupted (§23.5).
    const at = Date.now()
    window.localStorage.setItem(
      'metacooler-viewer:actions',
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'ran', at, kind: 'run', line: 'metacooler-run insulation a.cool', shell: true, status: 'ok' },
          { id: 'gone', at: at + 1, kind: 'run', line: 'metacooler-run compartments a.cool', shell: true, status: 'running' },
        ],
      }),
    )
    resetActions()
    const panel = mount()
    panel.toggle.click()
    const marks = rows(panel).map((row) => row.querySelector<HTMLElement>('.console-mark')?.title ?? '')
    expect(marks).toEqual(['analysis run — done', 'analysis run — interrupted'])
  })

  it('draws a refusal under the line it explains, and a caveat over it', () => {
    logAction({
      kind: 'run',
      line: 'metacooler-run insulation a.cool',
      shell: true,
      notes: ['# This file is remote.'],
    })
    logAction({
      kind: 'run',
      line: 'ran Track correlation — Yeast_ATAC.bw · loaded tracks, no contact map',
      shell: false,
      notes: ['# trackcorr reads a track; run it in the app.'],
    })
    const panel = mount()
    panel.toggle.click()
    const classesOf = (row: HTMLElement): string[] =>
      Array.from(row.querySelectorAll('.console-lines > *')).map((node) => node.className)
    expect(classesOf(rows(panel)[0])).toEqual(['console-note', 'console-line is-shell'])
    expect(classesOf(rows(panel)[1])).toEqual(['console-line', 'console-note'])
  })

  it('separates the days, and says how many lines each holds', () => {
    run('a.cool')
    run('b.cool')
    const panel = mount()
    panel.toggle.click()
    const days = panel.el.querySelectorAll('.console-day')
    expect(days).toHaveLength(1)
    expect(days[0].querySelector('.console-day-name')?.textContent).toBe('today')
    expect(days[0].querySelector('.console-day-count')?.textContent).toBe('2 lines')
  })

  // Two sentences: what will appear, and where it is kept. The deck-batch aside
  // it used to carry — *one line per map* — is §23.1's argument about the log's
  // shape rather than something a reader opening an empty panel can act on.
  it('says what it is for while it holds nothing', () => {
    const panel = mount()
    panel.toggle.click()
    expect(rows(panel)).toHaveLength(0)
    const empty = panel.el.querySelector('.console-empty')?.textContent ?? ''
    expect(empty).toContain('Nothing recorded yet.')
    expect(empty).toContain('kept for a week')
    expect(empty).not.toContain('one line per map')
  })

  it('follows a run that arrives while it is open', () => {
    const panel = mount()
    panel.toggle.click()
    expect(rows(panel)).toHaveLength(0)
    run('a.cool')
    expect(rows(panel)).toHaveLength(1)
  })
})

/**
 * The provenance toggle, which is a `btn-toggle` and not a checkbox.
 *
 * It was a ticked box labelled *output* — a word that beside a column of
 * commands reads as the numbers the runs produced, which is the one thing it
 * does not show — and a checkbox is for choosing rows in a list rather than for
 * a setting (§26.3). So the tests press a button and read `aria-pressed`.
 */
describe('the provenance toggle', () => {
  it('is a labelled toggle that says whether it is on', () => {
    const panel = mount()
    const box = panel.el.querySelector<HTMLButtonElement>('.console-output-box')
    if (box === null) throw new Error('no provenance toggle')
    expect(box.tagName).toBe('BUTTON')
    expect(box.textContent).toBe('provenance')
    expect(box.classList.contains('btn-toggle')).toBe(true)
    expect(box.getAttribute('aria-pressed')).toBe('false')
    box.click()
    expect(box.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the provenance and hides it again', () => {
    run('a.cool')
    const panel = mount()
    panel.toggle.click()
    expect(panel.el.querySelectorAll('.console-detail')).toHaveLength(0)

    const box = panel.el.querySelector<HTMLButtonElement>('.console-output-box')
    if (box === null) throw new Error('no provenance toggle')
    box.click()
    expect(
      Array.from(panel.el.querySelectorAll('.console-detail')).map((node) => node.textContent),
    ).toEqual(['# task: insulation v1', '# param window: 10'])

    box.click()
    expect(panel.el.querySelectorAll('.console-detail')).toHaveLength(0)
  })

  it('governs the clipboard as well as the screen', async () => {
    run('a.cool')
    const panel = mount()
    panel.toggle.click()

    findButton(panel, 'copy').click()
    await Promise.resolve()
    expect(copied[0]).toContain('metacooler-run insulation a.cool --window 10')
    expect(copied[0]).not.toContain('# param window: 10')

    const box = panel.el.querySelector<HTMLButtonElement>('.console-output-box')
    if (box === null) throw new Error('no provenance toggle')
    box.click()
    findButton(panel, 'copy').click()
    await Promise.resolve()
    expect(copied[1]).toContain('# param window: 10')
  })
})

describe('taking it away', () => {
  it('copies one day from its heading', async () => {
    run('a.cool')
    const panel = mount()
    panel.toggle.click()
    findButton(panel, 'copy this day').click()
    await Promise.resolve()
    expect(copied[0]).toContain('metacooler-run insulation a.cool')
  })

  it('copies one row from the row itself', async () => {
    run('a.cool')
    const panel = mount()
    panel.toggle.click()
    rows(panel)[0].querySelector<HTMLButtonElement>('.console-row-copy')?.click()
    await Promise.resolve()
    // The command alone, with no day heading around it: a row is copied to be
    // pasted into something, not to be read.
    expect(copied[0]).toBe('metacooler-run insulation a.cool --window 10')
  })

  it('writes a comment rather than a bare line for what a shell cannot run', async () => {
    logAction({ kind: 'open', line: 'opened a.cool' })
    const panel = mount()
    panel.toggle.click()
    rows(panel)[0].querySelector<HTMLButtonElement>('.console-row-copy')?.click()
    await Promise.resolve()
    expect(copied[0]).toMatch(/^# \d\d:\d\d:\d\d {2}opened a\.cool$/)
  })

  it('clears the list on request', () => {
    run('a.cool')
    const panel = mount()
    panel.toggle.click()
    findButton(panel, 'clear').click()
    expect(rows(panel)).toHaveLength(0)
    expect(panel.el.querySelector('.console-empty')).not.toBeNull()
  })

  it('saves a script, and records the file it wrote like every other export', async () => {
    run('a.cool')
    const panel = mount()
    panel.toggle.click()
    findButton(panel, 'save').click()
    // The save asks where the file goes before writing it (`ui/export.ts`),
    // which is a turn of the event loop even where there is no dialog to ask.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(saved).toHaveLength(1)
    expect(saved[0].name).toMatch(/^metacooler-console-.*\.sh$/)
    const text = await saved[0].blob.text()
    expect(text.split('\n')[0]).toBe('#!/bin/sh')
    expect(text).toContain('metacooler-run insulation a.cool --window 10')

    // A console that wrote a file and did not say so would be the one place in
    // the app where a file leaves without a line about it.
    const written = rows(panel).filter((row) => row.dataset['kind'] === 'write')
    expect(written).toHaveLength(1)
    expect(textOf(written[0], '.console-line')).toMatch(/^wrote metacooler-console-.*\.sh$/)
  })
})
