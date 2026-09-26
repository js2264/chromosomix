/**
 * The 4C task's two paths, and the normalisation that has to reach both of them.
 *
 * A slice of a Hi-C map is mostly P(s): contact falls by orders of magnitude
 * with distance, so a raw profile's shape is dominated by how far away each bin
 * is rather than by whether anything is happening there. Dividing by the decay
 * is what a reader turns *By P(s)* on for, and the task offers it on both paths.
 *
 * On the **cis** path it worked. On the **with trans** path it did not, and the
 * way it failed is the kind this module's own comments are written against: the
 * trans half was divided by the mean of what the anchor reached off its own
 * sequence, and the cis half — which nothing had normalised, because nothing had
 * read a square at all — was left as raw counts. One track, one axis, one legend
 * saying `O/E`, and two different quantities in it: ratios near 1 across
 * fourteen chromosomes and a spike of tens of thousands on the fifteenth, which
 * reads as the strongest signal in the file and is a unit error.
 *
 * The comment inside `overTransMean` even said why the cis half was skipped —
 * "the cis half has already been divided by the decay" — which was a true
 * statement about the *other* path.
 *
 * The file underneath is stubbed rather than read. What is being checked is the
 * arithmetic of the runner and which halves of it are ratios, and a real
 * `.mcool` would put four seconds of HDF5 between the test and the question.
 */

import { describe, expect, it } from 'vitest'

import { excludeAnchor, runFourC } from '@/analysis/run/fourc'
import type { JobContext } from '@/analysis/job'
import type { AnalysisFraming, Params, ProfileOutput } from '@/analysis/types'
import type { MetaCooler } from '@/metacooler/MetaCooler'

/**
 * Two sequences of eight bins each.
 *
 * `A` is the anchor's, and its cis square is a clean power-law decay so that a
 * correct O/E is flat at 1 by construction; `B` is off it, so the trans half is
 * a constant that must come out at 1 against its own mean.
 */
const BINS = 8
const N_BINS = BINS * 2
const ANCHOR_BIN = 3
/** `A`'s decay: cell (r, c) holds `1000 / (1 + |r - c|)`. */
const decayAt = (offset: number): number => 1000 / (1 + Math.abs(offset))
/** Every trans cell, which has no separation to decay over. */
const TRANS_CELL = 7

function cisSquare(): Float32Array {
  const values = new Float32Array(BINS * BINS)
  for (let r = 0; r < BINS; r++) {
    for (let c = 0; c < BINS; c++) values[r * BINS + c] = decayAt(c - r)
  }
  return values
}

/** Everything `parseMetacoolerRange` and the runner ask a file for. */
function fakeMc(): MetaCooler {
  return {
    nBins: N_BINS,
    binsize: 1000,
    nnz: 0,
    chromnames: ['A', 'B'],
    genomes: null,
    contigs: { strings: (column: string) => (column === 'name' ? ['A', 'B'] : []) },
    coords: { contigOfBin: (bin: number) => (bin < BINS ? 0 : 1) },
    extent: (region: string) => {
      const [name, span] = region.split(':')
      const base = name === 'A' ? 0 : BINS
      if (span === undefined) return [base, base + BINS]
      const [from, to] = span.split('-').map(Number)
      return [base + Math.floor(from / 1000), base + Math.ceil(to / 1000)]
    },
    contigExtent: (cid: number) => (cid === 0 ? [0, BINS] : [BINS, N_BINS]),
    /** A dense square, for the spans the view's own block does not cover. */
    matrix: async (query: { rows: [number, number]; cols: [number, number] }) => {
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          const a = query.rows[0] + r
          const b = query.cols[0] + c
          values[r * ncols + c] = (a < BINS) === (b < BINS) ? decayAt(b - a) : TRANS_CELL
        }
      }
      return { nrows, ncols, values, rowExtent: query.rows, colExtent: query.cols }
    },
    genomeExtent: () => [0, N_BINS],
    displayGenomes: () => [],
    /**
     * Every pixel of the file, upper-triangular as cooler stores one: `A`'s own
     * decay, `B`'s own decay, and a flat block between them.
     */
    scanPixels: async (options: {
      onChunk(chunk: {
        bin1: Int32Array
        bin2: Int32Array
        count: Float64Array
        length: number
      }): boolean | void
      onProgress?(done: number, total: number): void
    }) => {
      const bin1: number[] = []
      const bin2: number[] = []
      const count: number[] = []
      for (let a = 0; a < N_BINS; a++) {
        for (let b = a; b < N_BINS; b++) {
          const cis = (a < BINS) === (b < BINS)
          bin1.push(a)
          bin2.push(b)
          count.push(cis ? decayAt(b - a) : TRANS_CELL)
        }
      }
      options.onChunk({
        bin1: Int32Array.from(bin1),
        bin2: Int32Array.from(bin2),
        count: Float64Array.from(count),
        length: count.length,
      })
      options.onProgress?.(count.length, count.length)
    },
  } as unknown as MetaCooler
}

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'A',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, BINS],
  cols: [0, BINS],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

