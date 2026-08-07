/**
 * What the numbers in the cells *are* — the one question the picture cannot
 * answer about itself.
 *
 * A contact map is a field of colour, and the colour means nothing until you
 * know what was measured. cooler fixes `/pixels` at `bin1_id`, `bin2_id` and
 * `count`, and lets a file carry more columns beside them: an expected value, a
 * second normalisation, a per-pixel significance. Those are values per pixel
 * exactly as `count` is, and a viewer that assumed `count` could not draw them
 * at all — so a file that had gone to the trouble of storing one had no way of
 * saying so.
 *
 * Balancing is *not* one of those columns and is deliberately in the same list.
 * It is a transform applied to whichever column was read — cell × weight × weight
 * (§6.4) — but to a reader choosing what to look at it is one more answer to
 * "what am I seeing", and offering it as a tickbox beside a dropdown would be
 * splitting one question across two controls. The choice is flattened here and
 * unflattened into {@link ScoreChoice}'s two fields, which is the shape the
 * reader wants.
 */

/** One entry in the picker: what it says, and what it asks the reader for. */
export interface ScoreChoice {
  /** Stable identity, carried in the view state. `count`, `balanced`, or a column. */
  id: string
  /** What the dropdown shows. */
  label: string
  /** Multiply by the two bin weights. */
  balance: boolean
  /** `/pixels` column to read; absent means `count`. */
  value?: string
}

/** The id of the plain, always-present choice. */
export const COUNT_SCORE = 'count'
/** The id of "counts, weighted" — a transform rather than a column. */
export const BALANCED_SCORE = 'balanced'

/**
 * Everything this file can be drawn from, in the order it should be offered.
 *
 * Counts first because every cooler has them and everything else is an
 * alternative *to* them; balanced immediately after, because on a file that
 * carries weights it is what most readers actually want and the pair is one
 * decision. The file's own extra columns come last, under their own names —
 * this code has no vocabulary for what `expected` or `qvalue` mean and does not
 * invent one.
 */
export function scoreChoices(info: {
  hasWeights: boolean
  scoreColumns?: readonly string[]
}): ScoreChoice[] {
  const columns = info.scoreColumns ?? [COUNT_SCORE]
  const extras = columns.filter((key) => key !== COUNT_SCORE)
  return [
    { id: COUNT_SCORE, label: 'counts', balance: false },
    ...(info.hasWeights ? [{ id: BALANCED_SCORE, label: 'balanced', balance: true }] : []),
    ...extras.map((key) => ({ id: key, label: key, balance: false, value: key })),
  ]
}

/**
 * The choice a view state names, or counts.
 *
 * Untrusted input, like every other field of a shared link: a hash naming a
 * column this file does not have, or `balanced` on a file with no weights, lands
 * on counts rather than on a read that cannot be served. `balance=1` is still
 * read, because it is what every link written before this control existed says.
 */
export function scoreFor(
  choices: readonly ScoreChoice[],
  state: { balance?: boolean; score?: string },
): ScoreChoice {
  const wanted = state.score ?? (state.balance === true ? BALANCED_SCORE : COUNT_SCORE)
  return choices.find((choice) => choice.id === wanted) ?? choices[0]
}
