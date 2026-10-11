// @vitest-environment jsdom
/**
 * The **Share this tab** dialog.
 *
 * `share-link.test.ts` covers the codec and the fragment key. What it cannot see
 * is the dialog, and the dialog is where the reader actually meets the feature:
 * whether the link arrives on the clipboard without being asked for, whether
 * they are *told* that it did, and — the case that decides whether this is a
 * good change or a bad one — what happens on a browser that refuses the
 * clipboard, which is every insecure origin and so every colleague running the
 * viewer off a laptop over plain HTTP.
 *
 * The refusal path is the default here, not an edge case constructed for the
 * test: jsdom has no `navigator.clipboard`, exactly like the browsers this has
 * to keep working on. The success path is the one that needs a fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import { CONFIG_VERSION, type SessionConfig } from '@/state/SessionConfig'
import { SHARE_KEY } from '@/state/shareLink'
import { openShareDialog } from '@/ui/ShareDialog'
import type { Modal } from '@/ui/Modal'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const open: Modal[] = []

beforeEach(() => {
  teardown = setUpDom()
  // jsdom ships a `Blob` with no `.stream()`, and `encodeShare` deflates through
  // `blob.stream().pipeThrough(new CompressionStream(...))`. Node's own `Blob`
  // has it and is what a browser has, so the codec runs here for real rather
  // than being mocked out — which matters, because the thing worth asserting is
  // that the box ends up holding a genuine `#session=` payload.
  vi.stubGlobal('Blob', NodeBlob)
})

afterEach(() => {
  for (const modal of open.splice(0, open.length)) modal.close()
  document.querySelectorAll('.toast').forEach((node) => node.remove())
  vi.unstubAllGlobals()
  teardown()
})

const BASE = 'https://js2264.github.io/chromosomix/'

function configOf(): SessionConfig {
  return {
    version: CONFIG_VERSION,
    createdAt: '2026-08-12T09:00:00.000Z',
    // A local file, so `shortenable` is false and the shortener row settles into
    // its explanation instead of offering a button that would post a private
    // filename to a stranger. That keeps these cases about the copy.
    state: { uri: 'rep1.cool', view: 'region', region: 'chrI' },
    tracks: [],
    manual: [],
    bookmarks: [],
  } as unknown as SessionConfig
}

/**
 * Open the dialog and wait for the link to be generated.
 *
 * The generation is an async IIFE the dialog does not expose a handle to, so
 * this polls the box rather than awaiting something — which is also what a
 * reader does, and what makes "the field still says preparing…" a failure this
 * can catch rather than a race it can hide.
 */
async function opened(): Promise<{ modal: Modal; box: HTMLElement }> {
  const modal = openShareDialog({ config: configOf(), base: BASE })
  open.push(modal)
  const box = document.querySelector('.share-link') as HTMLElement
  for (let turn = 0; turn < 200; turn++) {
    if ((box.textContent ?? '').startsWith('http')) return { modal, box }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`the link never arrived: ${box.textContent ?? ''}`)
}

/** Let the copy's promise chain settle after the link has appeared. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 1))
}

function toast(): string | null {
  const node = document.querySelector('.toast')
  return node === null ? null : (node.textContent ?? '')
}

function hints(): string {
  return Array.from(document.querySelectorAll('.share-body .hint'))
    .map((node) => node.textContent ?? '')
    .join(' | ')
}

describe('the link it produces', () => {
  it('carries the whole session under the fragment key', async () => {
    const { box } = await opened()
    expect(box.textContent).toContain(`#${SHARE_KEY}=`)
    expect(box.textContent?.startsWith(BASE)).toBe(true)
  })

  it('is a scrollable box with an accessible name, not a bare focus stop', async () => {
    const { box } = await opened()
    // It stopped being an `<input readOnly>` so the reader can scroll a
    // thousand-character link by wheel and by drag. What an input gave for free
    // and a div does not is the announcement, so those have to be spelled out.
    expect(box.tagName).toBe('DIV')
    expect(box.getAttribute('tabindex')).toBe('0')
    expect(box.getAttribute('role')).toBe('textbox')
    expect(box.getAttribute('aria-readonly')).toBe('true')
    expect(box.getAttribute('aria-label')).toBeTruthy()
  })
})

describe('the modal itself', () => {
  it('is the wide variant, so its body cannot be clipped by its panel', async () => {
    await opened()
    // The bug: `.share-body` asked for a `min-width` 4rem wider than
    // `.modal-panel`, which is `overflow: hidden` — so the right-hand edge,
    // where the copy and shorten buttons live, was cut off with no way to scroll
    // to it.
    expect(document.querySelector('.modal-panel')?.classList.contains('modal-wide')).toBe(true)
  })

  /**
   * The shell keeps the dialog it opened in a field and treats that field as
   * "a dialog owns the keyboard". This was the one opener in the application
   * that took no `onClose`, so the field went on pointing at a dialog that was
   * no longer on screen: after one Escape here, every shortcut, the command
   * palette and every other dialog were dead until the page was reloaded.
   */
  it('tells its opener that it closed, however it was closed', () => {
    const closes: string[] = []
    const modal = openShareDialog({
      config: configOf(),
      base: BASE,
      onClose: () => closes.push('closed'),
    })
    open.push(modal)
    expect(closes).toHaveLength(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(closes).toHaveLength(1)
  })

  it('offers copying as an icon button with a name, and no label text', async () => {
    await opened()
    const copy = Array.from(document.querySelectorAll('.share-row button')).find(
      (node) => (node.getAttribute('aria-label') ?? '').toLowerCase().includes('copy'),
    ) as HTMLButtonElement | undefined
    expect(copy, 'no copy button').toBeDefined()
    expect(copy?.textContent?.trim()).toBe('')
    expect(copy?.querySelector('svg')).not.toBeNull()
  })
})

