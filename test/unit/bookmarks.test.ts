// @vitest-environment jsdom
/**
 * Saved places (§8.10): the store, the string, and the file.
 *
 * `jsdom` for one reason: the store persists through `sessionStorage`, and the
 * cases that matter most are what it does with what it finds there — a row from
 * an older build, a hand-edited key, a half-written array. `UiMemory` falls back
 * to an in-memory map where there is no storage, so under `node` those cases
 * would be testing the fallback rather than the thing.
 *
 * Three things are worth pinning here and none of them is the list itself.
 *
 * **The coordinate string**, because it is typed by hand and pasted out of this
 * app's own readout, which writes separators and units. A parser that refuses
 * what the page just printed is a parser the reader has to work around.
 *
 * **The BED reader**, because the whole point of importing is that the file came
 * from somewhere else — a peak caller, a loop caller, R — and every one of those
 * writes a slightly different BED. What must not happen is a silent partial
 * import: forty rows in, four bookmarks out, and no sign that thirty-six went
 * missing.
 *
 * **Duplicates**, because the button beside `go` is pressed twice by anybody who
 * cannot remember whether the first press worked, and a second identical row is
 * a worse answer than either "done" or "already there".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BookmarkStore,
  formatRegion,
  mintBookmarkId,
  parseRegion,
  parseTypedRegion,
  regionsFromBed,
  type Bookmark,
} from '@/annotations/bookmarks'
import { formatLocus, formatPosition } from '@/genome/assembly'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('reading a place a reader typed', () => {
  // 1-based and inclusive, the display form of §26.1 and every spelling of it:
  // the first base loses one and the last stays, so what is kept is the
  // 0-based half-open interval BED and the link are written in.
  it('takes the plain form', () => {
    expect(parseTypedRegion('II:120001-180000')).toEqual({ contig: 'II', start: 120000, end: 180000 })
  })

  it('takes the separators this app’s own readout writes', () => {
    // `formatLocus` prints `1,500,001-1,508,000`, and the breadcrumb prints
    // ranges with them.
    expect(parseTypedRegion('NC_000913.3:1,500,001-1,508,000')).toEqual({
      contig: 'NC_000913.3',
      start: 1500000,
      end: 1508000,
    })
    expect(parseTypedRegion(' chr7 : 1 200 001 - 1 260 000 ')).toEqual({
      contig: 'chr7',
      start: 1200000,
      end: 1260000,
    })
  })

  it('takes the units the tooltip writes, as the bases they name', () => {
    expect(parseTypedRegion('IV:1.2Mb-1.26Mb')).toEqual({ contig: 'IV', start: 1199999, end: 1260000 })
    expect(parseTypedRegion('IV:400kb-460kb')).toEqual({ contig: 'IV', start: 399999, end: 460000 })
  })

  it('takes the `..` an IGV or Ensembl URL uses', () => {
    expect(parseTypedRegion('7:1200001..1260000')).toEqual({ contig: '7', start: 1200000, end: 1260000 })
  })

  it('reads one position as a place of no width at that base, which is what a loop anchor is', () => {
    expect(parseTypedRegion('II:150,001')).toEqual({ contig: 'II', start: 150000, end: 150000 })
    // …which is not the one-base window the same number twice names.
    expect(parseTypedRegion('II:150,001-150,001')).toEqual({ contig: 'II', start: 150000, end: 150001 })
  })

  it('puts a backwards range the right way round rather than refusing it', () => {
    expect(parseTypedRegion('II:180000-120001')).toEqual({ contig: 'II', start: 120000, end: 180000 })
  })

  it('never lands before the first base', () => {
    expect(parseTypedRegion('II:0-1000')).toEqual({ contig: 'II', start: 0, end: 1000 })
    expect(parseTypedRegion('II:1-1000')).toEqual({ contig: 'II', start: 0, end: 1000 })
  })

  it('keeps a contig name that contains a colon', () => {
    // Split on the *last* colon: `NODE_1:len=5000` is a real assembler name.
    expect(parseTypedRegion('NODE_1:len=5000:101-200')).toEqual({
      contig: 'NODE_1:len=5000',
      start: 100,
      end: 200,
    })
  })

  it('refuses what is not a place', () => {
    // A bare contig has no length here, and "all of chromosome IV" is what the
    // region box is for.
    expect(parseTypedRegion('II')).toBeNull()
    expect(parseTypedRegion('')).toBeNull()
    expect(parseTypedRegion(':100-200')).toBeNull()
    expect(parseTypedRegion('II:')).toBeNull()
    expect(parseTypedRegion('II:abc-def')).toBeNull()
    // A negative coordinate is a mistake, not a range read from the last dash.
    expect(parseTypedRegion('II:-100')).toBeNull()
  })

  // THE LAW (§26.1), for the card: a row prints a place with `formatLocus` or
  // `formatPosition`, and that text typed back is the same place — whether the
  // place came from the map, from a BED or from the box itself.
  it('reads back exactly the place a row prints: display, typed, kept, display', () => {
    for (const place of [
      { contig: 'II', start: 120000, end: 180000 },
      { contig: 'chr1', start: 0, end: 1000 },
      { contig: 'NODE_1:len=5000', start: 12, end: 13 },
    ]) {
      expect(parseTypedRegion(formatLocus(place))).toEqual(place)
    }
    const point = { contig: 'II', start: 150000, end: 150000 }
    expect(parseTypedRegion(formatPosition(point.contig, point.start))).toEqual(point)
  })
})

describe('reading the region a link carries', () => {
  // `parseRegion` is the other direction of `formatRegion`: the machine form a
  // bookmark's `focus` is written into the hash in, read back as written.
  it('takes the digits as written, 0-based and half-open', () => {
    expect(parseRegion('II:120000-180000')).toEqual({ contig: 'II', start: 120000, end: 180000 })
    expect(parseRegion('II:150000')).toEqual({ contig: 'II', start: 150000, end: 150000 })
  })

  it('writes a form it reads back, with nothing a URL has to escape', () => {
    const region = { contig: 'NC_000913.3', start: 1500000, end: 1508000 }
    expect(formatRegion(region)).toBe('NC_000913.3:1500000-1508000')
    expect(parseRegion(formatRegion(region))).toEqual(region)
  })
})

describe('reading places out of a BED', () => {
  const FILE = [
    '# called by some tool',
    'track name="anchors"',
    'NC_000913.3\t120000\t124000\tanchor_A\t55\t+',
    'NC_000913.3\t1500000\t1508000\t.\t31\t-',
    'NC_000913.3 4200000 4204000 anchor_D',
    'this row is broken',
    'NC_000913.3\tnotanumber\t5\toops',
  ].join('\n')

  it('takes the first three columns and the name, and skips the rest', () => {
    const { regions, skipped } = regionsFromBed(FILE)
    expect(regions).toEqual([
      { contig: 'NC_000913.3', start: 120000, end: 124000, label: 'anchor_A' },
      // `.` is BED's "no name", and it must not become a bookmark called `.`.
      { contig: 'NC_000913.3', start: 1500000, end: 1508000, label: '' },
      // Space-separated, which BED permits and some tools emit.
      { contig: 'NC_000913.3', start: 4200000, end: 4204000, label: 'anchor_D' },
    ])
    expect(skipped).toBe(2)
  })

  it('reads a headed table, which is what a script writes', () => {
    const { regions, skipped } = regionsFromBed(
      ['chrom\tstart\tend\tname', 'II\t900\t930\tone', 'II\t2000\t2050\ttwo'].join('\n'),
    )
    expect(regions.map((r) => r.label)).toEqual(['one', 'two'])
    expect(skipped).toBe(0)
  })

  it('says nothing came out of a file with no regions in it', () => {
    // The count is what lets the card tell the reader rather than quietly
    // importing four rows out of forty.
    const { regions, skipped } = regionsFromBed('hello\nworld\n')
    expect(regions).toEqual([])
    expect(skipped).toBe(2)
  })

  it('reads a narrowPeak without being told what it is', () => {
    // Ten columns, the score in 7 rather than 5 — none of which this cares about,
    // which is the point of reading only the three columns every flavour shares.
    const { regions } = regionsFromBed(
      'chr1\t9356\t9506\tpeak_1\t1000\t.\t22.5\t3.1\t2.8\t75',
    )
    expect(regions).toEqual([{ contig: 'chr1', start: 9356, end: 9506, label: 'peak_1' }])
  })
})

describe('the store', () => {
  const at = (start: number, binsize?: number): Bookmark => ({
    id: mintBookmarkId(),
    label: '',
    contig: 'II',
    start,
    end: start + 1000,
    ...(binsize === undefined ? {} : { binsize }),
  })

  it('keeps what it is given, in order', () => {
    const store = new BookmarkStore('k')
    store.add(at(100))
    store.add(at(200))
    expect(store.marks.map((m) => m.start)).toEqual([100, 200])
  })

  it('refuses a place it already has, and says so', () => {
    const store = new BookmarkStore('k')
    expect(store.add(at(100, 1000))).toBe(true)
    expect(store.add(at(100, 1000))).toBe(false)
    expect(store.marks).toHaveLength(1)
  })

  it('treats the same place at another resolution as another bookmark', () => {
    // Because it is one: a loop found at 1 kb is not the picture 20 kb gives.
    const store = new BookmarkStore('k')
    store.add(at(100, 1000))
    store.add(at(100, 20000))
    expect(store.marks).toHaveLength(2)
  })

  it('counts what stuck when several arrive at once', () => {
    const store = new BookmarkStore('k')
    store.add(at(100))
    expect(store.addAll([at(100), at(200), at(300)])).toBe(2)
    expect(store.marks).toHaveLength(3)
  })

  it('notifies on every change and stops when unsubscribed', () => {
    const store = new BookmarkStore('k')
    const seen = vi.fn()
    const off = store.subscribe(seen)
    store.add(at(100))
    store.remove(store.marks[0].id)
    expect(seen).toHaveBeenCalledTimes(2)
    // A no-op does not notify: a duplicate press must not repaint the list.
    store.add(at(100))
    store.add(at(100))
    expect(seen).toHaveBeenCalledTimes(3)
    off()
    store.clear()
    expect(seen).toHaveBeenCalledTimes(3)
  })

  it('comes back on a new store over the same key, which is a change of resolution', () => {
    // The reader's own bug report, one layer down: switching resolution builds a
    // new store, and the key is the *file* (`state/UiMemory.ts`), so what was
    // saved at 2 kb is there at 5 kb.
    const first = new BookmarkStore('k')
    first.add(at(100, 2000))
    const second = new BookmarkStore('k')
    expect(second.marks.map((m) => m.start)).toEqual([100])
    expect(second.marks[0].binsize).toBe(2000)
  })

  it('is not fooled by rubbish in storage', () => {
    window.sessionStorage.setItem(
      'metacooler-viewer:ui:k:bookmarks',
      JSON.stringify([
        { id: 'b1', label: '', contig: 'II', start: 1, end: 2 },
        { id: 'b2', label: '', contig: '', start: 1, end: 2 },
        { id: 'b3', label: '', contig: 'II', start: 'x', end: 2 },
        { label: '', contig: 'II', start: 1, end: 2 },
        { id: 'b5', label: '', contig: 'II', start: 1, end: 2, binsize: -4 },
        'nonsense',
        null,
      ]),
    )
    expect(new BookmarkStore('k').marks.map((m) => m.id)).toEqual(['b1'])
  })

  it('does not mint an id a restored row already holds', () => {
    window.sessionStorage.setItem(
      'metacooler-viewer:ui:k:bookmarks',
      JSON.stringify([{ id: 'b900', label: '', contig: 'II', start: 1, end: 2 }]),
    )
    const store = new BookmarkStore('k')
    store.add(at(5))
    expect(new Set(store.marks.map((m) => m.id)).size).toBe(2)
  })
})
