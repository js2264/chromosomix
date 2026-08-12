/**
 * bedGraph and wig, read back as the tracks they are.
 *
 * The asymmetry this closes is worth stating once in the suite as well as in the
 * module: **the app wrote bedGraph and could not read one.** Every analysis
 * result offers the button, and dropping the file back produced a lane of grey
 * boxes — the four-column value landed in `name`, because a bedGraph is
 * BED-shaped and the sniffer knew three formats. Silently. So the first thing
 * tested here is the sniffer's ability to tell the two apart, in both
 * directions, since a rule that captures real BEDs would be a worse bug than the
 * one it fixes.
 */

import { describe, expect, it } from 'vitest'

import {
  IntervalTrack,
  parseBedGraph,
  parseWig,
  sniffSignal,
  type SignalSet,
} from '@/annotations/signal'
import { sniffFormat } from '@/annotations/parse'

const BEDGRAPH = ['chr1\t0\t100\t1.5', 'chr1\t100\t200\t3', 'chr1\t200\t300\t0.5', 'chr2\t0\t50\t9'].join(
  '\n',
)

describe('telling a signal file from a feature file', () => {
  it('recognises a bare four-column bedGraph', () => {
    expect(sniffSignal(BEDGRAPH)).toBe('bedgraph')
  })

  it('recognises one that declares itself', () => {
    const declared = `track type=bedGraph name="coverage"\nchr1\t0\t100\t2\n`
    expect(sniffSignal(declared)).toBe('bedgraph')
  })

  it('recognises both wig step styles', () => {
    expect(sniffSignal('fixedStep chrom=chr1 start=1 step=10\n1\n2\n3\n')).toBe('wig')
    expect(sniffSignal('variableStep chrom=chr1 span=5\n1\t3\n11\t4\n')).toBe('wig')
  })

  it('leaves a real BED alone, which is the half that could do harm', () => {
    // BED4: column four is a *name*. Capturing this would turn every peak set
    // into a signal track with NaN everywhere.
    expect(sniffSignal('chr1\t0\t100\tpeak1\nchr1\t200\t300\tpeak2\n')).toBeNull()
    // BED6: five and six columns, so the width test rejects it before the
    // numeric test is even asked.
    expect(sniffSignal('chr1\t0\t100\tpeak1\t500\t+\n')).toBeNull()
    // narrowPeak.
    expect(
      sniffSignal('chr1\t0\t100\tpeak1\t500\t.\t7.1\t3.2\t2.8\t50\n'),
    ).toBeNull()
    // GTF.
    expect(
      sniffSignal('chr1\tsrc\tgene\t100\t200\t.\t+\t.\tgene_id "a";\n'),
    ).toBeNull()
  })

  it('does not capture a three-column BED either', () => {
    expect(sniffSignal('chr1\t0\t100\nchr1\t200\t300\n')).toBeNull()
  })

  it('is the stricter of the two sniffers, which is why it is asked first', () => {
    // The overlap that made this necessary: the feature sniffer calls a bedGraph
    // a BED, confidently, and always has.
    expect(sniffFormat(BEDGRAPH)).toBe('bed')
    expect(sniffSignal(BEDGRAPH)).toBe('bedgraph')
  })
})

describe('parsing a bedGraph', () => {
  it('keeps the values, the bounds and the extent', () => {
    const set = parseBedGraph(BEDGRAPH)
    expect(set.length).toBe(4)
    expect(set.contigs.map((contig) => contig.name)).toEqual(['chr1', 'chr2'])
    expect(Array.from(set.contigs[0].starts)).toEqual([0, 100, 200])
    expect(Array.from(set.contigs[0].ends)).toEqual([100, 200, 300])
    expect(Array.from(set.contigs[0].values)).toEqual([1.5, 3, 0.5])
    expect(set.min).toBe(0.5)
    expect(set.max).toBe(9)
  })

  it('sorts a file somebody concatenated out of order', () => {
    const set = parseBedGraph('chr1\t200\t300\t2\nchr1\t0\t100\t1\n')
    expect(Array.from(set.contigs[0].starts)).toEqual([0, 200])
    expect(Array.from(set.contigs[0].values)).toEqual([1, 2])
  })

  it('skips the lines a real file carries and keeps going past a bad one', () => {
    const set = parseBedGraph(
      ['#comment', 'browser position chr1', 'track type=bedGraph', 'chr1\t0\t10\t1', 'garbage', 'chr1\t10\t20\t2'].join('\n'),
    )
    expect(set.length).toBe(2)
  })

  it('drops an empty or inverted interval rather than drawing one', () => {
    expect(parseBedGraph('chr1\t100\t100\t5\nchr1\t300\t200\t5\n').length).toBe(0)
  })
})

