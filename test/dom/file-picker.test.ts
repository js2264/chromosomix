// @vitest-environment jsdom
/**
 * The landing page, and the load box the two dialogs are made of.
 *
 * Three things are on the page and they are named: **Load files**, **Connect a
 * local or remote folder** and **Connect to a data store**. What the tests
 * below pin is that each is exactly one thing — one drop area with one URL
 * box, one row of place buttons, one row of tiles — and that neither row costs
 * a request: both are descriptions, and pressing one is a gesture rather than
 * a fetch (§24.2). Where those gestures go is the other half: *choose a
 * folder…* is the directory picker itself, because it is one gesture and the
 * browser draws it, while the three that need a form or a sign-in are doors to
 * the Connect dialog. The rest is what the box owes a reader whatever door
 * they came through: a drop target that also takes a click, and a box for a
 * URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilePicker } from '@/ui/FilePicker'
import { LoadBox } from '@/ui/LoadBox'
import type { ProviderId } from '@/ui/connectFronts'
import { connectedFolders, disconnectFolder } from '@/browse/connected'
import { icon } from '@/ui/icons'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

// A site built with both registrations, which is what a published site is and
// what the row of four is a row of: a sign-in the site cannot make loses its
// button here (`ui/connectFronts.ts`, §24.2), and the test runner makes no
// build-time define, so without this the row would be two.
vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: {
    googleClientId: 'test.apps.googleusercontent.com',
    googleApiKey: null,
    dropboxAppKey: 'a1b2c3d4e5f6g7h',
  },
}))

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  // A browser that can hold a directory, which is what decides the first
  // button's wording; the test below takes it away again to check the other.
  vi.stubGlobal('showDirectoryPicker', async () => null)
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
  connected: string[]
}

function build(withDoors = true): Built {
  const opened: Array<{ uri: string; local: boolean }> = []
  const files: File[][] = []
  const stores: string[] = []
  const places: string[] = []
  const connected: string[] = []
  const picker = new FilePicker({
    onOpen: (uri, source) => opened.push({ uri, local: source.kind === 'local' }),
    onOpenFiles: (chosen) => files.push([...chosen]),
    ...(withDoors
      ? {
          onStore: (id: string) => stores.push(id),
          onConnect: (provider: ProviderId) => places.push(provider),
          onConnected: (id: string) => connected.push(id),
        }
      : {}),
  })
  return { picker, el: picker.el, opened, files, stores, places, connected }
}

/** Let the picker's promise and the callback behind it settle. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
      // One verb for one act: *mount* was this heading's word alone, over
      // buttons that said connect and a dialog that said open (§26.4).
      'Connect a local or remote folder',
      'Connect to a data store',
    ])
    // Each heading leads with a mark, because three bold lines in one column
    // read as one section with emphasis in it rather than as three doors.
    expect(all(el, '.picker-heading > .picker-heading-mark')).toHaveLength(3)
    // And the masthead is the name alone: the tagline said in eight words what
    // the three headings under it say in nine, and cost a line of the fold.
    expect(all(el, '.picker-tagline')).toHaveLength(0)
    expect(all(el, '.dropzone')).toHaveLength(1)
    expect(all(el, '.input-url')).toHaveLength(1)
    expect(buttonNamed(el, 'open')).not.toBeNull()
    // No *choose files* button: clicking the drop area opens the same dialog,
    // and the same action drawn twice is a choice that does not exist.
    expect(buttonNamed(el, 'choose files…')).toBeNull()
    // The catalogue that used to stand beside the box is gone: it was a store.
    expect(buttonNamed(el, 'browse…')).toBeNull()
    expect(buttonNamed(el, 'private buckets…')).toBeNull()
  })

  it('is one target with the URL box under it, and says two things and no more', () => {
    const { el } = build()
    const drop = el.querySelector('.dropzone') as HTMLElement
    expect(drop).not.toBeNull()
    // Both things the target does are written on it, because it is the only
    // control here: a click opens the file dialog a *choose files* button used
    // to, and that button is gone rather than duplicating it.
    expect(textsOf(drop, '.dropzone-title')).toEqual(['Drop genomic files here'])
    expect(textsOf(drop, '.dropzone-sub')).toEqual(['or click to choose'])
    // And nothing else. The paragraph about what opens as what, and the glyph
    // over it, are what kept the three ways in from fitting on one screen.
    expect(drop.querySelector('.dropzone-note')).toBeNull()
    expect(drop.querySelector('.dropzone-mark')).toBeNull()
    expect(drop.children).toHaveLength(2)
    // The URL box is the other way in, under the rule that says so.
    const box = el.querySelector('.load-box') as HTMLElement
    const parts = [...box.children].map((node) => node.className)
    expect(parts).toEqual(['dropzone', 'load-or', 'load-row'])
    expect(textsOf(box, '.load-or')).toEqual(['or a URL'])
  })

  it('carries the marked button the Connect dialog’s panes are pressed by', () => {
    // "The buttons should be styled the same way the ones in the modal": one
    // shape for one gesture, wherever a reader meets it (`ui/icons.ts`).
    const { el } = build()
    expect(all(el, '.picker-provider')).toHaveLength(4)
    expect(all(el, '.picker-provider').every((node) => node.classList.contains('btn-mark'))).toBe(true)
  })

  it('offers the four places as buttons, and sends the three with a form to the dialog', () => {
    const built = build()
    expect(textsOf(built.el, '.picker-provider')).toEqual([
      'choose a folder…',
      'connect a bucket…',
      'sign in to Google…',
      'sign in to Dropbox…',
    ])
    const buttons = all<HTMLButtonElement>(built.el, '.picker-provider')
    buttons[1].click()
    buttons[3].click()
    // The id, not the form: what follows a press there is a bucket's two
    // policies or a sign-in with a code to paste, and both are the dialog's.
    expect(built.places).toEqual(['bucket', 'dropbox'])
  })

  it('opens the directory picker on *choose a folder…* rather than a dialog about one', () => {
    // One gesture, drawn by the browser: a dialog in front of it would be
    // asking the reader to press the same words twice.
    const handle = { kind: 'directory', name: 'maps' }
    const asked = vi.fn(async (options: unknown) => {
      void options
      return handle
    })
    vi.stubGlobal('showDirectoryPicker', asked)
    const built = build()
    ;(all<HTMLButtonElement>(built.el, '.picker-provider')[0]).click()
    expect(asked).toHaveBeenCalledTimes(1)
    // Asked for read access and nothing wider (§13).
    expect(asked.mock.calls[0][0]).toEqual({ mode: 'read' })
    // Nothing went to the dialog: this place is not one of its errands.
    expect(built.places).toEqual([])
  })

  it('hands the connected folder up, because a folder is the window’s and not this tab’s', async () => {
    const handle = { kind: 'directory', name: 'maps' }
    vi.stubGlobal('showDirectoryPicker', async () => handle)
    const built = build()
    ;(all<HTMLButtonElement>(built.el, '.picker-provider')[0]).click()
    await settled()
    expect(built.connected).toHaveLength(1)
    const [id] = built.connected
    // The id names a folder the window is now connected to — the same thing
    // the Connect dialog's own panes answer with.
    expect(connectedFolders().map((folder) => folder.id)).toContain(id)
    await disconnectFolder(id)
  })

  it('says nothing happened when the picker is cancelled', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => {
      throw new DOMException('cancelled', 'AbortError')
    })
    const built = build()
    ;(all<HTMLButtonElement>(built.el, '.picker-provider')[0]).click()
    await settled()
    expect(built.connected).toEqual([])
    expect(built.places).toEqual([])
  })

  it('says *this visit* on the button where a browser cannot keep the folder', () => {
    // Firefox and Safari have no picker; what they give is a snapshot of the
    // file list that does not survive a reload, and the label is the only
    // place a reader is told so before pressing (§20).
    vi.unstubAllGlobals()
    const { el } = build()
    expect(textsOf(el, '.picker-provider')[0]).toBe('choose a folder (this visit)…')
  })

  it('offers the six shipped stores as tiles, then the two doors', () => {
    const { el } = build()
    // The DNA Bacterial Zoo is a dev feature (§29), and the switch is off here.
    expect(textsOf(el, '.store-tile .store-tile-name')).toEqual([
      'RSG lab data',
      'IGV genomes',
      '4DN open data',
      'ENCODE',
      'DNA Zoo',
      'Roadmap (UCSC hub)',
      // The two doors, always last and always in this order: far more of the
      // world's published data is behind a hub than behind a store file
      // written for this viewer (§24.10).
      'Connect to a UCSC hub',
      'Add a custom store',
    ])
    // Every tile is a mark and a line, not a request.
    expect(all(el, '.store-tile .store-mark')).toHaveLength(8)
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
    // A shipped one in the middle, then the two doors — which stay last, in
    // that order, however many are shipped in front of them.
    tiles[2].click()
    tiles[tiles.length - 2].click()
    tiles[tiles.length - 1].click()
    expect(built.stores).toEqual(['4dn', 'hub', 'custom'])
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
    // The dialogs get the same two ways in, and the same two lines on the
    // target: it is the box's, so every door a file is asked for is the one
    // door drawn once.
    expect(box.el.querySelector('.dropzone > .dropzone-note')).toBeNull()
    expect(textsOf(box.el, '.dropzone-title')).toEqual(['Drop genomic files here'])
    expect(textsOf(box.el, '.load-or')).toEqual(['or a URL'])
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
