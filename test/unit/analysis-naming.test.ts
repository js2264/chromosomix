/**
 * A name a task acts on, against the file it is actually running against.
 *
 * §5.9 is a read-side rule everywhere else in the app — a track is asked for a
 * sequence by whatever name the panel drawing it writes, and every holder of a
 * name list resolves through `contigIndexOf`. The analysis worker had no such
 * door, and it is the one place where names cross files *by construction*: a
 * batch (§18.2) runs one set of parameters against every panel of a deck, and
 * those parameters were filled in against the **starred** map. Ticked sequences,
 * a typed region and a loaded BED are all that map's spellings.
 *
 * So a deck of three `.cool` files and a `.hic` ran the compartment task four
 * times and produced three tracks: `MetaCooler.contigId` is a faithful port of
 * cooler's own lookup and knows only what the file spells, so on the file that
 * writes `1` where the others write `chr1`, every ticked name matched nothing
 * and the run ended on *none of the ticked sequences has any bins in it* — true,
 * and not the reason.
 *
 * What is asserted here is the door: exact first, the conventions after, the
 * names that found nothing reported rather than dropped, and — the half that
 * makes it safe — the one letter that cannot be resolved without knowing the
 * list it came from left unresolved instead of guessed.
 */

import { describe, expect, it } from 'vitest'

import { contigIdFor, contigIdsFor } from '@/analysis/job'
import { NameIndex, contextOf } from '@/genome/naming'
import type { MetaCooler } from '@/metacooler/MetaCooler'

/** The three things {@link contigIdFor} asks a file for, and nothing else. */
function fakeMc(names: readonly string[]): MetaCooler {
  const ids = new Map(names.map((name, at) => [name, at]))
  const index = NameIndex.of(names.map((name) => ({ name })))
  return {
    chromnames: [...names],
    hasContig: (name: string) => ids.has(name),
    contigId: (name: string) => {
      const at = ids.get(name)
      if (at === undefined) throw new Error(`Contig ${name} not found`)
      return at
    },
    get names(): NameIndex {
      return index
    },
  } as unknown as MetaCooler
}

describe('a sequence somebody else named', () => {
  it('is the file’s own answer when the file spells it that way', () => {
    const mc = fakeMc(['chr1', 'chr2', 'chrX'])
    expect(contigIdFor(mc, 'chr1')).toBe(0)
    expect(contigIdFor(mc, 'chrX')).toBe(2)
  })

  it('crosses the `chr` prefix, which is the case the bug was reported on', () => {
    // A `.hic` off 4DN beside a `.cool` out of a local pipeline: one writes `1`,
    // the other `chr1`, and the deck already navigates as one.
    const bare = fakeMc(['1', '2', '3', 'X'])
    expect(contigIdFor(bare, 'chr1')).toBe(0)
    expect(contigIdFor(bare, 'chr3')).toBe(2)

    const prefixed = fakeMc(['chr1', 'chr2', 'chr3', 'chrX'])
    expect(contigIdFor(prefixed, '1')).toBe(0)
    expect(contigIdFor(prefixed, '3')).toBe(2)
  })

  it('crosses leading zeros and case', () => {
    const mc = fakeMc(['01', '02', '10'])
    expect(contigIdFor(mc, 'chr1')).toBe(0)
    expect(contigIdFor(mc, '10')).toBe(2)
    expect(contigIdFor(fakeMc(['CHR1']), 'chr1')).toBe(0)
  })

  it('is −1 for a sequence the file has not got, rather than a throw', () => {
    // The literal lookup refuses by exception, which is right for a port of
    // cooler and wrong for a task walking a list: one absent name would end a
    // run that had fifteen good ones in it.
    const mc = fakeMc(['chr1', 'chr2'])
    expect(contigIdFor(mc, 'chr9')).toBe(-1)
    expect(contigIdFor(mc, 'scaffold_7')).toBe(-1)
  })

  it('reads a Roman numeral against the list it came out of', () => {
    // `chrX` is chromosome ten in a yeast file and the sex chromosome in a human
    // one, and only the list it was written in can say which. That list is what
    // the ticked sequences *are*, so it travels.
    const numbered = fakeMc(['01', '09', '10', '11'])
    const yeast = ['chrI', 'chrIX', 'chrX', 'chrXI']
    expect(contigIdFor(numbered, 'chrX', contextOf(yeast))).toBe(2)
    expect(contigIdFor(numbered, 'chrXI', contextOf(yeast))).toBe(3)
  })

  it('leaves a bare X unresolved rather than guessing which it is', () => {
    // The safety of the whole retry: with no list behind it, `X` is the sex
    // chromosome far more often than it is ten, and a silent wrong match is the
    // one outcome §5.9 refuses. Nothing here has a sex chromosome to match, so
    // the honest answer is that this file has no such sequence.
    const numbered = fakeMc(['1', '9', '10', '11'])
    expect(contigIdFor(numbered, 'X')).toBe(-1)
  })
})

describe('a list of them', () => {
  it('comes back in the file’s own order, whatever order it was asked in', () => {
    // The caller lays a square out over these ids and reads a run of bins as one
    // block, so ascending is not a nicety.
    const mc = fakeMc(['chr1', 'chr2', 'chr3'])
    expect(contigIdsFor(mc, ['3', '1', '2']).ids).toEqual([0, 1, 2])
  })

  it('names what it could not find, so a short run says why it was short', () => {
    const mc = fakeMc(['chr1', 'chr2'])
    const { ids, missing } = contigIdsFor(mc, ['1', '2', 'chr7', 'MT'])
    expect(ids).toEqual([0, 1])
    expect(missing).toEqual(['chr7', 'MT'])
  })

  it('says nothing matched when nothing did, which is the reported failure', () => {
    // Three cools and a hic: the ticked list is the cool's, and every name of it
    // is unknown to the file being asked. What used to happen was an empty run
    // with a note about bins.
    const hic = fakeMc(['1', '2', '3'])
    const { ids, missing } = contigIdsFor(hic, ['MAG_1_ctg1', 'MAG_1_ctg2'])
    expect(ids).toEqual([])
    expect(missing).toHaveLength(2)
  })

  it('counts one sequence once, however many names reach it', () => {
    // Two spellings of one chromosome are one chromosome, and a square built
    // from both would hold its bins twice.
    const mc = fakeMc(['chr1', 'chr2'])
    expect(contigIdsFor(mc, ['chr1', '1', '01']).ids).toEqual([0])
  })
})
