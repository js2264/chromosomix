/**
 * What each task re-implements, as the Analysis column's `?` names it (§18.1,
 * §18.9).
 *
 * One line per task whose code follows a published method or package: the
 * method, the paper it is cited by, and how it came out against it in
 * `notebooks/validation.qmd` — **identical** or **equivalent** there, or
 * **untested** for a task the notebook does not run yet. A task whose code
 * names no reference has no line, and its row no `?`: an implementation written
 * from first principles, or reading biology rather than following an
 * algorithm — the arms' alignment, the origin and terminus, the metagenome's
 * tables, the model against the map, the dot plot — is not a re-implementation
 * of anything, and a citation on it would be a claim the code does not make.
 *
 * Kept as a table rather than a field on each descriptor so that the whole
 * list can be read, and checked, at once: `test/unit/references.test.ts` holds
 * every id to a task, every DOI to its shape, and every validated line to a
 * section of the notebook's own table. The DOIs are the papers' own, checked
 * against Europe PMC when they were written down.
 */

/** How a task came out against its reference in `notebooks/validation.qmd`. */
export type Agreement = 'identical' | 'equivalent' | 'untested'

/** What a task re-implements. */
export interface TaskReference {
  /** The method, as one would cite it: what it is, whose it is, and the year. */
  method: string
  /** The paper's DOI, bare: `10.1038/nature14450`. */
  doi: string
  agreement: Agreement
  /** Its section of `notebooks/validation.qmd`; absent while it is untested. */
  section?: number
}

const BIOFRAME = '10.1093/bioinformatics/btae088'
const COOLTOOLS = '10.1371/journal.pcbi.1012067'
const DEEPTOOLS = '10.1093/nar/gkw257'

export const TASK_REFERENCES: Readonly<Record<string, TaskReference>> = {
  coverage: {
    method: 'Coverage as cooltools computes it (Open2C 2024).',
    doi: COOLTOOLS,
    agreement: 'identical',
    section: 9,
  },
  cistrans: {
    method: 'Cis and trans sums as cooltools’ expected_cis and expected_trans make them (Open2C 2024).',
    doi: COOLTOOLS,
    agreement: 'identical',
    section: 20,
  },
  cellqc: {
    method: 'The near and mitotic contact shares of Nagano et al. 2017.',
    doi: '10.1038/nature23001',
    agreement: 'untested',
  },
  expected: {
    method: 'The expected contact by separation, as cooltools’ expected_cis computes it (Open2C 2024).',
    doi: COOLTOOLS,
    agreement: 'identical',
    section: 4,
  },
  pairsqc: {
    method: 'The pairs’ statistics and fragments, as pairtools’ stats and restrict count them (Open2C 2024).',
    doi: '10.1371/journal.pcbi.1012164',
    agreement: 'identical',
    section: 27,
  },
  scalogram: {
    method: 'The scalogram of Lioy et al. 2018.',
    doi: '10.1016/j.cell.2017.12.027',
    agreement: 'untested',
  },
  fourc: {
    method: 'Virtual 4C as cooltools’ virtual4c computes it (Open2C 2024).',
    doi: COOLTOOLS,
    agreement: 'identical',
    section: 10,
  },
  insulation: {
    method: 'Diamond insulation (Crane et al. 2015), as cooltools computes it.',
    doi: '10.1038/nature14450',
    agreement: 'identical',
    section: 1,
  },
  di: {
    method: 'The directionality index of Dixon et al. 2012, as domaincaller computes it.',
    doi: '10.1038/nature11082',
    agreement: 'identical',
    section: 2,
  },
  hicscore: {
    method: 'The HiC score of Bignaud et al. 2024, after their R script.',
    doi: '10.1038/s41594-023-01178-2',
    agreement: 'untested',
  },
  compartments: {
    method: 'The first eigenvector (Lieberman-Aiden et al. 2009), as cooltools’ eigs_cis takes it.',
    doi: '10.1126/science.1181369',
    agreement: 'equivalent',
    section: 3,
  },
  loops: {
    method: 'HiCCUPS (Rao et al. 2014), as cooltools.dots computes it.',
    doi: '10.1016/j.cell.2014.11.021',
    agreement: 'identical',
    section: 19,
  },
  chromosight: {
    method: 'Chromosight’s template matching (Matthey-Doret et al. 2020).',
    doi: '10.1038/s41467-020-19562-7',
    agreement: 'identical',
    section: 6,
  },
  hicrep: {
    method: 'HiCRep’s stratum-adjusted correlation (Yang et al. 2017).',
    doi: '10.1101/gr.220640.117',
    agreement: 'identical',
    section: 7,
  },
  apa: {
    method: 'Coolpup.py’s pile-ups (Flyamer et al. 2020), and chromosight’s score.',
    doi: '10.1093/bioinformatics/btaa073',
    agreement: 'identical',
    section: 11,
  },
  reconstruct3d: {
    method: 'pastis-NB, a negative binomial fit (Varoquaux et al. 2023).',
    doi: '10.1093/bioinformatics/btac838',
    agreement: 'equivalent',
    section: 8,
  },
  motif: {
    method: 'A motif scan as seqkit locate makes it (Shen et al. 2016).',
    doi: '10.1371/journal.pone.0163962',
    agreement: 'identical',
    section: 17,
  },
  restriction: {
    method: 'Restriction sites as bioframe’s digest finds them, each 2 bp earlier (Open2C 2024).',
    doi: BIOFRAME,
    agreement: 'identical',
    section: 26,
  },
  peaks: {
    method: 'yapc’s concave regions (Jänes et al. 2018), with IDR across replicates.',
    doi: '10.7554/eLife.37344',
    agreement: 'identical',
    section: 5,
  },
  composition: {
    method: 'GC content and skews, as bioframe and Biopython compute them (Open2C 2024).',
    doi: BIOFRAME,
    agreement: 'identical',
    section: 16,
  },
  metaplot: {
    method: 'deepTools’ computeMatrix and plotProfile (Ramírez et al. 2016).',
    doi: DEEPTOOLS,
    agreement: 'identical',
    section: 14,
  },
  trackcorr: {
    method: 'deepTools’ multiBigwigSummary and plotCorrelation (Ramírez et al. 2016), on exact window means.',
    doi: DEEPTOOLS,
    agreement: 'equivalent',
    section: 18,
  },
  frip: {
    method: 'FRiP, as the ENCODE guidelines define it (Landt et al. 2012).',
    doi: '10.1101/gr.136184.111',
    agreement: 'identical',
    section: 22,
  },
  groupsignal: {
    method: 'Mann–Whitney and Kruskal–Wallis tests as SciPy computes them (Virtanen et al. 2020).',
    doi: '10.1038/s41592-019-0686-2',
    agreement: 'identical',
    section: 23,
  },
  overlap: {
    method: 'bedtools’ intersect and jaccard, with a shuffle null (Quinlan and Hall 2010).',
    doi: '10.1093/bioinformatics/btq033',
    agreement: 'identical',
    section: 15,
  },
}

/** The task's reference, or `null` for a task that re-implements none. */
export function referenceOf(taskId: string): TaskReference | null {
  return TASK_REFERENCES[taskId] ?? null
}

/** Whether the validation has shown it to agree: identical or equivalent, not untested. */
export function isValidated(reference: TaskReference): boolean {
  return reference.agreement !== 'untested'
}
