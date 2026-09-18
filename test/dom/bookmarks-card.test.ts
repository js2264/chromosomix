// @vitest-environment jsdom
/**
 * The Bookmarks card (§8.10): three ways in, and one way out.
 *
 * What is worth asserting here is the *card's* half of the feature, which is
 * everything except the navigation itself. Three of them matter.
 *
 * **The row is a button.** A saved place is the one card row whose primary act is
 * a navigation, and it has to be reachable by clicking the row rather than by
 * hitting a fourteen-pixel arrow — so the test presses the row and expects the
 * shell to be asked to go, with the *whole* bookmark and not a re-parsed copy of
 * its label.
 *
 * **Nothing is silent.** Every way in can fail — a coordinate that does not
 * parse, a picture that is not at one place, a BED with nothing in it, a place
 * already saved — and each of those has to say so, because all four are a press
 * that would otherwise appear to do nothing.
 *
 * **The grain travels.** A bookmark taken while the map is at 10 kb records 10 kb;
 * one imported from a BED records none, because a file of intervals says where and
 * not how closely. That is the difference between giving back a picture and giving
 * back a coordinate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BookmarkStore, type Bookmark } from '@/annotations/bookmarks'
import { BookmarksCard } from '@/ui/BookmarksCard'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
})

afterEach(() => {
  teardown()
  window.sessionStorage.clear()
})

interface Mounted {
  card: BookmarksCard
  store: BookmarkStore
  went: Bookmark[]
  /** What the map claims to be showing; `null` is "not at one place". */
  framed: { contig: string; start: number; end: number; wrapped?: boolean } | null
  binsize: number | null
  available: boolean
  rows(): string[]
  note(): string | null
  press(text: string): void
  type(value: string): void
  goRow(match: string): void
  fileInput(): HTMLInputElement
}

