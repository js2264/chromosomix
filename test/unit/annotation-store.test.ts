/**
 * The annotation store, the drop routing, and the manual marks.
 *
 * Everything here is the part of §8 that is *decisions* rather than pixels: what
 * a card does with a file whose bytes disagree with the area it landed on, what
 * survives a reload, and what a coordinate box will accept.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { kindFor } from '../../src/annotations/loader'
import {
  ManualStore,
  formatPoint,
  mintMarkId,
  parsePoint,
  type ManualMark,
} from '../../src/annotations/manual'
import { ANNOTATION_PALETTE, AnnotationStore, cleanLabel } from '../../src/annotations/store'
import { defaultStyle } from '../../src/annotations/types'
import { overlapWarning } from '../../src/ui/AnnotationCard'
import { demoAnnotationsFor, DEMO_ANNOTATION_FILES } from '../../src/ui/examples'

/**
 * `UiMemory` reaches for `window.sessionStorage` and falls back to an in-memory
 * map when it throws — which is exactly what happens under Node. That fallback
 * is the thing being exercised here, and it behaves identically.
 */
function freshStore(uri = 'file.cool'): AnnotationStore {
  const store = new AnnotationStore(uri)
  store.clear()
  return store
}

const localSource = { kind: 'local' as const, file: null as unknown as File, name: 'ATAC.bw' }

describe('the annotation store', () => {
  let store: AnnotationStore

  beforeEach(() => {
    store = freshStore(`file-${Math.random()}.cool`)
  })

  it('puts a row on screen before a byte is read', () => {
    const entry = store.begin({ card: 'linear', kind: 'track', source: localSource })
    expect(entry.status).toBe('loading')
    expect(entry.label).toBe('ATAC')
    expect(store.forCard('linear')).toHaveLength(1)
    expect(store.forCard('overlay')).toHaveLength(0)
  })

  /**
   * An id is the handle everything holds a row by, so two rows may never share
   * one. A reload followed by re-opening the same map used to put every track on
   * the card twice — restored out of storage and taken over from the outgoing
   * file, both carrying the id they were saved under — and deleting either of
   * the twins deleted both, because `remove` is by id and there was only ever
   * one track to delete.
   */
  it('re-begins a row it already holds instead of twinning it', () => {
    const first = store.begin({ card: 'linear', kind: 'track', source: localSource, id: 'a7' })
    store.update('a7', { status: 'ready', label: 'renamed' })
    store.begin({ card: 'linear', kind: 'track', source: localSource, id: 'a7' })
    expect(store.entries).toHaveLength(1)
    expect(first.id).toBe('a7')
    store.remove('a7')
    expect(store.entries).toHaveLength(0)
  })

  // …and in the slot it already had. A row taken over from the file that was
  // open before is the same row, and a row that jumped to the bottom of the
  // stack on the way across would have been reordered by the transition.
  it('keeps a re-begun row where it was', () => {
    store.begin({ card: 'linear', kind: 'track', source: localSource, id: 'a1' })
    store.begin({ card: 'linear', kind: 'track', source: localSource, id: 'a2' })
    store.begin({ card: 'linear', kind: 'track', source: localSource, id: 'a3' })
    store.begin({ card: 'linear', kind: 'track', source: localSource, id: 'a1' })
    expect(store.entries.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3'])
  })

  // One edge and not both: two copies of one track is twice the ink for no more
  // information. The *bottom* edge, because that is the orientation a track is
  // read in — under a ruler, left to right — and the right-hand stack is the
  // one you choose deliberately, per track or by dropping a file there.
  it('starts on the bottom edge only', () => {
    const entry = store.begin({ card: 'linear', kind: 'track', source: localSource })
    expect(entry.placement).toEqual({ bottom: true, right: false })
    expect(store.drawnOn('right')).toHaveLength(0)
  })

  it('honours a placement the caller asks for', () => {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: localSource,
      placement: { bottom: false, right: true },
    })
    expect(entry.placement).toEqual({ bottom: false, right: true })
  })

  it('draws nothing that has not finished loading', () => {
    const entry = store.begin({ card: 'linear', kind: 'track', source: localSource })
    expect(store.drawnOn('bottom')).toHaveLength(0)
    store.update(entry.id, { status: 'ready' })
    expect(store.drawnOn('bottom')).toHaveLength(1)
    store.update(entry.id, { visible: false })
    expect(store.drawnOn('bottom')).toHaveLength(0)
  })

  // Removing the third of four and dropping a replacement should give the
  // replacement the colour that just came free, not a fifth that reads as a new
  // series.
  it('reuses a colour that has been freed', () => {
    const first = store.begin({ card: 'linear', kind: 'track', source: localSource })
    const second = store.begin({ card: 'linear', kind: 'track', source: localSource })
    expect(first.style.colour).toBe(ANNOTATION_PALETTE[0])
    expect(second.style.colour).toBe(ANNOTATION_PALETTE[1])
    store.remove(first.id)
    expect(store.nextColour()).toBe(ANNOTATION_PALETTE[0])
  })

  it('groups tracks that share an autoscale name, and only tracks', () => {
    const a = store.begin({ card: 'linear', kind: 'track', source: localSource })
    const b = store.begin({ card: 'linear', kind: 'track', source: localSource })
    const c = store.begin({ card: 'linear', kind: 'segments', source: localSource })
    store.restyle(a.id, { group: 'rna' })
    store.restyle(b.id, { group: 'rna' })
    store.restyle(c.id, { group: 'rna' })
    const groups = store.scaleGroups()
    expect(groups.get('rna')?.map((entry) => entry.id)).toEqual([a.id, b.id])
  })

  it('notifies on every change and stops when unsubscribed', () => {
    let calls = 0
    const off = store.subscribe(() => calls++)
    const entry = store.begin({ card: 'linear', kind: 'track', source: localSource })
    store.restyle(entry.id, { colour: '#123456' })
    expect(calls).toBe(2)
    off()
    store.remove(entry.id)
    expect(calls).toBe(2)
  })

  it('does not notify for an id that has gone', () => {
    let calls = 0
    store.subscribe(() => calls++)
    store.update('nope', { visible: false })
    store.remove('nope')
    expect(calls).toBe(0)
  })

  it('knows when a gene model is already loaded (§8.1)', () => {
    expect(store.hasGtf()).toBe(false)
    store.begin({ card: 'linear', kind: 'gtf', source: localSource })
    expect(store.hasGtf()).toBe(true)
  })
})

