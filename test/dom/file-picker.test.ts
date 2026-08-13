// @vitest-environment jsdom
/**
 * The picker, and the two dialogs that are made of it.
 *
 * One element serves three screens — the landing page, the file crumb's *open a
 * file*, and the header's `+` — and what separates them is a single optional
 * prop. That is a good arrangement while the difference stays visible, and an
 * invisible one the moment nothing asserts it: the catalogue is a list of
 * *published sessions*, so offering it from the header's dialog would offer to
 * throw the reader's tab away from the one control whose whole promise is that
 * it will not.
 *
 * The rest is what both dialogs owe a reader whatever door they came through: a
 * drop target that also takes a click, a box for a URL, and the way to a private
 * bucket beside it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FilePicker } from '@/ui/FilePicker'
import { icon } from '@/ui/icons'
import { all, buttonNamed, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
})

interface Built {
  el: HTMLElement
  opened: Array<{ uri: string; local: boolean }>
  files: File[][]
}

function build(examples?: Array<{ label: string; url: string }>): Built {
  const opened: Array<{ uri: string; local: boolean }> = []
  const files: File[][] = []
  const picker = new FilePicker({
    onOpen: (uri, source) => opened.push({ uri, local: source.kind === 'local' }),
    onOpenFiles: (chosen) => files.push([...chosen]),
    ...(examples === undefined ? {} : { examples }),
  })
  return { el: picker.el, opened, files }
}

/** A `drop`, with files on it, as jsdom will not build a real `DataTransfer`. */
function dropOn(node: HTMLElement, ...files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, items: [] } })
  node.dispatchEvent(event)
}

describe('the file picker', () => {
  it('offers a drop area, a URL box and a way to a private bucket', () => {
    const { el } = build()
    expect(all(el, '.dropzone')).toHaveLength(1)
    expect(all(el, '.remote-box .input-url')).toHaveLength(1)
    expect(buttonNamed(el, 'open')).not.toBeNull()
    expect(buttonNamed(el, 'browse…')).not.toBeNull()
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

  it('shows the catalogue when it is given one', () => {
    const { el } = build([{ label: 'Hum53', url: 'https://example.org/Hum53.json' }])
    const select = el.querySelector('.select-examples') as HTMLSelectElement
    expect(select).not.toBeNull()
    // The placeholder, then one row per published session.
    expect(all(select, 'option')).toHaveLength(2)
  })

  /**
   * The header's `+` builds exactly this one, and the assertion is the whole of
   * why the prop is optional: everything a reader came for is still here, and
   * the list of other people's sessions is not.
   */
  it('leaves the catalogue out when it is given none, and keeps the rest', () => {
    const { el } = build()
    expect(el.querySelector('.examples')).toBeNull()
    expect(el.querySelector('.select-examples')).toBeNull()
    expect(all(el, '.dropzone')).toHaveLength(1)
    expect(all(el, '.remote-box')).toHaveLength(1)
  })
})

describe('the header’s add-a-file mark', () => {
  it('is a file with a plus on it, and not the tab strip’s bare plus', () => {
    // Two marks one row apart: the strip's `+` adds a tab, this adds a file to
    // the tab you are in. A shared glyph would make them the same button.
    const add = icon('file-plus')
    const tab = icon('plus')
    expect(add.childElementCount).toBeGreaterThan(tab.childElementCount)
    expect(add.getAttribute('stroke')).toBe('currentColor')
  })
})
