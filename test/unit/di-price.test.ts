/**
 * The directionality index's price refuses exactly what its runner cannot
 * score (§18.8): a bin needs a whole window each side, so a sequence must be
 * longer than **twice** the window. The price once refused only a sequence no
 * longer than one window, and a sequence between the two was priced, read,
 * and then dropped by the runner without a score.
 */

import { describe, expect, it } from 'vitest'

import { DI_TASK } from '@/analysis/tasks/di'
import type { AnalysisContext, Params } from '@/analysis/types'

function withSequence(bins: number): AnalysisContext {
  return {
    hasMap: true,
    hasGenomes: false,
    blockLoaded: false,
    binsize: 1000,
    contigs: [{ name: 'IV', bins }],
    entries: [],
    framing: null,
  } as unknown as AnalysisContext
}

const params: Params = { window: 50, sequences: ['IV'] }

describe('the directionality index’s price', () => {
  it('refuses a sequence no longer than twice the window, saying how long it must be', () => {
    for (const bins of [50, 80, 100]) {
      const estimate = DI_TASK.estimate(withSequence(bins), params)
      expect(estimate.refusal, `${bins} bins`).toMatch(/no bin on it has a whole window either side: it needs more than 100/)
    }
  })

  it('prices a sequence one bin longer than that', () => {
    expect(DI_TASK.estimate(withSequence(101), params).refusal).toBeUndefined()
  })
})
