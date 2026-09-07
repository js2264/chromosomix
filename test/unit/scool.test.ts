/**
 * The single-cell container (spec §3.7): detection, per-cell views, and the sum.
 *
 * Driven off `test/fixtures/_scool.json`, which `scripts/make_scool_fixtures.py`
 * wrote beside the fixtures — so the expected sum is the one the *generator*
 * declared from the per-cell pixels it wrote, never one this file computes with
 * the same reader it is testing.
 *
 * Two layouts are exercised at every step and neither is the special case: the
 * standard container `cooler.create_scool` writes, and the flat one every
 * pre-0.8.11 writer produced. A test that passed on one and was never run on
 * the other is exactly how the flat layout came to be unopenable.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ViewerError } from '../../src/errors'
import { openHdf5 } from '../../src/h5/Hdf5File'
import { detectLayout } from '../../src/metacooler/detect'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { resolveCells, ScoolStore } from '../../src/metacooler/scool'
import { willListCells } from '../../src/metacooler/detect'
import {
  cellsOf,
  cellsPatch,
  parseViewState,
  serialiseViewState,
} from '../../src/state/ViewState'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import type { Hdf5Handle } from '../../src/h5/api'
import type { ByteSource } from '../../src/types'

const FIXTURE_DIR = decodeURIComponent(new URL('../fixtures/', import.meta.url).pathname)
const MANIFEST = `${FIXTURE_DIR}_scool.json`

interface ScoolManifest {
  binsize: number
  nbins: number
  cells: Record<string, Record<string, number>>
  expected_sum: Record<string, number>
  fixtures: Array<{ name: string; kind: string; cell_group: string; cells: string[] }>
}

const present = existsSync(MANIFEST)
const manifest: ScoolManifest = present
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as ScoolManifest)
  : ({ binsize: 0, nbins: 0, cells: {}, expected_sum: {}, fixtures: [] } as ScoolManifest)

/** Both layouts, as `[fixture, cellGroup]` — every case runs against each. */
const LAYOUTS: Array<[string, string]> = present
  ? manifest.fixtures
      .filter((f) => f.name !== 'balanced.scool')
      .map((f) => [f.name, f.cell_group])
  : []

const CELL_NAMES = Object.keys(manifest.cells).sort()

async function withHandle<T>(name: string, body: (h: Hdf5Handle) => T | Promise<T>): Promise<T> {
  const path = `${FIXTURE_DIR}${name}`
  const handle = await openHdf5(path, await LocalFileSource.open(path), '/')
  try {
    return await body(handle)
  } finally {
    handle.close()
  }
}

/**
 * Open a fixture as a map over `cells`; `null` is every cell.
 *
 * Built through `fromScool` on an open handle rather than through
 * `MetaCooler.open`, because a cell set is not part of a URI — it is what the
 * *view* selected, and the worker hands it to the same constructor this does.
 */
async function withMap<T>(
  name: string,
  cells: readonly string[] | null,
  body: (mc: MetaCooler) => T | Promise<T>,
): Promise<T> {
  return withHandle(name, async (h) => {
    const layout = detectLayout(h)
    return body(MetaCooler.fromScool(h, layout, h.attrs(), cells))
  })
}

/** `{ "0,1": 102 }` → the dense cell at row 0, column 1. */
function denseAt(values: Float32Array, n: number, key: string): number {
  const [row, col] = key.split(',').map(Number)
  return values[row * n + col]
}

describe.skipIf(!present)('scool fixtures are present', () => {
  it('the generator wrote both layouts', () => {
    expect(LAYOUTS.map(([name]) => name).sort()).toEqual(['cells.scool', 'flat.scool'])
  })
})

