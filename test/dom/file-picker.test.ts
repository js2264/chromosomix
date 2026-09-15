// @vitest-environment jsdom
/**
 * The landing page, and the load box the two dialogs are made of.
 *
 * Two things are on the page and they are named: **Load files** and **Connect
 * to a store**. What the tests below pin is that each is exactly one thing —
 * one drop area, one URL box, one row of tiles — and that the tiles cost no
 * request: a tile is a description, and pressing it is the gesture that opens
 * the drawer (§24.2). The rest is what the box owes a reader whatever door they
 * came through: a drop target that also takes a click, and a box for a URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilePicker } from '@/ui/FilePicker'
import { LoadBox } from '@/ui/LoadBox'
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
}

function build(withStores = true): Built {
  const opened: Array<{ uri: string; local: boolean }> = []
  const files: File[][] = []
  const stores: string[] = []
  const picker = new FilePicker({
    onOpen: (uri, source) => opened.push({ uri, local: source.kind === 'local' }),
    onOpenFiles: (chosen) => files.push([...chosen]),
    ...(withStores ? { onStore: (id: string) => stores.push(id) } : {}),
  })
  return { picker, el: picker.el, opened, files, stores }
}

/** A `drop`, with files on it, as jsdom will not build a real `DataTransfer`. */
function dropOn(node: HTMLElement, ...files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, items: [] } })
  node.dispatchEvent(event)
}

describe('the landing page', () => {
  it('names its two things, and offers one drop area and one URL box', () => {
    const { el } = build()
    expect(textsOf(el, '.picker-heading')).toEqual(['Load files', 'Connect to a store'])
    expect(all(el, '.dropzone')).toHaveLength(1)
    expect(all(el, '.input-url')).toHaveLength(1)
    expect(buttonNamed(el, 'choose files…')).not.toBeNull()
    expect(buttonNamed(el, 'open')).not.toBeNull()
    // The doors that used to stand beside the box are gone: a bucket is a
    // place, connected from the header, and a catalogue is a store.
    expect(buttonNamed(el, 'browse…')).toBeNull()
    expect(buttonNamed(el, 'private buckets…')).toBeNull()
  })

  it('offers the four shipped stores as tiles, then the one that adds a store', () => {
    const { el } = build()
    expect(textsOf(el, '.store-tile .store-tile-name')).toEqual([
      'RSG lab data',
      'IGV genomes',
      '4DN open data',
      'ENCODE',
      'Your own store',
    ])
    // Every tile is a mark and a line, not a request.
    expect(all(el, '.store-tile .store-mark')).toHaveLength(5)
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
    tiles[2].click()
    tiles[4].click()
    expect(built.stores).toEqual(['4dn', 'custom'])
  })

  it('leaves the stores out when it is given no door to them, and keeps the rest', () => {
    const { el } = build(false)
    expect(textsOf(el, '.picker-heading')).toEqual(['Load files'])
    expect(all(el, '.store-tile')).toHaveLength(0)
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
