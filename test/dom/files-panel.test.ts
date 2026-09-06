// @vitest-environment jsdom
/**
 * The Files panel: the folders this window is connected to, and their trees.
 *
 * What is worth pinning here is not that a listing draws — `bucket-browse` and
 * `browse-folders` own that between them — but the five things this column can
 * get wrong while every row on it looks right:
 *
 * - **Both verbs must reach the same place.** The `→` and a plain click on the
 *   row are the same instruction said two ways, and a reader who finds that one
 *   of them opens a file and the other does nothing has found a panel that
 *   cannot be trusted with the other rows either.
 * - **The arrow must not also be the row.** It is a button inside a clickable
 *   row, so a press that loaded the file twice — or that loaded it and then
 *   navigated — is the obvious failure and is invisible until it happens.
 * - **A drag has to carry the folder as well as the path.** The path alone is
 *   ambiguous the moment two folders are connected, and the file that opens
 *   would be the right name out of the wrong place.
 * - **Disconnecting has to take the listing with it.** A tree left on screen
 *   under a folder that has just been disconnected is a view of somewhere this
 *   app can no longer read, one click away from an error nobody can explain.
 * - **A folder that will not survive a reload must say so on the row.** A reader
 *   who finds that out tomorrow has been told at the wrong moment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilesCard } from '@/ui/FilesCard'
import { connectSnapshot, disconnectFolder } from '@/browse/connected'
import { writeScopes, type BucketScope } from '@/s3/credentials'
import { FILE_DRAG_TYPE, readFileDrag } from '@/ui/fileDrag'
import type { PickedFile } from '@/browse/folder'
import { all, mounted, textsOf, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const cards: FilesCard[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(async () => {
  for (const card of cards.splice(0)) card.destroy()
  // Both stores, or a folder connected in one test is still connected in the
  // next — the registry is module state and outlives a jsdom document.
  writeScopes([])
  for (const id of snapshotIds.splice(0)) await disconnectFolder(id)
  teardown()
  vi.unstubAllGlobals()
})

const snapshotIds: string[] = []
const BASE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/'

function scope(overrides: Partial<BucketScope> = {}): BucketScope {
  return {
    id: 'b0',
    label: 'lab collections',
    base: BASE,
    region: 'eu-west-3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    ...overrides,
  }
}

/** A `ListObjectsV2` body: sub-prefixes, keys, and whether S3 stopped early. */
function listing(folders: readonly string[], keys: ReadonlyArray<[string, number]>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    folders.map((prefix) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`).join('') +
    keys.map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`).join('') +
    `</ListBucketResult>`
  )
}

function serve(body: string): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(body) }),
  )
}

