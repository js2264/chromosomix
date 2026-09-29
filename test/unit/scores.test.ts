/**
 * What a contact map's cells *are*, and how a link says so.
 *
 * The picker is one control over two state fields — `balance`, which every link
 * written before it existed already carries, and `score`, which names a column.
 * Two fields for one question is a shape that goes wrong quietly: the failure is
 * a recipient looking at counts while the sender looks at expected values, with
 * both pictures perfectly plausible.
 */

import { describe, expect, it } from 'vitest'

import {
  BALANCED_SCORE,
  BASELINE_SCORE,
  CORRELATION_SCORE,
  COUNT_SCORE,
  INTERARM_SCORE,
  scoreChoices,
  scoreFor,
} from '@/ui/scores'

describe('what the cells can be', () => {
  // The plainest file there is — no weights, no extra columns — and it still has
  // a choice, which is the whole of the argument for computing normalisations
  // here. Before, this file's picker had one entry and so was not drawn at all,
  // and the answer to "can I see this normalised" was no.
  it('offers the computed normalisations on a file that carries nothing but counts', () => {
    const choices = scoreChoices({ hasWeights: false, scoreColumns: ['count'] })
    expect(choices.map((c) => c.id)).toEqual([COUNT_SCORE, 'vc', 'vcsqrt', 'ice', BASELINE_SCORE])
    // Counts first: everything else is an alternative *to* them.
    expect(choices[0].normalise).toBeUndefined()
    // None of them reads anything the file has not got.
    for (const choice of choices.slice(1)) {
      expect(choice.balance).toBe(false)
      expect(choice.value).toBeUndefined()
    }
  })

  it('adds balanced where there are weights, next to the counts it transforms', () => {
    const choices = scoreChoices({ hasWeights: true, scoreColumns: ['count'] })
    expect(choices.map((c) => c.id)).toEqual([
      COUNT_SCORE,
      BALANCED_SCORE,
      'vc',
      'vcsqrt',
      'ice',
      // Needs nothing of the file, so it is on every map — and sits where it
      // sits in the pipeline, one step inside the correlation.
      BASELINE_SCORE,
      // Needs the weights too, and for a reason of its own: a correlation of
      // unbalanced O/E is a correlation of the coverage bias, which is per-bin
      // and therefore looks exactly like a compartment.
      CORRELATION_SCORE,
    ])
    expect(choices[1].balance).toBe(true)
    // Balancing is a transform, not a column: nothing else is read for it.
    expect(choices[1].value).toBeUndefined()
    // And the file's own weights sit above the ones computed here, because where
    // the two disagree the file's are the better answer: a real balancing run
    // filters bins first and this one does not.
    expect(choices[1].normalise).toBeUndefined()
    expect(choices[4].normalise).toBe('ice')
  })

  // Never both at once. Correcting a matrix that has already been corrected is
  // not a picture of anything, and keeping the two exclusive here is what saves
  // the renderer from having to enforce it.
  it('never asks for the file’s weights and a computed normalisation together', () => {
    const choices = scoreChoices({ hasWeights: true, scoreColumns: ['count', 'expected'] })
    for (const choice of choices) {
      expect(choice.balance && choice.normalise !== undefined).toBe(false)
    }
  })

  // The file's own vocabulary, under the file's own names — this code has none
  // for what `expected` or `qvalue` mean and does not invent one. The order is
  // the one it was handed, because deciding it twice is how the picker and the
  // reader come to disagree: `MetaCooler.scoreColumns` is where extras are put
  // in a stable order, once, from the group's own child list.
  it('lists the extra pixel columns after the two it knows about', () => {
    const choices = scoreChoices({
      hasWeights: true,
      scoreColumns: ['count', 'expected', 'qvalue'],
    })
    expect(choices.map((c) => c.id)).toEqual([
      COUNT_SCORE,
      BALANCED_SCORE,
      'vc',
      'vcsqrt',
      'ice',
      BASELINE_SCORE,
      CORRELATION_SCORE,
      'expected',
      'qvalue',
    ])
    expect(choices[7]).toMatchObject({ value: 'expected', balance: false })
  })

  it('resolves what a link asks for', () => {
    const choices = scoreChoices({ hasWeights: true, scoreColumns: ['count', 'expected'] })
    expect(scoreFor(choices, {}).id).toBe(COUNT_SCORE)
    // Every link written before `score` existed says this, and still means it.
    expect(scoreFor(choices, { balance: true }).id).toBe(BALANCED_SCORE)
    expect(scoreFor(choices, { score: 'expected' }).value).toBe('expected')
  })

  // A shared link is untrusted input like any other: a column this file has not
  // got must land somewhere readable rather than on a read that cannot be served.
  it('falls back to counts for a score this file cannot serve', () => {
    const plain = scoreChoices({ hasWeights: false, scoreColumns: ['count'] })
    expect(scoreFor(plain, { score: 'expected' }).id).toBe(COUNT_SCORE)
    expect(scoreFor(plain, { balance: true }).id).toBe(COUNT_SCORE)
  })
})