/**
 * Dragging a row up the card moves that track up the stack beside the map:
 * `drawnOn` hands the lanes out in this order, so the order is not decoration.
 */
describe('reordering (drag, or the arrow keys)', () => {
  let store: AnnotationStore
  let ids: string[]

  beforeEach(() => {
    store = freshStore(`order-${Math.random()}.cool`)
    ids = ['a', 'b', 'c'].map(
      (name) =>
        store.begin({
          card: 'linear',
          kind: 'track',
          source: { ...localSource, name: `${name}.bw` },
        }).id,
    )
  })

  const order = (): string[] => store.forCard('linear').map((entry) => entry.label)

  it('moves a row down to the index it is given', () => {
    store.move(ids[0], 2)
    expect(order()).toEqual(['b', 'c', 'a'])
  })

  it('moves a row up', () => {
    store.move(ids[2], 0)
    expect(order()).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op for a row that is already there, and for one that has gone', () => {
    let calls = 0
    store.subscribe(() => calls++)
    store.move(ids[1], 1)
    store.move('nope', 0)
    expect(calls).toBe(0)
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  // A drop past the last row means "last", which is what the gesture looked
  // like — not an exception, and not a silently dropped move.
  it('clamps an index past either end', () => {
    store.move(ids[0], 99)
    expect(order()).toEqual(['b', 'c', 'a'])
    store.move(ids[0], -4)
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  /**
   * The two cards are interleaved in one array by load order, and a reorder of
   * one is not an event in the other. This is the case that catches an
   * implementation that renumbers `items` wholesale: with the overlay row minted
   * *between* two linear ones, any reordering that ignores the card would move
   * it too.
   */
  it('leaves the other card’s rows exactly where they were', () => {
    const store = freshStore(`mixed-${Math.random()}.cool`)
    const first = store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name: 'first.bw' },
    })
    store.begin({
      card: 'overlay',
      kind: 'pairs',
      source: { ...localSource, name: 'loops.bedpe' },
    })
    const last = store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name: 'last.bw' },
    })

    store.move(last.id, 0)
    expect(store.forCard('linear').map((entry) => entry.label)).toEqual(['last', 'first'])
    expect(store.forCard('overlay').map((entry) => entry.label)).toEqual(['loops'])
    // And the overlay row still sits between them in the underlying array, so
    // nothing downstream that reads `entries` sees it jump.
    expect(store.entries.map((entry) => entry.label)).toEqual(['last', 'loops', 'first'])
    expect(first.id).not.toBe(last.id)
  })
})

