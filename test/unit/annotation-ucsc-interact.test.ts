/**
 * `interact`, `bigInteract` and `longrange` — the two spellings of an
 * interaction (§8.18).
 *
 * The claims here are mostly about what these files were doing *before* they
 * were recognised, because that is what decides whether this feature is a
 * convenience or a correctness fix. Both formats are BED-shaped enough to reach
 * `sniffFormat`, whose last line is `return 'bed'`, so neither was refused:
 *
 * - an `interact` whose `value` is fractional was drawn as **one box spanning
 *   both anchors and the gap between them**;
 * - an `interact` whose `value` happens to be a whole number matched the bedpe
 *   rule — column 3 not an integer, columns 4 and 5 integers — and was read as a
 *   **bedpe**, putting the interaction's name in the second contig and its
 *   0–1000 score in the second start. Arcs between coordinates that were never
 *   in the file.
 * - a `longrange` was a BED4 whose *names* were the coordinates of the arcs.
 *
 * So the first test in each group pins the sniffer's precedence, and the rest
 * pin the reading.
 */

import { describe, expect, it } from 'vitest'

import {
  interactSummary,
  isInteractSchema,
  parseInteract,
  sniffInteract,
} from '@/annotations/interact'
import { longRangeSummary, parseLongRange, sniffLongRange } from '@/annotations/longrange'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffFormat } from '@/annotations/parse'
import { sniffSignal } from '@/annotations/signal'
import { sniffBarChart } from '@/annotations/barchart'
import { sniffVcf } from '@/annotations/vcf'
import { routeOf } from '@/browse/route'
import type { PairSet } from '@/annotations/types'

/** UCSC's own example shape: BED5+13, `value` written with decimals. */
const INTERACT = [
  'chr1\t1000\t20000\tregion1\t500\t5.000000\texpA\t#0000FF\tchr1\t1000\t2000\tprom1\t+\tchr1\t19000\t20000\tenh1\t-',
  'chr1\t3000\t40000\tregion2\t250\t2.500000\texpA\t#0000FF\tchr1\t3000\t4000\tprom2\t.\tchr1\t39000\t40000\tenh2\t.',
].join('\n')

/** The same file with a whole-number `value` — the row that used to become a bedpe. */
const INTERACT_WHOLE = [
  'chr1\t1000\t20000\tregion1\t500\t3\texpA\t#0000FF\tchr1\t1000\t2000\tprom1\t+\tchr1\t19000\t20000\tenh1\t-',
].join('\n')

/** A trans interaction: `chrom` bounds only the end that is on it. */
const INTERACT_TRANS = [
  'chr1\t1000\t2000\tacross\t500\t9\texpA\t#0000FF\tchr1\t1000\t2000\tleft\t+\tchr7\t500000\t501000\tright\t-',
].join('\n')

const LONGRANGE = [
  'chr1\t1000\t2000\tchr1:19000-20000,3.5',
  'chr1\t19000\t20000\tchr1:1000-2000,3.5',
  'chr1\t3000\t4000\tchr1:39000-40000,2.1',
  'chr1\t39000\t40000\tchr1:3000-4000,2.1',
].join('\n')

function pairAt(set: PairSet, at: number): Record<string, unknown> {
  return {
    contig1: set.contigs[set.contig1[at]],
    start1: set.start1[at],
    end1: set.end1[at],
    contig2: set.contigs[set.contig2[at]],
    start2: set.start2[at],
    end2: set.end2[at],
    score: set.score[at],
  }
}

