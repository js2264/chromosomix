/**
 * Every task the command line runs, as data a reader that is not a person can
 * use: what it reads, what it writes, and every flag it takes with the values
 * that flag accepts.
 *
 * `chromosomix tasks` prints a line per flag — its name, its default and its
 * label — which is enough for somebody who already knows the task and nothing
 * like enough to write a command from. A choice is printed with its default and
 * not with the values it takes; a number with no range; a file with no word on
 * what kind. An agent asked to run an APA with a distance-matched control has to
 * guess that the word is `matched`, and a guess the shell refuses is the good
 * outcome. So the descriptors are read here, once, into the whole answer, and
 * two things print it: `chromosomix tasks --json` (`cli/main.ts`) and the task
 * reference the site serves to language models (`llms/pages.ts`, SPECS §11).
 *
 * **It is the descriptors, read, and nothing decided here.** A value, a range,
 * a default and an option list are the registry's own; what is written here is
 * only how a shell spells each kind of parameter, which is `cli/main.ts`'s rule
 * restated — so the test beside it holds every flag this writes to the parser
 * that will read it.
 *
 * **No dev feature (§29), unless asked.** A task that belongs to one is absent
 * and so is an option only a file with genomes is offered, as the Analysis panel
 * leaves them out while the switch is off: the page is static text, read by
 * somebody who has no switch to turn on (§29.5). The command line runs them
 * regardless and `chromosomix tasks` lists them, so its `--json` asks for them
 * too (`dev: true`), and the two listings name the same tasks.
 */

import { TASK_GROUP_LABELS, TASKS } from './registry'
import { paramDerived, readsMap, type AnalysisTask, type ParamSpec, type ParamValue, type TaskGroup } from './types'

/** One value a choice takes. */
export interface CatalogueChoice {
  value: string
  label: string
  hint?: string
}

/** One parameter, as a shell writes it. */
export interface CatalogueParam {
  /** The parameter's key, which is also its flag: `--<key>`. */
  key: string
  /** How the flag is written, with a placeholder for its value: `--window <n>`. */
  flag: string
  kind: ParamSpec['kind']
  label: string
  hint?: string
  /** The heading it sits under in the app's form; absent is the top group. */
  section?: string
  /**
   * What the run uses when the flag is left out. Absent where there is no one
   * value — an input that names a file, or a number worked out from the map.
   */
  default?: ParamValue
  /** A sentence about the default where a value alone would mislead. */
  defaultNote?: string
  /** The values a choice takes, in the order the app offers them. */
  choices?: CatalogueChoice[]
  min?: number
  max?: number
  step?: number
  integer?: boolean
  /** `bp`, `bins`, `%` or `x`. */
  unit?: string
  /** Several values are taken: the flag repeated, or one value with commas. */
  multiple?: boolean
  /** May be left out, and is then not used. */
  optional?: boolean
  /** The name endings a file parameter takes. */
  accepts?: string[]
  /** For a column: the parameter whose feature set the column is read from. */
  from?: string
  /**
   * The app's form hides it at the task's defaults: it is read only under some
   * other answer to the task's own questions.
   */
  conditional?: boolean
  /**
   * Some files answer it themselves, and it is not asked of them: Pairs QC's
   * `.pairs`, on a map that was binned from one in the same run.
   */
  answeredBySomeFiles?: boolean
}

/** One file a run leaves as a whole (`AnalysisTask.documents`). */
export interface CatalogueDocument {
  /** Its name after the file stem: `mapreport.report.html`. */
  file: string
  label: string
  /** Written by the command line alone: a pipeline's file rather than a reader's. */
  shellOnly?: boolean
}

