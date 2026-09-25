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
  formatSpan,
  mintMarkId,
  parsePoint,
  parseSpan,
  type ManualMark,
} from '../../src/annotations/manual'
import { LEAD_MAP } from '../../src/annotations/placement'
import { ANNOTATION_PALETTE, AnnotationStore, cleanLabel } from '../../src/annotations/store'
import { defaultStyle, placementOn, type Placement } from '../../src/annotations/types'
import { remember } from '../../src/state/UiMemory'
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

  // One edge and not four: four copies of one track is four times the ink for
  // no more information. The *bottom* edge, because that is the orientation a
  // track is read in — under a ruler, left to right — and the other three are
  // the ones you choose deliberately, per track or by dropping a file there.
  it('starts on the bottom edge only', () => {
    const entry = store.begin({ card: 'linear', kind: 'track', source: localSource })
    expect(entry.placement).toEqual({ top: false, right: false, bottom: true, left: false })
    for (const edge of ['top', 'right', 'left'] as const) {
      expect(store.drawnOn(edge)).toHaveLength(0)
    }
  })

  it('honours a placement the caller asks for', () => {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: localSource,
      placement: { left: true },
    })
    expect(entry.placement).toEqual({ top: false, right: false, bottom: false, left: true })
  })

  // A session written before the top and left stacks existed carries two of the
  // four keys. `undefined` is falsy enough that nothing visibly breaks, but a
  // record with holes in it is one that every count over its edges gets wrong —
  // so the door it comes in through fills them.
  it('fills in the edges an older session never wrote', () => {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: localSource,
      placement: { bottom: false, right: true },
    })
    expect(entry.placement).toEqual({ top: false, right: true, bottom: false, left: false })
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
    expect(message?.tone).toBe('warn')
    expect(message?.text).toContain('0 of 16')
    expect(message?.text).toContain('chrI')
  })

  it('names what is missing on a partial match', () => {
    const message = overlapWarning({ matched: 15, total: 16, missing: ['XVI'], extra: [] })
    expect(message?.tone).toBe('warn')
    expect(message?.text).toContain('15 of 16')
    expect(message?.text).toContain('XVI')
  })

  it('says nothing when everything matched', () => {
    expect(overlapWarning({ matched: 16, total: 16, missing: [], extra: [] })).toBeNull()
    expect(overlapWarning(undefined)).toBeNull()
  })

  // On a metagenome the same arithmetic reads as a failure: a coverage track
  // over three MAGs of forty-nine matches 412 of 20,566 sequences, which is
  // exactly what a file about another organism would also say. The unit of the
  // answer is the MAG, and partial coverage is not a fault (§8.5).
  it('counts genomes rather than sequences where the map has them', () => {
    const message = overlapWarning({
      matched: 412,
      total: 20_566,
      missing: ['NODE_9'],
      extra: [],
      genomes: { matched: 3, total: 49, named: ['MAG_12', 'MAG_31', 'MAG_44'] },
    })
    expect(message?.tone).toBe('note')
    expect(message?.text).toBe('412 of 20,566 sequences, in 3 of 49 genomes: MAG_12, MAG_31, MAG_44.')
  })

  it('says so plainly when a track covers every genome', () => {
    const message = overlapWarning({
      matched: 20_100,
      total: 20_566,
      missing: ['NODE_9'],
      extra: [],
      genomes: { matched: 49, total: 49, named: ['MAG_1', 'MAG_2', 'MAG_3', 'MAG_4'] },
    })
    expect(message?.tone).toBe('note')
    expect(message?.text).toBe('20,100 of 20,566 sequences, across all 49 genomes.')
  })

  it('still shouts when a metagenome track matches nothing at all', () => {
    // The genome clause is about *partial* coverage. Zero is the one failure
    // §8.2 exists for, on a metagenome as anywhere else.
    const message = overlapWarning({
      matched: 0,
      total: 20_566,
      missing: ['NODE_1'],
      extra: ['chr1'],
      genomes: { matched: 0, total: 49, named: [] },
    })
    expect(message?.tone).toBe('warn')
    expect(message?.text).toContain('0 of 20,566')
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

  it('reads a box’s side as an interval, however the reader wrote it', () => {
    expect(parseSpan('I:120000-180000')).toEqual({ contig: 'I', from: 120_000, to: 180_000 })
    expect(parseSpan('I:120 kb - 1.53 Mb')).toEqual({ contig: 'I', from: 120_000, to: 1_530_000 })
    // The readout writes an en dash and separators; a reader pasting back what
    // the page showed them is doing the obvious thing.
    expect(parseSpan('XIII-syn40:964,431–1,000,000')).toEqual({
      contig: 'XIII-syn40',
      from: 964_431,
      to: 1_000_000,
    })
  })

  it('puts a box’s ends in order, since a box has no direction', () => {
    expect(parseSpan('I:180000-120000')).toEqual({ contig: 'I', from: 120_000, to: 180_000 })
  })

  it('refuses a side that is not an interval', () => {
    expect(parseSpan('I:120000')).toBeNull()
    expect(parseSpan('I:120000-')).toBeNull()
    expect(parseSpan('I:a-b')).toBeNull()
    expect(parseSpan('120000-180000')).toBeNull()
    expect(parseSpan(formatPoint({ contig: 'I', bp: 100 }))).toBeNull()
  })

  it('round-trips a span through its own formatter', () => {
    const span = { contig: 'NODE_1:2', from: 5_000, to: 40_000 }
    expect(parseSpan(formatSpan(span))).toEqual(span)
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
    store.add({
      id: mintMarkId(),
      kind: 'rect',
      a: { contig: 'I', from: 1, to: 10 },
      b: { contig: 'I', from: 20, to: 30 },
      colour: '#1f5fa9',
    })
    expect(store.lines).toHaveLength(1)
    expect(store.arrowheads).toHaveLength(1)
    expect(store.rects).toHaveLength(1)
    store.remove(line.id)
    expect(store.lines).toHaveLength(0)
    store.clear()
    expect(store.marks).toHaveLength(0)
  })

  it('restores a box, which a session file is allowed to carry', () => {
    // Stored state is untrusted input and every mark is validated on the way
    // back in, so a kind the validator did not know about is a kind that
    // silently vanishes on reload.
    const uri = `boxes-${Math.random()}.cool`
    const first = new ManualStore(uri)
    first.add({
      id: mintMarkId(),
      kind: 'rect',
      a: { contig: 'IV', from: 120_000, to: 180_000 },
      b: { contig: 'IV', from: 340_000, to: 400_000 },
      colour: '#0f8a5f',
    })
    expect(new ManualStore(uri).rects[0]).toMatchObject({
      kind: 'rect',
      a: { contig: 'IV', from: 120_000, to: 180_000 },
      b: { contig: 'IV', from: 340_000, to: 400_000 },
    })
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
 * preference, and the two axes answer it differently.
 *
 * A **horizontal** lane grows up the page wherever it is: every browser ever
 * built draws coverage rising from a floor under a ruler, and a profile above a
 * contact map hanging from its ceiling is one a reader has to mirror in their
 * head before they can compare it with the one below. A **vertical** lane has no
 * such convention, so what decides is the corner: it grows towards the matrix,
 * which beside the map's right edge means turning it round.
 *
 * So one edge turns, and moving a track between two edges that give different
 * answers turns it on the way. The turn is a toggle — a reader who deliberately
 * hung a bottom track from its ceiling has said something about it, and setting
 * `flip` from the edge would throw that away on the way across.
 */
describe('the edge a track is drawn on, and which way it grows', () => {
  const track = (store: AnnotationStore, placement?: Partial<Placement>) =>
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
    store.place(entry.id, placementOn('right'))
    expect(store.byId(entry.id)?.style.flip).toBe(true)
    store.place(entry.id, placementOn('bottom'))
    expect(store.byId(entry.id)?.style.flip).toBe(false)
  })

  // Three of the four edges read the same way, so a move between any two of them
  // turns nothing: a track under the map, over it, or to its left all grow the
  // way a track under a ruler does.
  it('turns nothing on a move between two edges that read the same way', () => {
    const store = freshStore(`flip-pair-${Math.random()}.cool`)
    const entry = track(store)
    for (const edge of ['top', 'left', 'bottom', 'top'] as const) {
      store.place(entry.id, placementOn(edge))
      expect(store.byId(entry.id)?.style.flip).toBe(false)
    }
    // …and only the one that does not turns it, in either direction.
    store.place(entry.id, placementOn('right'))
    expect(store.byId(entry.id)?.style.flip).toBe(true)
    store.place(entry.id, placementOn('top'))
    expect(store.byId(entry.id)?.style.flip).toBe(false)
  })

  // A toggle, not an assignment: the reader's own decision survives the round
  // trip rather than being overwritten by whichever edge it passed through.
  it('preserves a deliberate flip across the round trip', () => {
    const store = freshStore(`flip2-${Math.random()}.cool`)
    const entry = track(store)
    store.restyle(entry.id, { flip: true })
    store.place(entry.id, placementOn('right'))
    expect(store.byId(entry.id)?.style.flip).toBe(false)
    store.place(entry.id, placementOn('bottom'))
    expect(store.byId(entry.id)?.style.flip).toBe(true)
  })

  // A track drawn on two edges has one `flip` and two readings, so there is no
  // answer that is right for both stacks: it keeps what it had.
  it('leaves a track drawn on two edges alone', () => {
    const store = freshStore(`flip3-${Math.random()}.cool`)
    const entry = track(store)
    store.place(entry.id, { bottom: true, right: true })
    expect(store.byId(entry.id)?.style.flip).toBe(false)
    store.place(entry.id, placementOn('right'))
    expect(store.byId(entry.id)?.style.flip).toBe(false)
  })

  // A file dropped on an edge arrives already turned the right way round, for
  // the same reason: the reader aimed at that edge, not at that orientation.
  it('starts a track dropped on an edge reading the way that edge reads', () => {
    const store = freshStore(`flip4-${Math.random()}.cool`)
    // Up the page, above the map and below it alike.
    expect(track(store, placementOn('top')).style.flip).toBe(false)
    expect(track(store, placementOn('bottom')).style.flip).toBe(false)
    // Towards the matrix, which on the left is already which way it grows.
    expect(track(store, placementOn('left')).style.flip).toBe(false)
    expect(track(store, placementOn('right')).style.flip).toBe(true)
  })

  // On the way to the 1D browser, where there is no map to be beside and every
  // lane is a horizontal one under a ruler. Only the edge that turns, turns
  // back — and it is its own inverse, so the round trip is a no-op.
  it('turns the axes the browser would read backwards, and only those', () => {
    const store = freshStore(`flip5-${Math.random()}.cool`)
    const right = track(store, placementOn('right'))
    const top = track(store, placementOn('top'))
    store.turnAxesForBrowser()
    expect(store.byId(right.id)?.style.flip).toBe(false)
    expect(store.byId(top.id)?.style.flip).toBe(false)
    store.turnAxesForBrowser()
    expect(store.byId(right.id)?.style.flip).toBe(true)
    expect(store.byId(top.id)?.style.flip).toBe(false)
  })
})

describe('style defaults', () => {
  it('gives a lane a thickness its kind can use', () => {
    expect(defaultStyle('track', '#000').size).toBeGreaterThan(defaultStyle('segments', '#000').size)
    expect(defaultStyle('track', '#000').limits.auto).toBe(true)
  })
})

/**
 * What a turned map asks the store for: it has one stack, below the rectangle,
 * and every track has to arrive in it exactly once whichever edge of the square
 * it was put on (`ui/AnnotationLanes.ts`).
 */
describe('everything one map draws', () => {
  const ready = (store: AnnotationStore, name: string, placement: Placement): string => {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name },
      placement,
    })
    store.update(entry.id, { status: 'ready' })
    return entry.id
  }

  it('gives a track on two edges once, not twice', () => {
    // The failure the method exists to prevent: asking edge by edge and
    // concatenating draws a track placed on the bottom *and* the right as two
    // lanes, one above the other, in a stack that has no right edge to explain
    // the second one.
    const store = freshStore()
    const both = ready(store, 'a.bw', { ...placementOn('bottom'), right: true })
    expect(store.drawnAnywhereOn('lead').map((row) => row.id)).toEqual([both])
  })

  it('keeps the list’s own order rather than grouping by edge', () => {
    // A reader orders the list to order the stack. Four edges concatenated puts
    // every bottom track above every right one however the list reads.
    const store = freshStore()
    const a = ready(store, 'a.bw', placementOn('right'))
    const b = ready(store, 'b.bw', placementOn('bottom'))
    const c = ready(store, 'c.bw', placementOn('top'))
    expect(store.drawnAnywhereOn('lead').map((row) => row.id)).toEqual([a, b, c])
  })

  it('leaves out what is hidden, unread, or on no edge at all', () => {
    const store = freshStore()
    const shown = ready(store, 'a.bw', placementOn('bottom'))
    const hidden = ready(store, 'b.bw', placementOn('bottom'))
    store.update(hidden, { visible: false })
    ready(store, 'c.bw', { top: false, right: false, bottom: false, left: false })
    store.begin({ card: 'linear', kind: 'track', source: { ...localSource, name: 'd.bw' } })
    expect(store.drawnAnywhereOn('lead').map((row) => row.id)).toEqual([shown])
  })

  it('answers for one map without reading another’s placements', () => {
    const store = freshStore()
    const a = ready(store, 'a.bw', placementOn('bottom'))
    store.placeOn(a, 'p1', placementOn('top'))
    const b = ready(store, 'b.bw', placementOn('bottom'))
    expect(store.drawnAnywhereOn('p1').map((row) => row.id)).toEqual([a])
    expect(store.drawnAnywhereOn('lead').map((row) => row.id)).toEqual([a, b])
  })
})

