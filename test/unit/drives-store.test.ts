// @vitest-environment jsdom
/**
 * The Drive folders this browser keeps, and the one rule about them that is a
 * promise.
 *
 * A connected Drive folder is a row under the app's own `localStorage` prefix,
 * which is what makes the stored-data screen able to name it and *forget
 * everything* able to sweep it without knowing it exists (SPECS §24.2, §24.7).
 * Everything below is about the ways that quietly stops being true: a row that
 * survives a reload as something other than what was written, an id that gets
 * reused, and a line on the stored-data screen that says less than what is
 * actually held.
 *
 * {@link folderIdFrom} gets the longest run of cases because it is the only
 * place in this feature where a reader's typing becomes an address. A link it
 * misreads is not a wrong answer the reader can see — it is a folder in the
 * panel that 404s when it is clicked, three screens away from the box that
 * caused it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PREFIX } from '@/state/stored'
import {
  addDriveRow,
  folderIdFrom,
  readDriveRows,
  removeDriveRow,
  storedLines,
  subscribeDrives,
} from '@/state/drives'

const KEY = `${PREFIX}drives`

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('connected Drive folders', () => {
  it('is empty before anything is connected', () => {
    expect(readDriveRows()).toEqual([])
    expect(storedLines()).toEqual([])
  })

  it('keeps a folder under the app’s prefix and reads it back whole', () => {
    const row = addDriveRow({ label: 'Run 2024', folderId: '1AbCdEf' })
    expect(row).toEqual({ id: 'drive:1', label: 'Run 2024', folderId: '1AbCdEf' })
    // Under the prefix, which is what makes the sweep in `state/stored.ts` a
    // promise rather than a list somebody has to remember to add to.
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
    expect(readDriveRows()).toEqual([row])
  })

  /**
   * Ids are minted from the highest in use, never from the length.
   *
   * A length-based id hands a new folder the id of one that was just
   * disconnected, and the Files panel remembers its last folder by id — so the
   * next reload would open somebody else's Drive under a name the reader chose
   * for something else.
   */
  it('never reissues the id of a folder that was disconnected', () => {
    addDriveRow({ label: 'One', folderId: '1One' })
    const two = addDriveRow({ label: 'Two', folderId: '1Two' })
    expect(two.id).toBe('drive:2')

    removeDriveRow('drive:1')
    expect(addDriveRow({ label: 'Three', folderId: '1Three' }).id).toBe('drive:3')
  })

  it('connects one folder once, and lets the newer name win', () => {
    const first = addDriveRow({ label: 'My Drive', folderId: 'root' })
    const again = addDriveRow({ label: 'Everything', folderId: 'root' })
    expect(again.id).toBe(first.id)
    expect(readDriveRows()).toEqual([{ id: 'drive:1', label: 'Everything', folderId: 'root' }])
  })

  it('names an unlabelled folder by its id rather than leaving a blank row', () => {
    expect(addDriveRow({ label: '   ', folderId: '1AbCdEf' }).label).toBe('1AbCdEf')
  })

  it('forgets one, and says nothing about an id that is already gone', () => {
    addDriveRow({ label: 'One', folderId: '1One' })
    removeDriveRow('drive:1')
    expect(readDriveRows()).toEqual([])
    expect(() => removeDriveRow('drive:1')).not.toThrow()
  })

  /**
   * Stored state outlives the build that wrote it, so a row is dropped rather
   * than repaired: the repair for a missing folder id is a row in the panel that
   * answers a refusal when it is clicked, which is worse than the row being
   * absent.
   */
  it('drops a stored row that is not a folder, and keeps the ones that are', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 'drive:1', label: 'Good', folderId: '1Good' },
        { id: 'drive:2', label: 'No folder' },
        { label: 'No id', folderId: '1Orphan' },
        { id: 'drive:1', label: 'Duplicate id', folderId: '1Other' },
        'not a row',
        null,
      ]),
    )
    expect(readDriveRows()).toEqual([{ id: 'drive:1', label: 'Good', folderId: '1Good' }])
  })

  it('reads nothing out of a key that is not JSON, or not a list', () => {
    window.localStorage.setItem(KEY, '{oh no')
    expect(readDriveRows()).toEqual([])
    window.localStorage.setItem(KEY, '{"id":"drive:1"}')
    expect(readDriveRows()).toEqual([])
  })

  it('tells the dialog and the panel at once that the list changed', () => {
    let heard = 0
    const off = subscribeDrives(() => {
      heard++
    })
    addDriveRow({ label: 'One', folderId: '1One' })
    expect(heard).toBe(1)
    removeDriveRow('drive:1')
    expect(heard).toBe(2)

    off()
    addDriveRow({ label: 'Two', folderId: '1Two' })
    expect(heard).toBe(2)
  })
})

