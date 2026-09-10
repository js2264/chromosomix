/**
 * Every task's runner, by task id.
 *
 * The worker's whole dispatch: a `run` request names a task, this map says what
 * to call. It is the **worker-side** half of the split `analysis/job.ts`
 * describes — the descriptors in `analysis/tasks/` are imported by the panel and
 * the registry on the main thread, and nothing in that half names `MetaCooler`.
 *
 * A task id present here and absent from `analysis/registry.ts` is a task that
 * can be run and never offered; the reverse is a row that fails the moment it is
 * clicked. `test/unit/analysis-registry.test.ts` asserts the two agree, because
 * neither mistake is visible in either file.
 */

import type { TaskRunner } from '../job'
import { runApa } from './apa'
import { runChromosight } from './chromosight'
import { runCompartments } from './compartments'
import { runCoverage } from './coverage'
import { runExpected } from './expected'
import { runFourC } from './fourc'
import { runInsulation } from './insulation'
import { runMagNetwork, runMagPurity, runMagQc, runMagSplit } from './mags'

/**
 * Real runners only, and deliberately never stubbed with a fake.
 *
 * A placeholder runner that returned an empty result would make the worker, the
 * runner and the panel all appear to work while producing nothing — which is the
 * one failure mode this subtree is least able to notice, because every layer
 * would report success. An unknown id raises instead, naming itself, which is
 * what `analysis.worker.ts` does with it.
 */
export const RUNNERS: Record<string, TaskRunner> = {
  expected: runExpected,
  coverage: runCoverage,
  insulation: runInsulation,
  fourc: runFourC,
  apa: runApa,
  chromosight: runChromosight,
  compartments: runCompartments,
  magqc: runMagQc,
  magnetwork: runMagNetwork,
  magpurity: runMagPurity,
  magsplit: runMagSplit,
}