describe('interact', () => {
  it('is recognised before every sniffer that would take it', () => {
    expect(sniffInteract(INTERACT, 'loops.interact')).toBe(true)
    expect(sniffInteract(INTERACT_WHOLE, 'loops.interact')).toBe(true)
    // …and the ones it has to beat. Each of these used to win.
    expect(sniffFormat(INTERACT)).toBe('bed')
    expect(sniffFormat(INTERACT_WHOLE)).toBe('bedpe')
    // …while none of the sniffers asked *before* it takes it.
    expect(sniffVcf(INTERACT)).toBe(false)
    expect(sniffBarChart(INTERACT)).toBe(false)
    expect(sniffSignal(INTERACT)).toBe(null)
  })

  it('is recognised without the name, from the columns alone', () => {
    expect(sniffInteract(INTERACT)).toBe(true)
  })

  it('does not take a BED, a bedpe or a BED12', () => {
    expect(sniffInteract('chr1\t100\t200\tpeak\t500\t+')).toBe(false)
    expect(sniffInteract('chr1\t100\t200\tchr1\t900\t1000\tloop\t30')).toBe(false)
    expect(
      sniffInteract(
        'chr1\t1000\t20000\tgene\t0\t+\t1200\t19000\t0\t3\t1000,1000,2000,\t0,4000,17000,',
      ),
    ).toBe(false)
    // Eighteen columns, but the bounding span does not bound its own anchors.
    expect(
      sniffInteract(
        'chr1\t1000\t2000\tx\t500\t5\te\t#000\tchr1\t50000\t51000\ta\t+\tchr1\t60000\t61000\tb\t-',
      ),
    ).toBe(false)
  })

  it('reads both anchors, not the span between them', () => {
    const set = parseInteract(INTERACT)
    expect(set.length).toBe(2)
    expect(pairAt(set, 0)).toEqual({
      contig1: 'chr1',
      start1: 1000,
      end1: 2000,
      contig2: 'chr1',
      start2: 19000,
      end2: 20000,
      // `value`, not the 0–1000 display score beside it.
      score: 5,
    })
  })

  it('keeps a trans interaction as two contigs', () => {
    const set = parseInteract(INTERACT_TRANS)
    expect(pairAt(set, 0)).toMatchObject({ contig1: 'chr1', contig2: 'chr7', start2: 500000 })
    expect(interactSummary(set)).toContain('1 between sequences')
  })

  it('carries the names, the experiment and the direction into the detail', () => {
    const set = parseInteract(INTERACT)
    expect(set.name[0]).toBe('region1')
    expect(set.detail[0]).toContain('exp expA')
    expect(set.detail[0]).toContain('prom1 → enh1')
    expect(set.detail[0]).toContain('strands +-')
  })

  it('names the two ends when the row has no name of its own', () => {
    const anonymous = INTERACT.replace('region1', '.')
    expect(parseInteract(anonymous).name[0]).toBe('prom1/enh1')
  })

  it('is spotted in a bigBed by its schema, not by its shape', () => {
    expect(
      isInteractSchema('table interact\n"..."\n( string chrom; ... string sourceChrom; string targetChrom; )'),
    ).toBe(true)
    // bigGenePred and bigBarChart must not match it.
    expect(isInteractSchema('table bigGenePred\n( string chrom; string name2; )')).toBe(false)
    expect(isInteractSchema('table barChart\n( uint expCount; float[expCount] expScores; )')).toBe(
      false,
    )
  })

  it('is drawn as arcs, on the same card a bedpe is', () => {
    expect(cardFor('interact')).toBe('overlay')
    expect(kindFor('overlay', 'interact')).toBe('pairs')
    expect(kindFor('overlay', 'bedpe')).toBe('pairs')
  })

  it('is routed to the genome door by name', () => {
    expect(routeOf('https://host/loops.interact')).toBe('genome')
    expect(routeOf('https://host/loops.bigInteract')).toBe('genome')
  })
})

describe('longrange', () => {
  it('is recognised before the BED and signal sniffers', () => {
    expect(sniffLongRange(LONGRANGE)).toBe(true)
    expect(sniffFormat(LONGRANGE)).toBe('bed')
    // A bedGraph is also four columns; the two cannot capture each other.
    expect(sniffSignal(LONGRANGE)).toBe(null)
    expect(sniffLongRange('chr1\t100\t200\t3.5')).toBe(false)
  })

  it('folds the reciprocal line the format writes for tabix', () => {
    const set = parseLongRange(LONGRANGE)
    // Four lines, two interactions.
    expect(set.length).toBe(2)
    expect(longRangeSummary(set)).toContain('2 interactions')
    expect(longRangeSummary(set)).toContain('2 reciprocal lines folded in')
  })

  it('keeps two interactions over the same anchors when their scores differ', () => {
    const set = parseLongRange(
      ['chr1\t1000\t2000\tchr1:19000-20000,3.5', 'chr1\t1000\t2000\tchr1:19000-20000,9.5'].join(
        '\n',
      ),
    )
    expect(set.length).toBe(2)
  })

  it('reads the far end out of the fourth column', () => {
    const set = parseLongRange('chr1\t1000\t2000\tchr7:19000-20000,3.5')
    expect(pairAt(set, 0)).toEqual({
      contig1: 'chr1',
      start1: 1000,
      end1: 2000,
      contig2: 'chr7',
      start2: 19000,
      end2: 20000,
      score: 3.5,
    })
  })

  it('reads a row with no score rather than refusing it', () => {
    const set = parseLongRange('chr1\t1000\t2000\tchr1:19000-20000')
    expect(set.length).toBe(1)
    expect(Number.isNaN(set.score[0])).toBe(true)
  })

  it('is drawn as arcs', () => {
    expect(cardFor('longrange')).toBe('overlay')
    expect(kindFor('overlay', 'longrange')).toBe('pairs')
  })
})