/** One task. */
export interface CatalogueTask {
  /** The command: `chromosomix <id> …`. */
  id: string
  title: string
  blurb: string
  keywords: string[]
  group: TaskGroup
  groupLabel: string
  /** Whether a contact map is the positional argument, or the task reads tracks only. */
  readsMap: boolean
  /** Whether other maps are named with `--against`. */
  needsPeers: boolean
  /** Tasks whose results this one runs first, at their defaults. */
  requires: string[]
  /** The kinds of result it produces. */
  outputs: string[]
  /**
   * Files the run leaves as a whole, beside each output's own — the map
   * report's page and its MultiQC sections — each written by the command as
   * `<file stem>.<file>`, and offered by the app's drawer unless `shellOnly`.
   */
  documents: CatalogueDocument[]
  /** Bumped when the numbers it produces change meaning. */
  version: number
  params: CatalogueParam[]
}

/** What one kind of result is written as, into `--out`. */
export const OUTPUT_FILES: Readonly<Record<string, string>> = {
  profile: 'a value per bin: TSV, bedGraph and bigWig',
  curve: 'a curve: TSV',
  matrix: 'a matrix, a pileup or a heatmap: TSV',
  table: 'a table: TSV',
  intervals: 'a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model)',
}

/**
 * Every task, in the registry's order: those that are not a dev feature's, or
 * with `dev` every one the command line runs.
 */
export function taskCatalogue(options: { dev?: boolean; tasks?: readonly AnalysisTask[] } = {}): CatalogueTask[] {
  const dev = options.dev === true
  return (options.tasks ?? TASKS)
    .filter((task) => dev || (task.dev === undefined && task.group !== 'metagenome'))
    .map((task) => describeTask(task, dev))
}

function describeTask(task: AnalysisTask, dev: boolean): CatalogueTask {
  const defaults = defaultsOf(task)
  const params: CatalogueParam[] = []
  if (task.needsPeers === true) {
    params.push({
      key: 'against',
      flag: '--against <file>',
      kind: 'file',
      label: 'other maps',
      hint: 'The other contact maps to compare with; repeat the flag for each.',
      multiple: true,
    })
  }
  for (const spec of task.params) {
    if (spec.retired === true) continue
    params.push(describeParam(spec, defaults, dev))
  }
  return {
    id: task.id,
    title: task.title,
    blurb: task.blurb,
    keywords: [...(task.keywords ?? [])],
    group: task.group,
    groupLabel: TASK_GROUP_LABELS[task.group],
    readsMap: readsMap(task),
    needsPeers: task.needsPeers === true,
    requires: [...(task.requires ?? [])],
    outputs: [...new Set(task.outputs)],
    documents: (task.documents ?? []).map((document) => ({
      file: `${task.id}.${document.id}.${document.extension}`,
      label: document.label,
      ...(document.shellOnly === true ? { shellOnly: true } : {}),
    })),
    version: task.version,
    params,
  }
}

/** Every parameter at its default, which is what `when` is asked about. */
function defaultsOf(task: AnalysisTask): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const spec of task.params) {
    const value = (spec as { default?: ParamValue }).default
    out[spec.key] = value === undefined ? null : value
  }
  return out
}

