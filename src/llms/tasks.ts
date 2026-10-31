/**
 * `llms/tasks.md`: every analysis, written out from the registry.
 *
 * Nothing on this page is chosen by hand but the paragraphs around it. Each
 * task's section is `analysis/catalogue.ts` read in order — its id, its blurb,
 * what it reads and writes, and every parameter with its flag, its default and
 * the values it takes — so a parameter added to a descriptor is on the page the
 * next time it is generated, and the test fails until it is (`npm run llms`).
 */

import { ENTRY_KINDS, OUTPUT_FILES, taskCatalogue, type CatalogueParam, type CatalogueTask } from '../analysis/catalogue'
import { block, code, either, page, SITE, table } from './markdown'

/** What a placeholder file is called, by the kind of parameter that names it. */
const SAMPLE: Readonly<Record<string, string>> = {
  featureSet: 'bed',
  pairSet: 'bedpe',
  track: 'bw',
  sequence: 'fa',
}

/** The flags that load a file of each kind, where the parameter is not the flag itself. */
const LOADER: Readonly<Record<string, string>> = {
  featureSet: 'features',
  pairSet: 'pairs',
  sequence: 'sequence',
}

/**
 * Whether a section's command names this parameter: an input file nothing
 * stands in for, or a single locus or text with no default — 4C's anchor, the
 * motif searched for — without which the run says so and writes little or
 * nothing.
 */
function required(param: CatalogueParam): boolean {
  if (param.optional === true || param.conditional === true || param.answeredBySomeFiles === true) return false
  if ((param.kind === 'region' || param.kind === 'text') && param.default === undefined) return param.multiple !== true
  return ['featureSet', 'pairSet', 'track', 'sequence', 'file'].includes(param.kind) && param.key !== 'against'
}

/** The inputs of a command, as a shell writes them, placeholders for the files. */
function inputsOf(task: CatalogueTask): string[] {
  const out: string[] = []
  for (const param of task.params) {
    if (!required(param)) continue
    if (param.kind === 'file') {
      out.push(`--${param.key} <${param.key}${param.accepts?.[0] ?? ''}>`)
      continue
    }
    if (param.kind === 'region' || param.kind === 'text') {
      out.push(`--${param.key} <${param.kind === 'region' ? 'locus' : param.key}>`)
      continue
    }
    // A model is read through `--features` too, as the bed3d `reconstruct3d` writes.
    const file = `<${param.key}.${param.key === 'structure' ? 'bed3d' : (SAMPLE[param.kind] ?? 'txt')}>`
    const loader = LOADER[param.kind]
    if (loader === undefined || loader === param.key) out.push(`--${param.key} ${file}`)
    else out.push(`--${loader} ${file} --${param.key} ${file}`)
  }
  return out
}

/**
 * The shape of one task's command line. The map is optional only where the
 * inputs already name a track or a reference to declare the assembly, which a
 * run with no map needs (`cli/main.ts`).
 */
export function synopsisOf(task: CatalogueTask): string {
  const declares = task.params.some((param) => required(param) && (param.kind === 'track' || param.kind === 'sequence'))
  return [
    'chromosomix',
    task.id,
    task.readsMap || !declares ? '<map>' : '[<map>]',
    ...(task.needsPeers ? ['--against <map>'] : []),
    ...inputsOf(task),
    '[--<parameter> <value> …]',
    '--out <dir>',
  ].join(' ')
}

/** The cell that says what a parameter takes. */
function takes(param: CatalogueParam): string {
  const parts: string[] = []
  switch (param.kind) {
    case 'choice':
      parts.push(either((param.choices ?? []).map((choice) => choice.value)))
      break
    case 'toggle':
      parts.push(param.flag === '--no-balance' ? 'a switch' : 'on or off')
      break
    case 'number':
    case 'seed': {
      const kind = param.kind === 'seed' ? 'a seed, a whole number' : param.integer === true ? 'a whole number' : 'a number'
      const range =
        param.min !== undefined && param.max !== undefined
          ? `, ${param.min} to ${param.max}`
          : param.min !== undefined
            ? `, at least ${param.min}`
            : param.max !== undefined
              ? `, at most ${param.max}`
              : ''
      parts.push(`${kind}${range}${param.unit === undefined ? '' : `, in ${param.unit}`}`)
      break
    }
    case 'sequences':
      parts.push('sequence names, comma-separated')
      break
    case 'region':
      parts.push(param.multiple === true ? 'loci, comma-separated, display form' : 'a locus, display form')
      break
    case 'text':
      parts.push('text')
      break
    case 'column':
      parts.push(`a numeric column of the set \`--${param.from ?? ''}\` names`)
      break
    case 'file':
      parts.push(`a file or address: ${either(param.accepts ?? [])}`)
      break
    default:
      parts.push(`${param.multiple === true ? 'files' : 'a file'}: ${KIND_WORD[param.kind] ?? param.kind}`)
  }
  if (param.optional === true) parts.push('optional')
  return parts.join('; ')
}

const KIND_WORD: Readonly<Record<string, string>> = {
  featureSet: 'a feature set',
  pairSet: 'a set of pairs',
  track: 'a signal track',
  sequence: 'a reference sequence',
}

/** The cell that says what happens when the flag is left out. */
function fallback(param: CatalogueParam): string {
  if (param.defaultNote !== undefined) return param.defaultNote
  if (param.default === undefined || param.default === null) return param.optional === true ? 'not used' : '—'
  if (param.default === '') return 'empty'
  if (param.kind === 'toggle') return param.default === true ? 'on' : 'off'
  return code(Array.isArray(param.default) ? param.default.join(',') : String(param.default))
}