describe('parsing a wig', () => {
  it('converts fixedStep from 1-based inclusive to 0-based half-open', () => {
    const set = parseWig('fixedStep chrom=chr1 start=1 step=10 span=10\n1\n2\n3\n')
    // Position 1 in the file is base 0 here. Getting this wrong shifts a whole
    // track by one base — invisible at any zoom that does not matter, and wrong
    // at the one that does.
    expect(Array.from(set.contigs[0].starts)).toEqual([0, 10, 20])
    expect(Array.from(set.contigs[0].ends)).toEqual([10, 20, 30])
    expect(Array.from(set.contigs[0].values)).toEqual([1, 2, 3])
  })

  it('honours a start that is not 1', () => {
    const set = parseWig('fixedStep chrom=chr1 start=101 step=5 span=5\n7\n')
    expect(Array.from(set.contigs[0].starts)).toEqual([100])
    expect(Array.from(set.contigs[0].ends)).toEqual([105])
  })

  it('reads variableStep, with span sticky across the section', () => {
    const set = parseWig('variableStep chrom=chr2 span=4\n1\t8\n21\t9\n')
    expect(Array.from(set.contigs[0].starts)).toEqual([0, 20])
    expect(Array.from(set.contigs[0].ends)).toEqual([4, 24])
    expect(Array.from(set.contigs[0].values)).toEqual([8, 9])
  })

  it('carries several sections, and several contigs', () => {
    const set = parseWig(
      [
        'fixedStep chrom=chr1 start=1 step=1',
        '1',
        '2',
        'variableStep chrom=chr2',
        '5\t7',
      ].join('\n'),
    )
    expect(set.contigs.map((contig) => contig.name).sort()).toEqual(['chr1', 'chr2'])
    expect(set.length).toBe(3)
  })

  it('defaults span and step to one, as the specification says', () => {
    const set = parseWig('fixedStep chrom=chr1\n5\n6\n')
    expect(Array.from(set.contigs[0].starts)).toEqual([0, 1])
    expect(Array.from(set.contigs[0].ends)).toEqual([1, 2])
  })
})

describe('sampling a signal track', () => {
  const set: SignalSet = parseBedGraph(
    Array.from({ length: 100 }, (_, i) => `chr1\t${i * 10}\t${i * 10 + 10}\t${i}`).join('\n'),
  )
  const track = new IntervalTrack(set)

  it('returns the intervals themselves where they fit the pixels', () => {
    const got = track.samples('chr1', 0, 100, 1)
    expect(got).not.toBeNull()
    expect(got?.summary).toBe(false)
    expect(Array.from(got?.values ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('bins to the pixel grid when there are more intervals than pixels', () => {
    // 1,000 bases over 10 pixels: each pixel covers ten intervals.
    const got = track.samples('chr1', 0, 1000, 100)
    expect(got?.summary).toBe(true)
    expect(got?.values.length).toBe(10)
    // The first pixel covers values 0..9, whose base-weighted mean is 4.5 —
    // every interval being the same width here, so the weighting is not what is
    // under test; the *bin membership* is.
    expect(got?.values[0]).toBeCloseTo(4.5, 5)
    expect(got?.min?.[0]).toBe(0)
    expect(got?.max?.[0]).toBe(9)
    expect(got?.values[9]).toBeCloseTo(94.5, 5)
  })

  it('weights the mean by covered bases, not by interval count', () => {
    // One wide interval at 1 and one narrow at 100. An unweighted mean is 50.5
    // and describes the file's segmentation; the weighted mean is the signal.
    const uneven = new IntervalTrack(parseBedGraph('chr1\t0\t99\t1\nchr1\t99\t100\t100\n'))
    const binned = uneven.samples('chr1', 0, 100, 1000)
    expect(binned?.summary).toBe(true)
    expect(binned?.values.length).toBe(1)
    expect(binned?.values[0]).toBeCloseTo((99 * 1 + 1 * 100) / 100, 5)
    // The envelope keeps both, which is what the summary is for: a mean of 1.99
    // with no min and max would hide the spike entirely.
    expect(binned?.min?.[0]).toBe(1)
    expect(binned?.max?.[0]).toBe(100)
  })

  it('answers nothing, rather than failing, for a contig it does not hold', () => {
    expect(track.samples('chrZ', 0, 100, 1)).toBeNull()
    expect(track.has('chr1')).toBe(true)
    expect(track.has('chrZ')).toBe(false)
  })

  it('returns an empty window inside a contig it does hold', () => {
    const sparse = new IntervalTrack(parseBedGraph('chr1\t0\t10\t1\n'))
    const got = sparse.samples('chr1', 500, 600, 1)
    expect(got?.values.length).toBe(0)
  })

  it('reports the whole-file extent, for the starting clip', () => {
    expect(track.extent).toEqual({ min: 0, max: 99 })
    expect(track.length).toBe(100)
    expect(track.contigNames).toEqual(['chr1'])
  })
})
