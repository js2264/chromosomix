/**
 * The one way the raster cap moves, and the guards around it.
 *
 * `RASTER_MAX_DIM` is the number the read grid and the draw grid are both
 * derived from, so an override that lands wrong does not produce a wrong-sized
 * picture — it produces two grids that disagree, which is the one failure
 * `metacooler/pooling.ts` exists to prevent. What matters here is therefore not
 * that a good value is accepted but that **every bad one is refused**: a word,
 * a float, a negative, an empty string and a missing key all have to come back
 * as the default rather than as `NaN`, `0` or `Infinity`, any of which would
 * silently make `poolPlan` return a grid of nothing.
 *
 * The parse is exercised through `resolveRasterMaxDim`, which reads whatever
 * globals are in scope — so each case installs its own and takes it away again.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { pooledCellCap, poolPlan, setPooledCellCap } from '@/metacooler/pooling'
import {
  RASTER_KEY,
  RASTER_MAX,
  RASTER_MAX_DIM_DEFAULT,
  RASTER_MIN,
  RASTER_PARAM,
  resolveRasterMaxDim,
} from '@/render/rasterCap'

type Mutable = { location?: unknown; localStorage?: unknown }
const g = globalThis as Mutable

function withUrl(search: string): void {
  g.location = { search }
}

function withStorage(value: string | null): void {
  g.localStorage = {
    getItem: (key: string) => (key === RASTER_KEY ? value : null),
  }
}

afterEach(() => {
  delete g.location
  delete g.localStorage
  setPooledCellCap(RASTER_MAX_DIM_DEFAULT)
})

describe('resolveRasterMaxDim', () => {
  it('is the default with nothing to read', () => {
    expect(resolveRasterMaxDim()).toBe(RASTER_MAX_DIM_DEFAULT)
  })

  it('takes a value from the page URL', () => {
    withUrl(`?${RASTER_PARAM}=8192`)
    expect(resolveRasterMaxDim()).toBe(8192)
  })

  it('takes a value from storage when the URL says nothing', () => {
    withStorage('2048')
    expect(resolveRasterMaxDim()).toBe(2048)
  })

  it('lets the URL win over storage, because a link is a deliberate one-off', () => {
    withUrl(`?${RASTER_PARAM}=8192`)
    withStorage('2048')
    expect(resolveRasterMaxDim()).toBe(8192)
  })

  it('clamps to the range rather than refusing', () => {
    withUrl(`?${RASTER_PARAM}=99999`)
    expect(resolveRasterMaxDim()).toBe(RASTER_MAX)
    withUrl(`?${RASTER_PARAM}=1`)
    expect(resolveRasterMaxDim()).toBe(RASTER_MIN)
  })

  // The whole point of the guard: none of these may reach `poolPlan`.
  it.each(['', '  ', 'lots', '4096px', '-4096', '4096.5', '0', '1e4', 'NaN', 'Infinity'])(
    'falls back to the default for %o',
    (raw) => {
      withUrl(`?${RASTER_PARAM}=${encodeURIComponent(raw)}`)
      expect(resolveRasterMaxDim()).toBe(RASTER_MAX_DIM_DEFAULT)
      delete g.location
      withStorage(raw)
      expect(resolveRasterMaxDim()).toBe(RASTER_MAX_DIM_DEFAULT)
    },
  )

  it('survives a localStorage that throws, as a blocked-site-data page has', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('site data blocked')
      },
    }
    expect(resolveRasterMaxDim()).toBe(RASTER_MAX_DIM_DEFAULT)
  })
})

describe('setPooledCellCap', () => {
  it('is what the worker learns the session cap through', () => {
    setPooledCellCap(8192)
    expect(pooledCellCap()).toBe(8192)
  })

  it('ignores anything that is not a positive integer, so a stale client cannot break the grid', () => {
    setPooledCellCap(8192)
    for (const bad of [undefined, Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      setPooledCellCap(bad as number | undefined)
      expect(pooledCellCap()).toBe(8192)
    }
  })

  it('moves the grid every pooled read is planned on', () => {
    setPooledCellCap(RASTER_MAX_DIM_DEFAULT)
    expect(poolPlan(12_100, 16).binsPerCell).toBe(3)
    // The yeast case exactly: 12,100 bins fit at k = 1 once the cap passes them.
    setPooledCellCap(12_288)
    expect(poolPlan(12_100, 16).binsPerCell).toBe(1)
  })
})
