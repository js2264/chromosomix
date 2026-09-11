/**
 * A run, written the way the console records it (§23).
 *
 * Two lines of policy, and both are here rather than in `runner.ts` because
 * both are worth a test and neither is about queueing:
 *
 * **The command is the drawer's command.** `cliCommandFor` is called with the
 * same `Provenance` the `copy CLI command` button passes it, so a line in the
 * console and a line on the clipboard cannot be two accounts of one run. That
 * matters more here than it looks: the console records a run when it *happens*,
 * and the drawer offers one for the result on screen, so the two are usually
 * looking at the same job from an hour apart.
 *
 * **A task the CLI cannot run still gets a line.** `cliCannotRun` refuses the
 * three that read a bigWig — the reader for one lives in the annotations worker
 * and nowhere else — and a console that dropped those runs would be a record
 * with holes in it exactly where a reader is least likely to notice. So the line
 * becomes a sentence, marked as prose rather than as shell, and the refusal
 * rides along as the note saying why there is nothing to paste.
 *
 * The provisional provenance below is the other half of recording a run when it
 * starts. A result carries its own, written in the worker at the moment the
 * numbers come back — but a *failed* run has no result, and a failure is
 * precisely when a reader wants to know what was asked for. So one is composed
 * from the job, field for field as the worker composes it, and is replaced by
 * the worker's the moment there is one ({@link runDraft} is called twice, and
 * `AnalysisRunner` hands the second to `endAction`).
 */

import { cliCommandFor } from './cliCommand'
import { provenanceLines } from './write/tsv'
import type { AnalysisContext, AnalysisFraming, AnalysisTask, Params, Provenance } from './types'
import type { ActionDraft } from '../state/actions'
import { COMMIT, VERSION } from '../version'

/**
 * The build stamp a result would carry, spelled as the worker spells it.
 *
 * `analysis.worker.ts` composes exactly this and calls it `APP`. Two copies of
 * one string is a smell, and the alternative is worse: importing the worker
 * module on the main thread to read a constant off it drags h5wasm into the
 * shell's bundle. The value is two build-time constants joined, so the risk is
 * that they *stop* agreeing rather than that they are computed differently.
 */
const APP = [VERSION, COMMIT].filter((part) => part !== '').join(' ')

/**
 * What a run's provenance is before there is a result to read one off.
 *
 * The parameters and the framing as they were queued, which is what
 * `Provenance` means by them — *what was asked for* — so this is the same
 * record the worker would write, minus the moment it finished.
 */
export function provisionalProvenance(
  task: AnalysisTask,
  params: Params,
  framing: AnalysisFraming,
): Provenance {
  return {
    task: task.id,
    taskVersion: task.version,
    params,
    framing,
    app: APP,
    createdAt: new Date().toISOString(),
  }
}

export interface RunDraftInput {
  task: AnalysisTask
  provenance: Provenance
  /** The session's own facts — what turns bins into a locus and ids into names. */
  context: AnalysisContext | null
  /** Which map this run measured, where the session names more than one. */
  where?: string
}

/** One run, as the console's list holds it. */
export function runDraft(input: RunDraftInput): ActionDraft {
  const { task, provenance, context, where } = input
  const command = cliCommandFor({ task, provenance, context })
  const detail = provenanceLines(provenance)
  const seat = where === undefined ? {} : { where }
  if (command.refusal !== null) {
    return {
      kind: 'run',
      line: `ran ${task.title} — ${provenance.framing.label}`,
      shell: false,
      notes: [`# ${command.refusal}`],
      detail,
      ...seat,
    }
  }
  // `cliCommandFor` writes its caveats as `#` lines above the command and joins
  // the lot; the console keeps them apart, because one of them is what a shell
  // would take and the others are what it cannot be told.
  const lines = command.text.split('\n')
  return {
    kind: 'run',
    line: lines[lines.length - 1],
    shell: true,
    notes: lines.slice(0, -1),
    detail,
    ...seat,
  }
}