/**
 * An id is not a column, and a task that confuses the two reads nothing.
 *
 * `MatrixPanel.analysisFraming` used to hand the picker's `current` — an **id**
 * — to `AnalysisFraming.value`, which every analysis runner passes to
 * `mc.matrix({ value })` as a `/pixels` column name. On the commonest file there
 * is, a cooler somebody ran `cooler balance` over, that asked HDF5 for
 * `/resolutions/100/pixels/balanced` and every task on the map failed with *does
 * not exist*. `ICE`, `VC` and `VC √` did the same.
 *
 * The three fields below are what a choice actually means, and the invariant is
 * that only one of them is ever a column: two of the six entries name one, and
 * the other four are a transform, three computations and counts.
 */
describe('a choice unflattened, which is what an analysis needs', () => {
  const choices = scoreChoices({ hasWeights: true, scoreColumns: ['count', 'expected'] })

  it('never lets a non-column id pass as a column', () => {
    for (const choice of choices) {
      if (choice.value === undefined) continue
      // Anything that names a column names one the file said it has.
      expect(['count', 'expected']).toContain(choice.value)
    }
    // The two that read like columns and are not.
    expect(choices.find((c) => c.id === BALANCED_SCORE)?.value).toBeUndefined()
    expect(choices.find((c) => c.id === 'ice')?.value).toBeUndefined()
  })

  it('puts balancing in `balance` and nowhere else', () => {
    const balanced = choices.find((c) => c.id === BALANCED_SCORE)
    expect(balanced?.balance).toBe(true)
    expect(balanced?.normalise).toBeUndefined()
    // …and `balance` is never two things: the only other entry that sets it is
    // the correlation, which sets it because its pipeline genuinely starts at
    // balanced counts — not as a second meaning for the field.
    for (const choice of choices) {
      if (choice.id === BALANCED_SCORE || choice.correlate === true) continue
      expect(choice.balance).toBe(false)
    }
    const correlation = choices.find((c) => c.id === CORRELATION_SCORE)
    expect(correlation).toMatchObject({ balance: true, correlate: true })
    // It is a pipeline, not a column and not one of the normalisations computed
    // from counts: the only field it adds is its own.
    expect(correlation?.value).toBeUndefined()
    expect(correlation?.normalise).toBeUndefined()
  })

  it('offers the baseline everywhere, since it asks the file for nothing', () => {
    const bare = scoreChoices({ hasWeights: false, scoreColumns: ['count'] })
    const baseline = bare.find((c) => c.id === BASELINE_SCORE)
    expect(baseline).toMatchObject({ label: 'expected', baseline: true, balance: false })
    // A derivation, not a reading and not a correction: it names no column and
    // asks for no normalisation, exactly as the correlation does.
    expect(baseline?.value).toBeUndefined()
    expect(baseline?.normalise).toBeUndefined()
    expect(baseline?.correlate).toBeUndefined()
  })

  // The collision this is written against is not hypothetical: `expected` is the
  // first example the module header gives of a column a file may carry, and the
  // suite above passes one in every case. Two entries labelled `expected` would
  // be a picker that cannot say which one was clicked, and two entries *with the
  // same id* would be worse — `scoreFor` finds one, and the file's own data
  // becomes unreachable through the control that exists to reach it.
  it('does not take the name of a column a file may carry', () => {
    const choices = scoreChoices({ hasWeights: true, scoreColumns: ['count', 'expected'] })
    const ids = choices.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    const labels = choices.map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
    // The derived one keeps the word, because it has no other name; the column
    // is marked as what it is, because it does.
    expect(choices.find((c) => c.id === BASELINE_SCORE)?.label).toBe('expected')
    expect(choices.find((c) => c.value === 'expected')?.label).toBe('expected (column)')
    // And a link naming the column still lands on the column.
    expect(scoreFor(choices, { score: 'expected' }).value).toBe('expected')
    expect(scoreFor(choices, { score: BASELINE_SCORE }).baseline).toBe(true)
  })

  it('offers the correlation only where there are weights to balance with', () => {
    const bare = scoreChoices({ hasWeights: false, scoreColumns: ['count'] })
    expect(bare.some((c) => c.correlate === true)).toBe(false)
    // And it is the only entry that is a pipeline rather than a reading.
    expect(choices.filter((c) => c.correlate === true)).toHaveLength(1)
  })

  it('marks the computed ones, which no read can ask the file for', () => {
    // These are `render/derive.ts`'s arithmetic over a block already read. A
    // task reading the file for itself cannot reproduce them, which is why the
    // runner notes it rather than captioning counts as ICE.
    const computed = choices.filter((c) => c.normalise !== undefined).map((c) => c.id)
    expect(computed).toEqual(['vc', 'vcsqrt', 'ice'])
    for (const id of computed) {
      expect(choices.find((c) => c.id === id)?.value).toBeUndefined()
    }
  })

  it('resolves counts for a choice nothing recognises', () => {
    // The path a stored session takes when it names a column this file lost.
    expect(scoreFor(choices, { score: 'qvalue' }).id).toBe(COUNT_SCORE)
    expect(scoreFor(choices, { score: 'qvalue' }).value).toBeUndefined()
  })
})