describe.skipIf(!present)('detection (§3.1)', () => {
  it.each(LAYOUTS)('%s is an scool whose cells are listed', async (name, group) => {
    await withHandle(name, (h) => {
      const layout = detectLayout(h)
      expect(layout.kind).toBe('scool')
      expect(layout.cellGroup).toBe(group)
      expect([...(layout.entries ?? [])].sort()).toEqual(CELL_NAMES)
    })
  })

  it('a flat scool is not classified as the plain cooler it claims to be', async () => {
    await withHandle('flat.scool', (h) => {
      // The premise: its root really does say `HDF5::Cooler`, so only the order
      // of the branches keeps it out of the `cool` case.
      expect(h.attrs()['format']).toBe('HDF5::Cooler')
      expect(detectLayout(h).kind).toBe('scool')
    })
  })

  it('a single cell of an scool is a plain cooler', async () => {
    const path = `${FIXTURE_DIR}cells.scool`
    const mc = await MetaCooler.open(
      `${path}::/cells/cell_a`,
      await LocalFileSource.open(path),
    )
    try {
      expect(mc.layout.kind).toBe('cool')
      expect(mc.nBins).toBe(manifest.nbins)
    } finally {
      mc.close()
    }
  })
})

describe.skipIf(!present)('the shared coordinate system', () => {
  it.each(LAYOUTS)('%s reports the cells bin space, not the root', async (name) => {
    await withMap(name, null, (mc) => {
      expect(mc.nBins).toBe(manifest.nbins)
      expect(mc.binsize).toBe(manifest.binsize)
      expect(mc.chromnames).toEqual(['chr1', 'chr2'])
    })
  })
})

describe.skipIf(!present)('summing cells (§3.7)', () => {
  it.each(LAYOUTS)('%s over every cell reproduces the generator sum', async (name) => {
    await withMap(name, null, async (mc) => {
      const n = manifest.nbins
      const block = await mc.matrix({ rows: [0, n] })
      for (const [key, expected] of Object.entries(manifest.expected_sum)) {
        expect(denseAt(block.values, n, key), `cell ${key}`).toBe(expected)
      }
      // Everything the generator did not write is zero — a sum that leaked a
      // neighbouring pixel would show up here and nowhere else.
      const written = new Set(Object.keys(manifest.expected_sum))
      let stray = 0
      for (let r = 0; r < n; r++) {
        for (let c = r; c < n; c++) {
          if (!written.has(`${r},${c}`) && block.values[r * n + c] !== 0) stray++
        }
      }
      expect(stray, 'pixels outside the generator table').toBe(0)
    })
  })

  it.each(LAYOUTS)('%s over one cell is that cell alone', async (name) => {
    for (const [cell, pixels] of Object.entries(manifest.cells)) {
      await withMap(name, [cell], async (mc) => {
        const n = manifest.nbins
        const block = await mc.matrix({ rows: [0, n] })
        let total = 0
        for (const value of block.values) total += value
        // Each stored pixel appears once on the diagonal and twice off it, so
        // the block's total is the mirrored one — which is the check that the
        // fan-out did not double the diagonal.
        let expected = 0
        for (const [key, value] of Object.entries(pixels)) {
          const [r, c] = key.split(',').map(Number)
          expected += r === c ? value : 2 * value
        }
        expect(total, `${cell} in ${name}`).toBe(expected)
      })
    }
  })

  it.each(LAYOUTS)('%s over a subset sums only that subset', async (name) => {
    await withMap(name, ['cell_a', 'cell_b'], async (mc) => {
      const n = manifest.nbins
      const block = await mc.matrix({ rows: [0, n] })
      // (0,0) is 1 in cell_a and 10 in cell_b; cell_c's 100 at (0,1) is left out.
      expect(denseAt(block.values, n, '0,0')).toBe(11)
      expect(denseAt(block.values, n, '0,1')).toBe(2)
      expect(denseAt(block.values, n, '1,2')).toBe(7)
      expect(denseAt(block.values, n, '4,4')).toBe(0)
    })
  })

  it.each(LAYOUTS)('%s sums the same over a sub-window as over the whole', async (name) => {
    await withMap(name, null, async (mc) => {
      const n = manifest.nbins
      const whole = await mc.matrix({ rows: [0, n] })
      const window = await mc.matrix({ rows: [0, 2], cols: [0, 2] })
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          expect(window.values[r * 2 + c], `(${r},${c})`).toBe(whole.values[r * n + c])
        }
      }
    })
  })
})