function mount(): Mounted {
  const store = new BookmarkStore('k')
  // The three things a test moves under the card, held in a box the closures read
  // through: the card is built once per file and asks the shell for these on every
  // press, which is exactly the coupling being exercised.
  const map = {
    framed: { contig: 'II', start: 120000, end: 180000 } as Mounted['framed'],
    binsize: 10000 as number | null,
    available: true,
  }
  const went: Bookmark[] = []
  const card = new BookmarksCard({
    store,
    go: (mark) => went.push(mark),
    available: () => map.available,
    framed: () => map.framed,
    binsize: () => map.binsize,
  })
  document.body.appendChild(card.el)
  const root = card.el

  return {
    card,
    store,
    went,
    get framed() {
      return map.framed
    },
    set framed(next: Mounted['framed']) {
      map.framed = next
    },
    get binsize() {
      return map.binsize
    },
    set binsize(next: number | null) {
      map.binsize = next
    },
    get available() {
      return map.available
    },
    set available(next: boolean) {
      map.available = next
    },
    rows: () =>
      Array.from(root.querySelectorAll('.bookmark-row')).map((row) =>
        (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    note: () => {
      const node = root.querySelector('.ann-note')
      return node !== null && !node.classList.contains('hidden') ? node.textContent : null
    },
    press: (text) => {
      const node = Array.from(root.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === text,
      )
      if (node === undefined) throw new Error(`no button called ${text}`)
      node.click()
    },
    type: (value) => {
      const input = root.querySelector<HTMLInputElement>('input[type=text]')
      if (input === null) throw new Error('no coordinate box')
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    goRow: (match) => {
      const row = Array.from(root.querySelectorAll('.bookmark-row')).find((node) =>
        (node.textContent ?? '').includes(match),
      )
      if (row === undefined) throw new Error(`no row matching ${match}`)
      row.querySelector<HTMLButtonElement>('.bookmark-go')?.click()
    },
    fileInput: () => {
      const input = root.querySelector<HTMLInputElement>('input[type=file]')
      if (input === null) throw new Error('no file input')
      return input
    },
  }
}

/** A `File` whose `text()` resolves — jsdom's own does not, under node's Blob. */
function bedFile(name: string, body: string): File {
  const file = new File([body], name)
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(body) })
  return file
}

/** Hand a `File` to a hidden input, as choosing one in the picker does. */
function choose(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  // The read is a promise; one turn of the microtask queue is enough.
  return Promise.resolve().then(() => Promise.resolve())
}

describe('saving a place', () => {
  it('takes coordinates that were typed, with the resolution the map is at', () => {
    const app = mount()
    app.type('II:900,000-960,000')
    app.press('add')
    expect(app.store.marks).toEqual([
      { id: expect.any(String), label: '', contig: 'II', start: 900000, end: 960000, binsize: 10000 },
    ])
    expect(app.rows()).toHaveLength(1)
  })

  it('marks a coordinate that did not parse instead of adding nothing quietly', () => {
    const app = mount()
    app.type('somewhere in the middle')
    app.press('add')
    expect(app.store.marks).toEqual([])
    expect(app.card.el.querySelector('input[type=text]')?.classList.contains('is-bad')).toBe(true)
    // …and clears the mark once it does parse.
    app.type('II:1-2')
    app.press('add')
    expect(app.card.el.querySelector('input[type=text]')?.classList.contains('is-bad')).toBe(false)
  })

  it('takes the window on screen, from the card and from the title line alike', () => {
    const app = mount()
    app.press('this view')
    expect(app.store.marks[0]).toMatchObject({ contig: 'II', start: 120000, end: 180000 })
    app.framed = { contig: 'II', start: 300000, end: 320000 }
    // The button beside `go` calls the same method, which is why it is public.
    app.card.saveFramed()
    expect(app.store.marks).toHaveLength(2)
    expect(app.store.marks[1]).toMatchObject({ start: 300000, end: 320000 })
  })

  it('says why it cannot, rather than doing nothing', () => {
    const app = mount()
    app.framed = null
    app.press('this view')
    expect(app.store.marks).toEqual([])
    expect(app.note()).toMatch(/not at one place/)

    app.available = false
    app.card.saveFramed()
    expect(app.note()).toMatch(/No map is open/)
  })

  it('refuses a window across a circular sequence’s origin, and says which', () => {
    // §8.15: on a declared circle the window on screen can run off the end of
    // the sequence and back on at its start. That is one place and it cannot be
    // written as one — a BED interval whose end is below its start is not a BED
    // interval — so the sentence has to be about the junction rather than the
    // "not at one place" one, which would tell a reader looking at a single
    // sequence that they are not.
    const app = mount()
    app.framed = { contig: 'chr', start: 4_500_000, end: 150_000, wrapped: true }
    app.press('this view')
    expect(app.store.marks).toEqual([])
    expect(app.note()).toMatch(/across the sequence/)
    expect(app.note()).not.toMatch(/not at one place/)
  })

  it('says a place is already saved rather than saving it twice', () => {
    // The reason: anybody who cannot remember whether the first press worked
    // presses it again, and two identical rows is the worst of the three answers.
    const app = mount()
    app.press('this view')
    expect(app.note()).toBeNull()
    app.press('this view')
    expect(app.store.marks).toHaveLength(1)
    expect(app.note()).toMatch(/already bookmarked/)
  })

  it('disables *this view* when there is no map, and enables it when there is', () => {
    const app = mount()
    const here = Array.from(app.card.el.querySelectorAll('button')).find(
      (b) => b.textContent === 'this view',
    )
    expect(here?.disabled).toBe(false)
    app.available = false
    app.card.refresh()
    expect(here?.disabled).toBe(true)
    app.available = true
    app.card.refresh()
    expect(here?.disabled).toBe(false)
  })
})

describe('the list', () => {
  it('reads a named place as its name over its coordinates', () => {
    const app = mount()
    app.store.add({ id: 'b1', label: 'anchor_A', contig: 'II', start: 120000, end: 124000 })
    const row = app.card.el.querySelector('.bookmark-row')
    expect(row?.querySelector('.bookmark-name')?.textContent).toBe('anchor_A')
    expect(row?.querySelector('.bookmark-coords')?.textContent).toBe('II:120,000-124,000')
  })

  it('reads a nameless place as its coordinates alone', () => {
    const app = mount()
    app.press('this view')
    const row = app.card.el.querySelector('.bookmark-row')
    expect(row?.querySelector('.bookmark-name')).toBeNull()
    expect(row?.querySelector('.bookmark-coords')?.textContent).toBe('II:120,000-180,000')
  })

  it('writes a place of no width as one coordinate, not a range of nothing', () => {
    const app = mount()
    app.store.add({ id: 'b1', label: '', contig: 'II', start: 150000, end: 150000 })
    expect(app.card.el.querySelector('.bookmark-coords')?.textContent).toBe('II:150,000')
  })

  it('shows the grain when the bookmark has one, and nothing when it has not', () => {
    const app = mount()
    app.store.add({ id: 'b1', label: '', contig: 'II', start: 1, end: 2, binsize: 10000 })
    app.store.add({ id: 'b2', label: '', contig: 'II', start: 3, end: 4 })
    const chips = Array.from(app.card.el.querySelectorAll('.bookmark-row')).map(
      (row) => row.querySelector('.bookmark-res')?.textContent ?? null,
    )
    expect(chips).toEqual(['10.0 kb', null])
  })

  it('carries an arrow on every row, which is the whole affordance', () => {
    const app = mount()
    app.press('this view')
    expect(app.card.el.querySelector('.bookmark-go svg')).not.toBeNull()
  })

  it('asks the shell to go, with the bookmark itself', () => {
    const app = mount()
    const mark: Bookmark = {
      id: 'b1',
      label: 'anchor_A',
      contig: 'II',
      start: 120000,
      end: 124000,
      binsize: 2000,
    }
    app.store.add(mark)
    app.goRow('anchor_A')
    // The object, not a reconstruction of it: the bin size is the half a label
    // could never carry, and it is what decides which resolution opens.
    expect(app.went).toEqual([mark])
  })

  it('forgets one, and forgets all of them', () => {
    const app = mount()
    app.type('II:1-2')
    app.press('add')
    app.type('II:3-4')
    app.press('add')
    expect(app.rows()).toHaveLength(2)
    app.card.el.querySelector<HTMLButtonElement>('.bookmark-row .btn-close')?.click()
    expect(app.rows()).toHaveLength(1)
    app.press('remove all')
    expect(app.rows()).toEqual([])
    // No *remove all* when there is nothing to remove.
    expect(
      Array.from(app.card.el.querySelectorAll('button')).some(
        (b) => b.textContent === 'remove all',
      ),
    ).toBe(false)
  })

  it('follows the store when something else writes to it', () => {
    // The store is the session's, not the card's: a config imported into this tab
    // writes it, and the list has to follow rather than wait for a rebuild.
    const app = mount()
    app.store.addAll([
      { id: 'x1', label: '', contig: 'II', start: 1, end: 2 },
      { id: 'x2', label: '', contig: 'II', start: 3, end: 4 },
    ])
    expect(app.rows()).toHaveLength(2)
  })

  it('stops listening once destroyed', () => {
    const app = mount()
    app.card.destroy()
    app.store.add({ id: 'b9', label: '', contig: 'II', start: 1, end: 2 })
    expect(app.rows()).toEqual([])
  })
})

describe('importing a BED', () => {
  const BED = [
    '# called somewhere else',
    'track name="anchors"',
    'II\t120000\t124000\tanchor_A\t55\t+',
    'II\t900000\t930000\t.',
    'nonsense',
  ].join('\n')

  it('turns every interval into a place, and names them from the file', async () => {
    const app = mount()
    await choose(app.fileInput(), bedFile('loops.bed', BED))
    expect(app.store.marks.map((m) => [m.label, m.start])).toEqual([
      ['anchor_A', 120000],
      ['', 900000],
    ])
  })

  it('records no resolution, because a BED does not claim one', () => {
    // The map is at 10 kb here and the import must not say the file said so:
    // inventing a grain would put a claim in the bookmark the file never made.
    const app = mount()
    return choose(app.fileInput(), bedFile('loops.bed', BED)).then(() => {
      expect(app.store.marks.every((m) => m.binsize === undefined)).toBe(true)
    })
  })

  it('says how many arrived and how many lines had nothing in them', async () => {
    const app = mount()
    await choose(app.fileInput(), bedFile('loops.bed', BED))
    expect(app.note()).toBe('loops.bed: 2 of 2 added, 1 line had no region.')
  })

  it('says so when the file had no regions at all', async () => {
    const app = mount()
    await choose(app.fileInput(), bedFile('notes.txt', 'hello\nworld\n'))
    expect(app.store.marks).toEqual([])
    expect(app.note()).toMatch(/No regions in notes\.txt/)
  })

  it('re-importing the same file adds nothing, and says that too', async () => {
    const app = mount()
    await choose(app.fileInput(), bedFile('loops.bed', BED))
    await choose(app.fileInput(), bedFile('loops.bed', BED))
    expect(app.store.marks).toHaveLength(2)
    // Still counting the unreadable line, which is right: the file has not
    // changed, so the report of what is in it should not either.
    expect(app.note()).toBe(
      'loops.bed: 0 of 2 added, the rest were already saved, 1 line had no region.',
    )
  })

  it('reports a file it could not read instead of failing silently', async () => {
    const app = mount()
    const broken = new File([''], 'gone.bed')
    Object.defineProperty(broken, 'text', {
      value: () => Promise.reject(new Error('NotReadableError')),
    })
    await choose(app.fileInput(), broken)
    expect(app.note()).toMatch(/could not be read/)
  })

  it('clears the input, so choosing the same file twice fires again', async () => {
    const app = mount()
    const input = app.fileInput()
    const spy = vi.spyOn(input, 'value', 'set')
    await choose(input, bedFile('loops.bed', BED))
    expect(spy).toHaveBeenCalledWith('')
  })
})
