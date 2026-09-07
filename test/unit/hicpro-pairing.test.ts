/**
 * Pairing a HiC-Pro matrix with its bin file (§3.8).
 *
 * The fourth kind of companion these rules handle, and the one whose absence
 * matters most: a `.tbi` is an optimisation and a `.bai` is a format's only
 * bounded read, but an `_abs.bed` is the matrix's *coordinate system*. So the
 * cases below are about the gestures that find it — dropped together, sitting
 * in a connected folder, or named on a URL — and about the one file that must
 * **not** be captured, which is an ordinary BED.
 */

import { describe, expect, it } from 'vitest'

import {
  basesForIndex,
  hicProBinsNames,
  indexNamesFor,
  isHicProMatrix,
  isIndexName,
  pairIndexes,
  splitBinsFragment,
} from '@/annotations/sidecar'
import { routeOf } from '@/browse/route'

/** A `File` in name only, which is all these rules read. */
const file = (name: string): File => new File([''], name)

describe('what a matrix is, by name', () => {
  it.each(['s_100000.matrix', 's_100000_iced.matrix', 's_40000.matrix.gz'])(
    '%s is a contact map, not an unknown',
    (name) => {
      expect(isHicProMatrix(name)).toBe(true)
      expect(routeOf(name)).toBe('map')
    },
  )

  it('a .bed stays on the genome door, because it is also a real BED', () => {
    expect(routeOf('s_100000_abs.bed')).toBe('genome')
  })

  it('reads the name out of a URL that carries a query and a fragment', () => {
    // Both reach `routeOf`: a presigned bucket URL has the first, and a HiC-Pro
    // pair names its bin file in the second — which ends in `.bed`, and sent
    // the *matrix* to the genome door until the fragment was stripped.
    expect(routeOf('https://x/a/s_100000.matrix?X-Amz-Signature=abc')).toBe('map')
    expect(routeOf('https://x/a/s_100000.matrix#bins=https%3A%2F%2Fy%2Fs_abs.bed')).toBe('map')
  })
})

describe('the names either half can look for', () => {
  it('offers a matrix both raw and iced, gzipped or not', () => {
    // One bed per resolution, and `raw/` and `iced/` share it — so a reader who
    // drops the bed may have meant either matrix.
    expect(basesForIndex('s_100000_abs.bed')).toEqual([
      's_100000.matrix',
      's_100000_iced.matrix',
      's_100000.matrix.gz',
      's_100000_iced.matrix.gz',
    ])
  })

  it('strips _iced on the way back, since the bed is the raw one', () => {
    expect(hicProBinsNames('s_100000_iced.matrix')).toEqual([
      's_100000_abs.bed',
      's_100000_abs.bed.gz',
    ])
    expect(indexNamesFor('s_100000.matrix.gz')).toEqual([
      's_100000_abs.bed',
      's_100000_abs.bed.gz',
    ])
  })

  it('does not capture an ordinary BED', () => {
    // The guard that keeps a feature file dropped beside a contact map from
    // being swallowed as its bins.
    expect(isIndexName('genes.bed')).toBe(false)
    expect(isIndexName('peaks_abs_summits.bed')).toBe(false)
    expect(isIndexName('s_100000_abs.bed')).toBe(true)
  })
})

describe('a drop of both halves', () => {
  it('opens the matrix, with the bed attached rather than routed on its own', () => {
    const matrix = file('s_100000.matrix')
    const bins = file('s_100000_abs.bed')
    expect(pairIndexes([matrix, bins])).toEqual([{ file: matrix, index: bins }])
  })

  it('pairs them whichever order they were dropped in', () => {
    const matrix = file('s_100000.matrix')
    const bins = file('s_100000_abs.bed')
    expect(pairIndexes([bins, matrix])).toEqual([{ file: matrix, index: bins }])
  })

  it('pairs the iced matrix with the same bed', () => {
    const iced = file('s_100000_iced.matrix')
    const bins = file('s_100000_abs.bed')
    expect(pairIndexes([iced, bins])).toEqual([{ file: iced, index: bins }])
  })

  it('leaves a lone bed to be routed as the track it also is', () => {
    // Not swallowed and not refused: an `_abs.bed` with no matrix beside it is
    // a perfectly good BED4, and dropping one should draw it.
    const bins = file('s_100000_abs.bed')
    expect(pairIndexes([bins])).toEqual([{ file: bins }])
  })

  it('keeps a BAM and its index working alongside', () => {
    // The rules are shared, so the fourth companion must not disturb the three.
    const bam = file('reads.bam')
    const bai = file('reads.bam.bai')
    const matrix = file('s_100000.matrix')
    const bins = file('s_100000_abs.bed')
    expect(pairIndexes([bam, bai, matrix, bins])).toEqual([
      { file: bam, index: bai },
      { file: matrix, index: bins },
    ])
  })
})

describe('naming the bin file on a URL', () => {
  it('splits the fragment off, decoded', () => {
    const { address, bins } = splitBinsFragment(
      'https://x/s.matrix#bins=https%3A%2F%2Fy%2Fs_abs.bed',
    )
    expect(address).toBe('https://x/s.matrix')
    expect(bins).toBe('https://y/s_abs.bed')
  })

  it('takes an undecodable fragment as written rather than throwing', () => {
    // A stray `%` in a URL box must not stop the box responding.
    expect(splitBinsFragment('https://x/s.matrix#bins=a%b').bins).toBe('a%b')
  })

  it('leaves a URL with no fragment alone', () => {
    expect(splitBinsFragment('https://x/s.matrix')).toEqual({ address: 'https://x/s.matrix' })
  })
})
