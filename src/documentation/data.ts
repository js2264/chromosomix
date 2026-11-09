/**
 * What the documentation site reads from the app (SPECS §32): the analysis
 * tasks, each with its method, its validation, its command and every
 * parameter, and the reference pages the site serves to language models.
 *
 * The site is `documentation/` — Astro and Starlight, built and published by
 * `.github/workflows/docs.yml` to `doc.chromosomix.app`, one copy per release.
 * Its guides are written by hand; everything here is **read from the app**, so
 * each version of the site says what that version's app does. A parameter
 * added to a descriptor is on its task's page the next time the site is built,
 * and a task with no page fails the build (`documentation/astro.config.mjs`).
 *
 * Loaded by `scripts/docs-data.mjs` the way `scripts/llms.mjs` loads
 * `llms/render.ts`: through a Vite server of its own, under Node, which then
 * writes what this returns into `documentation/src/generated/` and the
 * generated pages beside the guides. Nothing it returns is committed.
 *
 * The dev features are off, as they are for the pages served to models: the
 * site is static text, read by somebody with no switch to turn (§29.5).
 */

import { ENTRY_KINDS, OUTPUT_FILES, taskCatalogue, type CatalogueTask } from '../analysis/catalogue'
import { TASK_REFERENCES, type Agreement } from '../analysis/references'
import { resetDevFeatures } from '../state/devFeatures'
import { cliPage } from '../llms/cli'
import { dataPage } from '../llms/data'
import { embedPage } from '../llms/embed'
import { linksPage } from '../llms/links'
import { about, fallback, KIND_WORD, synopsisOf, takes } from '../llms/tasks'

/** One parameter, as its task's page lists it. Each text is inline Markdown. */
export interface DocsParam {
  key: string
  flag: string
  label: string
  /** The heading it sits under in the app's form; absent is the top group. */
  section?: string
  /** What it takes: a choice's values, a number's range and unit, a file's kind. */
  takes: string
  /** What the run uses when the flag is left out. */
  fallback: string
  /** What it does: its hint and its choices' hints, in sentences; empty where the label says it all. */
  about: string
}

/** The method a task re-implements, and how it came out against it. */
export interface DocsReference {
  method: string
  doi: string
  agreement: Agreement
  /** Its section of `notebooks/validation.qmd`, as published at `/validation/`. */
  section?: number
}

/** One task, as its page and the index read it. */
export interface DocsTask {
  id: string
  title: string
  blurb: string
  keywords: string[]
  /** `2d`, `3d` or `1d`: the card it is listed under in the Analysis panel. */
  group: string
  groupLabel: string
  readsMap: boolean
  needsPeers: boolean
  /** Tasks run first, at their defaults, whose results this one reads. */
  requires: { id: string; title: string }[]
  /** Each kind of result, and the files it is written as. */
  outputs: { kind: string; files: string }[]
  /** Files a run leaves as a whole: the map report's page, its MultiQC sections. */
  documents: { file: string; label: string; shellOnly: boolean }[]
  version: number
  /** The shape of its command line. */
  synopsis: string
  params: DocsParam[]
  reference: DocsReference | null
}

/** A page generated whole: one of the reference pages served to models, made a page of the site. */
export interface DocsPage {
  /** Its file under `documentation/src/content/docs/`, which is also its address. */
  path: string
  title: string
  description: string
  /** The page's body, in Markdown, after its title and summary. */
  markdown: string
}

export interface DocsData {
  tasks: DocsTask[]
  /** The Analysis panel's cards, in its order, each with its tasks' ids in theirs. */
  groups: { group: string; label: string; tasks: string[] }[]
  /** How a command names a file for each kind of parameter that takes one. */
  inputs: { kind: string; label: string; how: string }[]
  /** What each kind of result is written as. */
  outputs: { kind: string; files: string }[]
  pages: DocsPage[]
}

/**
 * Where each page served to models is on the documentation site, so that the
 * links between them stay links between pages of the site. `tasks.md` has no
 * page of its own here: each task has one, and the index is the analyses page.
 */
export const PAGE_HOMES: Readonly<Record<string, string>> = {
  'llms/links.md': '/reference/links/',
  'llms/cli.md': '/reference/command-line/',
  'llms/tasks.md': '/analyses/',
  'llms/embed.md': '/reference/embedding/',
  'llms/data.md': '/reference/files-and-stores/',
}

