/**
 * The controls more than one task has, written once.
 *
 * A `ParamSpec` is data, so a shared one is a shared *decision* rather than a
 * shared implementation: the six tasks that read the matrix all face the same
 * question about balancing, and six copies of it is six chances for five of them
 * to be right. Anything genuinely per-task — a window, a scope, a threshold —
 * stays in the task that owns it.
 *
 * Main-thread safe, like every other module under `tasks/`: it names no
 * `MetaCooler` and nothing under `analysis/run/` (see `analysis/job.ts`).
 */

import type { AnalysisContext, ToggleParam } from '../types'

/**
 * Whether a task should apply the file's balancing weights.
 *
 * `hasWeights` and nothing else, because that is the whole of the question. A
 * balanced cooler should be read balanced — every descriptor in the catalogue
 * that mentions it says so, from compartments' "an unbalanced correlation
 * matrix is mostly a picture of coverage" to coverage's "a balanced file should
 * have a flat total" — and a file with no `/bins/weight` has nothing to apply,
 * so asking for weights there is asking for a refused read.
 *
 * A file whose normalisation is a **column** rather than a weight needs nothing
 * here: the score picker's choice reaches the runner as the framing's `value`,
 * and reading that column is not the same act as multiplying by two weights
 * (`ui/scores.ts` keeps the two apart on purpose). Such a file has no weights,
 * so this answers `false` and the column is read as it stands, which is right.
 */
export function balancedByDefault(context: AnalysisContext): boolean {
  return context.hasWeights
}

/**
 * *Use balancing weights*, decided from the file and never shown.
 *
 * It was a tickbox on six tasks, defaulting to off on five of them, and it was
 * the one setting in the panel where the wrong answer produces a figure that
 * looks entirely reasonable: an unbalanced P(s), an unbalanced insulation track
 * and an unbalanced 4C profile are all plausible shapes, and nothing in any of
 * them says which one was asked for. A reader who has opened a balanced file has
 * already answered this question by opening it.
 *
 * Still a parameter, so the runners are unchanged and the provenance still
 * records what the numbers were computed with — which is what makes an exported
 * TSV able to say it. See {@link ToggleParam.derive}.
 */
export const BALANCE_PARAM: ToggleParam = {
  kind: 'toggle',
  key: 'balance',
  label: 'use balancing weights',
  default: false,
  derive: balancedByDefault,
}