describe.skipIf(!present)('the summed index', () => {
  it.each(LAYOUTS)('%s bin offsets are the sum of the cells own', async (name) => {
    await withHandle(name, async (h) => {
      const layout = detectLayout(h)
      const all = new ScoolStore(h, layout, CELL_NAMES, manifest.nbins, 'i')
      const summed = all.binOffsets()
      const perCell = CELL_NAMES.map(
        (cell) => new ScoolStore(h, layout, [cell], manifest.nbins, 'i').binOffsets(),
      )
      for (let i = 0; i < summed.length; i++) {
        let total = 0
        for (const offsets of perCell) total += offsets[i]
        expect(summed[i], `bin ${i}`).toBe(total)
      }
      // And the last entry is the set's stored-pixel count, which is what the
      // read-cost forecast is built on.
      expect(summed[summed.length - 1]).toBe(all.nnz)
    })
  })
})

describe.skipIf(!present)('how far the sum has got', () => {
  it.each(LAYOUTS)('%s is reported per cell, in cells', async (name) => {
    // The one read here whose cost is linear in something other than the
    // picture: the same window over one cell and over four thousand is the same
    // block and a thousandfold different wait. Cells are the only honest
    // denominator, and the store is where they are counted — nothing between it
    // and the view layer knows this file has cells at all.
    await withMap(name, null, async (mc) => {
      const store = mc.store as ScoolStore
      const seen: Array<[number, number]> = []
      store.onCells = (done, total) => seen.push([done, total])
      await mc.matrix({ rows: [0, manifest.nbins] })
      expect(seen).toEqual(CELL_NAMES.map((_, i) => [i + 1, CELL_NAMES.length]))
    })
  })

  it.each(LAYOUTS)('%s costs nothing and reaches no one when unset', async (name) => {
    // The ordinary case — every read of every other file — and the read must be
    // identical with the sink absent.
    await withMap(name, null, async (mc) => {
      const watched = await mc.matrix({ rows: [0, manifest.nbins] })
      ;(mc.store as ScoolStore).onCells = null
      const plain = await mc.matrix({ rows: [0, manifest.nbins] })
      expect([...plain.values]).toEqual([...watched.values])
    })
  })
})

describe.skipIf(!present)('naming a cell that is not there', () => {
  it('is refused rather than silently dropped', () => {
    expect(() => resolveCells(CELL_NAMES, ['cell_a', 'nope'])).toThrowError(ViewerError)
    try {
      resolveCells(CELL_NAMES, ['cell_a', 'nope'])
    } catch (error) {
      expect((error as ViewerError).code).toBe('cell-not-found')
      expect((error as ViewerError).message).toContain('nope')
    }
  })

  it('an empty or absent selection is every cell', () => {
    expect(resolveCells(CELL_NAMES, null)).toEqual(CELL_NAMES)
    expect(resolveCells(CELL_NAMES, [])).toEqual(CELL_NAMES)
  })

  it('a repeated name is counted once, in file order', () => {
    expect(resolveCells(['b', 'a'], ['a', 'b', 'a'])).toEqual(['b', 'a'])
  })
})