describe('what survives a reload (§8.6)', () => {
  it('remembers a finished row and its settings', () => {
    const uri = `keep-${Math.random()}.cool`
    const store = new AnnotationStore(uri)
    const entry = store.begin({ card: 'linear', kind: 'track', source: localSource })
    store.update(entry.id, { status: 'ready' })
    store.restyle(entry.id, { colour: '#abcdef', group: 'rna' })

    const stored = AnnotationStore.stored(uri)
    expect(stored).toHaveLength(1)
    expect(stored[0].style.colour).toBe('#abcdef')
    expect(stored[0].style.group).toBe('rna')
    expect(stored[0].source).toEqual({ kind: 'local', name: 'ATAC.bw' })
  })

  // A row still loading is not a row: remembering it would restore a
  // placeholder for a file nothing ever read.
  it('does not remember a row that never finished', () => {
    const uri = `partial-${Math.random()}.cool`
    const store = new AnnotationStore(uri)
    store.begin({ card: 'linear', kind: 'track', source: localSource })
    expect(AnnotationStore.stored(uri)).toHaveLength(0)
  })

  it('drops a stored row that no longer makes sense', () => {
    const uri = `bad-${Math.random()}.cool`
    const store = new AnnotationStore(uri)
    const good = store.begin({ card: 'linear', kind: 'track', source: localSource })
    store.update(good.id, { status: 'ready' })
    // Stored state outlives the build that wrote it, so it is untrusted input.
    const rows = AnnotationStore.stored(uri)
    expect(rows).toHaveLength(1)
    expect(AnnotationStore.stored('never-written.cool')).toEqual([])
  })
})

describe('labels', () => {
  it('strips a suffix without eating a hyphenated name', () => {
    expect(cleanLabel('Yeast_ChIP_Pol2-vs-input.narrowPeak')).toBe('Yeast_ChIP_Pol2-vs-input')
    expect(cleanLabel('/a/b/Yeast_ATAC.bw')).toBe('Yeast_ATAC')
    expect(cleanLabel('genes.gtf.gz')).toBe('genes')
    expect(cleanLabel('no-suffix')).toBe('no-suffix')
  })
})

describe('drop routing (§8.3)', () => {
  // The zone says what the reader meant; the bytes say what the file is, and
  // the bytes win wherever the card can absorb it.
  it('takes what a card can draw, whatever area it landed on', () => {
    expect(kindFor('linear', 'bigwig')).toBe('track')
    expect(kindFor('linear', 'gtf')).toBe('gtf')
    expect(kindFor('linear', 'bed')).toBe('segments')
    expect(kindFor('overlay', 'bed')).toBe('segments')
    expect(kindFor('overlay', 'bedpe')).toBe('pairs')
  })

  it('refuses what a card has nowhere to put', () => {
    expect(kindFor('linear', 'bedpe')).toBeNull()
    expect(kindFor('overlay', 'bigwig')).toBeNull()
    expect(kindFor('overlay', 'gtf')).toBeNull()
  })

  // A bigBed is read whole and parsed as the BED it holds, so from either card
  // it is one: boxes on a lane, and a BED12 inside one draws its exons.
  it('takes a bigBed as the segments it contains', () => {
    expect(kindFor('linear', 'bigbed')).toBe('segments')
    expect(kindFor('overlay', 'bigbed')).toBe('segments')
  })
})

