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

import { BALANCED_SCORE, COUNT_SCORE, scoreChoices, scoreFor } from '@/ui/scores'

describe('what the cells can be', () => {
  // The plainest file there is — no weights, no extra columns — and it still has
  // a choice, which is the whole of the argument for computing normalisations
  // here. Before, this file's picker had one entry and so was not drawn at all,
  // and the answer to "can I see this normalised" was no.
  it('offers the computed normalisations on a file that carries nothing but counts', () => {
    const choices = scoreChoices({ hasWeights: false, scoreColumns: ['count'] })
    expect(choices.map((c) => c.id)).toEqual([COUNT_SCORE, 'vc', 'vcsqrt', 'ice'])
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
    expect(choices.map((c) => c.id)).toEqual([COUNT_SCORE, BALANCED_SCORE, 'vc', 'vcsqrt', 'ice'])
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
      'expected',
      'qvalue',
    ])
    expect(choices[5]).toMatchObject({ value: 'expected', balance: false })
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
    // …and every other entry leaves it off, so `balance` is never two things.
    for (const choice of choices) {
      if (choice.id === BALANCED_SCORE) continue
      expect(choice.balance).toBe(false)
    }
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
