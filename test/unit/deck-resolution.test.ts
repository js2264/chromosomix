/**
 * One resolution for every map, and a rung that is no part of a file's address.
 *
 * A deck's companions are read at the first map's resolution on their own
 * ladders (§16.2) — `pickOnLadder` — and an `.mcool` opened at the rung it lands
 * on is written into a link as the file alone, and read back from one as the
 * entry it is open at (§3.4) — `state/landing.ts`. A task reads each companion
 * at the deck's resolution by the same rule its picture follows — `onLadder`.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { onLadder } from '@/app/SessionAnalysis'
import { forgetLandings, linkState, linkUri, noteLanding, openedState, openedUri } from '@/state/landing'
import type { ViewState } from '@/types'
import { pickOnLadder, rungsOf } from '@/ui/refine'
import type { OpenResult } from '@/worker/protocol'

const LADDER = rungsOf(['1000', '2000', '5000', '10000', '25000', '50000', '100000'])

describe('another map’s resolution on this file’s ladder', () => {
  it('is the stored rung of that size where there is one', () => {
    expect(pickOnLadder(25_000, LADDER, false)).toEqual({
      pick: { binsize: 25_000, rung: { name: '25000', binsize: 25_000 }, factor: 1 },
      exact: true,
    })
  })

  it('sums a picked resolution out of the coarsest rung that divides it', () => {
    // The first map sums a pick it has not got the same way (§3.4).
    expect(pickOnLadder(40_000, LADDER, true)).toEqual({
      pick: { binsize: 40_000, rung: { name: '10000', binsize: 10_000 }, factor: 4 },
      exact: true,
    })
  })

  it('never sums the zoom’s own choice: the nearest stored rung, said to be another', () => {
    // A screen-sized read is a stored rung (§2); the zoom's bin size on a file
    // that has not got it is drawn at the nearest one, and the panel says so.
    const near = pickOnLadder(40_000, LADDER, false)
    expect(near?.pick.binsize).toBe(50_000)
    expect(near?.exact).toBe(false)
  })

  it('takes the coarser of two rungs as near', () => {
    // 2 kb and 8 kb are as far from 4 kb on a log scale.
    const near = pickOnLadder(4_000, rungsOf(['2000', '8000']), false)
    expect(near?.pick.binsize).toBe(8_000)
  })

  it('has nothing to offer from a file with no rung at all', () => {
    expect(pickOnLadder(5_000, [], true)).toBeNull()
    expect(pickOnLadder(0, LADDER, true)).toBeNull()
  })
})

describe('the rung a link leaves out', () => {
  afterEach(() => forgetLandings())

  const FILE = 'https://x.example.org/k562.mcool'

  it('writes a file open at its landing rung as the file alone', () => {
    noteLanding(`${FILE}::resolutions/25000`)
    expect(linkUri(`${FILE}::resolutions/25000`)).toBe(FILE)
    // However the group is spelled.
    expect(linkUri(`${FILE}::/resolutions/25000`)).toBe(FILE)
  })

  it('keeps a rung a link named that is not the one it lands on', () => {
    // An older link's `::1000` is honoured as it was, and written as it came.
    noteLanding(`${FILE}::resolutions/25000`)
    expect(linkUri(`${FILE}::resolutions/1000`)).toBe(`${FILE}::resolutions/1000`)
  })

  it('writes every address as it is where the file was never opened here', () => {
    expect(linkUri(`${FILE}::resolutions/25000`)).toBe(`${FILE}::resolutions/25000`)
    expect(openedUri(FILE)).toBe(FILE)
  })

  it('reads the file alone back as the entry open, as that entry spells it', () => {
    noteLanding(`${FILE}::resolutions/25000`)
    expect(openedUri(FILE)).toBe(`${FILE}::resolutions/25000`)
    // The tab's own spelling where it is this file, so a step back is a step
    // within it rather than another open.
    expect(openedUri(FILE, `${FILE}::/resolutions/25000`)).toBe(`${FILE}::/resolutions/25000`)
    // An address naming a rung is read as it is.
    expect(openedUri(`${FILE}::resolutions/1000`)).toBe(`${FILE}::resolutions/1000`)
  })

  it('round-trips a view state through the address bar', () => {
    noteLanding(`${FILE}::resolutions/25000`)
    const state = { uri: `${FILE}::resolutions/25000`, view: 'region', region: 'chr5' } as ViewState
    const written = linkState(state)
    expect(written.uri).toBe(FILE)
    expect(written.region).toBe('chr5')
    expect(openedState(written, state.uri)).toEqual(state)
    expect(openedState(null)).toBeNull()
  })
})

describe('a map beside the first, read for a task at the deck’s resolution', () => {
  const FILE = 'https://x.example.org/rep2.mcool'
  const opened = (binsize: number, entries: string[], extra: Record<string, unknown> = {}): OpenResult =>
    ({ binsize, entries, entryGroup: 'resolutions', ...extra }) as unknown as OpenResult

  it('is the entry of the rung of that size where its file stores one', () => {
    expect(onLadder(`${FILE}::resolutions/25000`, opened(25_000, ['5000', '25000', '100000']), 100_000)).toMatchObject({
      uri: `${FILE}::resolutions/100000`,
      binsize: 100_000,
      factor: 1,
    })
  })

  it('sums the coarsest rung that divides it where it stores none', () => {
    // The run is told to sum it (`RunTarget.coarsen`), as its picture is summed.
    expect(onLadder(`${FILE}::resolutions/25000`, opened(25_000, ['5000', '25000', '100000']), 40_000)).toMatchObject({
      uri: `${FILE}::resolutions/5000`,
      binsize: 40_000,
      factor: 8,
    })
  })

  it('is the stored rung nearest it, at its own size, where no rung divides it', () => {
    expect(onLadder(`${FILE}::resolutions/100000`, opened(100_000, ['25000', '100000']), 40_000)).toMatchObject({
      uri: `${FILE}::resolutions/25000`,
      binsize: 25_000,
      factor: 1,
    })
  })

  it('is nothing to do at the rung it is open at', () => {
    expect(onLadder(`${FILE}::resolutions/25000`, opened(25_000, ['5000', '25000']), 25_000)).toBeNull()
    expect(onLadder(`${FILE}::resolutions/25000`, opened(25_000, ['5000', '25000']), undefined)).toBeNull()
  })

  it('sums a file of one resolution whose bins divide it, at its own address', () => {
    expect(onLadder('https://x.example.org/one.cool', opened(1_000, []), 4_000)).toMatchObject({
      uri: 'https://x.example.org/one.cool',
      binsize: 4_000,
      factor: 4,
    })
  })

  it('leaves a map binned here from a .pairs at the grid it was binned at', () => {
    expect(onLadder('local.pairs', opened(1_000, [], { pairs: { binning: {} } }), 4_000)).toBeNull()
  })
})