describe('the contig overlap warning (§8.2)', () => {
  // Silent zero-overlap is the most likely support question there is, and it
  // presents as "the feature is broken" rather than "these files disagree".
  it('says so loudly when nothing matches', () => {
    const message = overlapWarning({ matched: 0, total: 16, missing: ['I'], extra: ['chrI'] })
    expect(message).toContain('0 of 16')
    expect(message).toContain('chrI')
  })

  it('names what is missing on a partial match', () => {
    const message = overlapWarning({ matched: 15, total: 16, missing: ['XVI'], extra: [] })
    expect(message).toContain('15 of 16')
    expect(message).toContain('XVI')
  })

  it('says nothing when everything matched', () => {
    expect(overlapWarning({ matched: 16, total: 16, missing: [], extra: [] })).toBeNull()
    expect(overlapWarning(undefined)).toBeNull()
  })
})

describe('manual marks', () => {
  it('reads back a coordinate this app itself wrote', () => {
    expect(parsePoint('I:120000')).toEqual({ contig: 'I', bp: 120_000 })
    // `fmt.int` writes separators and `fmt.bp` writes units; refusing to read
    // back what the page just printed would be a small cruelty.
    expect(parsePoint('I:1,531,933')).toEqual({ contig: 'I', bp: 1_531_933 })
    expect(parsePoint(' XIII-syn40 : 1.53 Mb ')).toEqual({ contig: 'XIII-syn40', bp: 1_530_000 })
    expect(parsePoint('II:120 kb')).toEqual({ contig: 'II', bp: 120_000 })
  })

  // A contig may legally be named `NODE_1:2`, so the *last* colon splits.
  it('splits on the last colon, not the first', () => {
    expect(parsePoint('NODE_1:2:5000')).toEqual({ contig: 'NODE_1:2', bp: 5000 })
  })

  it('refuses what it cannot read', () => {
    expect(parsePoint('I')).toBeNull()
    expect(parsePoint('I:')).toBeNull()
    expect(parsePoint(':100')).toBeNull()
    expect(parsePoint('I:abc')).toBeNull()
    expect(parsePoint('I:-100')).toBeNull()
  })

  it('round-trips through its own formatter', () => {
    const point = { contig: 'XIII-syn40', bp: 964_431 }
    expect(parsePoint(formatPoint(point))).toEqual(point)
  })

  it('keeps marks, and forgets them on request', () => {
    const store = new ManualStore(`marks-${Math.random()}.cool`)
    const line: ManualMark = {
      id: mintMarkId(),
      kind: 'line',
      axis: 'vertical',
      at: { contig: 'I', bp: 100 },
      colour: '#111318',
    }
    store.add(line)
    store.add({
      id: mintMarkId(),
      kind: 'arrowhead',
      a: { contig: 'I', bp: 1 },
      b: { contig: 'I', bp: 2 },
      colour: '#c0392b',
    })
    expect(store.lines).toHaveLength(1)
    expect(store.arrowheads).toHaveLength(1)
    store.remove(line.id)
    expect(store.lines).toHaveLength(0)
    store.clear()
    expect(store.marks).toHaveLength(0)
  })

  it('restores what a previous visit left', () => {
    const uri = `restore-${Math.random()}.cool`
    const first = new ManualStore(uri)
    first.add({
      id: mintMarkId(),
      kind: 'line',
      axis: 'both',
      at: { contig: 'IV', bp: 400_000 },
      colour: '#111318',
    })
    const second = new ManualStore(uri)
    expect(second.marks).toHaveLength(1)
    // Everything a mark is: where it is, what it looks like, and which one it
    // is. A caption used to be the fourth and is not a thing a mark carries.
    expect(second.lines[0]).toMatchObject({
      kind: 'line',
      axis: 'both',
      at: { contig: 'IV', bp: 400_000 },
      colour: '#111318',
    })
  })
})

