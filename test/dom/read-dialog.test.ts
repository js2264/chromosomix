// @vitest-environment jsdom
/**
 * What a click on a read puts in front of the reader.
 *
 * A read is a worse tooltip subject than a gene and a better card subject: what
 * anyone wants from one is its flags, its CIGAR and where its mate went, and
 * none of those fits in two lines following a pointer. So the design question
 * this file pins is *which facts the card is willing to invent*. A BAM record
 * carries several fields that mean "not recorded" rather than a value —
 * `tlen: 0`, `mapq: 255`, an absent mate — and a card that printed them as
 * numbers would be asserting measurements nobody made.
 *
 * Every field here comes out of the pile the lane already drew. Nothing is
 * fetched, which is why a click answers at once, and why the card cannot
 * disagree with the rectangle that was clicked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FLAG } from '@/annotations/bam/format'
import { openReadDialog } from '@/ui/ReadDialog'
import type { ReadPile } from '@/annotations/types'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

function rowsOf(root: ParentNode): Map<string, string> {
  const keys = textsOf(root, '.feature-key')
  const values = textsOf(root, '.feature-val')
  return new Map(keys.map((key, i) => [key, values[i] ?? '']))
}

interface Spec {
  start: number
  end: number
  flags?: number
  mapq?: number
  tlen?: number
  mateContig?: number
  matePos?: number
  ops?: Array<[number, number]>
  clipStart?: number
  clipEnd?: number
  diffs?: number
  group?: number
  groups?: string[]
  name?: string
}

function pileOf(spec: Spec): ReadPile {
  const ops = spec.ops ?? [[0, spec.end - spec.start]]
  return {
    contig: 'chrI',
    start: 0,
    end: 10_000,
    length: 1,
    refStart: Int32Array.of(spec.start),
    refEnd: Int32Array.of(spec.end),
    clipStart: Int32Array.of(spec.clipStart ?? 0),
    clipEnd: Int32Array.of(spec.clipEnd ?? 0),
    row: Int16Array.of(0),
    flags: Uint16Array.of(spec.flags ?? 0),
    mapq: Uint8Array.of(spec.mapq ?? 60),
    mateContig: Int32Array.of(spec.mateContig ?? -1),
    matePos: Int32Array.of(spec.matePos ?? -1),
    tlen: Int32Array.of(spec.tlen ?? 0),
    group: Uint8Array.of(spec.group ?? 0),
    mate: Int32Array.of(-1),
    opAt: Int32Array.of(0, ops.length),
    opCode: Uint8Array.from(ops.map(([code]) => code)),
    opLen: Int32Array.from(ops.map(([, length]) => length)),
    diffAt: Int32Array.of(0, spec.diffs ?? 0),
    diffPos: new Int32Array(spec.diffs ?? 0),
    diffBase: new Uint8Array(spec.diffs ?? 0),
    contigs: ['chrI', 'chrII'],
    groups: spec.groups ?? ['reads'],
    names: [spec.name ?? 'HWI-1:2:3:4:5'],
  }
}

function open(spec: Spec, source = 'sample.bam'): { rows: Map<string, string>; title: string } {
  const modal = openReadDialog({ pile: pileOf(spec), index: 0, source })
  const root = document.body
  const title = root.querySelector('.modal-title')?.textContent ?? ''
  const rows = rowsOf(root)
  modal.close()
  return { rows, title }
}

describe('what the card leads with', () => {
  it('is the read’s own name, which is what was clicked', () => {
    expect(open({ start: 1000, end: 1100, name: 'HWI-7:1101:2:3' }).title).toBe('HWI-7:1101:2:3')
  })

  it('repeats the name in the body, where the case survives and it can be copied', () => {
    // The heading is uppercased by the house style, and a read name is a
    // case-sensitive identifier somebody pastes into `samtools view | grep`.
    const { rows } = open({ start: 1000, end: 1100, name: 'hwi-7:1101:2:3' })
    expect(rows.get('name')).toBe('hwi-7:1101:2:3')
  })

  it('writes no name row for a pile that kept none', () => {
    expect(open({ start: 1000, end: 1100, name: '' }).rows.has('name')).toBe(false)
  })

  it('falls back to a word rather than an empty heading', () => {
    expect(open({ start: 1000, end: 1100, name: '' }).title).toBe('Read')
  })

  // A plain hyphen, through `formatLocus`: §26.1 gives a locus one spelling and
  // keeps the en dash for a range of *values*, so a window wearing one read as a
  // quantity.
  it('gives the position 1-based, as a reader would write it', () => {
    const { rows } = open({ start: 1000, end: 1100 })
    expect(rows.get('position')).toBe('chrI:1,001-1,100')
  })

  it('calls the extent an aligned span, because a spliced read is not that long', () => {
    // A read across a 5 kb intron covers five kilobases and is 100 bases long.
    // "length" would be the card asserting the wrong one of those.
    const { rows } = open({
      start: 1000,
      end: 6100,
      ops: [[0, 50], [3, 5000], [0, 50]],
    })
    expect(rows.has('length')).toBe(false)
    expect(rows.get('aligned span')).toBe('5.1 kb')
    expect(rows.get('CIGAR')).toBe('50M5000N50M')
  })
})

describe('the flags', () => {
  it('names every bit that is set and keeps the number', () => {
    // The number is what gets pasted into `samtools view -f`, so hiding it
    // would be a card the reader has to work around.
    const flags = FLAG.PAIRED | FLAG.PROPER_PAIR | FLAG.REVERSE | FLAG.SECOND_IN_PAIR
    const { rows } = open({ start: 1000, end: 1100, flags })
    expect(rows.get('flags')).toBe(`paired, proper pair, reverse, second in pair (${flags})`)
    expect(rows.get('strand')).toBe('reverse (−)')
  })

  it('lists no bits rather than twelve rows saying no', () => {
    expect(open({ start: 1000, end: 1100, flags: 0 }).rows.get('flags')).toBe('none (0)')
  })

  it('says which reads are the pieces of a split one', () => {
    const flags = FLAG.PAIRED | FLAG.FIRST_IN_PAIR | FLAG.SUPPLEMENTARY
    expect(open({ start: 1000, end: 1100, flags }).rows.get('flags')).toContain('supplementary')
  })
})

describe('the fields that mean "not recorded"', () => {
  it('does not print an insert size a single-ended record never had', () => {
    expect(open({ start: 1000, end: 1100, tlen: 0 }).rows.has('insert size')).toBe(false)
    expect(open({ start: 1000, end: 1100, tlen: -320 }).rows.get('insert size')).toBe('320 bp')
  })

  it('says 255 is not a mapping quality, because in SAM it is not', () => {
    expect(open({ start: 1000, end: 1100, mapq: 255 }).rows.get('mapping quality')).toBe(
      'not available (255)',
    )
    expect(open({ start: 1000, end: 1100, mapq: 0 }).rows.get('mapping quality')).toBe('0')
  })

  it('distinguishes the three things a missing mate can mean', () => {
    expect(open({ start: 1000, end: 1100, flags: 0 }).rows.get('mate')).toBe('unpaired')
    expect(
      open({ start: 1000, end: 1100, flags: FLAG.PAIRED | FLAG.MATE_UNMAPPED }).rows.get('mate'),
    ).toBe('unmapped')
    expect(open({ start: 1000, end: 1100, flags: FLAG.PAIRED }).rows.get('mate')).toBe(
      'not recorded',
    )
  })

  it('marks a mate on another sequence, which is the whole point of asking', () => {
    const here = open({
      start: 1000,
      end: 1100,
      flags: FLAG.PAIRED,
      mateContig: 0,
      matePos: 4999,
    })
    expect(here.rows.get('mate')).toBe('chrI:5,000 (forward)')

    const away = open({
      start: 1000,
      end: 1100,
      flags: FLAG.PAIRED | FLAG.MATE_REVERSE,
      mateContig: 1,
      matePos: 77,
    })
    expect(away.rows.get('mate')).toBe('chrII:78 (reverse, other sequence)')
  })

  it('omits mismatches and clips where there are none', () => {
    const plain = open({ start: 1000, end: 1100 }).rows
    expect(plain.has('mismatches')).toBe(false)
    expect(plain.has('soft clipped')).toBe(false)

    const marked = open({ start: 1000, end: 1100, diffs: 3, clipStart: 8, clipEnd: 0 }).rows
    expect(marked.get('mismatches')).toBe('3')
    expect(marked.get('soft clipped')).toBe('8 before, 0 after')
  })
})

describe('what it says about the lane', () => {
  it('names the category the read was coloured as, once there is more than one', () => {
    const { rows } = open({
      start: 1000,
      end: 1100,
      group: 1,
      groups: ['forward', 'reverse'],
    })
    expect(rows.get('group')).toBe('reverse')
  })

  it('says nothing about a group when the lane is one colour', () => {
    expect(open({ start: 1000, end: 1100 }).rows.has('group')).toBe(false)
  })

  it('names the track last, which is where the question is asked from', () => {
    const modal = openReadDialog({
      pile: pileOf({ start: 1000, end: 1100 }),
      index: 0,
      source: 'Pol2 ChIP',
    })
    expect([...rowsOf(document.body).keys()].pop()).toBe('track')
    expect(rowsOf(document.body).get('track')).toBe('Pol2 ChIP')
    modal.close()
  })
})

describe('the zoom button', () => {
  it('is offered only where the view has somewhere to take it', () => {
    const without = openReadDialog({ pile: pileOf({ start: 1000, end: 1100 }), index: 0, source: 'x' })
    expect(document.querySelector('.feature-foot .btn')).toBeNull()
    without.close()

    let went = 0
    const with_ = openReadDialog({
      pile: pileOf({ start: 1000, end: 1100 }),
      index: 0,
      source: 'x',
      onGoTo: () => {
        went++
      },
    })
    const button = document.querySelector('.feature-foot .btn') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button?.click()
    expect(went).toBe(1)
    // Pressing it closes the card: the reader asked to look at the picture.
    expect(document.querySelector('.modal-panel')).toBeNull()
    with_.close()
  })
})
