/**
 * The colour a called variant is drawn in, and the one column it has to agree in.
 *
 * The whole argument for the rule is vertical. Open a FASTA, a BAM and a VCF
 * over one locus and a heterozygous A>G should read as one column in three inks
 * that agree: the sequence row writes a green `A`, the pile puts blue `G` marks
 * through half its reads, and the variant row draws a blue box. That only holds
 * if all three read the same table, which is what these pin — an equality
 * against `BASE_COLOURS`, not a literal, so a second palette cannot appear
 * without failing here.
 */

import { describe, expect, it } from 'vitest'

import { BASE_COLOURS } from '@/render/sequence'
import { variantInk, VARIANT_MIN_WIDTH } from '@/render/variants'

const LANE = '#1f5fa9'

/** A detail string as `parseVcf` writes one. */
function detail(ref: string, alt: string, rest = ''): string {
  return `${ref}>${alt} · type snv${rest}`
}

describe('the ink a variant takes', () => {
  it('gives a substitution the colour of the base it substitutes to', () => {
    // Against the table itself. A literal here would pass while the sequence
    // lane drew something else.
    for (const [at, base] of ['A', 'C', 'G', 'T'].entries()) {
      expect(variantInk(detail('A', base), LANE), base).toBe(BASE_COLOURS[at])
    }
  })

  it('is the same ink the sequence lane and the pile use for that base', () => {
    // The claim, stated as the identity it is: three lanes, one table.
    expect(variantInk(detail('A', 'G'), LANE)).toBe(BASE_COLOURS[2])
    expect(BASE_COLOURS[2]).toBe('#d59225')
  })

  it('draws a record with no single base in the ink that already means that', () => {
    // An insertion's bases are not in the reference and a deletion's ALT is the
    // padding base that did not change, so neither has a base to be coloured
    // *by*. `BASE_COLOURS[4]` is the grey the sequence lane and the pile draw an
    // `N` in — the same sentence in the same ink, rather than a new one.
    for (const [ref, alt] of [
      ['G', 'GAA'],
      ['CTTT', 'C'],
      ['N', '<DEL>'],
      ['A', ']chr2:321681]A'],
    ]) {
      expect(variantInk(detail(ref, alt), LANE), `${ref}>${alt}`).toBe(BASE_COLOURS[4])
    }
  })

  it('does not use the lane’s own colour for one, which would collide', () => {
    // The reason this is not the lane's colour: the stock lane is `#1f5fa9` and
    // C is `#2f6fb5`. On a default lane an insertion and a substitution to C
    // were the same blue, which is exactly the collision the depth mark's own
    // ink was moved for. Asserted as a distance so a new default cannot
    // reintroduce it.
    expect(variantInk(detail('G', 'GAA'), LANE)).not.toBe(LANE)
  })

  it('will not pick one of several ALTs', () => {
    // `A>G,T` is two substitutions to two different bases and there is no single
    // honest colour for it.
    expect(variantInk(detail('A', 'G,T'), LANE)).toBe(BASE_COLOURS[4])
  })

  it('answers the lane’s colour for anything that is not a REF>ALT at all', () => {
    // A BED's detail reaches this only through a bug, and a bug must not paint.
    expect(variantInk('', LANE)).toBe(LANE)
    expect(variantInk('score 500 · signal 7.2', LANE)).toBe(LANE)
    expect(variantInk('>leading', LANE)).toBe(LANE)
  })

  it('gives a single base enough width to be seen and to be hit', () => {
    // `laneRect` floors a box to one pixel, which is enough to exist and not
    // enough to find. Three is where a mark reads as a mark.
    expect(VARIANT_MIN_WIDTH).toBeGreaterThanOrEqual(3)
  })
})