function describeParam(spec: ParamSpec, defaults: Record<string, ParamValue>, dev: boolean): CatalogueParam {
  const flag = `--${spec.key}`
  const out: CatalogueParam = {
    key: spec.key,
    flag,
    kind: spec.kind,
    label: spec.label,
    ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    ...(spec.section === undefined ? {} : { section: spec.section }),
    ...(spec.when !== undefined && !spec.when(defaults) ? { conditional: true } : {}),
    ...(spec.askedOf === undefined ? {} : { answeredBySomeFiles: true }),
  }
  switch (spec.kind) {
    case 'number': {
      out.flag = `${flag} <n>`
      if (spec.seed === undefined) out.default = spec.default
      else {
        out.defaultNote =
          `Worked out from the map's bin size when left out` +
          (Number.isFinite(spec.default) ? `; ${spec.default} where there is no map.` : '.')
      }
      if (spec.min !== undefined) out.min = spec.min
      if (spec.max !== undefined) out.max = spec.max
      if (spec.step !== undefined) out.step = spec.step
      if (spec.integer === true) out.integer = true
      if (spec.unit !== undefined && spec.unit !== '') out.unit = spec.unit
      return out
    }
    case 'seed':
      out.flag = `${flag} <n>`
      out.default = spec.default
      out.integer = true
      return out
    case 'choice': {
      out.flag = `${flag} <value>`
      out.default = spec.default
      out.choices = spec.options
        .filter((option) => dev || option.needsGenomes !== true)
        .map((option) => ({
          value: option.value,
          label: option.coolLabel ?? option.label,
          ...(option.hint === undefined ? {} : { hint: option.hint }),
        }))
      return out
    }
    case 'toggle':
      if (paramDerived(spec)) {
        // `--no-balance` is the one way a shell answers a question the file
        // otherwise answers (`cli/main.ts`, `withDerived`).
        out.flag = '--no-balance'
        out.defaultNote = 'On wherever the file carries balancing weights; --no-balance reads the raw counts.'
        return out
      }
      // `--no-balance` is the command line's own — the raw counts, for the
      // framing and every task — so coverage's switch of that name is turned
      // off the long way (`cli/main.ts`, `flagsFor`).
      out.flag = spec.key === 'balance' ? `${flag} / ${flag}=false` : `${flag} / --no-${spec.key}`
      out.default = spec.default
      return out
    case 'sequences':
      out.flag = `${flag} <name,…>`
      out.multiple = true
      out.defaultNote = 'Every sequence of the file when left out.'
      return out
    case 'region':
      out.flag = spec.many === true ? `${flag} <locus,…>` : `${flag} <locus>`
      if (spec.many === true) out.multiple = true
      // The app's form seeds a locus from what is on screen; a shell has no
      // screen, so one left out is none — every sequence, for a list of them.
      if (spec.default !== undefined) out.default = spec.default
      else out.defaultNote = spec.many === true ? 'Every sequence of the file when left out.' : 'None.'
      return out
    case 'text':
      out.flag = `${flag} <text>`
      if (spec.default !== undefined) out.default = spec.default
      else out.defaultNote = 'None.'
      return out
    case 'file':
      out.flag = `${flag} <file>`
      out.accepts = [...spec.accept]
      return out
    case 'column':
      out.flag = `${flag} <column>`
      out.from = spec.from
      if (spec.optional === true) out.optional = true
      return out
    case 'featureSet':
    case 'pairSet':
    case 'track':
    case 'sequence':
      out.flag = spec.multiple === true ? `${flag} <file,…>` : `${flag} <file>`
      if (spec.multiple === true) out.multiple = true
      if (spec.optional === true) out.optional = true
      return out
  }
}

/**
 * How a shell hands a file to a parameter of each of the four kinds that name
 * one — the rule `cli/main.ts` reads them by (`loadInputs`, `bindInputs`,
 * `loadTrackFiles`, `loadSequences`), said once.
 */
export const ENTRY_KINDS: Readonly<Record<'featureSet' | 'pairSet' | 'track' | 'sequence', string>> = {
  featureSet:
    'BED, narrowPeak, GTF/GFF3, genePred, VCF, cytoBand, barChart or splice junctions. Load the file with ' +
    '`--features <file>` and name it in the parameter by its file name; where the parameter is itself called ' +
    '`features`, that one flag does both.',
  pairSet:
    'BEDPE, interact or longrange. Load the file with `--pairs <file>` (or `--features <file>`) and name it in ' +
    'the parameter by its file name; where the parameter is itself called `pairs`, that one flag does both.',
  track:
    'bigWig, bedGraph or wig, or a FASTA read as its GC content, by path or address. The file the parameter ' +
    'names is the file loaded.',
  sequence:
    'FASTA, gzipped or not (read by range where its `.fai` is beside it), or `.2bit`. Load it with ' +
    '`--sequence <file>` and give the parameter the same path; where the parameter is itself called ' +
    '`sequence`, that one flag does both.',
}
