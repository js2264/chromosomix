/**
 * Saving hand-drawn marks, and reading them back.
 *
 * The property worth having is the round trip: what the Manual card writes must
 * be something this app's own loader sniffs, parses and draws — otherwise
 * "export" means "a file, somewhere, in a format nobody promised". So these
 * tests do not assert on the text alone; they push it back through
 * `sniffFormat` and the parsers the annotation cards use.
 *
 * BED is half-open, so a mark on one base is `[bp, bp + 1)`. That is the whole
 * of the coordinate contract, and it is the one thing a careless writer gets
 * wrong in a way no reader complains about.
 */

import { describe, expect, it } from 'vitest'

import { formatMarks, marksFor, readMarks } from '@/annotations/export'
import { ManualStore, type ManualMark } from '@/annotations/manual'
import { parseBed, parseBedpe, sniffFormat } from '@/annotations/parse'

const MARKS: ManualMark[] = [
  { id: 'm1', kind: 'line', axis: 'vertical', at: { contig: 'I', bp: 120_000 }, colour: '#111318' },
  { id: 'm2', kind: 'line', axis: 'both', at: { contig: 'XIII-syn40', bp: 964_431 }, colour: '#c0392b' },
  {
    id: 'm3',
    kind: 'arrowhead',
    a: { contig: 'I', bp: 1_000 },
    b: { contig: 'IV', bp: 2_000 },
    colour: '#1f5fa9',
  },
  {
    id: 'm4',
    kind: 'rect',
    a: { contig: 'I', from: 120_000, to: 180_000 },
    b: { contig: 'IV', from: 340_000, to: 400_000 },
    colour: '#0f8a5f',
  },
]

describe('marksFor', () => {
  it('sends each kind to the file that can hold it', () => {
    expect(marksFor(MARKS, 'bed').map((mark) => mark.id)).toEqual(['m1', 'm2'])
    // A loop and a box are both a pair of places, which is one row shape and one
    // file: what differs is how wide each anchor is, and that is a number in a
    // column rather than a format.
    expect(marksFor(MARKS, 'bedpe').map((mark) => mark.id)).toEqual(['m3', 'm4'])
  })
})

describe('formatMarks', () => {
  it('writes lines as BED, one base wide and half-open', () => {
    const text = formatMarks(MARKS, 'bed')
    const rows = text.trim().split('\n').filter((line) => !line.startsWith('#'))
    expect(rows).toEqual(['I\t120000\t120001\tvertical\t0\t.', 'XIII-syn40\t964431\t964432\tboth\t0\t.'])
  })

  it('writes loops as BEDPE, both anchors on their own contig', () => {
    const text = formatMarks(MARKS, 'bedpe')
    const rows = text.trim().split('\n').filter((line) => !line.startsWith('#'))
    // A loop's anchors are the one base each names; a box's are the two
    // stretches it was drawn across, which is what BEDPE's six coordinate
    // columns are for — the row is the box, not a summary of it.
    expect(rows).toEqual([
      'I\t1000\t1001\tIV\t2000\t2001\tm3\t0\t.\t.',
      'I\t120000\t180000\tIV\t340000\t400000\tm4\t0\t.\t.',
    ])
  })

  it('never writes an empty interval for a box drawn inside one bin', () => {
    // `chr 100 100` is a row half the tools in this field drop.
    const text = formatMarks(
      [
        {
          id: 'm5',
          kind: 'rect',
          a: { contig: 'I', from: 100, to: 100 },
          b: { contig: 'I', from: 100, to: 100 },
          colour: '#000',
        },
      ],
      'bedpe',
    )
    expect(text.trim().split('\n')[1]).toBe('I\t100\t101\tI\t100\t101\tm5\t0\t.\t.')
  })

  it('carries where it came from, as a comment every reader skips', () => {
    const text = formatMarks(MARKS, 'bed', { file: 'yeast.cool', created: '20260804-160000' })
    expect(text.split('\n')[0]).toBe(
      '# chromosomix manual annotations from yeast.cool on 20260804-160000',
    )
  })

  it('writes a header and no rows rather than nothing at all', () => {
    const text = formatMarks([], 'bed')
    expect(text.trim().split('\n')).toEqual(['# chromosomix manual annotations'])
  })
})

describe('the round trip', () => {
  it('comes back through the sniffer as the format it claims', () => {
    expect(sniffFormat(formatMarks(MARKS, 'bed'), 'marks.bed')).toBe('bed')
    expect(sniffFormat(formatMarks(MARKS, 'bedpe'), 'marks.bedpe')).toBe('bedpe')
  })

  it('reloads as the same coordinates the marks were drawn at', () => {
    // `contig` is an index into `contigs`, which is how both parsers hand back
    // names: the file's own order, resolved once rather than per feature.
    const features = parseBed(formatMarks(MARKS, 'bed'), 'marks.bed')
    expect(features.length).toBe(2)
    expect(features.contigs[features.contig[0]]).toBe('I')
    expect(features.start[0]).toBe(120_000)
    expect(features.end[0]).toBe(120_001)
    expect(features.contigs[features.contig[1]]).toBe('XIII-syn40')
    expect(features.start[1]).toBe(964_431)
    // The axis rides in the name column, so a re-imported line still knows
    // which way it was drawn.
    expect(features.name).toEqual(['vertical', 'both'])

    const pairs = parseBedpe(formatMarks(MARKS, 'bedpe'))
    expect(pairs.length).toBe(2)
    expect(pairs.contigs[pairs.contig1[0]]).toBe('I')
    expect(pairs.start1[0]).toBe(1_000)
    expect(pairs.contigs[pairs.contig2[0]]).toBe('IV')
    expect(pairs.start2[0]).toBe(2_000)
    // A box keeps its width through the trip: the anchors come back as the
    // stretches it was drawn across rather than as the points a loop has.
    expect([pairs.start1[1], pairs.end1[1]]).toEqual([120_000, 180_000])
    expect([pairs.start2[1], pairs.end2[1]]).toEqual([340_000, 400_000])
  })
})

describe('readMarks', () => {
  const strip = (marks: readonly ManualMark[]): unknown[] =>
    marks.map(({ id: _id, colour: _colour, ...rest }) => rest)

  it('gives back every kind the export wrote, with each line on its own axis', () => {
    const text = formatMarks(MARKS, 'bed') + formatMarks(MARKS, 'bedpe')
    const { marks, skipped } = readMarks(text)
    expect(skipped).toBe(0)
    expect(marks).toEqual(strip(MARKS))
  })

  it('reads any BED as crosshairs at each start, and counts what it could not read', () => {
    const { marks, skipped } = readMarks(
      'track name=peaks\nchrI\t100\t500\tpeak_1\t12\t+\nchrII 7 9\nnonsense\n',
    )
    expect(marks).toEqual([
      { kind: 'line', axis: 'both', at: { contig: 'chrI', bp: 100 } },
      { kind: 'line', axis: 'both', at: { contig: 'chrII', bp: 7 } },
    ])
    expect(skipped).toBe(1)
  })

  it('does not add a mark twice when the same file comes in again', () => {
    const store = new ManualStore(`import-${Math.random()}.cool`)
    const { marks } = readMarks(formatMarks(MARKS, 'bed') + formatMarks(MARKS, 'bedpe'))
    expect(store.addAll(marks)).toBe(4)
    expect(store.addAll(marks)).toBe(0)
    expect(store.marks).toHaveLength(4)
    expect(new Set(store.marks.map((mark) => mark.id)).size).toBe(4)
  })
})
