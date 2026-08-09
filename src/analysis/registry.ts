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

import { COVERAGE_TASK } from "./tasks/coverage";
import { FOURC_TASK } from "./tasks/fourc";
import { APA_TASK } from "./tasks/apa";
import { CID_TASK } from "./tasks/cid";
import { COMPARTMENTS_TASK } from "./tasks/compartments";
import {
  MAG_NETWORK_TASK,
  MAG_PURITY_TASK,
  MAG_QC_TASK,
  MAG_SPLIT_TASK,
} from "./tasks/mags";
import { OVERLAP_TASK } from "./tasks/overlap";
import { TRACK_CORRELATION_TASK } from "./tasks/trackcorr";
import { METAPLOT_TASK } from "./tasks/metaplot";
import { INSULATION_TASK } from "./tasks/insulation";
import { EXPECTED_TASK } from "./tasks/ps";
import type { AnalysisContext, AnalysisTask, TaskGroup } from "./types";

export const TASKS: readonly AnalysisTask[] = [
  EXPECTED_TASK,
  COVERAGE_TASK,
  INSULATION_TASK,
  FOURC_TASK,
  METAPLOT_TASK,
  APA_TASK,
  CID_TASK,
  COMPARTMENTS_TASK,
  TRACK_CORRELATION_TASK,
  OVERLAP_TASK,
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