describe.skipIf(!present)('balancing follows the shared bins', () => {
  it('a container with a shared /bins/weight offers it', async () => {
    await withMap('balanced.scool', null, (mc) => {
      expect(mc.hasWeights).toBe(true)
    })
  })

  it.each(LAYOUTS)('%s without one does not', async (name) => {
    await withMap(name, null, (mc) => {
      expect(mc.hasWeights).toBe(false)
    })
  })

  it('balanced values are the summed counts times the two shared weights', async () => {
    await withMap('balanced.scool', null, async (mc) => {
      const n = manifest.nbins
      const raw = await mc.matrix({ rows: [0, n] })
      const balanced = await mc.matrix({ rows: [0, n], balance: true })
      // The generator's weights, in bin order.
      const weights = [1.0, 0.5, 2.0, 0.25, 4.0]
      for (const key of Object.keys(manifest.expected_sum)) {
        const [r, c] = key.split(',').map(Number)
        expect(denseAt(balanced.values, n, key), key).toBeCloseTo(
          raw.values[r * n + c] * weights[r] * weights[c],
          5,
        )
      }
    })
  })
})

describe.skipIf(!present)('the cells table', () => {
  it.each(LAYOUTS)('%s has a row per cell, led by nnz and sum', async (name) => {
    await withMap(name, null, (mc) => {
      const table = mc.cellTable()
      expect(table.length).toBe(CELL_NAMES.length)
      expect(table.columns.slice(0, 3)).toEqual(['name', 'nnz', 'sum'])
      expect([...table.strings('name')].sort()).toEqual(CELL_NAMES)
      // The generator's own per-cell pixel counts, row by row.
      for (let row = 0; row < table.length; row++) {
        const cell = String(table.get('name', row))
        expect(table.get('nnz', row), cell).toBe(Object.keys(manifest.cells[cell]).length)
      }
    })
  })

  it.each(LAYOUTS)('%s drops the attributes every cell agrees on', async (name) => {
    await withMap(name, null, (mc) => {
      const columns = mc.cellTable().columns
      // These are the file's, not the cell's: identical on every row, so they
      // would be four unsortable columns pushing nnz and sum off the screen.
      for (const constant of ['bin-size', 'bin-type', 'storage-mode', 'format', 'nbins']) {
        expect(columns, constant).not.toContain(constant)
      }
      expect(columns).not.toContain('metadata')
    })
  })
})

describe.skipIf(!present)('swapping the cell set in place', () => {
  it.each(LAYOUTS)('%s reports and re-reads without re-opening', async (name) => {
    await withMap(name, null, async (mc) => {
      const n = manifest.nbins
      expect([...mc.activeCells].sort()).toEqual(CELL_NAMES)
      const everything = await mc.matrix({ rows: [0, n] })

      mc.selectCells(['cell_c'])
      expect(mc.activeCells).toEqual(['cell_c'])
      const one = await mc.matrix({ rows: [0, n] })
      expect(denseAt(one.values, n, '0,1')).toBe(100)
      expect(denseAt(one.values, n, '0,0')).toBe(0)

      // …and back, to the same numbers as before the swap.
      mc.selectCells(null)
      const again = await mc.matrix({ rows: [0, n] })
      expect([...again.values]).toEqual([...everything.values])
    })
  })

  it('a file with no cells refuses the request rather than ignoring it', async () => {
    const path = `${FIXTURE_DIR}cells.scool`
    const mc = await MetaCooler.open(
      `${path}::/cells/cell_a`,
      await LocalFileSource.open(path),
    )
    try {
      expect(() => mc.selectCells(['cell_b'])).toThrowError(ViewerError)
      expect(mc.cells).toEqual([])
      expect(mc.activeCells).toEqual([])
    } finally {
      mc.close()
    }
  })
})