/**
 * A row that has been here before brings back every decision made about it —
 * **including having been turned off**.
 *
 * `begin` is the door a row comes back through as well as the door a new one
 * arrives by, and the two want opposite defaults: a track nobody has said
 * anything about is drawn, and a track that was hidden is hidden. Left to the
 * new-row default, the hidden ones came back drawn — which on an `.mcool` is
 * every change of resolution, since the same file at another level is a fresh
 * open with the tracks restored around it, and the reader's "not this one" was
 * undone by a menu they used for something else entirely.
 */
describe('what a row brings back with it', () => {
  const restored = (store: AnnotationStore, visible: boolean) =>
    store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name: 'a.bw' },
      id: `kept-${Math.random()}`,
      visible,
    })

  it('is drawn when nobody has said otherwise', () => {
    const store = freshStore(`vis-new-${Math.random()}.cool`)
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name: 'a.bw' },
    })
    expect(store.byId(entry.id)?.visible).toBe(true)
  })

  it('comes back hidden when it was hidden', () => {
    const store = freshStore(`vis-${Math.random()}.cool`)
    const entry = restored(store, false)
    expect(store.byId(entry.id)?.visible).toBe(false)
  })

  it('stays hidden when the same row is begun again', () => {
    // Two roads bring a row back — storage and the file that was open before —
    // and nothing stops both arriving. The second must not undraw the answer.
    const store = freshStore(`vis-twice-${Math.random()}.cool`)
    const entry = restored(store, false)
    store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name: 'a.bw' },
      id: entry.id,
      visible: false,
    })
    expect(store.byId(entry.id)?.visible).toBe(false)
    expect(store.entries.filter((row) => row.id === entry.id)).toHaveLength(1)
  })
})

