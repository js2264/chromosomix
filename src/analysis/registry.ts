/**
 * Every task the panel can offer, in the order it offers them.
 *
 * Main-thread only, and free of `MetaCooler` by construction: it imports
 * descriptors from `analysis/tasks/` and nothing from `analysis/run/`, which is
 * the split `analysis/job.ts` argues for and the reason the analysis worker's
 * bundle does not contain the panel's half of this subtree.
 *
 * **A task that means nothing on this file is absent, not disabled.** That is
 * §8.5's doctrine applied a second time and for the same reason §18.1 gives: a
 * disabled row is a promise the file cannot keep, and the reader spends their
 * attention discovering why rather than reading what is there. {@link tasksFor}
 * is the whole of the mechanism — a row that survives it is a row that will run
 * — and there is deliberately no second list of tasks that exist but are greyed
 * out. A `.metacool` carries no gene models, so it offers no metaplot; a `.cool`
 * has no genomes, so it offers no MAG tasks; and both offer P(s), because both
 * have a diagonal.
 *
 * Registry order is the catalogue order of §18.8 and is not sorted here. It is a
 * reading order — the tasks somebody runs first come first, and the composites
 * come after the things they are built from — and sorting the list by title
 * would replace an argued order with an alphabetical one.
 */

import { CHROMOSIGHT_TASK } from "./tasks/chromosight";
import { CELL_QC_TASK } from "./tasks/cellqc";
import { HICREP_TASK } from "./tasks/hicrep";
import { CIS_TRANS_TASK } from "./tasks/cistrans";
import { COVERAGE_TASK } from "./tasks/coverage";
import { FOURC_TASK } from "./tasks/fourc";
import { APA_TASK } from "./tasks/apa";
import { COMPARTMENTS_TASK } from "./tasks/compartments";
import {
  MAG_NETWORK_TASK,
  MAG_PURITY_TASK,
  MAG_QC_TASK,
  MAG_SPLIT_TASK,
} from "./tasks/mags";
import { FRIP_TASK } from "./tasks/frip";
import { OVERLAP_TASK } from "./tasks/overlap";
import { TRACK_CORRELATION_TASK } from "./tasks/trackcorr";
import { METAPLOT_TASK } from "./tasks/metaplot";
import { MOTIF_TASK } from "./tasks/motif";
import { INSULATION_TASK } from "./tasks/insulation";
import { DI_TASK } from "./tasks/di";
import { HIC_SCORE_TASK } from "./tasks/hicscore";
import { SCALOGRAM_TASK } from "./tasks/scalogram";
import { EXPECTED_TASK } from "./tasks/ps";
import { RECONSTRUCT_TASK, SPATIAL_TRACKS_TASK, STRUCTURE_MAP_TASK } from "./tasks/structure";
import type { AnalysisContext, AnalysisTask, TaskGroup } from "./types";

export const TASKS: readonly AnalysisTask[] = [
  // The map group reads outward from the axis: what every bin *has* first
  // (coverage and the marginals), then what every *sequence* has — cis, trans
  // and which pairs of sequences touch, which is the same question one level up
  // and the one that says whether the assembly is the karyotype — then how
  // contact falls away from the diagonal (P(s)),
  // then how far each *bin* reaches within that decay (the scalogram, which is
  // P(s) kept per bin instead of averaged over the sequence),
  // then one locus's slice of that decay (4C), then the domains it resolves
  // into — insulation, the directionality index that reads the same edge from
  // its asymmetry, and the HiC score that says how much contact is there at all
  // rather than how it is shared out — then the compartments those domains sit
  // in. Each is a question the one before it makes it sensible to ask. Detection comes last
  // of the map group and is the only one that *calls* anything: it needs the
  // decay the tasks above it describe, and what it produces — a loop set — is
  // what the aggregation tasks below it take as input.
  COVERAGE_TASK,
  CIS_TRANS_TASK,
  CELL_QC_TASK,
  EXPECTED_TASK,
  SCALOGRAM_TASK,
  FOURC_TASK,
  INSULATION_TASK,
  DI_TASK,
  HIC_SCORE_TASK,
  COMPARTMENTS_TASK,
  CHROMOSIGHT_TASK,
  HICREP_TASK,
  // The tracks group opens with the one task that *makes* an interval set out of
  // the file rather than reading one somebody loaded: a motif search answers
  // where a sequence occurs, and what it produces is exactly the input the three
  // below it take. Same reading order as the map group's — the thing that comes
  // first is the thing the next one is built on.
  MOTIF_TASK,
  METAPLOT_TASK,
  APA_TASK,
  TRACK_CORRELATION_TASK,
  FRIP_TASK,
  OVERLAP_TASK,
  STRUCTURE_MAP_TASK,
  SPATIAL_TRACKS_TASK,
  RECONSTRUCT_TASK,
  MAG_QC_TASK,
  MAG_NETWORK_TASK,
  MAG_PURITY_TASK,
  MAG_SPLIT_TASK,
];

/**
 * The descriptor for an id, or `undefined` where there is none.
 *
 * `undefined` rather than a throw because the callers are a stored session, a
 * shared URL and a result held over from an earlier build, and every one of
 * those can legitimately name a task this build does not have. The row that
 * cannot be rebuilt is dropped; the app is not.
 */
export function taskById(id: string): AnalysisTask | undefined {
  return TASKS.find((task) => task.id === id);
}

/**
 * The tasks worth listing, in registry order.
 *
 * Everything that is not `absent` — which includes the ones that cannot run yet.
 * A row that says *load a loop set* is the menu; a row that is missing teaches a
 * reader the feature does not exist. See {@link TaskAvailability}.
 */
export function tasksFor(context: AnalysisContext): AnalysisTask[] {
  return TASKS.filter((task) => task.availability(context).state !== 'absent');
}

/** The tasks that could be run right now — what the panel counts as usable. */
export function runnableTasks(context: AnalysisContext): AnalysisTask[] {
  return TASKS.filter((task) => task.availability(context).state === 'ready');
}

/**
 * The three headings of §18.8's catalogue.
 *
 * Written out rather than derived from the group name, because *metagenome* is
 * a word and "On the map" is a phrase, and a heading generated from an
 * identifier is a heading nobody chose.
 */
export const TASK_GROUP_LABELS: Record<TaskGroup, string> = {
  map: "On the map",
  tracks: "Tracks and features",
  metagenome: "Metagenome",
};
