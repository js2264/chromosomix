// @vitest-environment jsdom
/**
 * The picker, and the two dialogs that are made of it.
 *
 * One element serves three screens — the landing page, the file crumb's *open a
 * file*, and the header's `+` — and what separates them is a single optional
 * prop. That is a good arrangement while the difference stays visible, and an
 * invisible one the moment nothing asserts it: every row of a hub is a whole
 * file or a whole saved session, so offering the hubs section from the header's
 * dialog would offer to throw the reader's tab away from the one control whose
 * whole promise is that it will not.
 *
 * The rest is what both dialogs owe a reader whatever door they came through: a
 * drop target that also takes a click, a box for a URL, and the way to a private
 * bucket beside it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FilePicker } from '@/ui/FilePicker'
import { icon } from '@/ui/icons'
import { HUB_KIND, HUB_VERSION, type HubRef } from '@/state/hub'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
})

interface Built {
  picker: FilePicker
  el: HTMLElement
  opened: Array<{ uri: string; local: boolean }>
  files: File[][]
}

function build(hubs?: readonly HubRef[]): Built {
  const opened: Array<{ uri: string; local: boolean }> = []
  const files: File[][] = []
  const picker = new FilePicker({
    onOpen: (uri, source) => opened.push({ uri, local: source.kind === 'local' }),
    onOpenFiles: (chosen) => files.push([...chosen]),
    ...(hubs === undefined ? {} : { hubs }),
  })
  return { picker, el: picker.el, opened, files }
}

/** One hub, inline, so building the picker fetches nothing (§23.2). */
const DEMOS: HubRef = {
  id: 'demos',
  label: 'Demos',
  builtin: true,
  hub: {
    kind: HUB_KIND,
    version: HUB_VERSION,
    name: 'Demos',
    columns: [{ key: 'assembly', label: 'Assembly' }],
    entries: [
      {
        label: 'A published session',
        uri: 'https://data.example/demo/yeast/Yeast_microC.metacooler.json',
        kind: 'workspace',
        fields: { assembly: 'S288C' },
      },
      {
        label: 'A map on somebody else’s bucket',
        uri: 'https://4dn.example/a.mcool',
        kind: 'map',
      },
    ],
  },
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

  it('shows the hubs section when it is given hubs', () => {
    const { el } = build([DEMOS])
    expect(el.querySelector('.hubs-box')).not.toBeNull()
    expect(textsOf(el, '.hubs-box h3')).toEqual(['Hubs'])
    // The other way onto the same table (§23.4): a portal search form, which
    // fetches nothing until its button is pressed.
    expect(el.querySelector('.hubs-box .portal-search')).not.toBeNull()
    const select = el.querySelector('.hub-select') as HTMLSelectElement
    expect(select).not.toBeNull()
    // The placeholder, then one row per hub on offer. Still one line at any
    // length, which is what the table under it is not.
    expect(all(select, 'option')).toHaveLength(2)
  })

  /**
   * The header's `+` builds exactly this one, and the assertion is the whole of
   * why the prop is optional: everything a reader came for is still here, and
   * the catalogue of whole sessions is not.
   */
  it('leaves the hubs out when it is given none, and keeps the rest', () => {
    const { el } = build()
    expect(el.querySelector('.hubs-box')).toBeNull()
    expect(el.querySelector('.hub-table')).toBeNull()
    expect(all(el, '.dropzone')).toHaveLength(1)
    expect(all(el, '.remote-box')).toHaveLength(1)
  })

  /**
   * What a `?hub=` link lands on.
   *
   * `App.restore` builds a reference and hands it here, and the table loads it
   * without anybody touching the selector — a link is a gesture (§23.2). The
   * hub in this case is inline, so the assertion is about the wiring rather
   * than about a fetch.
   */
  it('lands on a hub it is handed, without a gesture in the page', () => {
    const built = build([DEMOS])
    expect(all(built.el, '.hub-name')).toHaveLength(0)
    built.picker.loadHub(DEMOS)
    expect(all(built.el, '.hub-name')).toHaveLength(2)
  })

  /**
   * A picked row leaves by the same door a typed URL leaves by.
   *
   * That is the property worth asserting rather than the click: `onOpen` with a
   * remote source is what `Session.openWithConfig` routes — a `.json` to
   * `openConfigUrl`, anything else to the file path — so a hub row that left by
   * some other door would be a second router to keep in step with the first.
   */
  it('opens a hub row as a remote file, by its absolute URI', () => {
    const built = build([DEMOS])
    // Chosen the way a reader chooses it, through the table's own selector.
    // The Demos hub is inline, so nothing is fetched (§23.2).
    const select = built.el.querySelector('.hub-select') as HTMLSelectElement
    select.value = 'demos'
    select.dispatchEvent(new Event('change'))
    const rows = all<HTMLButtonElement>(built.el, '.hub-name')
    expect(rows.map((row) => row.textContent)).toEqual([
      'A published session',
      'A map on somebody else’s bucket',
    ])
    rows[1].click()
    expect(built.opened).toEqual([
      { uri: 'https://4dn.example/a.mcool', local: false },
    ])
    // And a workspace row hands over its `.json` URL unchanged, which is what
    // `Session.openWithConfig` recognises as a session rather than a file.
    rows[0].click()
    expect(built.opened[1]).toEqual({
      uri: 'https://data.example/demo/yeast/Yeast_microC.metacooler.json',
      local: false,
    })
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