/**
 * What a deck put down does to the tracks that were on it.
 *
 * A deck closing is a statement about **layout**, and never about what the
 * reader has imported. `PanelDeck.closeDeck` reconciles the lanes to the one map
 * that is staying and leaves every track where it was; what that leaves behind
 * is a track with no lanes, which is a state this model has always had and is
 * one tick from being on the lead.
 *
 * It used to be a deletion, and the deletion was uneven in a way that read as a
 * bug: a track the reader had also put on the lead survived and one they had
 * only ever put on a companion did not.
 */
describe('closing a deck', () => {
  /** A finished track, since a lane is only drawn once its file has been read. */
  function loaded(store: AnnotationStore, name: string, placement: Placement): string {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name },
      placement,
    })
    store.update(entry.id, { status: 'ready' })
    return entry.id
  }

  it('brings a companion-only track to the lead, at the edge it was on', () => {
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'companion.bw', placementOn('bottom'))
    store.noteMapFiles(new Map([['slot-2', 'rep2.cool']]))
    store.placeOn(id, 'slot-2', placementOn('top'))
    store.unplaceFrom(id, LEAD_MAP)
    expect(store.drawnOnMap('slot-2', 'top')).toHaveLength(1)

    // The deck goes down: one map left, and the lanes reconciled to it.
    store.keepMaps(new Set([LEAD_MAP]))
    // The import survives — a deck put down is a statement about layout, not
    // about what the reader has loaded — and so does the *work*: it used to be
    // left drawn nowhere, which reads as the close having deleted it.
    expect(store.entries.map((entry) => entry.id)).toEqual([id])
    expect(store.drawnOnMap(LEAD_MAP, 'top')).toHaveLength(1)
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
    expect(store.drawnOnMap('slot-2', 'top')).toHaveLength(0)
  })

  it('gives it back when a map opens that file again, and takes the loan back', () => {
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'companion.bw', placementOn('bottom'))
    store.noteMapFiles(new Map([['slot-2', 'rep2.cool']]))
    store.placeOn(id, 'slot-2', placementOn('top'))
    store.unplaceFrom(id, LEAD_MAP)
    store.keepMaps(new Set([LEAD_MAP]))

    // A new deck: a new slot id, because a slot id is minted per deck and never
    // minted again. What identifies "that map" is the file it is showing.
    store.noteMapFiles(new Map([['slot-9', 'rep2.cool']]))
    store.adoptHome('slot-9', 'rep2.cool')

    expect(store.drawnOnMap('slot-9', 'top')).toHaveLength(1)
    // …and the lead lane it borrowed while the map was away goes back, or the
    // track would be drawn twice.
    expect(store.drawnOnMap(LEAD_MAP, 'top')).toHaveLength(0)
  })

  it('leaves a track that was also on the lead exactly where it was', () => {
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'both.bw', placementOn('bottom'))
    store.noteMapFiles(new Map([['slot-2', 'rep2.cool']]))
    store.placeOn(id, 'slot-2', placementOn('top'))

    store.keepMaps(new Set([LEAD_MAP]))
    // The lead's own lane is not rearranged by a close: it is not going
    // anywhere, and moving it to wherever the departing copy sat would be a
    // change nobody asked for.
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)
    expect(store.drawnOnMap(LEAD_MAP, 'top')).toHaveLength(0)
    expect(store.drawnOnMap('slot-2', 'top')).toHaveLength(0)

    // And the companion's lane still comes back, without disturbing the lead's.
    store.adoptHome('slot-9', 'rep2.cool')
    expect(store.drawnOnMap('slot-9', 'top')).toHaveLength(1)
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)
  })

  it('forgets nothing and invents nothing for a map it never learnt a file for', () => {
    // A cell closed before it had opened anything: the lane still comes to the
    // lead rather than vanishing, and there is simply no home to send it back to.
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'orphan.bw', placementOn('bottom'))
    store.placeOn(id, 'slot-2', placementOn('left'))
    store.unplaceFrom(id, LEAD_MAP)

    store.keepMaps(new Set([LEAD_MAP]))
    expect(store.drawnOnMap(LEAD_MAP, 'left')).toHaveLength(1)
    store.adoptHome('slot-9', 'rep2.cool')
    expect(store.drawnOnMap('slot-9', 'left')).toHaveLength(0)
  })
})

