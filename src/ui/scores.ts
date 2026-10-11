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
 * unflattened into {@link ScoreChoice}'s three fields, which is the shape the
 * reader wants.
 *
 * The same argument admits the normalisations `render/derive.ts` computes, and
 * they are the reason the list stopped being short. `balanced` is only offered
 * on a file somebody ran `cooler balance` over, which most files are not, and a
 * reader of one of those had exactly one entry — so the control disappeared
 * entirely and the answer to "can I see this normalised" was no. VC, VC √ and
 * ICE need nothing from the file but its counts, so they are always there, and
 * they belong in this list rather than beside it because a reader picking
 * between `balanced` and `ICE` is picking between two answers to one question:
 * whose balancing, the file's or ours.
 *
 * Observed-over-expected is deliberately **not** in this list, and it is the one
 * place the argument above stops. It does not answer "what number is in the
 * cell" — it answers "compared to what", and it composes with every entry here
 * (the standard pipeline is O/E *of* balanced counts). Folding it in would make
 * `balanced` and `O/E` mutually exclusive, which is not a limitation of the
 * arithmetic but only of the control; it gets a toggle of its own.
 *
 * **The baseline is in the list, and the O/E argument is what puts it there.**
 * `expected` does not answer "compared to what" — it *is* the what: every cell
 * replaced by the mean the ratio would have divided it by, so the picture is the
 * distance decay alone. That composes with nothing either, for the same reason
 * the correlation does not: O/E of the baseline is 1 wherever it is anything, so
 * the toggle has nothing left to do and goes inert while this is chosen. It is
 * computed from the counts rather than from balanced counts, which is what makes
 * it the denominator of the O/E this app draws by default — the picker opens on
 * `counts`, and `balanced` is a choice a reader makes, not the one they are
 * given. Pick `balanced` and turn O/E on and the baseline is recomputed from
 * those; this entry is the one you can *see*, not a claim that it is the only
 * one there is.
 *
 * **On a circle the baseline has a second shape, and it is in the list for
 * the same reason.** Taken along a bacterial chromosome's two arms (§8.15) the
 * baseline is an X: the main diagonal's decay down each arm, and the inter-arm
 * decay either side of the secondary diagonal through the origin — where the
 * plain one has only the first, and averages the second into it. `arm decay`
 * is that baseline drawn, which answers "what are these numbers" exactly as
 * `expected` does. It is the picture `expected` draws while `arms` is on,
 * offered as one choice so that looking at both diagonals does not depend on a
 * toggle; and it is offered on a view of one sequence declared circular and
 * nowhere else, because nowhere else are there two arms to read it along. A
 * link naming it anywhere else lands on counts, as one naming a column the
 * file lacks does.
 *
 * **The correlation is in the list, and the O/E argument is exactly why.** It is
 * the one derived field that does not compose with anything: the cell no longer
 * holds a contact at all, it holds a coefficient between −1 and 1 for a *pair of
 * bins' whole rows*. There is no such thing as the correlation of a VC-corrected
 * map beside the correlation of a balanced one — the pipeline that gives the
 * A/B compartments is fixed at balanced → O/E → correlate, so the entry carries
 * all three and the reader picks one thing. That is the same flattening
 * `balanced` gets two paragraphs above, applied to a longer pipeline: a control
 * per step would be three controls whose only legal combination is the one this
 * entry already is.
 */

import type { Normalisation } from '../render/derive'

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
  /**
   * Normalisation to compute here from whatever was read; absent means none.
   *
   * Orthogonal to the two fields above, and in practice never combined with
   * {@link balance}: correcting a matrix that has already been corrected is not
   * a picture of anything. {@link scoreChoices} never emits both, so the
   * exclusivity is a fact about the list rather than a rule the renderer has to
   * enforce.
   */
  normalise?: Normalisation
  /**
   * Replace the square by the correlation between its rows, over balanced
   * observed-over-expected (§18.8).
   *
   * The only entry that is a *pipeline* rather than a reading, and the only one
   * that can be refused: it needs a square block of one file, and it is cubic in
   * the bins, so `ui/MapDerivation.ts` gates it and says so in the caption when it
   * cannot be drawn. Carried here rather than as a key of its own so that
   * picking it is one act — see this module's header.
   */
  correlate?: boolean
  /**
   * Replace every cell by the expected value at its separation — the
   * denominator of an observed/expected, drawn instead of divided by
   * (`render/derive.ts`).
   *
   * Like {@link correlate} it is a derivation rather than a reading, and like it
   * the entry carries what it needs so that picking it is one act. Unlike it, it
   * needs nothing of the file and can be refused for nothing, so it is offered
   * on every map.
   */
  baseline?: boolean
  /**
   * Take that baseline along both arms of a circular chromosome — both of its
   * diagonals, the main one and the secondary one through the origin — whether
   * or not the `arms` toggle is on (`analysis/arms.ts`, §8.15).
   *
   * Always beside {@link baseline}, which is what it is a shape of, so
   * everything the baseline sets aside — the O/E toggle, the ramp's middle —
   * this sets aside too.
   */
  alongArms?: boolean
}

