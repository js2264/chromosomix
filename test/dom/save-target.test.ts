// @vitest-environment jsdom
/**
 * Where an export goes (`ui/export.ts`): the platform's save dialog, opened in
 * Downloads with the name ready to change, and the plain download only where
 * there is no dialog to open.
 *
 * The dialog is stubbed — jsdom has none — so what is asserted is the contract
 * with it: what it is asked for, what a cancel does (nothing, and silently),
 * and that a dialog which refuses to open still leaves the reader their file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chooseSaveTarget, downloadBlob } from '@/ui/export'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let downloads: Array<{ name: string; blob: Blob }>
let restore: () => void

/** The anchor road: what the browser would have been handed as a download. */
function captureDownloads(): () => void {
  let pending: Blob | null = null
  const urls = URL as unknown as { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void }
  const realCreate = urls.createObjectURL
  const realRevoke = urls.revokeObjectURL
  const realClick = HTMLAnchorElement.prototype.click
  urls.createObjectURL = (blob) => {
    pending = blob
    return 'blob:test'
  }
  urls.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (pending !== null) downloads.push({ name: this.download, blob: pending })
    pending = null
  }
  return () => {
    urls.createObjectURL = realCreate
    urls.revokeObjectURL = realRevoke
    HTMLAnchorElement.prototype.click = realClick
  }
}

/** A save dialog that answers as told, and remembers what it was asked and given. */
function stubPicker(answer: { name: string } | DOMException) {
  const asked: unknown[] = []
  const written: Blob[] = []
  const scope = window as unknown as { showSaveFilePicker?: unknown }
  scope.showSaveFilePicker = (options: unknown) => {
    asked.push(options)
    if (answer instanceof DOMException) return Promise.reject(answer)
    return Promise.resolve({
      name: answer.name,
      createWritable: () =>
        Promise.resolve({
          write: (blob: Blob) => {
            written.push(blob)
            return Promise.resolve()
          },
          close: () => Promise.resolve(),
        }),
    })
  }
  return { asked, written }
}

beforeEach(() => {
  teardown = setUpDom()
  downloads = []
  restore = captureDownloads()
})

afterEach(() => {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
  restore()
  teardown()
})

describe('an export with a save dialog to open', () => {
  it('asks in Downloads, under the suggested name, and writes where the reader chose', async () => {
    const { asked, written } = stubPicker({ name: 'my figure.png' })
    const target = await chooseSaveTarget('map-20260924-300dpi.png', 'image/png')
    expect(asked).toEqual([
      {
        suggestedName: 'map-20260924-300dpi.png',
        startIn: 'downloads',
        types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
      },
    ])
    // The reader's name, not the suggested one: it is what a card says it saved.
    expect(target?.name).toBe('my figure.png')
    const blob = new Blob(['x'], { type: 'image/png' })
    await target?.write(blob)
    expect(written).toEqual([blob])
    // …and nothing through the download road as well.
    expect(downloads).toHaveLength(0)
  })

  it('writes nothing, and says nothing, when the reader cancels', async () => {
    stubPicker(new DOMException('The user aborted a request.', 'AbortError'))
    expect(await chooseSaveTarget('marks.bed', 'text/plain')).toBeNull()
    expect(await downloadBlob(new Blob(['x']), 'marks.bed')).toBeNull()
    expect(downloads).toHaveLength(0)
  })

  it('still hands the file over when the dialog will not open', async () => {
    // What a browser says when the press is too long ago to open one.
    stubPicker(new DOMException('Must be handling a user gesture.', 'SecurityError'))
    expect(await downloadBlob(new Blob(['x'], { type: 'text/plain' }), 'marks.bed')).toBe('marks.bed')
    expect(downloads.map((d) => d.name)).toEqual(['marks.bed'])
  })

  it('leaves the type filter out for a name the dialog would not take', async () => {
    const { asked } = stubPicker({ name: 'notes' })
    await chooseSaveTarget('notes', 'text/plain')
    expect(asked).toEqual([{ suggestedName: 'notes', startIn: 'downloads' }])
  })
})

describe('an export with no save dialog', () => {
  it('downloads under the suggested name, as it always did', async () => {
    expect(await downloadBlob(new Blob(['x'], { type: 'text/plain' }), 'marks.bed')).toBe('marks.bed')
    expect(downloads.map((d) => d.name)).toEqual(['marks.bed'])
  })
})