/**
 * Moving a lane **on the map the hand is over**.
 *
 * `place` is the lead's control: it writes the *track's* default placement, which
 * is what the row in the Tracks card shows and what a session with no deck
 * means. A drag made on a companion's edge went through it too, so dragging a
 * computed track from the left of the third replicate to underneath it rewrote
 * the track's default, moved the **lead's** lane, and left the picture the hand
 * was over exactly as it was. §18.5 says a computed track is a track like any
 * other and `annotations/placement.ts` says an edge belongs to the lane; this is
 * the call that makes both true at once.
 */
describe('moving a track on the lead', () => {
  it('moves the lead’s lane before it tells anybody', () => {
    // The edge buttons on a row read the lane, and so does the write to
    // session storage; the lane used to be set after the announcement, so both
    // saw the edge the track had just left.
    const store = freshStore()
    const entry = store.begin({ card: 'linear', kind: 'track', label: 'ATAC', source: localSource })
    const seen: boolean[] = []
    store.subscribe(() => seen.push(store.laneFor(entry.id, LEAD_MAP)?.placement.right === true))
    store.placeAt(entry.id, LEAD_MAP, { bottom: true, right: true })
    expect(seen).toEqual([true])
  })

  it('restyles several rows as one change', () => {
    const store = freshStore()
    const a = store.begin({ card: 'linear', kind: 'track', label: 'a', source: localSource })
    const b = store.begin({ card: 'linear', kind: 'track', label: 'b', source: localSource })
    let changes = 0
    store.subscribe(() => changes++)
    store.restyleEach([a.id, b.id, 'gone'], { size: 64 })
    expect(changes).toBe(1)
    expect(store.byId(a.id)?.style.size).toBe(64)
    expect(store.byId(b.id)?.style.size).toBe(64)
    // A patch may read each row's own style.
    store.restyleEach([a.id, b.id], (style) => ({ size: style.size + 1 }))
    expect(store.byId(a.id)?.style.size).toBe(65)
  })
})