/** The generated reference pages: what writes each, and where it goes. */
const REFERENCE_PAGES: ReadonlyArray<{ path: string; render: () => string }> = [
  { path: 'reference/links.md', render: linksPage },
  { path: 'reference/command-line.md', render: cliPage },
  { path: 'reference/embedding.md', render: embedPage },
  { path: 'reference/files-and-stores.md', render: dataPage },
]

/**
 * What a parameter does, as the page for models says it, less the label it
 * opens with — `Window: The diamond is…` — which the table's first column
 * already gives. A parameter with nothing more to say than its label has an
 * empty sentence.
 */
export function unlabelled(label: string, sentence: string): string {
  const name = label.charAt(0).toUpperCase() + label.slice(1)
  let rest = sentence
  if (rest.startsWith(`${name}: `)) rest = rest.slice(name.length + 2)
  else if (rest.startsWith(`${name}.`)) rest = rest.slice(name.length + 1)
  rest = rest.trim()
  return rest === '' ? '' : rest.charAt(0).toUpperCase() + rest.slice(1)
}

function describeTask(task: CatalogueTask, titles: ReadonlyMap<string, string>): DocsTask {
  const reference = TASK_REFERENCES[task.id]
  return {
    id: task.id,
    title: task.title,
    blurb: task.blurb,
    keywords: task.keywords,
    group: task.group,
    groupLabel: task.groupLabel,
    readsMap: task.readsMap,
    needsPeers: task.needsPeers,
    requires: task.requires.map((id) => ({ id, title: titles.get(id) ?? id })),
    outputs: task.outputs.map((kind) => ({ kind, files: OUTPUT_FILES[kind] ?? kind })),
    documents: task.documents.map((document) => ({
      file: document.file,
      label: document.label,
      shellOnly: document.shellOnly === true,
    })),
    version: task.version,
    synopsis: synopsisOf(task),
    params: task.params.map((param) => ({
      key: param.key,
      flag: param.flag,
      label: param.label,
      ...(param.section === undefined ? {} : { section: param.section }),
      takes: takes(param),
      fallback: fallback(param),
      about: unlabelled(param.label, about(param)),
    })),
    reference:
      reference === undefined
        ? null
        : {
            method: reference.method,
            doi: reference.doi,
            agreement: reference.agreement,
            ...(reference.section === undefined ? {} : { section: reference.section }),
          },
  }
}

/**
 * A page served to models, as a page of the site: its `# title` and `>`
 * summary lifted into the page's own title and description, and its links to
 * the other pages pointed at their homes here (`PAGE_HOMES`). Links to the app
 * itself stay as they are: they are addresses of `chromosomix.app`.
 */
export function asSitePage(path: string, markdown: string): DocsPage {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const titleLine = lines.findIndex((line) => line.startsWith('# '))
  if (titleLine === -1) throw new Error(`${path}: the page has no # title`)
  const title = lines[titleLine].slice(2).trim()
  let rest = lines.slice(titleLine + 1)
  while (rest.length > 0 && rest[0].trim() === '') rest = rest.slice(1)
  const summary: string[] = []
  while (rest.length > 0 && rest[0].startsWith('>')) {
    summary.push(rest[0].replace(/^>\s?/, ''))
    rest = rest.slice(1)
  }
  const description = summary
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const body = rest
    .join('\n')
    .replace(/https:\/\/chromosomix\.app\/(llms\/[a-z0-9-]+\.md)(#[^)\s]*)?/g, (match, page: string, anchor?: string) => {
      const home = PAGE_HOMES[page]
      return home === undefined ? match : `${home}${anchor ?? ''}`
    })
    .trim()
  return { path, title, description, markdown: `${body}\n` }
}

export function docsData(): DocsData {
  resetDevFeatures(false)
  const catalogue = taskCatalogue()
  const titles = new Map(catalogue.map((task) => [task.id, task.title]))
  const tasks = catalogue.map((task) => describeTask(task, titles))
  const groups: DocsData['groups'] = []
  for (const task of tasks) {
    let group = groups.find((entry) => entry.group === task.group)
    if (group === undefined) {
      group = { group: task.group, label: task.groupLabel, tasks: [] }
      groups.push(group)
    }
    group.tasks.push(task.id)
  }
  return {
    tasks,
    groups,
    inputs: Object.entries(ENTRY_KINDS).map(([kind, how]) => ({ kind, label: KIND_WORD[kind] ?? kind, how })),
    outputs: Object.entries(OUTPUT_FILES).map(([kind, files]) => ({ kind, files })),
    pages: REFERENCE_PAGES.map((entry) => asSitePage(entry.path, entry.render())),
  }
}
