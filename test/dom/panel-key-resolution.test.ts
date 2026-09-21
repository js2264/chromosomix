// @vitest-environment jsdom
/**
 * What the corner key says one square of the map is worth, on a **pooled**
 * block.
 *
 * Two places tell a reader the resolution and they must not disagree: the line
 * above the map (`blockSummary`) and the key in its top-right corner, which is
 * also the key an exported figure carries. On a whole yeast genome the first
 * said `3.0 kb` and the second `9.0 kb`, and the second is the one that leaves
 * the app — `keyNote`'s own docstring is about exactly that risk: "a methods
 * section quoting a number nobody can check against the panel is how the wrong
 * one gets published."
 *
 * The cause was one constructor argument feeding two fields that mean different
 * things. `options.binsize` is the **effective** resolution and `setResolution`
 * overwrites it from every block; `baseBinsize` is **the open map's own**, taken
 * once at construction and never updated. `WholeView` is the only view that
 * plans its grid before it reads, so it was the only one that could pass the
 * pooled number — right for the first field, wrong for the second, and the key
 * multiplies `binsPerCell` into the second a second time.
 *
 * So what is pinned here is the **agreement**, not a string: whatever the file's
 * bin size and however hard the view pools, the key says what the line says.
 * A single wrong constant would satisfy one assertion; it cannot satisfy this.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MatrixPanel, resolutionNote } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
})

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** An on-diagonal square of one sequence, pooled as a wide view would pool it. */
function block(bins: number, binsPerCell = 1): MatrixResult {
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins),
    rowExtent: [0, bins],
    colExtent: [0, bins],
    rowGroups: [{ label: 'I', start: 0, end: bins, unitStart: 0 }],
    colGroups: [{ label: 'I', start: 0, end: bins, unitStart: 0 }],
    level: 'bin',
    binsPerCell,
  } as unknown as MatrixResult
}

/**
 * A panel holding a block, built and driven **as every view builds and drives
 * one**: the file's own bin size at construction, then the effective resolution,
 * then the block. Getting this sequence wrong is what let the bug hide — see
 * `analysis-framing-label.test.ts`, whose harness omitted `setResolution` and so
 * asserted against a state no view ever produces.
 */
async function panelShowing(fileBinsize: number, data: MatrixResult): Promise<MatrixPanel> {
  const panel = new MatrixPanel({ binsize: fileBinsize, detachedControls: true, hideTitle: true })
  built.push(panel)
  document.body.append(panel.el)
  panel.setResolution(fileBinsize * ((data as { binsPerCell?: number }).binsPerCell ?? 1))
  panel.setData(data, 'I')
  await frame()
  return panel
}

/** What the corner key says a square covers. */
function keyNote(panel: MatrixPanel): string {
  return panel.el.querySelector('.map-key-note')?.textContent ?? ''
}

describe('the resolution in the map’s corner', () => {
  it('is the cell size, not the cell size times the pooling', async () => {
    // The yeast whole-genome case exactly: 1 kb bins, three to a cell.
    const panel = await panelShowing(1000, block(64, 3))
    expect(keyNote(panel)).toBe('3.0 kb')
    expect(keyNote(panel)).not.toBe('9.0 kb')
  })

  it('agrees with the line above the map, at every pooling', async () => {
    for (const [fileBinsize, binsPerCell] of [
      [1000, 1],
      [1000, 3],
      [200, 13],
      [20_000, 4],
      [5000, 2],
    ] as const) {
      const data = block(64, binsPerCell)
      const panel = await panelShowing(fileBinsize, data)
      // `blockSummary` builds the line above the map from the file's own bin
      // size; `resolutionNote` is the phrase it puts in it, and the key prints
      // the same phrase with its prefix removed.
      const said = resolutionNote(fileBinsize, data).replace(/^effective resolution: /, '')
      expect(keyNote(panel), `${fileBinsize} bp × ${binsPerCell}`).toBe(said)
    }
  })

  it('is unmoved by setResolution, because it reads the open map and not the grid', async () => {
    // The sharp form of the whole bug. `setResolution` is how the *effective*
    // resolution arrives and it is called on every block; the key must be
    // reading the other field. If it ever reads `options.binsize`, this moves —
    // and that is precisely what `WholeView` achieved by passing its pooled
    // grid to the constructor, where it seeded both fields at once.
    const panel = await panelShowing(1000, block(64, 3))
    expect(keyNote(panel)).toBe('3.0 kb')
    panel.setResolution(1000 * 3)
    await frame()
    expect(keyNote(panel)).toBe('3.0 kb')
    panel.setResolution(1000 * 9)
    await frame()
    expect(keyNote(panel)).toBe('3.0 kb')
  })

  it('says nothing where a cell is a whole sequence, rather than padding itself', async () => {
    // A contig-level block has no bin resolution to report, and a key line that
    // is sometimes blank beats one that reads `1 sequence per cell`.
    const contigs = {
      ...block(8),
      level: 'contig',
      contigsPerCell: 1,
    } as unknown as MatrixResult
    const panel = await panelShowing(1000, contigs)
    expect(keyNote(panel)).toBe('')
  })
})

describe('resolutionNote', () => {
  // The unit underneath, so a failure above can be read as either the panel
  // handing it the wrong number or this getting the arithmetic wrong.
  it('multiplies the pooling into the bin size exactly once', () => {
    expect(resolutionNote(1000, { binsPerCell: 3, level: 'bin' })).toBe(
      'effective resolution: 3.0 kb',
    )
  })

  it('takes the answering rung’s bin size over the open map’s', () => {
    // A block read from a sibling rung carries its own, and it wins — the
    // caller's is the open map's and would caption a 2 kb read as 1 kb.
    expect(resolutionNote(1000, { binsPerCell: 1, level: 'bin', binsize: 2000 })).toBe(
      'effective resolution: 2.0 kb',
    )
  })
})
