/**
 * The notebooks published beside the app, as *About* names them (SPECS §18.10).
 *
 * Four Quarto notebooks, each published at `<site>/<path>/` with a
 * `rendered.json` beside it: when it was rendered, from which build, by which
 * run, on what machine, and the one line of what it found
 * (`notebooks/scripts/rendered.py`). `.github/workflows/notebooks.yml` renders
 * and publishes the validation, the timings and the parity with every release.
 * The laptop is rendered by hand, on a laptop, and committed as
 * `notebooks/laptop.html`, which is what the site publishes; the workflow's
 * own render of it is a run's artifact and nothing more. This module is what
 * the app knows of that: which pages there are, what each is for, where the
 * site holding them is, and how to read a stamp without believing it.
 *
 * Where each page is published is `notebooks/scripts/pages.py`'s table, and
 * `test/unit/notebooks.test.ts` holds this list to it and to
 * `NOTEBOOK_SEGMENTS`, so a fifth notebook cannot be published without *About*
 * naming it.
 *
 * The stamp is read on demand, when the reader opens the tab that shows it,
 * and never at startup — the reasoning `versions.ts` gives for its manifest. It
 * is untrusted input from the network that ends up as text and a link on
 * screen, so a field that fails its check is dropped rather than repaired.
 */

import { HOMEPAGE, TARGET } from './version'
import { IS_PORTABLE, NOTEBOOK_SEGMENTS, SITE_BASE } from './versions'

/** One published notebook. */
export interface Notebook {
  /** Where it is published under the site, without its slash. */
  path: (typeof NOTEBOOK_SEGMENTS)[number]
  /** As its page is titled. */
  title: string
  /** What it holds chromosomix to, in a sentence. */
  what: string
  /**
   * Rendered by hand and committed rather than by the workflow: `local` in
   * `pages.py`'s table.
   */
  byHand?: true
}

/** In the order the workflow lists them, and `NOTEBOOK_SEGMENTS` with it. */
export const NOTEBOOKS: readonly Notebook[] = [
  {
    path: 'validation',
    title: 'Validation',
    what:
      'Every analysis run twice over public data, once by chromosomix and once by the package it ' +
      'reproduces — cooltools, coolpuppy, chromosight, deepTools, bedtools and the rest — and the two ' +
      'lined up bin by bin or call by call.',
  },
  {
    path: 'timings',
    title: 'Timings',
    what:
      'The time to a picture beside juicebox.js and HiGlass, on the same files, then every command of ' +
      'the validation run again and timed against its reference.',
  },
  {
    path: 'parity',
    title: 'Parity',
    what:
      'Ten tasks run in the app, in a headless browser, then again from the line its console wrote, ' +
      'and every file the two wrote compared.',
  },
  {
    path: 'laptop',
    title: 'Laptop',
    what:
      'What a genome-wide analysis costs on a laptop: 23 of them run once each, with their time and ' +
      'peak memory. Render it on your own to measure yours.',
    byHand: true,
  },
]

/**
 * The site the notebooks are published on, with its trailing slash, or `null`
 * when this build can name none.
 *
 * **This page's own site when it is one**: the published app, an archived pin
 * or a preview, which all reach up to `SITE_BASE`, where the workflow put the
 * pages beside the app. **The deployed site, by its homepage, otherwise**: the
 * desktop and the single file have no site of their own, the package's copy is
 * unpacked into somebody else's, and a dev server serves the app and nothing
 * the workflow wrote — the rule `ui/stores/registry.ts` follows for the
 * stores, with the dev server added, since the stores are in the checkout and
 * the notebooks are not.
 */
export function notebooksSite(
  where: {
    target: typeof TARGET
    portable: boolean
    dev: boolean
    href: string | null
    siteBase: string
    homepage: string
  } = {
    target: TARGET,
    portable: IS_PORTABLE,
    dev: import.meta.env.DEV,
    href: typeof window === 'undefined' ? null : window.location.href,
    siteBase: SITE_BASE,
    homepage: HOMEPAGE,
  },
): string | null {
  const onSite = where.target === 'web' && !where.portable && !where.dev
  if (onSite && where.href !== null && /^https?:/.test(where.href)) {
    try {
      return new URL(where.siteBase, where.href).href
    } catch {
      // A base that does not resolve is not a site this page is on.
    }
  }
  if (where.homepage === '') return null
  try {
    const home = new URL(where.homepage).href
    return home.endsWith('/') ? home : `${home}/`
  } catch {
    return null
  }
}

