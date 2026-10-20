/**
 * What a run leaves in the form's memory (`analysis/memory.ts`): its own
 * parameters, less the context's seeds the reader never answered — so a form
 * opened on the next rung follows that rung (SPECS §18.2).
 */

import { describe, expect, it } from 'vitest'
import { asAsked } from '../../src/analysis/memory'
import { HICCUPS_TASK } from '../../src/analysis/tasks/hiccups'
import { resolveSeeds, type AnalysisContext, type Params } from '../../src/analysis/types'

/** What the seeds read of a context: its bin size, and nothing else. */
const at = (binsize: number): AnalysisContext => ({ binsize }) as AnalysisContext

describe('a run remembered as it was asked', () => {
  const held: Params = { sequences: null, outer: 5, inner: 2, maxSeparation: null, clusteringRadius: null }

  it('keeps unanswered the seeds it was handed answered', () => {
    const ran = resolveSeeds(HICCUPS_TASK.params, at(1_000), held)
    expect(ran.maxSeparation).toBe(10_000)
    expect(ran.clusteringRadius).toBe(20)
    const kept = asAsked(HICCUPS_TASK, ran, held, at(1_000))
    expect(kept.maxSeparation).toBeNull()
    expect(kept.clusteringRadius).toBeNull()
    // Typed, so kept: a typed number does not follow the map.
    expect(kept.outer).toBe(5)
    expect(kept.inner).toBe(2)
    // And the next rung reads its own: 10 Mb and 20 kb in 10 kb bins.
    const next = resolveSeeds(HICCUPS_TASK.params, at(10_000), kept)
    expect(next.maxSeparation).toBe(1_000)
    expect(next.clusteringRadius).toBe(2)
  })

  it('keeps a number a replay asked for that is not the seed', () => {
    const ran = { ...resolveSeeds(HICCUPS_TASK.params, at(1_000), held), maxSeparation: 500 }
    expect(asAsked(HICCUPS_TASK, ran, held, at(1_000)).maxSeparation).toBe(500)
  })

  it('keeps the run as it ran where the form never held anything', () => {
    const ran = resolveSeeds(HICCUPS_TASK.params, at(1_000), held)
    expect(asAsked(HICCUPS_TASK, ran, null, at(1_000))).toBe(ran)
    expect(asAsked(HICCUPS_TASK, ran, held, null)).toBe(ran)
  })
})
