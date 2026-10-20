/**
 * What a task was last run with, per file.
 *
 * One `UiMemory` scope holding every task's parameters, rather than one scope
 * per task, and the reason is `state/SessionConfig.ts`. That module gathers a
 * session by reading a **fixed list** of scopes out of storage — which is what
 * makes an exported config provably the same thing a reload would restore — and
 * a scope named after a task id cannot be on a fixed list. Sixteen tasks would
 * mean sixteen entries in `SCOPES` and a seventeenth silently missing from every
 * exported session until somebody noticed.
 *
 * So the scope is one, and the task id is a key inside it. Adding a task then
 * changes nothing about persistence, which is the property worth having.
 *
 * Why remember at all: a parameter set is a decision, and a reader who has found
 * the insulation window that shows what they are looking at should not have to
 * find it again after clicking a chromosome (§18.2). The same argument the table
 * filters in this module's namesake are kept for.
 */

import { recall, remember } from '../state/UiMemory'
import type { AnalysisContext, AnalysisTask, ParamValue, Params } from './types'

/** The one scope. Named in `SessionConfig`'s `SCOPES`; do not rename lightly. */
export const ANALYSIS_SCOPE = 'analysis:params'

/** Every task's last parameters for one file, by task id. */
export type AnalysisMemory = Record<string, Params>

/**
 * What is stored, validated.
 *
 * Untrusted input like everything else that comes out of storage: a session
 * outlives the build that wrote it, and a task whose parameters changed shape
 * must not hand a renderer a value it cannot draw. Anything that is not a plain
 * record of plain records is treated as nothing remembered — the form then falls
 * back to the descriptor's defaults, which is always a working state.
 */
export function readAnalysisMemory(uri: string): AnalysisMemory {
  const raw = recall<unknown>(uri, ANALYSIS_SCOPE)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: AnalysisMemory = {}
  for (const [task, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[task] = value as Params
    }
  }
  return out
}

/**
 * The parameters `task` was last configured with on `uri`, or `null`.
 *
 * What `ui/AnalysisDrawer.ts` opens a task's form from, merged key by key over
 * the descriptor's defaults and validated there — which is the only place that
 * knows what shape each parameter is meant to be.
 */
export function recallParams(uri: string, task: string): Params | null {
  return readAnalysisMemory(uri)[task] ?? null
}

/**
 * Record what `task` was just run with.
 *
 * Read-modify-write rather than a partial update, because the scope is shared:
 * writing one task's entry without the others would drop fifteen of them.
 */
export function rememberParams(uri: string, task: string, params: Params): void {
  const all = readAnalysisMemory(uri)
  all[task] = params
  remember(uri, ANALYSIS_SCOPE, all)
}

/**
 * A run's parameters as the form should next open on them.
 *
 * As run, except a number the context seeds (`NumberParam.seed`) that the form
 * `held` unanswered and the run read as that seed: it stays unanswered, so it
 * goes on following the map. A run is handed every seed answered, so that its
 * record names what was read; remembered as read, a 1 kb run's reach in bins
 * would come back on the 10 kb rung as 1 kb's, ten times as far (§18.2). A
 * number the reader typed, or one a replay asked for that is not the seed, is
 * kept as it is.
 */
export function asAsked(
  task: AnalysisTask,
  ran: Params,
  held: Params | null,
  context: AnalysisContext | null,
): Params {
  if (held === null || context === null) return ran
  let out: Record<string, ParamValue> | null = null
  for (const spec of task.params) {
    if (spec.kind !== 'number' || spec.seed === undefined) continue
    const asked = held[spec.key]
    if (typeof asked === 'number' && Number.isFinite(asked)) continue
    if (ran[spec.key] !== spec.seed(context)) continue
    out ??= { ...ran }
    out[spec.key] = null
  }
  return out ?? ran
}
