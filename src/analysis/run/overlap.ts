/**
 * Interval set overlap, run.
 *
 * A thin wrapper: the arithmetic is `analysis/overlap.ts` and the only decision
 * here is how to present it. A table rather than a number, because the four
 * quantities answer different questions and a reader who is handed only the
 * Jaccard will use it for the one it does not answer.
 */

import { compareSets } from '../overlap'
import { idParam, numParam, type TrackTaskRunner } from '../job'
import type { TableOutput, TaskOutput } from '../types'

export const runOverlap: TrackTaskRunner = async (job) => {
  const aId = idParam(job.params, 'a')
  const bId = idParam(job.params, 'b')
  const a = aId === null ? undefined : job.inputs.features?.[aId]
  const b = bId === null ? undefined : job.inputs.features?.[bId]
  if (a === undefined || b === undefined) return []

  job.progress(0, 1, 'Comparing')
  const result = compareSets(a, b, {
    minFraction: Math.max(0, Math.min(1, numParam(job.params, 'minFraction', 0.000001))),
  })
  job.progress(1, 1, 'Done')

  if (!Number.isFinite(result.jaccard)) {
    job.note('Neither set covers any bases, so there is nothing to compare.')
  }

  const table: TableOutput = {
    kind: 'table',
    id: 'overlap',
    label: 'Overlap',
    columns: [
      { key: 'measure', label: 'Measure', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'number', digits: 4 },
      { key: 'note', label: '', kind: 'text' },
    ],
    rows: [
      { measure: 'Jaccard (bases)', value: result.jaccard, note: 'Symmetric; 1 is identical.' },
      { measure: 'Shared bases', value: result.intersection, note: '' },
      { measure: 'Bases in either', value: result.union, note: '' },
      { measure: 'Bases in the first', value: result.basesA, note: 'After merging its own overlaps.' },
      { measure: 'Bases in the second', value: result.basesB, note: 'After merging its own overlaps.' },
      {
        measure: 'First set hit',
        value: result.featuresA === 0 ? Number.NaN : result.featuresAHit / result.featuresA,
        note: `${result.featuresAHit.toLocaleString()} of ${result.featuresA.toLocaleString()} features.`,
      },
      {
        measure: 'Second set hit',
        value: result.featuresB === 0 ? Number.NaN : result.featuresBHit / result.featuresB,
        note: `${result.featuresBHit.toLocaleString()} of ${result.featuresB.toLocaleString()} features.`,
      },
    ],
  }
  const outputs: TaskOutput[] = [table]
  return outputs
}