/**
 * The baseline's inter-arm half (§7.5, §8.15), on a view of one circle.
 *
 * Offered where there are two arms to be across and nowhere else, so the
 * question is asked of the view rather than of the file: the same cooler offers
 * it on its chromosome's map and not on its whole-genome one.
 */
describe('the inter-arm half of the baseline', () => {
  it('is offered only on a view of one circle, right under the baseline it is half of', () => {
    const plain = scoreChoices({ hasWeights: true, scoreColumns: ['count'] })
    expect(plain.some((c) => c.id === INTERARM_SCORE)).toBe(false)
    expect(scoreChoices({ hasWeights: true, scoreColumns: ['count'], circle: false })).toEqual(plain)
    const circle = scoreChoices({ hasWeights: true, scoreColumns: ['count'], circle: true })
    expect(circle.map((c) => c.id)).toEqual([
      COUNT_SCORE,
      BALANCED_SCORE,
      'vc',
      'vcsqrt',
      'ice',
      BASELINE_SCORE,
      INTERARM_SCORE,
      CORRELATION_SCORE,
    ])
  })

  it('is a baseline, and so reads the counts and asks the file for nothing', () => {
    const entry = scoreChoices({ hasWeights: false, circle: true }).find((c) => c.id === INTERARM_SCORE)
    expect(entry).toMatchObject({ label: 'inter-arm', balance: false, baseline: true, interArm: true })
    expect(entry?.value).toBeUndefined()
    expect(entry?.normalise).toBeUndefined()
    expect(entry?.correlate).toBeUndefined()
    // The whole baseline stays whole.
    expect(scoreChoices({ hasWeights: false, circle: true }).find((c) => c.id === BASELINE_SCORE)?.interArm)
      .toBeUndefined()
  })

  it('resolves from a link on a circle, and lands on counts anywhere else', () => {
    const circle = scoreChoices({ hasWeights: true, circle: true })
    expect(scoreFor(circle, { score: INTERARM_SCORE }).interArm).toBe(true)
    const line = scoreChoices({ hasWeights: true })
    expect(scoreFor(line, { score: INTERARM_SCORE }).id).toBe(COUNT_SCORE)
  })

  it('does not take the name of a column a file may carry', () => {
    const choices = scoreChoices({ hasWeights: true, scoreColumns: ['count', 'inter-arm'], circle: true })
    const labels = choices.map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(choices.find((c) => c.value === 'inter-arm')?.label).toBe('inter-arm (column)')
  })
})
