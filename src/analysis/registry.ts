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
import { devFeature } from '../state/devFeatures';
import { CELL_QC_TASK } from "./tasks/cellqc";
import { HICREP_TASK } from "./tasks/hicrep";
import { CIS_TRANS_TASK } from "./tasks/cistrans";
import { COVERAGE_TASK } from "./tasks/coverage";
import { FOURC_TASK } from "./tasks/fourc";
import { APA_TASK } from "./tasks/apa";
import { COMPARTMENTS_TASK } from "./tasks/compartments";
import { INTERARM_TASK } from "./tasks/interarm";
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
import { PEAKS_TASK } from "./tasks/peaks";
import { COMPOSITION_TASK } from "./tasks/composition";
import { DOTPLOT_TASK } from "./tasks/dotplot";
import { GROUP_SIGNAL_TASK } from "./tasks/groupsignal";
import { ORITER_TASK } from "./tasks/oriter";
import { INSULATION_TASK } from "./tasks/insulation";
import { DI_TASK } from "./tasks/di";
import { HIC_SCORE_TASK } from "./tasks/hicscore";
import { SCALOGRAM_TASK } from "./tasks/scalogram";
import { EXPECTED_TASK } from "./tasks/ps";
import { RECONSTRUCT_TASK, SPATIAL_TRACKS_TASK, STRUCTURE_MAP_TASK } from "./tasks/structure";
import type { AnalysisContext, AnalysisTask, TaskGroup } from "./types";

export const TASKS: readonly AnalysisTask[] = [
  // Registry order is catalogue order (§18.8), and the cards come out in the
  // order their first task does — so this list is read as four blocks.
  //
  // **2D.** Outward from the axis: what every bin *has* first (coverage and the
  // marginals), then what every *sequence* has — cis, trans and which pairs of
  // sequences touch, which is the same question one level up and the one that
  // says whether the assembly is the karyotype — then how contact falls away
  // from the diagonal (P(s)), then how far each *bin* reaches within that decay
  // (the scalogram, which is P(s) kept per bin instead of averaged over the
  // sequence), then one locus's slice of that decay (4C), then the domains it
  // resolves into — insulation, the directionality index that reads the same
  // edge from its asymmetry, and the HiC score that says how much contact is
  // there at all rather than how it is shared out — then the compartments those
  // domains sit in. Each is a question the one before it makes it sensible to
  // ask. Detection comes next and is the only one that *calls* anything: it
  // needs the decay the tasks above it describe, and what it produces — a loop
  // set — is what the pileup under it takes as input. Reproducibility and the
  // pileup close the card: both read the matrix against something else, another
  // map in one case and a set of places in the other.
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
  // The arms of a bacterial chromosome, after the compartments that are read
  // with their secondary diagonal divided out: how strongly the two arms touch
  // is the question that makes the arm-frame expectation necessary at all.
  INTERARM_TASK,
  CHROMOSIGHT_TASK,
  HICREP_TASK,
  APA_TASK,
  // **3D**, and the one that *makes* a model comes first, because the other two
  // read one: a reader with no structure loaded has exactly one thing to do in
  // this card, and it should be the first row rather than the third.
  RECONSTRUCT_TASK,
  STRUCTURE_MAP_TASK,
  SPATIAL_TRACKS_TASK,
  // **1D**, opening with the one task that *makes* an interval set out of the
  // file rather than reading one somebody loaded: a motif search answers where a
  // sequence occurs, and what it produces is exactly the input the four below it
  // take. Same reading order as the 2D card's — the thing that comes first is
  // the thing the next one is built on.
  MOTIF_TASK,
  // And the other that makes one: peaks called from a track, which is the input
  // FRiP, the metaplot and the overlap below were always handed from elsewhere.
  // A motif search reads the sequence and this reads a track, so the two open
  // the card side by side, before the tasks that read what they make.
  PEAKS_TASK,
  // Then the two that read a bacterial chromosome off its own sequence: its
  // composition, whose GC skew changes sign at the ends of replication, and the
  // origin and terminus that skew and the sites around it place — which the 2D
  // tasks that read the chromosome's arms then take as their reference point.
  COMPOSITION_TASK,
  ORITER_TASK,
  METAPLOT_TASK,
  TRACK_CORRELATION_TASK,
  FRIP_TASK,
  // Beside FRiP, which asks how much of a track sits inside one set: this asks
  // how its values differ between the groups of one — A against B.
  GROUP_SIGNAL_TASK,
  OVERLAP_TASK,
  // Last of the 1D card, and of a kind of its own: two sequence sets against
  // each other rather than one read along its length (§28) — a dev feature.
  DOTPLOT_TASK,
  // **Metagenome**, absent unless the file has genomes, so the card is there
  // for a metacool and nowhere else.
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
  return TASKS.filter((task) => shown(task) && task.availability(context).state !== 'absent');
}

/** The tasks that could be run right now — what the panel counts as usable. */
export function runnableTasks(context: AnalysisContext): AnalysisTask[] {
  return TASKS.filter((task) => shown(task) && task.availability(context).state === 'ready');
}

/**
 * Whether a task is offered at all: always, unless it belongs to a dev feature
 * that is off (§29) — which is *absent*, the strongest answer, since a greyed
 * row with *load a metagenome* on it is exactly the sentence the switch exists
 * to keep off the screen.
 */
function shown(task: AnalysisTask): boolean {
  return task.dev === undefined || devFeature(task.dev);
}

/**
 * The three headings of §18.8's catalogue.
 *
 * Written out rather than derived from the group name, because *metagenome* is
 * a word and "On the map" is a phrase, and a heading generated from an
 * identifier is a heading nobody chose.
 */
export const TASK_GROUP_LABELS: Record<TaskGroup, string> = {
  "2d": "2D tasks",
  "3d": "3D tasks",
  "1d": "1D tasks",
  metagenome: "Metagenome",
};

