/**
 * Every runner that belongs in the **annotations** worker, by task id.
 *
 * The counterpart of `analysis/run/index.ts`, and separate from it for the
 * reason `analysis/job.ts` gives about venues: these tasks are handed a
 * {@link TrackJobContext} rather than a {@link JobContext}, and the two workers
 * import one map each. A single map would mean each worker importing runners it
 * can never call — and, worse, importing `MetaCooler` into the annotations
 * worker, which is the layering rule §6.1 exists to keep.
 */

import type { TrackTaskRunner } from '../job'
import { runFrip } from './frip'
import { runGroupSignal } from './groupsignal'
import { runMetaplot } from './metaplot'
import { runMotif } from './motif'
import { runComposition } from './composition'
import { runOriTer } from './oriter'
import { runOverlap } from './overlap'
import { runTrackCorrelation } from './trackcorr'

export const TRACK_RUNNERS: Record<string, TrackTaskRunner> = {
  motif: runMotif,
  composition: runComposition,
  oriter: runOriTer,
  metaplot: runMetaplot,
  trackcorr: runTrackCorrelation,
  frip: runFrip,
  groupsignal: runGroupSignal,
  overlap: runOverlap,
}