function job(params: Params): { context: JobContext; notes: string[] } {
  const notes: string[] = []
  const context = {
    mc: fakeMc(),
    params,
    framing: FRAMING,
    // The view's own block, covering `A` exactly — so the cis path takes the
    // square out of it rather than reading, which is what a reader looking at
    // the anchor's chromosome has already paid for.
    inputs: {
      block: {
        nrows: BINS,
        ncols: BINS,
        values: cisSquare(),
        rowExtent: [0, BINS] as [number, number],
        colExtent: [0, BINS] as [number, number],
        binsPerCell: 1,
      },
    },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text: string) => notes.push(text),
    toBp: (bins: number) => bins * 1000,
    toBins: (bp: number) => Math.max(1, Math.round(bp / 1000)),
  } as unknown as JobContext
  return { context, notes }
}

async function profileOf(params: Params): Promise<ProfileOutput> {
  const outputs = await runFourC(job(params).context)
  const first = outputs[0]
  if (first === undefined || first.kind !== 'profile') throw new Error('no profile')
  return first
}

/** The anchor's own sequence, and everything off it. */
function halves(profile: ProfileOutput): { cis: number[]; trans: number[] } {
  return {
    cis: [...profile.values.slice(0, BINS)],
    trans: [...profile.values.slice(BINS)],
  }
}

const ANCHOR = `A:${ANCHOR_BIN * 1000}-${(ANCHOR_BIN + 1) * 1000}`

describe('a 4C profile', () => {
  it('says what it needs when no anchor was chosen', async () => {
    const made = job({ anchor: '' })
    const outputs = await runFourC(made.context)
    expect(outputs).toEqual([])
    expect(made.notes[0]).toContain('No anchor was chosen')
  })

  it('is counts, over the anchor’s own sequence, when cis only', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: true })
    const { cis, trans } = halves(profile)
    expect(profile.unit).toBe('contacts')
    // The band sum of one bin against each column of the decay square.
    // Float32 all the way through, so to a part in a million rather than exactly.
    expect(cis[ANCHOR_BIN] / decayAt(0)).toBeCloseTo(1, 5)
    expect(cis[ANCHOR_BIN + 2] / decayAt(2)).toBeCloseTo(1, 5)
    // A cis-only run has said nothing at all about the other sequences, and a
    // track claiming zero contact there would be a claim it did not make.
    expect(trans.every((value) => Number.isNaN(value))).toBe(true)
  })

  it('reaches the other sequence when asked for trans', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: false })
    const { trans } = halves(profile)
    expect(trans.every((value) => value === TRANS_CELL)).toBe(true)
    expect(profile.label).toContain('with trans')
  })
})

/**
 * *Exclude anchor region* (§18.8): the anchor against itself is the diagonal,
 * and the bin beside it its shoulder — the brightest cells of the map by orders
 * of magnitude, and in a track the spike every other bin is read against.
 */
describe('with the anchor left out', () => {
  it('leaves the anchor and one bin either side empty, and every other bin as it was', async () => {
    const kept = halves(await profileOf({ anchor: ANCHOR, cis: true })).cis
    const profile = await profileOf({ anchor: ANCHOR, cis: true, excludeAnchor: true })
    const { cis } = halves(profile)
    for (const bin of [ANCHOR_BIN - 1, ANCHOR_BIN, ANCHOR_BIN + 1]) {
      // A gap, not a zero: nothing was measured away.
      expect(Number.isNaN(cis[bin])).toBe(true)
    }
    for (const bin of [0, ANCHOR_BIN - 2, ANCHOR_BIN + 2, BINS - 1]) expect(cis[bin]).toBe(kept[bin])
    expect(profile.label).toBe(`4C · ${ANCHOR} · anchor excluded`)
  })

  it('is off unless asked for', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: true })
    expect(Number.isFinite(halves(profile).cis[ANCHOR_BIN])).toBe(true)
    expect(profile.label).not.toContain('excluded')
  })

  it('leaves the same gap after a division, and the trans half alone', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: false, normalise: 'ps', excludeAnchor: true })
    const { cis, trans } = halves(profile)
    expect(Number.isNaN(cis[ANCHOR_BIN])).toBe(true)
    expect(Number.isNaN(cis[ANCHOR_BIN + 1])).toBe(true)
    expect(cis[ANCHOR_BIN + 2]).toBeCloseTo(1, 4)
    expect(trans.every((value) => Number.isFinite(value))).toBe(true)
  })

  it('says so when leaving the anchor out leaves nothing', async () => {
    // A whole sequence named, cis only: the anchor is everything the profile reads.
    const made = job({ anchor: 'A', cis: true, excludeAnchor: true })
    const outputs = await runFourC(made.context)
    const profile = outputs[0] as ProfileOutput
    expect([...profile.values].every((value) => Number.isNaN(value))).toBe(true)
    expect(made.notes.join(' ')).toContain('leaves nothing')
  })

  it('stops at either end of the file', () => {
    const values = new Float32Array(6).fill(1)
    excludeAnchor(values, { from: 0, to: 1 })
    expect([...values].map((value) => Number.isNaN(value))).toEqual([true, true, false, false, false, false])
    values.fill(1)
    excludeAnchor(values, { from: 5, to: 6 })
    expect([...values].map((value) => Number.isNaN(value))).toEqual([false, false, false, false, true, true])
  })
})

