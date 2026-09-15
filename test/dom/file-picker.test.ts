// @vitest-environment jsdom
/**
 * The landing page, and the load box the two dialogs are made of.
 *
 * Three things are on the page and they are named: **Load files**, **Mount a
 * local or remote folder** and **Connect to a data store**. What the tests
 * below pin is that each is exactly one thing — one drop area with one URL
 * box, one row of place buttons, one row of tiles — and that neither row costs
 * a request: both are descriptions, and pressing one is the gesture that opens
 * the drawer or the Connect dialog (§24.2). The rest is what the box owes a
 * reader whatever door they came through: a drop target that also takes a
 * click, and a box for a URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilePicker } from '@/ui/FilePicker'
import { LoadBox } from '@/ui/LoadBox'
import type { ProviderId } from '@/ui/connectFronts'
import { icon } from '@/ui/icons'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
})

interface Built {
  picker: FilePicker
  el: HTMLElement
  opened: Array<{ uri: string; local: boolean }>
  files: File[][]
  stores: string[]
  places: string[]
}

function build(withDoors = true): Built {
  const opened: Array<{ uri: string; local: boolean }> = []
  const files: File[][] = []
  const stores: string[] = []
  const places: string[] = []
  const picker = new FilePicker({
    onOpen: (uri, source) => opened.push({ uri, local: source.kind === 'local' }),
    onOpenFiles: (chosen) => files.push([...chosen]),
    ...(withDoors
      ? {
          onStore: (id: string) => stores.push(id),
          onConnect: (provider: ProviderId) => places.push(provider),
        }
      : {}),
  })
  return { picker, el: picker.el, opened, files, stores, places }
}

/** A `drop`, with files on it, as jsdom will not build a real `DataTransfer`. */
function dropOn(node: HTMLElement, ...files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, items: [] } })
  node.dispatchEvent(event)
}