describe('moving a lane on one map', () => {
  function loaded(store: AnnotationStore, name: string, placement: Placement): string {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { ...localSource, name },
      placement,
    })
    store.update(entry.id, { status: 'ready' })
    return entry.id
  }

  it('moves the companion’s lane and leaves the lead’s alone', () => {
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'coverage', placementOn('bottom'))
    store.placeOn(id, 'slot-2', placementOn('left'))

    store.placeAt(id, 'slot-2', placementOn('bottom'))

    expect(store.drawnOnMap('slot-2', 'bottom')).toHaveLength(1)
    expect(store.drawnOnMap('slot-2', 'left')).toHaveLength(0)
    // The lead is where it was, and so is the track's own default.
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)
    expect(store.byId(id)?.placement.bottom).toBe(true)
    expect(store.byId(id)?.placement.left).toBe(false)
  })

  it('turns the axis on that lane alone, as an override', () => {
    // A vertical lane grows towards the matrix and a horizontal one grows up the
    // page, so a lane crossing between them is turned on the way — and on a
    // companion that turn is the *lane's*, which is exactly why `flip` is one of
    // the two fields a lane may differ on.
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'coverage', placementOn('bottom'))
    store.placeOn(id, 'slot-2', placementOn('left'))
    const before = store.byId(id)?.style.flip

    store.placeAt(id, 'slot-2', placementOn('right'))

    expect(store.byId(id)?.style.flip).toBe(before)
    const lane = store.placements.find((each) => each.track === id && each.map === 'slot-2')
    expect(lane?.style?.flip).toBe(!(before ?? false))
  })

  it('is the lead’s own control when the map is the lead', () => {
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'coverage', placementOn('bottom'))
    store.placeAt(id, LEAD_MAP, placementOn('top'))
    expect(store.byId(id)?.placement.top).toBe(true)
    expect(store.drawnOnMap(LEAD_MAP, 'top')).toHaveLength(1)
  })

  it('puts a track on a map it was not on, which is what a drop onto an edge is', () => {
    const store = freshStore(`deck-${Math.random()}.cool`)
    const id = loaded(store, 'coverage', placementOn('bottom'))
    store.placeAt(id, 'slot-2', placementOn('top'))
    expect(store.drawnOnMap('slot-2', 'top')).toHaveLength(1)
    // Nothing was turned: there is no edge it came from.
    expect(store.placements.find((each) => each.map === 'slot-2')?.style).toBeUndefined()
  })
})

/**
 * What happens to a deck's lanes when the file is opened again.
 *
 * A change of resolution is a fresh open: the session puts down its store, makes
 * another, and begins every track it was holding around it. `begin` places what
 * it is handed on the **lead** — which is what importing has always meant, and
 * is exactly wrong for a row that is coming back. So a deck of four maps each
 * carrying its own bigWig came back with all four stacked on the first one, and
 * a track that had lived only on a companion arrived on a map it had never been
 * on.
 */