/** A `File` carrying the relative path a `webkitdirectory` input would give it. */
function fileAt(path: string): File {
  const file = new File(['xxxx'], path.split('/').pop() ?? path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

/** A card, its load calls, and the folder it was told to open. */
function card(options: { snapshot?: readonly string[] } = {}): {
  el: HTMLElement
  loaded: PickedFile[]
  connects: number
} {
  const loaded: PickedFile[] = []
  let connects = 0
  if (options.snapshot !== undefined) {
    const folder = connectSnapshot('run2', options.snapshot.map((path) => fileAt(`run2/${path}`)))
    snapshotIds.push(folder.id)
  }
  const made = new FilesCard({
    onLoad: (picked) => loaded.push(picked),
    onConnect: () => {
      connects++
    },
  })
  cards.push(made)
  made.showFirst()
  return {
    el: made.el,
    loaded,
    get connects() {
      return connects
    },
  }
}

describe('with nothing connected', () => {
  it('says so, and offers the one gesture that fixes it', () => {
    const { el } = card()
    expect(el.textContent).toContain('No folders connected')
    const connect = all<HTMLButtonElement>(el, '.files-actions .btn')[0]
    expect(connect.textContent).toBe('connect a folder…')
  })
})

describe('a connected bucket', () => {
  it('lists it, and draws the folder view under the folder list', async () => {
    serve(listing(['collections/hum53/'], [['collections/map.mcool', 4096]]))
    writeScopes([scope()])
    const { el } = card()

    expect(textsOf(el, '.files-folder-label')).toEqual(['lab collections'])
    await vi.waitFor(() =>
      expect(textsOf(el, '.folder-entry-name')).toEqual(['hum53/', 'map.mcool']),
    )
  })

  /**
   * A file this viewer has no route for is drawn and is inert.
   *
   * Hiding it would make the folder view disagree with the folder, which is the
   * one thing it is for.
   */
  it('draws what it cannot open, dimmed, with the reason on it', async () => {
    serve(listing([], [['collections/notes.txt', 10], ['collections/map.mcool', 10]]))
    writeScopes([scope()])
    const { el } = card()

    await vi.waitFor(() => expect(all(el, '.folder-entry')).toHaveLength(2))
    const inert = all(el, '.folder-entry-inert')
    expect(inert).toHaveLength(1)
    expect(inert[0].textContent).toContain('notes.txt')
    expect(inert[0].getAttribute('title')).toContain('Not a format this viewer opens')
    // No arrow on a row that cannot be loaded: a verb offered and refused is
    // worse than no verb.
    expect(all(inert[0], '.folder-entry-load')).toHaveLength(0)
  })

  it('offers a BAM, and explains the index sitting beside it', async () => {
    // The pair as a reader sees it in a bucket: one row to load, one row that
    // says what it is for. A `.bai` drawn as "not a format this viewer opens"
    // is one step from concluding the pair cannot be opened at all.
    serve(
      listing(
        [],
        [
          ['collections/reads.bam', 10],
          ['collections/reads.bam.bai', 10],
        ],
      ),
    )
    writeScopes([scope()])
    const { el } = card()

    await vi.waitFor(() => expect(all(el, '.folder-entry')).toHaveLength(2))
    const inert = all(el, '.folder-entry-inert')
    expect(inert).toHaveLength(1)
    expect(inert[0].textContent).toContain('reads.bam.bai')
    expect(inert[0].getAttribute('title')).toContain('BAM index')
  })
})

describe('the two verbs on a row', () => {
  async function rows(): Promise<ReturnType<typeof card>> {
    serve(listing([], [['collections/map.mcool', 4096]]))
    writeScopes([scope()])
    const made = card()
    await vi.waitFor(() => expect(all(made.el, '.folder-entry-file')).toHaveLength(1))
    return made
  }

  it('loads the file when the row is clicked', async () => {
    const { el, loaded } = await rows()
    mounted(el, () => all<HTMLElement>(el, '.folder-entry-file')[0].click())
    await vi.waitFor(() => expect(loaded).toHaveLength(1))
    expect(loaded[0].uri).toBe(`${BASE}map.mcool`)
    // Listed under a scope with a key, so it opens with that key rather than
    // with whatever a second lookup resolves.
    expect(loaded[0].source).toMatchObject({ kind: 'remote', credential: { region: 'eu-west-3' } })
  })

  it('loads it once — not twice — when the arrow is pressed', async () => {
    const { el, loaded } = await rows()
    // The arrow is a button inside a row that is itself clickable. Without the
    // guard in `folderBrowse.ts` this press would load the file twice.
    mounted(el, () => all<HTMLButtonElement>(el, '.folder-entry-load')[0].click())
    await vi.waitFor(() => expect(loaded).toHaveLength(1))
  })

  /**
   * And once when the click lands on the *glyph*, which is where a hand lands.
   *
   * The arrow's visible pixels are an inline `<svg>` and therefore an
   * `SVGElement`. A guard written against `HTMLElement` passes this test's
   * sibling above — which clicks the button itself — and fails here, loading
   * the file twice for every real press. `App.ts` records the identical mistake
   * costing a deck edge its drop.
   */
  it('loads it once when the click lands on the arrow’s glyph', async () => {
    const { el, loaded } = await rows()
    const glyph = all<HTMLButtonElement>(el, '.folder-entry-load')[0].querySelector('svg')
    expect(glyph).not.toBeNull()
    mounted(el, () => {
      glyph!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() => expect(loaded).toHaveLength(1))
  })

  it('loads it from the keyboard, since the row is not a real button', async () => {
    const { el, loaded } = await rows()
    const row = all<HTMLElement>(el, '.folder-entry-file')[0]
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('tabindex')).toBe('0')
    mounted(el, () => {
      row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => expect(loaded).toHaveLength(1))
  })
})

describe('dragging a row', () => {
  /**
   * The payload names the folder as well as the path.
   *
   * The path alone is ambiguous the moment two folders are connected, and what
   * would open is the right name out of the wrong place.
   */
  it('carries the folder and the path, and resolves back to the same file', async () => {
    const made = card({ snapshot: ['map.mcool'] })
    await vi.waitFor(() => expect(all(made.el, '.folder-entry-file')).toHaveLength(1))

    const data = new Map<string, string>()
    const transfer = {
      effectAllowed: '',
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      types: [...data.keys()],
    }
    const row = all<HTMLElement>(made.el, '.folder-entry-file')[0]
    const start = new window.Event('dragstart', { bubbles: true }) as DragEvent
    Object.defineProperty(start, 'dataTransfer', { value: transfer })
    mounted(made.el, () => row.dispatchEvent(start))

    const payload: unknown = JSON.parse(data.get(FILE_DRAG_TYPE) ?? '{}')
    expect(payload).toMatchObject({ path: 'map.mcool', name: 'map.mcool' })
    // The plain-text half is for other applications and is never read back here.
    expect(data.get('text/plain')).toBe('map.mcool')

    const drop = new window.Event('drop') as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    const picked = await readFileDrag(drop)
    expect(picked?.uri).toBe('map.mcool')
    expect(picked?.source.kind).toBe('local')
  })

  it('answers nothing for a payload whose folder is gone', async () => {
    const drop = new window.Event('drop') as DragEvent
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        getData: () => JSON.stringify({ folder: 'snap:nope', path: 'x.bw', name: 'x.bw' }),
      },
    })
    // A folder disconnected between the drag and the drop. There is one thing a
    // target does about it and this is it: nothing.
    expect(await readFileDrag(drop)).toBeNull()
  })

  it('answers nothing for a drag that is not ours', async () => {
    const drop = new window.Event('drop') as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => '' } })
    expect(await readFileDrag(drop)).toBeNull()
  })
})