describe('what the stored-data screen is told', () => {
  /**
   * Named rather than counted, and the missing half named too.
   *
   * A Drive folder is somewhere the reader connected to, so the labels are the
   * part worth reading back before deciding what to do on a borrowed machine
   * (the rule the folders and the stores already follow). And the line says what
   * is *not* here: the token that lists these folders is held in memory and
   * never written (§24.8), so a reader who reads this line has been told the
   * whole of what is on the disk.
   */
  it('names the folders, and says no token is kept with them', () => {
    addDriveRow({ label: 'Run 2024', folderId: '1AbCdEf' })
    addDriveRow({ label: 'My Drive', folderId: 'root' })
    const lines = storedLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].label).toBe('Drive folders you connected')
    expect(lines[0].detail).toContain('Run 2024')
    expect(lines[0].detail).toContain('My Drive')
    expect(lines[0].detail).toMatch(/no token is kept/i)
  })

  it('prints no folder id, because a name is what a reader recognises', () => {
    addDriveRow({ label: 'Run 2024', folderId: '1AbCdEf' })
    expect(storedLines()[0].detail).not.toContain('1AbCdEf')
  })
})

describe('the folder id in what was pasted', () => {
  it('takes the address bar of a folder, with or without the account segment', () => {
    expect(folderIdFrom('https://drive.google.com/drive/folders/1AbCdEf')).toBe('1AbCdEf')
    expect(folderIdFrom('https://drive.google.com/drive/u/0/folders/1AbCdEf')).toBe('1AbCdEf')
  })

  it('drops the query the Share button adds, and anything after the id', () => {
    const shared = 'https://drive.google.com/drive/folders/1AbCdEf?usp=sharing'
    expect(folderIdFrom(shared)).toBe('1AbCdEf')
    expect(folderIdFrom('https://drive.google.com/drive/folders/1AbCdEf/')).toBe('1AbCdEf')
  })

  it('takes a bare id, and the whitespace around a pasted one', () => {
    expect(folderIdFrom('1AbCdEf')).toBe('1AbCdEf')
    expect(folderIdFrom('  1AbCdEf \n')).toBe('1AbCdEf')
  })

  it('reads an empty box as My Drive, which is what Drive calls root', () => {
    // The one folder nobody has a link to copy: a reader who wants their whole
    // Drive has nothing to paste, so the empty box is the gesture.
    expect(folderIdFrom('')).toBe('root')
    expect(folderIdFrom('   ')).toBe('root')
    expect(folderIdFrom('https://drive.google.com/drive/u/0/my-drive')).toBe('root')
  })

  /**
   * A file link is the refusal that matters.
   *
   * Passed through as an id it would list the *file's* children, which is
   * nothing, and an empty folder is the one refusal a reader cannot tell from a
   * mistake of their own. `sources/rewrite.ts` is where a file link belongs and
   * it already opens one.
   */
  it('refuses a link that is not a folder rather than guessing', () => {
    expect(folderIdFrom('https://drive.google.com/file/d/1AbCdEf/view')).toBeNull()
    expect(folderIdFrom('https://example.org/drive/folders/1AbCdEf')).toBeNull()
    expect(folderIdFrom('not a link, not an id')).toBeNull()
    expect(folderIdFrom('https://drive.google.com/')).toBeNull()
  })
})