describe('carrying a deck’s lanes across a reopen', () => {
  /** The state a reopen leaves: every carried row begun again, on the lead. */
  function reopened(store: AnnotationStore, names: readonly string[]): string[] {
    return names.map((name) => {
      const entry = store.begin({
        card: 'linear',
        kind: 'track',
        source: { ...localSource, name },
        placement: placementOn('bottom'),
      })
      store.update(entry.id, { status: 'ready' })
      return entry.id
    })
  }

  it('puts a companion-only track back on its companion, and off the lead', () => {
    const store = freshStore(`carry-${Math.random()}.cool`)
    const [id] = reopened(store, ['companion.bw'])
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)

    store.restoreLanes([{ track: id, map: 'p1', placement: placementOn('top') }])
    expect(store.drawnOnMap('p1', 'top')).toHaveLength(1)
    // Off the lead, not merely also on the companion: a snapshot applied on top
    // of `begin`'s placement leaves the same picture twice.
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
  })

  it('puts a track that was on three maps back on all three', () => {
    const store = freshStore(`carry-${Math.random()}.cool`)
    const [id] = reopened(store, ['everywhere.bw'])
    store.restoreLanes([
      { track: id, map: LEAD_MAP, placement: placementOn('bottom') },
      { track: id, map: 'p1', placement: placementOn('bottom') },
      { track: id, map: 'p2', placement: placementOn('left') },
    ])
    expect(store.mapsDrawing(id).sort()).toEqual([LEAD_MAP, 'p1', 'p2'])
    expect(store.drawnOnMap('p2', 'left')).toHaveLength(1)
    expect(store.drawnOnMap('p2', 'bottom')).toHaveLength(0)
  })

  it('keeps the edge each map drew it on, rather than one edge for all', () => {
    const store = freshStore(`carry-${Math.random()}.cool`)
    const [id] = reopened(store, ['sided.bw'])
    store.restoreLanes([
      { track: id, map: LEAD_MAP, placement: placementOn('bottom') },
      { track: id, map: 'p1', placement: placementOn('right') },
    ])
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)
    expect(store.drawnOnMap(LEAD_MAP, 'right')).toHaveLength(0)
    expect(store.drawnOnMap('p1', 'right')).toHaveLength(1)
    expect(store.drawnOnMap('p1', 'bottom')).toHaveLength(0)
  })

  it('says nothing about a row that did not come back', () => {
    // A `computed` row is not carried by the loader at all, and a `detached` one
    // has no file behind it. Their lanes are in the snapshot and their ids are
    // not in the store, and naming a track that is not here must not invent one.
    const store = freshStore(`carry-${Math.random()}.cool`)
    const [id] = reopened(store, ['here.bw'])
    store.restoreLanes([
      { track: id, map: 'p1', placement: placementOn('top') },
      { track: 'analysis:coverage', map: 'p2', placement: placementOn('left') },
    ])
    expect(store.entries.map((entry) => entry.id)).toEqual([id])
    expect(store.placements.map((lane) => lane.track)).toEqual([id])
  })

  it('leaves rows the snapshot does not mention where the reopen put them', () => {
    const store = freshStore(`carry-${Math.random()}.cool`)
    const [first, second] = reopened(store, ['moved.bw', 'untouched.bw'])
    store.restoreLanes([{ track: first, map: 'p1', placement: placementOn('top') }])
    expect(store.drawnOnMap(LEAD_MAP, 'bottom').map((entry) => entry.id)).toEqual([second])
  })
})

/**
 * Where a task's result goes.
 *
 * `begin` places every new row on the lead, which is what *importing* has always
 * meant. A result is not an import: it is a measurement of one picture, and on a
 * deck the picture is whichever the star is on — an insulation track computed
 * from the third replicate is a track about the third replicate, and drawing it
 * beside a map whose numbers it is not is the one way this can be quietly wrong.
 * `AnalysisWorkspace.placeOnTarget` is the mover; this pins the two calls it
 * makes.
 */
describe('a result placed on the starred map', () => {
  it('leaves the lead and lands on the map it was measured from', () => {
    const store = freshStore(`star-${Math.random()}.cool`)
    const entry = store.begin({ card: 'synthetic', kind: 'track', source: localSource })
    store.update(entry.id, { status: 'ready' })
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)

    store.placeOn(entry.id, 'slot-3', placementOn('bottom'))
    store.unplaceFrom(entry.id, LEAD_MAP)
    expect(store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
    expect(store.drawnOnMap('slot-3', 'bottom')).toHaveLength(1)
    // Still one import, on one row of the panel: a result on a companion is a
    // placement, never a second copy of the track.
    expect(store.entries).toHaveLength(1)
  })
})

/**
 * Where the tracks were drawn, across a reload.
 *
 * `homes` used to say in prose that it was deliberately not persisted, and the
 * argument was sound: an arrangement of pictures that no longer exist is not
 * something to restore a reader into. What changed is the premise — a deck of
 * local companions now comes back — so the arrangement is worth keeping, and a
 * restored deck that put every track on the lead would be the one part of the
 * session that did not return.
 *
 * The old behaviour still has to hold wherever the old premise does: where the
 * companions do *not* come back, the lanes park onto the lead exactly as before.
 */