describe('the landing page', () => {
  it('names its three things, and offers one drop area and one URL box', () => {
    const { el } = build()
    expect(textsOf(el, '.picker-heading')).toEqual([
      'Load files',
      'Mount a local or remote folder',
      'Connect to a data store',
    ])
    expect(all(el, '.dropzone')).toHaveLength(1)
    expect(all(el, '.input-url')).toHaveLength(1)
    expect(buttonNamed(el, 'choose files…')).not.toBeNull()
    expect(buttonNamed(el, 'open')).not.toBeNull()
    // The catalogue that used to stand beside the box is gone: it was a store.
    expect(buttonNamed(el, 'browse…')).toBeNull()
    expect(buttonNamed(el, 'private buckets…')).toBeNull()
  })

  it('puts the ways in beside the drop area rather than under it', () => {
    // Three peers on one row: drop, choose, or name a URL. Stacked, the page
    // said the reader's next move was to drag something, which is wrong for
    // the reader who has a URL and for the one with no window to drag out of.
    const { el } = build()
    const row = el.querySelector('.load-main') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.querySelector('.dropzone')).not.toBeNull()
    const ways = row.querySelector('.load-ways') as HTMLElement
    expect(buttonNamed(ways, 'choose files…')).not.toBeNull()
    expect(ways.querySelector('.input-url')).not.toBeNull()
    // The paragraph about what opens as what is under the row, not inside the
    // target: it is read once, and a drop area is not a place for prose.
    const drop = row.querySelector('.dropzone') as HTMLElement
    expect(drop.textContent).toBe('Drop files hereor click to choose')
    expect((el.querySelector('.load-note')?.textContent ?? '')).toMatch(/opens as a browser over its genome/)
  })

  it('carries the marked button the Connect dialog’s panes are pressed by', () => {
    // "The buttons should be styled the same way the ones in the modal": one
    // shape for one gesture, wherever a reader meets it (`ui/icons.ts`).
    const { el } = build()
    expect(buttonNamed(el, 'choose files…')?.className).toContain('btn-mark')
    expect(all(el, '.picker-provider').every((node) => node.classList.contains('btn-mark'))).toBe(true)
  })

  it('offers the four places as buttons, each a door to the Connect dialog', () => {
    const built = build()
    expect(textsOf(built.el, '.picker-provider')).toEqual([
      'choose a folder…',
      'connect a bucket…',
      'sign in to Google…',
      'sign in to Dropbox…',
    ])
    const buttons = all<HTMLButtonElement>(built.el, '.picker-provider')
    buttons[0].click()
    buttons[3].click()
    // The id, not the form: what follows a press is a picker, a form or a
    // sign-in, and all three are the dialog's (§24.2).
    expect(built.places).toEqual(['local', 'dropbox'])
  })

  it('offers the five shipped stores as tiles, then the one that adds a store', () => {
    const { el } = build()
    expect(textsOf(el, '.store-tile .store-tile-name')).toEqual([
      'RSG lab data',
      'IGV genomes',
      '4DN open data',
      'ENCODE',
      'DNA Zoo',
      'Your own store',
    ])
    // Every tile is a mark and a line, not a request.
    expect(all(el, '.store-tile .store-mark')).toHaveLength(6)
  })

  it('fetches nothing when it is built or when the tiles are drawn', () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    build()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('hands a pressed tile up by id, which is the gesture that opens the drawer', () => {
    const built = build()
    const tiles = all<HTMLButtonElement>(built.el, '.store-tile')
    // A shipped one in the middle, and the last tile — which is the one that
    // adds a store, and stays last however many are shipped in front of it.
    tiles[2].click()
    tiles[tiles.length - 1].click()
    expect(built.stores).toEqual(['4dn', 'custom'])
  })

  it('leaves the two rows out when it is given no door to them, and keeps the rest', () => {
    const { el } = build(false)
    expect(textsOf(el, '.picker-heading')).toEqual(['Load files'])
    expect(all(el, '.store-tile')).toHaveLength(0)
    expect(all(el, '.picker-provider')).toHaveLength(0)
    expect(all(el, '.dropzone')).toHaveLength(1)
  })

  it('takes a file dropped on the area', () => {
    const built = build()
    const drop = built.el.querySelector('.dropzone') as HTMLElement
    dropOn(drop, new File([], 'sample.mcool'))
    expect(built.files).toHaveLength(1)
    expect(built.files[0].map((file) => file.name)).toEqual(['sample.mcool'])
  })

  it('reports a typed URL as a remote source', () => {
    const built = build()
    const box = built.el.querySelector('.input-url') as HTMLInputElement
    box.value = ' https://bucket.example.org/Hum53.metacool '
    ;(buttonNamed(built.el, 'open') as HTMLButtonElement).click()
    // Trimmed, and remote: the byte source is the only thing that differs
    // between this and the drop above.
    expect(built.opened).toEqual([
      { uri: 'https://bucket.example.org/Hum53.metacool', local: false },
    ])
  })

  it('says nothing about an empty box rather than opening nothing', () => {
    const built = build()
    ;(buttonNamed(built.el, 'open') as HTMLButtonElement).click()
    expect(built.opened).toEqual([])
  })

  it('rewrites a share link to the address that opens (§24.5)', () => {
    const built = build()
    const box = built.el.querySelector('.input-url') as HTMLInputElement
    box.value = 'https://www.dropbox.com/s/abc/a.mcool?dl=0'
    ;(buttonNamed(built.el, 'open') as HTMLButtonElement).click()
    expect(built.opened[0].uri).toBe('https://dl.dropboxusercontent.com/s/abc/a.mcool?dl=0')
  })
})

describe('the load box on its own', () => {
  it('is the same drop area and URL box the landing page has, shallower', () => {
    const box = new LoadBox({ onOpen: () => undefined, onOpenFiles: () => undefined, compact: true })
    expect(box.el.querySelector('.dropzone-compact')).not.toBeNull()
    expect(all(box.el, '.input-url')).toHaveLength(1)
    expect(all(box.el, '.store-tile')).toHaveLength(0)
    // The dialogs get the row too, and the sentence about what opens as what:
    // it is the box's, so every door a file is asked for carries it.
    expect(box.el.querySelector('.load-main > .load-ways')).not.toBeNull()
    expect(box.el.querySelector('.load-note')).not.toBeNull()
    // No places and no stores here: this box is the *load* half alone.
    expect(all(box.el, '.picker-provider')).toHaveLength(0)
  })
})

describe('the two marks on a file row', () => {
  it('are a plus, and a window with a plus where its corner was — not one glyph twice', () => {
    // *Add here* and *open in a new session* stand side by side on every row
    // (`ui/rowVerbs.ts`); a shared glyph would make them the same button.
    const add = icon('plus')
    const fresh = icon('new-session')
    expect(add.innerHTML).not.toBe(fresh.innerHTML)
    // The frame is open at its top-right corner and the plus sits there.
    expect(fresh.innerHTML).toContain('M18 2v8')
    expect(fresh.innerHTML).toContain('M14 6h8')
  })
})