describe('divided by P(s)', () => {
  it('flattens the decay on the cis-only path', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: true, normalise: 'ps' })
    const { cis } = halves(profile)
    // The square *is* the curve, so every bin comes out at exactly 1.
    for (const value of cis) expect(value).toBeCloseTo(1, 5)
    // A ratio has no unit, and calling one "contacts" would put a number centred
    // on 1 under an axis labelled as a count.
    expect(profile.unit).toBe('')
    expect(profile.label).toContain('O/E')
  })

  it('flattens it on the with-trans path too — both halves, one quantity', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: false, normalise: 'ps' })
    const { cis, trans } = halves(profile)
    // The regression. This half used to be the raw band sum — a thousand-fold
    // spike on one chromosome of a track whose every other value is near 1.
    for (const value of cis) expect(value).toBeCloseTo(1, 5)
    for (const value of trans) expect(value).toBeCloseTo(1, 5)
  })

  it('leaves the two halves on one readable scale', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: false, normalise: 'ps' })
    const finite = [...profile.values].filter((value) => Number.isFinite(value))
    const span = Math.max(...finite) / Math.min(...finite)
    // Both halves are ratios against their own expectation, so the whole track
    // fits on one axis. Before the fix this ratio was in the hundreds.
    expect(span).toBeLessThan(1.5)
  })

  it('says so when there is no trans expectation to divide by', async () => {
    const made = job({ anchor: 'A', cis: false, normalise: 'ps' })
    // An anchor covering the whole file leaves nothing outside it.
    const mc = made.context.mc as unknown as { contigExtent(cid: number): [number, number] }
    mc.contigExtent = () => [0, N_BINS]
    await runFourC(made.context)
    expect(made.notes.join(' ')).toContain('no trans expectation')
  })

  it('is off by default, because a ratio is a derived quantity', async () => {
    const profile = await profileOf({ anchor: ANCHOR, cis: true })
    expect(profile.label).not.toContain('O/E')
    expect(profile.unit).toBe('contacts')
  })
})

/**
 * The same runner, over a file whose sequences are contigs of MAGs.
 *
 * Neither *Cis only* nor *Normalisation* is a control on such a file — the form
 * drops both (`tasks/fourc.ts`) — and the params that reach the runner say
 * nothing about it: `cis` is `true` because that is a cooler's default and
 * because a stored session from another file carries it. Honouring it would give
 * back a profile of one MAG against itself, with the rest of the community left
 * as gaps, which on a metagenomic map is the one reading nobody came for.
 */
describe('on a metagenome', () => {
  /** The same two sequences, now belonging to a file that has genomes. */
  function metaJob(params: Params): { context: JobContext; notes: string[] } {
    const made = job(params)
    const mc = made.context.mc as unknown as { hasGenomes: boolean }
    mc.hasGenomes = true
    return made
  }

  async function metaProfile(params: Params): Promise<ProfileOutput> {
    const outputs = await runFourC(metaJob(params).context)
    const first = outputs[0]
    if (first === undefined || first.kind !== 'profile') throw new Error('no profile')
    return first
  }

  it('reaches the other sequences even though “cis only” is on', async () => {
    const profile = await metaProfile({ anchor: ANCHOR, cis: true })
    const { cis, trans } = halves(profile)
    expect(trans.every((value) => value === TRANS_CELL)).toBe(true)
    // And the anchor's own sequence is still there: this is one profile over the
    // whole file, not the trans half of one.
    expect(cis[ANCHOR_BIN]).toBeGreaterThan(0)
  })

  it('does not say “with trans”, because there is nothing else it could be', async () => {
    const profile = await metaProfile({ anchor: ANCHOR, cis: true })
    expect(profile.label).toBe(`4C · ${ANCHOR}`)
  })

  it('stays in contacts, whatever a remembered normalisation says', async () => {
    // One assembly's decay is not the expectation for contact between
    // assemblies, so the ratio would be two quantities under one axis.
    const profile = await metaProfile({ anchor: ANCHOR, cis: true, normalise: 'ps' })
    expect(profile.label).not.toContain('O/E')
    expect(profile.unit).toBe('contacts')
    expect(halves(profile).trans.every((value) => value === TRANS_CELL)).toBe(true)
  })
})