describe('remembering which panel a track was drawn on', () => {
  function loaded(store: AnnotationStore, name: string, placement: Placement): string {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'local', file: new File([], name), name },
      placement,
    })
    store.update(entry.id, { status: 'ready' })
    return entry.id
  }

  it('writes down a lane on a live companion, not only a parked one', () => {
    // The half that would have been easy to miss: persisting `homes` alone
    // records the tracks whose maps were *closed* and forgets every one still on
    // screen, which is exactly backwards.
    const uri = `lanes-${Math.random()}.cool`
    const store = freshStore(uri)
    const id = loaded(store, 'companion.bw', placementOn('bottom'))
    store.noteMapFiles(new Map([['slot-2', 'rep2.cool']]))
    store.placeOn(id, 'slot-2', placementOn('top'))
    store.unplaceFrom(id, LEAD_MAP)

    const written = AnnotationStore.storedLanes(uri)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ track: id, uri: 'rep2.cool', borrowedLead: true })
    // Keyed by the file, never by the slot id — a slot id is minted per deck and
    // would name nothing in the window that reads this back.
    expect(JSON.stringify(written)).not.toContain('slot-2')
  })

  it('puts a track back on the companion showing its file, after a reload', () => {
    const uri = `lanes-${Math.random()}.cool`
    const first = freshStore(uri)
    const id = loaded(first, 'companion.bw', placementOn('bottom'))
    first.noteMapFiles(new Map([['slot-2', 'rep2.cool']]))
    first.placeOn(id, 'slot-2', placementOn('top'))
    first.unplaceFrom(id, LEAD_MAP)
    // Read before the next store exists: `freshStore` clears, which is what a
    // test wants and not what a reload does.
    const written = AnnotationStore.storedLanes(uri)

    // A new page load: a new store over the same file, and the rows and the
    // arrangement read back out of session memory.
    const next = freshStore(uri)
    const back = next.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'local', file: new File([], 'companion.bw'), name: 'companion.bw' },
      id,
    })
    next.update(back.id, { status: 'ready' })
    next.seedHomes(written)

    // Nothing has moved yet: seeding parks, and the deck is not built.
    expect(next.drawnOnMap(LEAD_MAP, 'top')).toHaveLength(0)

    // …and the companion opens, under an id this window minted for itself.
    next.noteMapFiles(new Map([['slot-41', 'rep2.cool']]))
    next.adoptHome('slot-41', 'rep2.cool')
    expect(next.drawnOnMap('slot-41', 'top')).toHaveLength(1)
  })

  it('leaves the track on the lead when the companion does not come back', () => {
    // The old decision, still in force wherever its premise still holds.
    const uri = `lanes-${Math.random()}.cool`
    const first = freshStore(uri)
    const id = loaded(first, 'companion.bw', placementOn('bottom'))
    first.noteMapFiles(new Map([['slot-2', 'rep2.cool']]))
    first.placeOn(id, 'slot-2', placementOn('top'))
    first.unplaceFrom(id, LEAD_MAP)
    const written = AnnotationStore.storedLanes(uri)

    const next = freshStore(uri)
    const back = next.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'local', file: new File([], 'companion.bw'), name: 'companion.bw' },
      id,
      placement: placementOn('bottom'),
    })
    next.update(back.id, { status: 'ready' })
    next.seedHomes(written)
    // No deck: nothing ever calls `adoptHome`, and the row is drawn where a
    // restored row has always been drawn.
    expect(next.drawnOnMap('slot-41', 'top')).toHaveLength(0)
    expect(next.entries.map((entry) => entry.id)).toEqual([id])
  })

  it('refuses a stored lane that is not one', () => {
    const uri = `lanes-${Math.random()}.cool`
    const store = freshStore(uri)
    // Untrusted like every other stored shape. A record from a build that wrote
    // a different form must be dropped rather than repaired into a lane the
    // renderers would choke on.
    expect(() =>
      store.seedHomes([
        { track: '', uri: 'a.cool', placement: placementOn('top'), borrowedLead: true },
      ]),
    ).not.toThrow()
    expect(AnnotationStore.storedLanes('never-written.cool')).toEqual([])
  })
})

/**
 * What the *session's own map* says about a track.
 *
 * Every other map's lane is written down by file, in `deck:lanes`, and the lead
 * is deliberately excluded there: a `StoredLane` is keyed on the companion's URI
 * and the lead has no such key to be found under. So the two things a lane can
 * say that a track cannot — *I am not on this map* and *my range here is
 * different* — were sayable about every map in a deck except the one every
 * session has. Both are losable in ordinary use: taking a track off the lead is
 * one press of the last lit edge, and every analysis result computed against a
 * starred companion is placed there and taken off the lead.
 */
