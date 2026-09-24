/**
 * What the compartments drawer says beside Run when the resolution is wrong.
 *
 * A 1 kb bacterial map is 4,642 bins on one sequence: allowed, since it is
 * under the correlation gate, and six minutes of eigenvectors with the CPU
 * meter reading idle. The estimate now says so before Run, and names the rung
 * of the file at which the same sequence is a comfortable size.
 */

import { describe, expect, it } from 'vitest'

import { buildAnalysisContext } from '@/analysis/context'
import { COMFORTABLE_CORRELATION_BINS, COMPARTMENTS_TASK } from '@/analysis/tasks/compartments'
import type { AnalysisContext } from '@/analysis/types'

function context(binsize: number, length: number, resolutions: number[]): AnalysisContext {
  return buildAnalysisContext({
    uri: 'WT.mcool::resolutions/' + binsize,
    layout: 'mcool',
    binsize,
    nBins: Math.ceil(length / binsize),
    hasGenomes: false,
    hasWeights: true,
    scoreColumns: ['count'],
    contigs: {
      length: 1,
      columns: ['name', 'length'],
      data: { name: ['NC_000913.3'], length: Float64Array.from([length]) },
    },
    genomes: null,
    displayGenomes: null,
    entries: [],
    framing: null,
    blockLoaded: false,
    blockBytes: 0,
    resolutions,
  })
}

// The correlation's, since the warning is about the correlation's minutes;
// cooltools' method, the default, is priced below.
const PARAMS = { sequences: ['NC_000913.3'], contacts: 'cis', balance: true, method: 'correlation' }

describe('the compartments estimate at a resolution finer than the task wants', () => {
  it('warns, colours the line as a scan, and names the rung that would fit', () => {
    const estimate = COMPARTMENTS_TASK.estimate(
      context(1000, 4_641_652, [1000, 2000, 5000, 10_000]),
      PARAMS,
    )
    expect(estimate.refusal).toBeUndefined()
    expect(estimate.class).toBe('scan')
    expect(estimate.note).toContain('4,642 bins a sequence at 1 kb')
    expect(estimate.note).toContain(`${COMFORTABLE_CORRELATION_BINS.toLocaleString()} bins`)
    // 5 kb is the finest rung that brings 4.64 Mb under two thousand bins.
    expect(estimate.note).toContain('Open it at 5 kb (929 bins) or coarser.')
  })

  it('says coarser without a rung to name on a file with no ladder', () => {
    const estimate = COMPARTMENTS_TASK.estimate(context(1000, 4_641_652, []), PARAMS)
    expect(estimate.note).toContain('Open the file at a coarser resolution.')
    expect(estimate.note).not.toContain('Open it at')
  })

  it('says nothing of the kind at a resolution that fits', () => {
    const estimate = COMPARTMENTS_TASK.estimate(context(5000, 4_641_652, [1000, 5000]), PARAMS)
    expect(estimate.class).toBe('bounded')
    expect(estimate.note).not.toContain('far finer')
  })
})

/**
 * The warning is about the correlation's minutes, and cooltools' road has no
 * correlation: three eigenvectors of the same 4,642 bins take seconds (§18.8).
 */
describe('the compartments estimate under cooltools’ method, the default', () => {
  it('prices a decomposition, and gives no warning that belongs to the correlation', () => {
    // The default: no method named at all.
    const { method: _correlation, ...defaults } = PARAMS
    void _correlation
    const estimate = COMPARTMENTS_TASK.estimate(context(1000, 4_641_652, [1000, 5000]), defaults)
    expect(estimate.refusal).toBeUndefined()
    expect(estimate.class).toBe('bounded')
    expect(estimate.note).not.toContain('far finer')
    expect(estimate.note).toContain('one decomposition each')
    expect(estimate.note).not.toContain('correlation')
  })
})