describe.skipIf(!present)('the §12 listing gate', () => {
  it.each(LAYOUTS)('%s is recognised as about to list, before it lists', async (name) => {
    await withHandle(name, (h) => {
      expect(willListCells(h, h.attrs())).toBe(true)
    })
  })

  it('a plain cooler is not, so it opens over the network untouched', async () => {
    const path = `${FIXTURE_DIR}cells.scool`
    const source = await LocalFileSource.open(path)
    const h = await openHdf5(`${path}::/cells/cell_a`, source, '/cells/cell_a')
    try {
      expect(willListCells(h, h.attrs())).toBe(false)
    } finally {
      h.close()
    }
  })

  it('is not raised for an HDF5 file that declares some other format', async () => {
    // Everything this viewer cannot open matches "not a cooler and not a
    // collection". Without the format test, an .h5ad or a .loom was met with a
    // dialog about single-cell containers instead of `not-a-cooler`.
    const stub = {
      attrs: () => ({ format: 'AnnData' }),
      has: () => false,
    } as unknown as Hdf5Handle
    expect(willListCells(stub, stub.attrs())).toBe(false)
  })

  it('is not raised for a local file, which pays neither cost', async () => {
    // The premise of the whole gate: it is about round trips, not about the
    // format. A file on disk seeks for free, so it is never asked about.
    await withHandle('cells.scool', async (h) => {
      const layout = detectLayout(h)
      expect(layout.entries?.length).toBe(CELL_NAMES.length)
    })
    const path = `${FIXTURE_DIR}cells.scool`
    const mc = await MetaCooler.open(path, await LocalFileSource.open(path))
    try {
      expect(mc.layout.kind).toBe('scool')
    } finally {
      mc.close()
    }
  })

  it('is raised, with the size in it, when the source seeks over the network', async () => {
    // A local file wearing the one property the gate reads. Everything else
    // about it is a real mount, so what is under test is the decision and not
    // a stub of the reader.
    const path = `${FIXTURE_DIR}cells.scool`
    const real = await LocalFileSource.open(path)
    const remote: ByteSource = {
      id: real.id,
      size: real.size,
      isRemote: true,
      mount: () => real.mount(),
      readBytes: (at, length) => real.readBytes(at, length),
      stats: () => real.stats(),
      close: () => real.close(),
    }
    let thrown: unknown
    try {
      await MetaCooler.open(path, remote)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ViewerError)
    expect((thrown as ViewerError).code).toBe('scool-listing-cost')
    expect((thrown as ViewerError).detail['size']).toBe(real.size)
    real.close()
  })

  it('does not ask again once the reader has agreed to pay', async () => {
    // The bug this is here for: choosing *small pieces* leaves the source
    // remote — that is the whole point of the choice — so the gate saw the same
    // state it had just refused on and refused again, forever. Choosing
    // *download it whole* happened to pass only because that source stops being
    // remote, which is why the flag is explicit rather than inferred.
    const path = `${FIXTURE_DIR}cells.scool`
    const real = await LocalFileSource.open(path)
    const remote: ByteSource = {
      id: real.id,
      size: real.size,
      isRemote: true,
      mount: () => real.mount(),
      readBytes: (at, length) => real.readBytes(at, length),
      stats: () => real.stats(),
      close: () => real.close(),
    }
    const mc = await MetaCooler.open(path, remote, { listingAgreed: true })
    try {
      expect(mc.layout.kind).toBe('scool')
      expect(mc.cells.length).toBe(CELL_NAMES.length)
    } finally {
      mc.close()
    }
  })
})

describe('the cell set in a view state', () => {
  it('round-trips a subset through the hash', () => {
    const state = { uri: 'f.scool', view: 'whole' as const, cells: 'cell_a,cell_c' }
    expect(cellsOf(parseViewState(serialiseViewState(state)) ?? state)).toEqual([
      'cell_a',
      'cell_c',
    ])
  })

  it('writes every cell as the sentinel rather than enumerating them', () => {
    // Four thousand names is not a URL, and "all of them" is the one selection
    // whose meaning does not depend on the file.
    expect(cellsPatch(null, 4000)).toEqual({ cells: '*' })
    expect(cellsPatch(['a', 'b', 'c'], 3)).toEqual({ cells: '*' })
    expect(cellsPatch(['a', 'b'], 3)).toEqual({ cells: 'a,b' })
  })

  it('reads both spellings of all as the same answer', () => {
    expect(cellsOf({ uri: 'f', view: 'whole' })).toBeNull()
    expect(cellsOf({ uri: 'f', view: 'whole', cells: '*' })).toBeNull()
  })
})