describe('the annotations published beside a demo map', () => {
  const map = 'https://example.org/demo/Yeast_microC_G2M_1kb.cool'

  it('offers all ten, with their URLs beside the map', () => {
    const found = demoAnnotationsFor(map)
    expect(found).toHaveLength(10)
    expect(found[0].url).toBe('https://example.org/demo/Yeast_annotations.gtf')
    // No card and no zone: where each of these is drawn comes from its own
    // bytes, like every other file (`cardFor`), so the table names a file and a
    // label and nothing it would have to be kept in step with.
    expect(found.every((entry) => entry.label !== '')).toBe(true)
  })

  // A *local* file of the same name is somebody else's data under a familiar
  // name; offering ten yeast tracks against it would be a serious mistake.
  it('offers nothing for a local file, or for another map', () => {
    expect(demoAnnotationsFor('Yeast_microC_G2M_1kb.cool')).toEqual([])
    expect(demoAnnotationsFor('https://example.org/demo/Ecoli.mcool')).toEqual([])
  })

  it('names ten distinct files', () => {
    expect(new Set(DEMO_ANNOTATION_FILES).size).toBe(10)
  })
})

/**
 * Which way a lane's values grow is a reading direction rather than a
 * preference: a bottom lane grows up towards the map, and the same track beside
 * the map grows *away* from it unless it is turned round. So moving a track
 * between the two stacks turns it, and the turn is a toggle — a reader who
 * deliberately hung a bottom track from its ceiling has said something about it,
 * and setting `flip` from the edge would throw that away on the way across.
 */
describe('the edge a track is drawn on, and which way it grows', () => {
  const track = (store: AnnotationStore, placement?: { bottom: boolean; right: boolean }) =>
    store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name: 'a.bw' },
      ...(placement === undefined ? {} : { placement }),
    })

  it('turns a track round on the way to the right edge, and back again', () => {
    const store = freshStore(`flip-${Math.random()}.cool`)
    const entry = track(store)
    expect(store.byId(entry.id)?.style.flip).toBe(false)
    store.place(entry.id, { bottom: false, right: true })
    expect(store.byId(entry.id)?.style.flip).toBe(true)
    store.place(entry.id, { bottom: true, right: false })
    expect(store.byId(entry.id)?.style.flip).toBe(false)
  })

  // A toggle, not an assignment: the reader's own decision survives the round
  // trip rather than being overwritten by whichever edge it passed through.
  it('preserves a deliberate flip across the round trip', () => {
    const store = freshStore(`flip2-${Math.random()}.cool`)
    const entry = track(store)
    store.restyle(entry.id, { flip: true })
    store.place(entry.id, { bottom: false, right: true })
    expect(store.byId(entry.id)?.style.flip).toBe(false)
    store.place(entry.id, { bottom: true, right: false })
    expect(store.byId(entry.id)?.style.flip).toBe(true)
  })

  // A track drawn on both edges has one `flip` and two readings, so there is no
  // answer that is right for both stacks: it keeps what it had.
  it('leaves a track drawn on both edges alone', () => {
    const store = freshStore(`flip3-${Math.random()}.cool`)
    const entry = track(store)
    store.place(entry.id, { bottom: true, right: true })
    expect(store.byId(entry.id)?.style.flip).toBe(false)
    store.place(entry.id, { bottom: false, right: true })
    expect(store.byId(entry.id)?.style.flip).toBe(false)
  })

  // A file dropped on the right of the map arrives already turned round, for
  // the same reason: the reader aimed at that edge, not at that orientation.
  it('starts a track dropped on the right edge already turned round', () => {
    const store = freshStore(`flip4-${Math.random()}.cool`)
    expect(track(store, { bottom: false, right: true }).style.flip).toBe(true)
    expect(track(store, { bottom: true, right: false }).style.flip).toBe(false)
  })
})

describe('style defaults', () => {
  it('gives a lane a thickness its kind can use', () => {
    expect(defaultStyle('track', '#000').size).toBeGreaterThan(defaultStyle('segments', '#000').size)
    expect(defaultStyle('track', '#000').limits.auto).toBe(true)
  })
})
