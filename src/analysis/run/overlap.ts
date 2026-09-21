/**
 * Interval set overlap, run.
 *
 * A thin wrapper: the arithmetic is `analysis/overlap.ts` and the only decision
 * here is how to present it. A table rather than a number, because the four
 * quantities answer different questions and a reader who is handed only the
 * Jaccard will use it for the one it does not answer.
 */

import { compareSets, shuffleNull, type NullStat } from '../overlap'
import { boolParam, chosenInput, numParam, strParam, type TrackTaskRunner } from '../job'
import type { TableOutput, TaskOutput } from '../types'

export const runOverlap: TrackTaskRunner = async (job) => {
  // By the **parameter key**, `a` and `b` — see `chosenInput`.
  const first = chosenInput(job.inputs.features, job.params, 'a')
  const second = chosenInput(job.inputs.features, job.params, 'b')
  const a = first.value
  const b = second.value
  if (a === undefined || b === undefined) {
    const short = [first, second].filter((found) => found.value === undefined)
    const picked = short.filter((found) => found.chosen).length
    job.note(
      picked === short.length
        ? // Both slots hold an id and neither set is loaded: the rows went away
          // after the form was filled in.
          `The interval ${short.length === 2 ? 'sets' : 'set'} chosen ${short.length === 2 ? 'are' : 'is'} no longer loaded. Re-open the file, or pick another.`
        : `Two interval sets are needed and ${short.length === 2 && picked === 0 ? 'neither has' : 'one has not'} been chosen. Load two BED files, or a BED and a GTF, and pick one in each box.`,
    )
    return []
  }

  job.progress(0, 1, 'comparing')
  const result = compareSets(a, b, {
    minFraction: Math.max(0, Math.min(1, numParam(job.params, 'minFraction', 0.000001))),
  })
  job.progress(1, 1, 'done')

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
      { key: 'note', label: 'Note', kind: 'text' },
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

  if (!boolParam(job.params, 'shuffle', false)) return outputs

  // Which set moves is a parameter because the per-feature statistic is not
  // symmetric: *are my loops on boundaries* and *are boundaries on my loops* are
  // different questions with different nulls, and a task that always shuffled
  // the first would answer whichever of them the reader happened to load first.
  const movesFirst = strParam(job.params, 'shuffleWhich', 'a') !== 'b'
  const iterations = Math.max(20, Math.trunc(numParam(job.params, 'iterations', 1000)))
  job.progress(0, iterations, 'shuffling')
  const test = shuffleNull(movesFirst ? a : b, movesFirst ? b : a, {
    minFraction: Math.max(0, Math.min(1, numParam(job.params, 'minFraction', 0.000001))),
    iterations,
    seed: numParam(job.params, 'seed', 1),
    lengthOf: (contig) => job.lengthOf(contig),
    cancelled: () => job.cancelled(),
    onProgress: (done, total) => job.progress(done, total, 'shuffling'),
  })
  job.throwIfCancelled()

  if (test === null) {
    job.note(
      'The set chosen to move occupies no sequence this session knows a length for, so there ' +
        'was nothing to shuffle it within. Load the assembly — a chrom.sizes, or the map itself.',
    )
    return outputs
  }

  if (test.assumedLengths.length > 0) {
    // Said out loud rather than absorbed, because it biases in a known
    // direction: a null drawn on the span the data happens to reach is drawn on
    // something shorter than the real sequence, which packs the shuffled
    // intervals more tightly than chance would and inflates every enrichment.
    job.note(
      `${test.assumedLengths.length.toLocaleString()} sequence` +
        `${test.assumedLengths.length === 1 ? ' has' : 's have'} no known length, so the null was ` +
        'drawn over the furthest position either set reaches there — which is shorter than the ' +
        `sequence and overstates the enrichment. ${test.assumedLengths.slice(0, 6).join(', ')}` +
        `${test.assumedLengths.length > 6 ? ', …' : ''}.`,
    )
  }
  if (test.droppedContigs.length > 0) {
    job.note(
      `${test.droppedContigs.length.toLocaleString()} sequence` +
        `${test.droppedContigs.length === 1 ? '' : 's'} could not be shuffled at all and ` +
        `${test.droppedContigs.length === 1 ? 'is' : 'are'} left out of the null: ` +
        `${test.droppedContigs.slice(0, 6).join(', ')}${test.droppedContigs.length > 6 ? ', …' : ''}.`,
    )
  }

  const moved = movesFirst ? 'first' : 'second'
  const rowFor = (label: string, stat: NullStat, digits: number): Record<string, string | number> => ({
    measure: label,
    observed: stat.observed,
    expected: stat.mean,
    fold: stat.fold,
    z: stat.z,
    // One tail, chosen by which side the observation actually fell on, rather
    // than both printed side by side: a reader looking at a fold of 4 does not
    // want the depletion p, and a table that offers both invites the smaller one
    // to be quoted whichever way the result went.
    p: stat.observed >= stat.mean ? stat.pEnriched : stat.pDepleted,
    tail: stat.observed >= stat.mean ? 'enriched' : 'depleted',
    digits,
  })

  const rows = [
    rowFor('Jaccard (bases)', test.jaccard, 4),
    rowFor('Shared bases', test.intersection, 0),
    rowFor(`Features of the ${moved} set hit`, test.featuresHit, 0),
  ].map(({ digits: _digits, ...row }) => row)

  outputs.push({
    kind: 'table',
    id: 'overlap-null',
    label: `Against ${test.iterations.toLocaleString()} shuffles of the ${moved} set`,
    columns: [
      { key: 'measure', label: 'Measure', kind: 'text' },
      { key: 'observed', label: 'Observed', kind: 'number', digits: 4 },
      { key: 'expected', label: 'Expected', kind: 'number', digits: 4, hint: 'Mean of the null.' },
      { key: 'fold', label: 'Fold', kind: 'number', digits: 2, hint: 'Observed over expected.' },
      { key: 'z', label: 'z', kind: 'number', digits: 2 },
      {
        key: 'p',
        label: 'p',
        kind: 'number',
        digits: 5,
        hint:
          'Permutation p on the tail the observation fell on, with Phipson and Smyth’s +1: the ' +
          `smallest this run can report is ${(1 / (test.iterations + 1)).toPrecision(2)}.`,
      },
      { key: 'tail', label: 'Tail', kind: 'text' },
    ],
    rows,
  } satisfies TableOutput)

  return outputs
}