/** A sentence's first letter lowered, unless the word is an initialism (`VC`, `ICE`). */
function lowered(text: string): string {
  return /^[A-Z](?:[a-z]|\s)/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

/** What a parameter is, in a sentence: its label, its hint, its choices' hints. */
function about(param: CatalogueParam): string {
  const label = param.label.charAt(0).toUpperCase() + param.label.slice(1)
  const sentences = [param.hint === undefined ? `${label}.` : `${label}: ${param.hint}`]
  const explained = (param.choices ?? []).filter((choice) => choice.hint !== undefined || choice.label !== choice.value)
  if (explained.length > 0) {
    sentences.push(
      explained.map((choice) => `${code(choice.value)} — ${lowered(choice.hint ?? choice.label)}`.replace(/\.$/, '')).join('; ') +
        '.',
    )
  }
  if (param.conditional === true) sentences.push('*Read only under other settings of this task.*')
  if (param.answeredBySomeFiles === true) sentences.push('*Not asked of a file that answers it itself.*')
  return sentences.join(' ')
}

function section(task: CatalogueTask): string {
  const reads = task.readsMap
    ? `a contact map, named as the positional argument${task.needsPeers ? ', and the maps it is compared with, by `--against`' : ''}`
    : 'tracks and interval files, with or without a contact map'
  const facts = [
    `- **Reads:** ${reads}.`,
    ...(task.requires.length === 0
      ? []
      : [
          task.requires.length === 1
            ? `- **Runs first:** ${either(task.requires)}, at its defaults, and reads its result.`
            : `- **Runs first:** ${either(task.requires, 'and')}, at their defaults, and reads their results.`,
        ]),
    `- **Writes:** ${task.outputs.map((kind) => OUTPUT_FILES[kind] ?? kind).join('; ')}.`,
    ...(task.documents.length === 0
      ? []
      : [
          `- **And, for the run as a whole:** ${task.documents
            .map((document) => `${document.label}, \`<file stem>.${document.file}\`${document.shellOnly === true ? ' (command line only)' : ''}`)
            .join('; ')}.`,
        ]),
    ...(task.keywords.length === 0 ? [] : [`- **Also known as:** ${task.keywords.join(', ')}.`]),
  ]
  const params = table(
    ['Flag', 'Takes', 'Default', 'What it is'],
    task.params.map((param) => [
      code(param.flag),
      takes(param),
      fallback(param),
      `${param.section === undefined ? '' : `*${param.section}.* `}${about(param)}`,
    ]),
  )
  return [`### ${task.title} — \`${task.id}\``, task.blurb, facts.join('\n'), block(synopsisOf(task), 'sh'), params].join(
    '\n\n',
  )
}

export function tasksPage(): string {
  const tasks = taskCatalogue()
  const groups = [...new Set(tasks.map((task) => task.groupLabel))]
  return page([
    '# chromosomix analysis tasks',
    `> Every analysis chromosomix runs — ${tasks.length} tasks, in the app’s Analysis panel and from the ` +
      '`chromosomix` command line, with the same parameters and the same results — with what each reads, ' +
      'what it writes, and every parameter: its flag, what it takes, its default and what it does. ' +
      'Generated from the app’s own task registry, so it is exactly what this release accepts.',
    '## Reading this page',
    [
      `- A task is run as its section’s command shows; installing the command and its shared flags (\`--window\`, ` +
        `\`--no-balance\`, \`--contacts\`, \`--coarsen\`…) are on the [command line page](${SITE}llms/cli.md).`,
      '- A parameter’s flag is its key: `--window 20`. A switch takes no value — `--call` turns it on, ' +
        '`--no-call` or `--call=false` off. A list is the flag repeated or one comma-separated value.',
      '- A choice is one of the values listed, exactly, and a number is a number: anything else is refused ' +
        'before a file is opened, with exit status 2 and a sentence naming what the flag takes.',
      '- A locus is written as the app displays it: 1-based and inclusive, digits grouped or not, ' +
        '`IV:1,000,001-1,400,000`.',
      '- A map is read balanced wherever the file carries balancing weights; `--no-balance` reads the raw ' +
        'counts. An `.mcool` names one resolution: `sample.mcool::/resolutions/10000`.',
      '- A task that reads tracks rather than a matrix runs with no map at all, over the assembly its files ' +
        'declare — but then needs a track (`--tracks`, or `--track <file.bw>`) or a reference (`--sequence`) ' +
        'among them; with interval files alone, name a map.',
      '- *Read only under other settings* marks a parameter the app’s form hides at the task’s defaults: it ' +
        'takes effect once another parameter is set to what it belongs to.',
      `- \`chromosomix tasks --json\` prints all of this as one JSON document, for the installed version.`,
    ].join('\n'),
    '### Inputs that are files',
    table(
      ['A parameter that takes', 'Formats, and how a command names one'],
      Object.entries(ENTRY_KINDS).map(([kind, how]) => [KIND_WORD[kind] ?? kind, how]),
    ),
    '### What a task writes',
    'Every result goes into `--out` (default `.`) as `<file stem>.<task>.<output>.<ext>`, and each TSV ' +
      'opens with `#` lines naming the build, the file and every parameter that produced it.',
    table(
      ['Result', 'Files'],
      Object.entries(OUTPUT_FILES).map(([kind, files]) => [code(kind), files]),
    ),
    '## Index',
    table(
      ['Task', 'Command', 'Kind', 'What it does'],
      tasks.map((task) => [task.title, code(task.id), task.groupLabel, task.blurb]),
    ),
    ...groups.flatMap((label) => [
      `## ${label}`,
      ...tasks.filter((task) => task.groupLabel === label).map(section),
    ]),
  ])
}
