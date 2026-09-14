// @vitest-environment jsdom
/**
 * The stores this browser keeps, and the one rule about them that is a promise.
 *
 * A remembered store is a row under the app's own `localStorage` prefix, which is
 * what makes the stored-data screen able to name it and *forget everything*
 * able to sweep it without knowing it exists (§24.2). Everything below is about
 * the two ways that quietly stops being true: a row that survives a reload as
 * something other than what was written, and an id that gets reused.
 *
 * The subscription is the third thing, and it is not decoration: the table that
 * shows the menu is the same element the reader presses *remember* in, so a
 * list refreshed only on reload would leave the store they just kept missing from
 * the menu they kept it in.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PREFIX } from '@/state/stored'
import {
  addStoreRow,
  readStoreRows,
  rememberedStores,
  removeStoreRow,
  subscribeStores,
} from '@/state/stores'

const KEY = `${PREFIX}stores`

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('remembered stores', () => {
  it('is empty before anything is kept', () => {
    expect(readStoreRows()).toEqual([])
    expect(rememberedStores()).toEqual([])
  })

  it('round-trips a row through storage', () => {
    const added = addStoreRow({ label: 'Lab shelf', url: 'https://lab.example/store.json' })
    expect(added).toEqual({ id: 'store:1', label: 'Lab shelf', url: 'https://lab.example/store.json' })
    expect(readStoreRows()).toEqual([added])
    // Under the app's own prefix, which is the whole of what makes the sweep in
    // `state/stored.ts` cover this without naming it.
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
  })

  it('gives each new row an id nothing else has had', () => {
    addStoreRow({ label: 'one', url: 'https://a.example/store.json' })
    addStoreRow({ label: 'two', url: 'https://b.example/store.json' })
    removeStoreRow('store:1')
    const third = addStoreRow({ label: 'three', url: 'https://c.example/store.json' })
    // Not `store:1` again. Ids are counted from the highest in use rather than
    // from the list's length, so a `?store=` bookmark cannot come to name a
    // different shelf than it was written against.
    expect(third.id).toBe('store:3')
    expect(readStoreRows().map((row) => row.id)).toEqual(['store:2', 'store:3'])
  })

  it('treats the same URL twice as one row, and takes the newer label', () => {
    const first = addStoreRow({ label: 'old name', url: 'https://lab.example/store.json' })
    const again = addStoreRow({ label: 'new name', url: 'https://lab.example/store.json' })
    expect(again.id).toBe(first.id)
    expect(readStoreRows()).toEqual([{ id: first.id, label: 'new name', url: 'https://lab.example/store.json' }])
  })

  it('falls back to the URL when there is no label to show', () => {
    expect(addStoreRow({ label: '', url: 'https://lab.example/store.json' }).label).toBe(
      'https://lab.example/store.json',
    )
  })

  it('removes one, and says nothing about an id that is already gone', () => {
    addStoreRow({ label: 'one', url: 'https://a.example/store.json' })
    addStoreRow({ label: 'two', url: 'https://b.example/store.json' })
    removeStoreRow('store:1')
    expect(readStoreRows().map((row) => row.label)).toEqual(['two'])
    expect(() => removeStoreRow('store:99')).not.toThrow()
    expect(readStoreRows()).toHaveLength(1)
  })

  it('drops a stored row that cannot be used rather than repairing it', () => {
    // Stored state outlives the build that wrote it, so this is untrusted input
    // exactly like the URL hash. A row with no URL would be a menu entry that
    // fails when it is pressed, and a `javascript:` one is a value about to be
    // handed to `fetch`.
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 'store:1', label: 'good', url: 'https://a.example/store.json' },
        { id: '', label: 'no id', url: 'https://b.example/store.json' },
        { id: 'store:3', label: 'no url' },
        { id: 'store:4', label: 'not fetchable', url: 'javascript:alert(1)' },
        { id: 'store:1', label: 'duplicate id', url: 'https://e.example/store.json' },
        'not an object',
      ]),
    )
    expect(readStoreRows()).toEqual([
      { id: 'store:1', label: 'good', url: 'https://a.example/store.json' },
    ])
  })

  it('survives a stored value that is not a list at all', () => {
    for (const raw of ['{}', 'not json', '"a string"', '7']) {
      window.localStorage.setItem(KEY, raw)
      expect(readStoreRows(), raw).toEqual([])
    }
  })

  it('offers them as references that are not built in', () => {
    addStoreRow({ label: 'Lab shelf', url: 'https://lab.example/store.json' })
    expect(rememberedStores()).toEqual([
      { id: 'store:1', label: 'Lab shelf', url: 'https://lab.example/store.json', builtin: false },
    ])
  })
})

describe('subscribing to them', () => {
  it('hears an add and a remove, and stops when it unsubscribes', () => {
    let heard = 0
    const off = subscribeStores(() => {
      heard++
    })
    addStoreRow({ label: 'one', url: 'https://a.example/store.json' })
    expect(heard).toBe(1)
    removeStoreRow('store:1')
    expect(heard).toBe(2)
    off()
    addStoreRow({ label: 'two', url: 'https://b.example/store.json' })
    expect(heard).toBe(2)
  })

  it('says nothing when a remove removed nothing', () => {
    // A repaint costs a rebuilt `<select>`, which loses the selection under a
    // reader who is choosing; an id that was not there is not a change.
    let heard = 0
    const off = subscribeStores(() => {
      heard++
    })
    removeStoreRow('store:99')
    expect(heard).toBe(0)
    off()
  })
})