describe('a folder that will not last', () => {
  it('says on the row that it is only for this visit', async () => {
    const made = card({ snapshot: ['map.mcool'] })
    await vi.waitFor(() => expect(all(made.el, '.folder-entry-file')).toHaveLength(1))
    expect(textsOf(made.el, '.files-folder-note')).toEqual(['this visit'])
    expect(all(made.el, '.files-folder-name')[0].getAttribute('title')).toContain('snapshot')
  })
})

describe('a bucket added from another screen', () => {
  /**
   * The Buckets dialog and the Connect dialog write the same `localStorage` key,
   * and neither knows this panel exists. Without the announce they share, a
   * reader who adds a bucket in one of them finds the Files panel still saying
   * *no folders connected* — and no gesture in the panel that would fix it.
   */
  it('appears in the panel without the panel being told by its host', async () => {
    serve(listing([], []))
    const { el } = card()
    expect(el.textContent).toContain('No folders connected')

    const { bucketForm } = await import('@/ui/bucketForm')
    const form = bucketForm({ onSaved: () => {} })
    document.body.appendChild(form)
    all<HTMLInputElement>(form, 'input')[1].value = BASE
    ;(form.querySelector('.btn-primary') as HTMLButtonElement).click()

    await vi.waitFor(() => expect(textsOf(el, '.files-folder-label')).toHaveLength(1))
    form.remove()
  })
})

describe('disconnecting', () => {
  it('takes the listing with it', async () => {
    serve(listing([], [['collections/map.mcool', 10]]))
    writeScopes([scope()])
    const { el } = card()
    await vi.waitFor(() => expect(all(el, '.folder-entry-file')).toHaveLength(1))

    mounted(el, () => all<HTMLButtonElement>(el, '.files-folder .btn-close')[0].click())
    await vi.waitFor(() => expect(el.textContent).toContain('No folders connected'))
    // A tree left on screen would be a view of somewhere this app can no longer
    // read, one click from an error nobody could explain.
    expect(all(el, '.folder-entry')).toHaveLength(0)
  })
})
