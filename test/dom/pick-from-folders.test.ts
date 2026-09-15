// @vitest-environment jsdom
/**
 * Picking a file out of a connected place, from a box that takes a URL.
 *
 * The dialog behind the four `from a connected place…` buttons. Three things
 * are worth pinning: it lists every place the window is connected to and not
 * only buckets, a pick hands back the `PickedFile` the Files column would and
 * closes the dialog, and with nothing connected it says so and names the Files
 * column's button rather than offering an empty listing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectSnapshot, disconnectFolder } from '@/browse/connected'
import type { PickedFile } from '@/browse/folder'
import { writeScopes, type BucketScope } from '@/s3/credentials'
import { folderPickButton, pickFromFolders } from '@/ui/pickFromFolders'
import { all, buttonNamed, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const snapshotIds: string[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(async () => {
  writeScopes([])
  for (const id of snapshotIds.splice(0)) await disconnectFolder(id)
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
  teardown()
  vi.unstubAllGlobals()
})

const BASE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/'

function scope(): BucketScope {
  return {
    id: 'b0',
    label: 'lab collections',
    base: BASE,
    region: 'eu-west-3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  }
}

function listing(keys: ReadonlyArray<[string, number]>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    keys.map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`).join('') +
    `</ListBucketResult>`
  )
}

/** A `File` carrying the relative path a `webkitdirectory` input would give it. */
function fileAt(path: string): File {
  const file = new File(['xxxx'], path.split('/').pop() ?? path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

function dialog(): { body: HTMLElement; picked: PickedFile[] } {
  const picked: PickedFile[] = []
  pickFromFolders({ onPick: (file) => picked.push(file) })
  const body = document.querySelector<HTMLElement>('.pick-body')
  expect(body).not.toBeNull()
  return { body: body as HTMLElement, picked }
}

describe('with nothing connected', () => {
  it('says so, and names the Files column’s button rather than listing nothing', () => {
    const { body } = dialog()
    expect(body.textContent).toContain('Nothing is connected yet')
    expect(body.textContent).toContain('Open a local/remote folder')
    expect(all(body, '.pick-place')).toHaveLength(0)
  })
})

describe('with places connected', () => {
  it('lists a folder on this machine beside a bucket, and opens on the first', async () => {
    const folder = connectSnapshot('run2', [fileAt('run2/sample.mcool'), fileAt('run2/notes.txt')])
    snapshotIds.push(folder.id)
    writeScopes([scope()])
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(listing([[`collections/hum53.mcool`, 12]])) }),
    )
    const { body, picked } = dialog()
    expect(all(body, '.pick-place').map((node) => node.textContent?.trim())).toEqual([
      'run2',
      'lab collections',
    ])
    await vi.waitFor(() => expect(all(body, '.folder-entry-file').length).toBe(1))
    // A row the viewer has no route for is drawn and inert, as in the column.
    expect(all(body, '.folder-entry-inert')).toHaveLength(1)
    ;(all<HTMLElement>(body, '.folder-entry-file')[0]).click()
    await vi.waitFor(() => expect(picked).toHaveLength(1))
    expect(picked[0].source.kind).toBe('local')
    expect(picked[0].uri).toBe('sample.mcool')
    // …and the dialog is gone with the pick.
    expect(document.querySelector('.pick-body')).toBeNull()
  })

  it('browses the bucket when its place is pressed, and picks with the scope’s key', async () => {
    writeScopes([scope()])
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(listing([[`collections/hum53.mcool`, 12]])) }),
    )
    const { body, picked } = dialog()
    await vi.waitFor(() => expect(all(body, '.folder-entry-file').length).toBe(1))
    ;(all<HTMLElement>(body, '.folder-entry-file')[0]).click()
    await vi.waitFor(() => expect(picked).toHaveLength(1))
    expect(picked[0].uri).toBe(`${BASE}hum53.mcool`)
    expect(picked[0].source.kind).toBe('remote')
    expect(picked[0].source.kind === 'remote' && picked[0].source.credential?.accessKeyId).toBe(
      'AKIAIOSFODNN7EXAMPLE',
    )
  })
})

describe('the button beside a URL box', () => {
  it('opens the dialog, whatever is connected', () => {
    const node = folderPickButton(() => undefined)
    document.body.appendChild(node)
    expect(node.textContent).toBe('from a connected place…')
    node.click()
    expect(document.querySelector('.pick-body')).not.toBeNull()
    expect(buttonNamed(document.body, 'from a connected place…')).toBe(node)
  })
})