/** Where a notebook's page is, on `site`. */
export function notebookUrl(site: string, notebook: Notebook): string {
  return new URL(`${notebook.path}/`, site).href
}

/** Where its `rendered.json` is, on `site`. */
export function stampUrl(site: string, notebook: Notebook): string {
  return new URL(`${notebook.path}/rendered.json`, site).href
}

/** What a `rendered.json` says, once it has survived being read. */
export interface NotebookStamp {
  /** When the render finished, ISO 8601. */
  finished: string
  /** How long it took, in seconds, or `null`. */
  seconds: number | null
  /** The `package.json` version it was rendered from. */
  version: string
  /** The commit, short, or `''`. */
  commit: string
  /** The workflow run's page, and its number, or `null` for a render by hand. */
  run: { url: string; number: string } | null
  /** The runner, as cores and gigabytes, or `null`. */
  machine: { cores: number; memoryGb: number | null } | null
  /** The one line of what the page found, or `''`. */
  summary: string
}

/** Longer than any line the four notebooks write, and short enough for a dialog. */
const SUMMARY_LIMIT = 600

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,40})?$/
const COMMIT = /^[0-9a-f]{7,40}$/
/** A run of this repository's, or of a fork's, on GitHub: the one host the workflow runs on. */
const RUN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : ''
}

/**
 * A `rendered.json`, checked field by field.
 *
 * `null` when it has no finishing time or no version, which are what make it a
 * stamp at all; any other field that fails its check is left out.
 */
export function parseStamp(raw: unknown): NotebookStamp | null {
  const stamp = record(raw)
  if (stamp === null) return null
  const finished =
    typeof stamp.finished === 'string' && !Number.isNaN(Date.parse(stamp.finished)) ? stamp.finished : ''
  const build = record(stamp.chromosomix)
  const version = text(build?.version, VERSION)
  if (finished === '' || version === '') return null
  const seconds =
    typeof stamp.seconds === 'number' && Number.isFinite(stamp.seconds) && stamp.seconds >= 0 ? stamp.seconds : null
  const run = record(stamp.run)
  const runUrl = text(run?.url, RUN)
  const machine = record(stamp.machine)
  const cores =
    typeof machine?.cores === 'number' && Number.isInteger(machine.cores) && machine.cores > 0 ? machine.cores : null
  const memory = machine?.memory_gb
  const summary = typeof stamp.summary === 'string' ? stamp.summary.replace(/\s+/g, ' ').trim() : ''
  return {
    finished,
    seconds,
    version,
    commit: text(build?.commit, COMMIT).slice(0, 7),
    run: runUrl === '' ? null : { url: runUrl, number: text(run?.number, /^\d{1,9}$/) },
    machine:
      cores === null
        ? null
        : { cores, memoryGb: typeof memory === 'number' && Number.isFinite(memory) && memory > 0 ? memory : null },
    summary: summary.length > SUMMARY_LIMIT ? '' : summary,
  }
}

/** How a stamp is fetched: `fetch`, or a stand-in for it. */
export type StampReader = (url: string) => Promise<Response>

/**
 * Read a notebook's stamp: the parsed stamp, or `null` for any failure — the
 * network, a page not published yet, a file that does not parse.
 *
 * A failure is not reported: the link to the page is still there, and a reader
 * offline learns nothing from being told so in a dialog about something else.
 */
export async function fetchStamp(
  url: string,
  read: StampReader = (input) => fetch(input),
): Promise<NotebookStamp | null> {
  try {
    const response = await read(url)
    if (!response.ok) return null
    return parseStamp(await response.json())
  } catch {
    return null
  }
}