describe('what the lead map says about a track', () => {
  function ready(store: AnnotationStore, name = 'ATAC.bw'): string {
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'local', file: new File([], name), name },
      placement: placementOn('bottom'),
    })
    store.update(entry.id, { status: 'ready' })
    return entry.id
  }

  /** One page load's worth: what was written, read back into a new store. */
  function reload(uri: string, id: string): AnnotationStore {
    const written = AnnotationStore.stored(uri)
    const next = freshStore(uri)
    const row = written.find((held) => held.id === id)
    if (row === undefined) throw new Error('the row was not persisted at all')
    next.begin({
      card: row.card,
      kind: row.kind,
      source: { kind: 'local', file: new File([], row.source.name), name: row.source.name },
      id: row.id,
      placement: row.placement,
      style: row.style,
      lead: row.lead,
    })
    next.update(id, { status: 'ready' })
    return next
  }

  it('says nothing where the lead simply draws it', () => {
    // The overwhelming majority of rows. A second copy of `placement` in every
    // workspace file, for the benefit of the few that differ, is not worth it.
    const uri = `lead-${Math.random()}.cool`
    const store = freshStore(uri)
    ready(store)
    expect('lead' in AnnotationStore.stored(uri)[0]).toBe(false)
  })

  it('brings back a track the reader took off the lead', () => {
    const uri = `lead-${Math.random()}.cool`
    const store = freshStore(uri)
    const id = ready(store, 'companion.bw')
    store.unplaceFrom(id, LEAD_MAP)
    expect(AnnotationStore.stored(uri)[0].lead).toBeNull()

    // `placement` still names the edge the track *would* go on, and a restore
    // dutifully put it there: a deck of four came back with the fourth's tracks
    // stacked on the first as well.
    const next = reload(uri, id)
    expect(next.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
    expect(next.entries).toHaveLength(1)
  })

  it('brings back a range set on the lead’s own lane', () => {
    const uri = `lead-${Math.random()}.cool`
    const store = freshStore(uri)
    const id = ready(store)
    // `limits` is one of the two fields a lane may differ on, precisely because
    // a ceiling is a number about one library's depth
    // (`annotations/placement.ts`'s `LANE_OVERRIDES`).
    store.overrideOn(id, LEAD_MAP, { limits: { auto: false, min: 0, max: 42 } })
    expect(AnnotationStore.stored(uri)[0].lead?.style).toEqual({
      limits: { auto: false, min: 0, max: 42 },
    })

    const next = reload(uri, id)
    expect(next.laneFor(id, LEAD_MAP)?.style?.limits).toEqual({ auto: false, min: 0, max: 42 })
    // …and the cascade resolves it over the track, which is what a lane patch is.
    expect(next.entriesOn(LEAD_MAP)[0].style.limits).toEqual({ auto: false, min: 0, max: 42 })
  })

  it('brings back edges the lead alone was given', () => {
    const uri = `lead-${Math.random()}.cool`
    const store = freshStore(uri)
    const id = ready(store)
    store.placeOn(id, LEAD_MAP, placementOn('left'))
    const next = reload(uri, id)
    expect(next.drawnOnMap(LEAD_MAP, 'left')).toHaveLength(1)
    expect(next.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
  })

  it('reads a row from before the field existed as “on the lead, as placement says”', () => {
    // The tolerance an added field promises. Absent is not `null`, and reading
    // the two as one would take every track in every older session off the map.
    const uri = `lead-${Math.random()}.cool`
    const store = freshStore(uri)
    const id = ready(store)
    const row = AnnotationStore.stored(uri)[0]
    const next = freshStore(uri)
    next.begin({
      card: row.card,
      kind: row.kind,
      source: { kind: 'local', file: new File([], 'ATAC.bw'), name: 'ATAC.bw' },
      id,
      placement: row.placement,
      style: row.style,
    })
    expect(next.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
    next.update(id, { status: 'ready' })
    expect(next.laneFor(id, LEAD_MAP)?.placement.bottom).toBe(true)
  })

  it('drops an unreadable lead record rather than the row that carries it', () => {
    // Losing this field costs a lane its edges; losing the row loses the file it
    // names, which is the whole import.
    const uri = `lead-${Math.random()}.cool`
    const store = freshStore(uri)
    const id = ready(store)
    remember(uri, 'annotations', [
      { ...AnnotationStore.stored(uri)[0], lead: 'somewhere' },
    ])
    const back = AnnotationStore.stored(uri)
    expect(back).toHaveLength(1)
    expect(back[0].lead).toBeUndefined()
    expect(back[0].id).toBe(id)
  })
})

/**
 * The name a dropped file gives its row.
 *
 * `cleanLabel` is the default for every import, and its suffix list had drifted
 * behind the formats the app reads: a `.vcf`, a `.bam`, a `.bw`-spelled
 * `.bigbed` and every bedGraph landed as a lane called `NA12878.vcf` while a
 * `.bed` beside it was called `peaks`. Asserted against the formats rather than
 * against a list, so the next one added has somewhere to fail.
 */
describe('the label a file lands under', () => {
  it('takes the suffix off every format the app reads', () => {
    for (const name of [
      'ATAC.bw', 'ATAC.bigwig', 'genes.bb', 'genes.bigbed',
      'genes.gtf', 'genes.gff3', 'peaks.bed', 'loops.bedpe',
      'NA12878.vcf', 'NA12878.vcf.gz', 'reads.bam',
      'peaks.narrowPeak', 'signal.bdg', 'signal.bedgraph', 'signal.wig',
      'genome.fa', 'genome.fasta',
    ]) {
      expect(cleanLabel(name), name).not.toContain('.')
    }
  })

  it('leaves a name that is not a suffix alone', () => {
    // A dot is not a suffix. `Pf3D7.v3.calls` keeps every part of its name.
    expect(cleanLabel('Pf3D7.v3.calls.vcf')).toBe('Pf3D7.v3.calls')
  })
})