describe('when the clipboard works', () => {
  // The answer is in the dialog's own note, not in a corner note over the
  // status bar: this copy happens while the reader is looking at the dialog,
  // and its refusal was always written there.
  it('copies the link the moment it exists, and says so in the dialog', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        },
      },
    })
    const { box } = await opened()
    await settle()
    expect(written).toEqual([box.textContent])
    expect(hints()).toMatch(/copied to the clipboard/i)
    expect(toast()).toBeNull()
  })

  /**
   * Dismissed before the link exists, the dialog asked for nothing: the copy
   * that would have followed writes over a clipboard the reader has since
   * filled with something else.
   */
  it('copies nothing once the dialog has been closed', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        },
      },
    })
    openShareDialog({ config: configOf(), base: BASE })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    await settle()
    await settle()
    expect(written).toEqual([])
  })
})

describe('when the clipboard is refused', () => {
  /**
   * jsdom has no `navigator.clipboard`, which is the same state every insecure
   * origin is in. Nothing has gone wrong from where the reader sits — the link
   * is on screen — so there must be no success notification and there must be a
   * sentence telling them to copy it themselves.
   */
  it('shows no notification, and tells the reader to copy it', async () => {
    await opened()
    await settle()
    expect(toast()).toBeNull()
    expect(hints()).toMatch(/select/i)
  })

  it('does not throw out of the generation, so the rest of the dialog still fills in', async () => {
    const { box } = await opened()
    await settle()
    expect(box.textContent).toContain(`#${SHARE_KEY}=`)
    // The shortener row settles either into an offer or into the explanation of
    // why there is none; an exception during generation would leave it empty.
    expect(hints().length).toBeGreaterThan(0)
  })

  it('survives a clipboard that rejects rather than one that is absent', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    })
    await opened()
    await settle()
    expect(toast()).toBeNull()
    expect(hints()).toMatch(/select/i)
  })
})

/**
 * The shell's own use of the dialog, which is where the missing `onClose` was
 * actually felt.
 *
 * `App` holds the dialog it opened in one field and reads `modal !== null` as
 * "a dialog owns the keyboard": it is the guard on every shortcut, on the
 * command palette, and on every other dialog in the application. This opener
 * was the only one that never told the field it had closed, so one Escape here
 * left the whole window keyboard-dead until the page was reloaded — with the
 * dialog itself gone from the screen, so nothing said why.
 */
describe('as the shell opens it', () => {
  it('hands the keyboard back to the window when it is dismissed', () => {
    resetMounting()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = new App(root)
    // A tab with something in it, so the button *offers* the dialog: with
    // nothing open there is nothing to put in a link and the button is
    // unavailable rather than answering with a refusal (§8.5). `adopt` tells
    // nobody by design — a restored tab is named, not opened — so the shell is
    // told the way a session tells it, which is what clicking the tab does.
    const session = app['current']
    session?.store.adopt({ uri: 'https://data.example/f.mcool', view: 'genomes' })
    if (session !== undefined) app['sessionChanged'](session)

    const share = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Share this tab as a link"]',
    )
    expect(share, 'the header has no share button').not.toBeNull()
    expect(share?.disabled).toBe(false)
    share?.click()
    expect(document.querySelector('.modal-title')?.textContent).toBe('Share this tab')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(app['modal']).toBeNull()

    // And the window really does answer keys again: `t` is the theme.
    const before = document.documentElement.getAttribute('data-theme')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
    expect(document.documentElement.getAttribute('data-theme')).not.toBe(before)
  })
})