/** The id of the plain, always-present choice. */
export const COUNT_SCORE = 'count'
/** The id of "counts, weighted" — a transform rather than a column. */
export const BALANCED_SCORE = 'balanced'
/** The id of the compartment pipeline: balanced, over expected, correlated. */
export const CORRELATION_SCORE = 'correlation'
/**
 * The id of the distance-decay baseline — the denominator of O/E, drawn.
 *
 * `baseline` and not `expected`, which is the label. A `/pixels` column called
 * `expected` is the *first* example this module's header gives of what a file
 * may carry, and it would arrive in {@link scoreChoices}'s extras under exactly
 * that id — two entries with one id, of which {@link scoreFor} would find one
 * and the file's own data would become unreachable. The label is disambiguated
 * the other way round, in the extras, so that the reader still sees the word
 * they are looking for on the thing this computes.
 */
export const BASELINE_SCORE = 'baseline'
/** The id of the baseline along a circle's two arms — `score=armbaseline` in a link. */
export const ARM_BASELINE_SCORE = 'armbaseline'

/**
 * Everything this file can be drawn from, in the order it should be offered.
 *
 * Counts first because every cooler has them and everything else is an
 * alternative *to* them; balanced immediately after, because on a file that
 * carries weights it is what most readers actually want and the pair is one
 * decision. Then the three the viewer can compute from counts alone, cheapest
 * first — which is also weakest-assumption first, so a reader working down the
 * list is asking for progressively more to be taken on trust. The file's own
 * extra columns come last, under their own names — this code has no vocabulary
 * for what `expected` or `qvalue` mean and does not invent one.
 *
 * `ice` sits *below* `balanced` rather than replacing it on a file that has
 * both. They should agree, and where they do not the file's own weights are the
 * better answer: a real balancing run filters bins before it starts, and this
 * one deliberately does not (`render/derive.ts`).
 *
 * `circle` is whether the view is a window on one sequence declared circular
 * (§8.15) — the only view with two arms to read the baseline along, and so the
 * only one that is offered on.
 */
export function scoreChoices(info: {
  hasWeights: boolean
  scoreColumns?: readonly string[]
  circle?: boolean
}): ScoreChoice[] {
  const columns = info.scoreColumns ?? [COUNT_SCORE]
  const extras = columns.filter((key) => key !== COUNT_SCORE)
  return [
    { id: COUNT_SCORE, label: 'counts', balance: false },
    ...(info.hasWeights ? [{ id: BALANCED_SCORE, label: 'balanced', balance: true }] : []),
    { id: 'vc', label: 'VC', balance: false, normalise: 'vc' as const },
    { id: 'vcsqrt', label: 'VC √', balance: false, normalise: 'vcsqrt' as const },
    { id: 'ice', label: 'ICE', balance: false, normalise: 'ice' as const },
    // Between the normalisations and the correlation, because that is where it
    // sits in the pipeline they are ordered by: it is a step *of* the O/E the
    // correlation is taken over, and the list runs outward from the numbers in
    // the file.
    { id: BASELINE_SCORE, label: 'expected', balance: false, baseline: true },
    // Right under the baseline it is a shape of, and only where there are two
    // arms to read it along. Two short words, because the dropdown beside its
    // label is 97 pixels and `arm expected` would lose its last letters there;
    // `decay` is the arms toggle's own word for the thing divided out, and the
    // caption, which has the room, says `expected along the arms`.
    ...(info.circle === true
      ? [{ id: ARM_BASELINE_SCORE, label: 'arm decay', balance: false, baseline: true, alongArms: true }]
      : []),
    // Only on a file that carries weights, and that is the pipeline's own
    // requirement rather than a preference: a correlation of unbalanced O/E is a
    // correlation of the coverage bias, which is per-bin and therefore looks
    // exactly like a compartment. Beside `balanced` in what it needs and after
    // `ICE` in the list, because it is the furthest of these from the numbers in
    // the file and the list runs outward.
    ...(info.hasWeights
      ? [{ id: CORRELATION_SCORE, label: 'correlation', balance: true, correlate: true }]
      : []),
    // Under the file's own names, except where one of those names is already the
    // label of something computed above — `expected` is the collision that
    // actually happens, and two entries reading `expected` would be a picker
    // that cannot say which one the reader clicked. The *column* is the one that
    // moves, because the derived entry has no other name to go by and a column
    // does: its own, said plainly.
    ...extras.map((key) => ({
      id: key,
      label: DERIVED_LABELS.has(key) ? `${key} (column)` : key,
      balance: false,
      value: key,
    })),
  ]
}

/** Labels {@link scoreChoices} computes, which a `/pixels` column may not reuse. */
const DERIVED_LABELS = new Set([
  'counts',
  'balanced',
  'VC',
  'VC √',
  'ICE',
  'expected',
  'arm decay',
  'correlation',
])

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
