/**
 * Every figure a saved workspace shows, from a shell (§27).
 *
 * ## Why this exists
 *
 * `metacooler-run` is the Analysis panel without the panel: the same numbers,
 * computed over two hundred files instead of one. What it cannot give back is
 * the *picture* — the map with its tracks on two edges, its loops circled, its
 * colour scale clipped where the reader clipped it; a deck of four replicates
 * side by side; the P(s) with the log axes and the window somebody zoomed it
 * to. Those are what go into a paper, and until now the only way to make one
 * was to open the workspace and press **save**, one tab, one bookmark and one
 * figure at a time.
 *
 * So this takes a workspace — the file the save button writes, every tab of a
 * window in one file — and saves every figure it shows, as that window would
 * have saved it.
 *
 * ## How: the app itself, headless
 *
 * Nothing is drawn here. A figure in this app is a map read by a worker, lanes
 * sampled by another, a 3D model lit through WebGL and a chart laid out by a
 * library, all onto a canvas with fonts — and a second implementation of any
 * of them for a shell would be a second picture to keep in step with the first,
 * and would drift from it the first time either changed. So this command
 * starts a headless Chromium, serves it the viewer and the workspace's files
 * from `127.0.0.1` (`cli/serve.ts`), opens the page with `?plot=1`, and drives
 * it through `window.metacoolerPlot` over the DevTools protocol
 * (`plot/harness.ts`, `cli/cdp.ts`) — one tab per page load, so no tab's
 * memory, workers or window preferences reach the next.
 *
 * Every figure is the surface's own export: the map's Export card, the deck's,
 * the 1D browser's, a structure cell's row, a drawer figure's PNG and PDF
 * buttons. Same code, same file.
 *
 * ## The three choices it makes for a reader
 *
 * - **The window is 1600 × 1000 with every column folded**, because the size a
 *   map is drawn at is the room the window leaves it, and a workspace does not
 *   record the reader's screen. `--viewport` changes it.
 * - **The recorded analyses are re-run only when asked** (`--analysis`),
 *   because a workspace keeps the recipe and not the result (§18.2) and a run
 *   can take minutes. With it, each task runs as its Run button would, with the
 *   parameters the tab recorded, before the tab's own figure is taken — so the
 *   lanes those tasks put on the map are on it.
 * - **Nothing is downloaded.** It needs a Chromium on the machine (Chrome,
 *   Chromium, Edge, Brave, or the one Playwright fetched) and finds it itself;
 *   `--browser` names one.
 *
 * ## No dependencies beyond the app's own
 *
 * Argument parsing, the protocol client and the server are here rather than
 * depended on, which is `metacooler-run`'s rule and `package.json`'s.
 */

import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildWorkspaceFile, parseWorkspaceFile } from '../state/workspace'
import { isRefusal, refusalMessage, type SessionConfig } from '../state/SessionConfig'
import { COMMIT, VERSION } from '../version'
import { PLOT_PROTOCOL, type BlobRef, type PlotConfig, type RunReport, type TabReport, type WireRequest } from '../plot/protocol'
import type { RecordedTask } from '../plot/types'
import { TEXT_SCALE_STEPS } from '../ui/textScale'
import { Browser, findBrowser } from './chrome'
import type { CdpPage } from './cdp'
import { safeName } from './names'
import {
  baseOf,
  expandOver,
  isAddress,
  isDirectory,
  locate,
  overTab,
  rewriteTab,
  tabStem,
  uniqueStems,
  type MissingFile,
  type NameKind,
  type WorkspaceBase,
} from './plotWorkspace'
import { PlotServer, type ViewerSource } from './serve'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** How each flag takes its value: a switch, one value, or a list (repeated or comma-separated). */
type FlagKind = 'bool' | 'value' | 'list'

const FLAGS: Record<string, FlagKind> = {
  out: 'value',
  tab: 'list',
  format: 'list',
  dpi: 'value',
  caption: 'bool',
  theme: 'value',
  'text-scale': 'value',
  viewport: 'value',
  main: 'bool',
  analysis: 'bool',
  tasks: 'list',
  structures: 'bool',
  bookmarks: 'bool',
  region: 'list',
  regions: 'list',
  over: 'list',
  data: 'list',
  'bin-size': 'value',
  rungs: 'value',
  scool: 'value',
  'allow-missing': 'bool',
  browser: 'value',
  viewer: 'value',
  timeout: 'value',
  list: 'bool',
  quiet: 'bool',
  verbose: 'bool',
  show: 'bool',
  help: 'bool',
  version: 'bool',
}

/** One-letter spellings. */
const SHORT: Record<string, string> = { o: 'out', h: 'help', q: 'quiet', v: 'verbose' }

export interface PlotArgs {
  positional: string[]
  values: Map<string, string[]>
  switches: Map<string, boolean>
}

/**
 * Read the command line against {@link FLAGS}, strictly.
 *
 * A flag this command does not know is an error, and so is a value missing
 * after one that takes it: a batch script with `--dpi300` in it must not run for
 * an hour at the default. A switch never takes the next word, so
 * `--analysis workspace.json` is the switch and then the workspace — the order
 * a reader types them in either way. `--no-caption` is the switch off, and
 * `--caption=false` says the same.
 */
export function parseFlags(argv: readonly string[]): PlotArgs {
  const positional: string[] = []
  const values = new Map<string, string[]>()
  const switches = new Map<string, boolean>()
  for (let at = 0; at < argv.length; at++) {
    const token = argv[at]
    if (token === '--') {
      positional.push(...argv.slice(at + 1))
      break
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token)
      continue
    }
    const body = token.startsWith('--') ? token.slice(2) : token.slice(1)
    const eq = body.indexOf('=')
    let name = eq >= 0 ? body.slice(0, eq) : body
    let inline = eq >= 0 ? body.slice(eq + 1) : undefined
    if (!token.startsWith('--')) name = SHORT[name] ?? `-${name}`
    let negated = false
    if (!(name in FLAGS) && name.startsWith('no-') && FLAGS[name.slice(3)] === 'bool') {
      name = name.slice(3)
      negated = true
    }
    const kind = FLAGS[name]
    if (kind === undefined) throw new Error(`metacooler-plot has no flag ${token.split('=')[0]}.${suggest(name)}`)
    if (kind === 'bool') {
      if (negated && inline !== undefined) throw new Error(`--no-${name} takes no value.`)
      const on = inline === undefined ? !negated : !['false', '0', 'no', 'off'].includes(inline.toLowerCase())
      switches.set(name, on)
      continue
    }
    if (inline === undefined) {
      const next = argv[at + 1]
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        throw new Error(`--${name} needs a value.`)
      }
      inline = next
      at += 1
    }
    const held = values.get(name) ?? []
    if (kind === 'list') held.push(...inline.split(',').map((item) => item.trim()).filter((item) => item !== ''))
    else held.push(inline)
    values.set(name, held)
  }
  return { positional, values, switches }
}

/** `Did you mean --tasks?` for a flag one edit away from a real one. */
function suggest(name: string): string {
  const near = Object.keys(FLAGS).find((flag) => distance(flag, name) <= 2)
  return near === undefined ? ' Try --help.' : ` Did you mean --${near}?`
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const held = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = held
    }
  }
  return row[b.length]
}

/** Everything the command line decided, checked. */
export interface PlotOptions {
  out: string
  tabs: number[] | null
  formats: Array<'png' | 'pdf'>
  dpi: number
  caption: boolean
  theme: 'light' | 'dark'
  textScale: number
  viewport: { width: number; height: number }
  main: boolean
  analysis: boolean
  tasks: string[] | null
  structures: boolean
  bookmarks: boolean
  regions: string[]
  regionFiles: string[]
  over: string[]
  data: string[]
  pairs: { base: number; rungs: number } | null
  scool: 'whole' | 'fine'
  allowMissing: boolean
  browser: string | undefined
  viewer: string | undefined
  timeoutMs: number
  list: boolean
  quiet: boolean
  verbose: boolean
  show: boolean
}

/** The default text scale is the app's own, so a figure's type is the size a reader sees. */
const DEFAULT_TEXT_SCALE = 1.35

/** Turn the parsed flags into options, or say in one sentence which one is wrong. */
export function optionsOf(args: PlotArgs): PlotOptions {
  const one = (name: string): string | undefined => {
    const held = args.values.get(name)
    return held === undefined ? undefined : held[held.length - 1]
  }
  const all = (name: string): string[] => args.values.get(name) ?? []
  const on = (name: string, fallback = false): boolean => args.switches.get(name) ?? fallback
  const number = (name: string, fallback: number, test: (value: number) => boolean, what: string): number => {
    const raw = one(name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || !test(value)) throw new Error(`--${name} needs ${what}; got ${JSON.stringify(raw)}.`)
    return value
  }

  const formats = all('format').map((format) => format.toLowerCase())
  for (const format of formats) {
    if (format !== 'png' && format !== 'pdf') {
      throw new Error(`--format takes png or pdf — the two files every Export card writes; got ${JSON.stringify(format)}.`)
    }
  }
  const tabs = all('tab').map((raw) => {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) throw new Error(`--tab takes tab numbers counted from 1; got ${JSON.stringify(raw)}.`)
    return value - 1
  })
  const theme = one('theme') ?? 'light'
  if (theme !== 'light' && theme !== 'dark') throw new Error(`--theme is light or dark; got ${JSON.stringify(theme)}.`)
  const viewport = one('viewport') ?? '1600x1000'
  const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(viewport)
  if (size === null || Number(size[1]) < 320 || Number(size[2]) < 240) {
    throw new Error(`--viewport is a window size like 1600x1000, at least 320x240; got ${JSON.stringify(viewport)}.`)
  }
  const textScale = number(
    'text-scale',
    DEFAULT_TEXT_SCALE,
    (value) => (TEXT_SCALE_STEPS as readonly number[]).includes(value),
    `one of the text sizes the app offers, ${TEXT_SCALE_STEPS.join(', ')}`,
  )
  const scool = one('scool') ?? 'pieces'
  if (scool !== 'pieces' && scool !== 'whole') {
    throw new Error(`--scool is pieces or whole — how a single-cell file is read; got ${JSON.stringify(scool)}.`)
  }
  const binSize = one('bin-size')
  const pairs =
    binSize === undefined
      ? null
      : {
          base: Math.floor(number('bin-size', 0, (value) => value >= 1, 'a bin size in base pairs')),
          rungs: Math.floor(number('rungs', 1, (value) => value >= 1 && value <= 12, 'a number of rungs from 1 to 12')),
        }
  const tasks = all('tasks')
  return {
    out: one('out') ?? '.',
    tabs: tabs.length === 0 ? null : tabs,
    formats: formats.length === 0 ? ['png'] : [...new Set(formats as Array<'png' | 'pdf'>)],
    dpi: number('dpi', 300, (value) => value >= 24 && value <= 1200, 'a resolution from 24 to 1200 dpi'),
    caption: on('caption', true),
    theme,
    textScale,
    viewport: { width: Number(size[1]), height: Number(size[2]) },
    main: on('main', true),
    analysis: on('analysis') || tasks.length > 0,
    tasks: tasks.length === 0 ? null : tasks,
    structures: on('structures'),
    bookmarks: on('bookmarks'),
    regions: all('region'),
    regionFiles: all('regions'),
    over: all('over'),
    data: all('data'),
    pairs,
    scool: scool === 'whole' ? 'whole' : 'fine',
    allowMissing: on('allow-missing'),
    browser: one('browser'),
    viewer: one('viewer'),
    timeoutMs: number('timeout', 600, (value) => value > 0, 'a number of seconds') * 1000,
    list: on('list'),
    quiet: on('quiet'),
    verbose: on('verbose'),
    show: on('show'),
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One tab to plot: which, of which file, and what its files are called. */
export interface Job {
  /** 0-based index of the tab in the workspace. */
  tab: number
  /** The file `--over` put in place of the tab's own, or `null`. */
  over: string | null
  config: SessionConfig
  /** The stem every file this job writes starts with. */
  stem: string
  /** What the tab is called, for the lines this command prints. */
  label: string
}

/**
 * Which tabs, over which files, called what.
 *
 * Every tab by default, because the command is *every figure the workspace
 * shows*; the one in front with `--over`, as `replay` does, because applying a
 * whole window of tabs to each of two hundred files is rarely what anybody
 * means — and `--tab` says otherwise either way.
 */
export function planJobs(
  tabs: readonly SessionConfig[],
  active: number,
  options: Pick<PlotOptions, 'tabs' | 'over'>,
): Job[] {
  const wanted = options.tabs ?? (options.over.length > 0 ? [active] : tabs.map((_, index) => index))
  for (const index of wanted) {
    if (index < 0 || index >= tabs.length) {
      throw new Error(
        `the workspace holds ${tabs.length} tab${tabs.length === 1 ? '' : 's'}; --tab ${index + 1} is not one of them.`,
      )
    }
  }
  const jobs: Job[] = []
  const overs = options.over.length === 0 ? [null] : options.over
  for (const over of overs) {
    for (const index of wanted) {
      const config = over === null ? tabs[index] : overTab(tabs[index], over)
      // Over a file, the stem is that file's (`overTab` drops the tab's name),
      // so two tabs over one file are told apart by which tab each was.
      const own = tabStem(config)
      const stem = over !== null && wanted.length > 1 ? `${own}-tab${index + 1}` : own
      jobs.push({
        tab: index,
        over,
        config,
        stem,
        label: tabs[index].name ?? labelOf(tabs[index].state.uri),
      })
    }
  }
  const stems = uniqueStems(jobs.map((job) => job.stem))
  return jobs.map((job, index) => ({ ...job, stem: stems[index] }))
}

/** The file part of a URI, as a reader would name it. */
function labelOf(uri: string): string {
  const path = uri.split('::')[0]
  const tail = path.split(/[\\/]/).pop() ?? path
  return tail === '' ? path : tail
}

/** Every missing file of every job, before anything is started. */
export function missingFiles(
  jobs: readonly Job[],
  base: WorkspaceBase,
  data: readonly string[],
): Array<{ job: Job; missing: MissingFile[] }> {
  const out: Array<{ job: Job; missing: MissingFile[] }> = []
  for (const job of jobs) {
    const { missing } = rewriteTab(job.config, (name, how) => {
      const found = locate(name, how, base, data)
      return found.kind === 'missing' ? null : 'about:blank'
    })
    if (missing.length > 0) out.push({ job, missing })
  }
  return out
}

/** A locus per row of a BED, as `--region` takes them: `chrom:start-end`, 0-based half-open. */
export function regionsOfBed(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || /^(#|track\b|browser\b)/.test(line)) continue
    const [chrom, start, end] = line.split('\t')
    if (chrom === undefined || start === undefined || end === undefined) continue
    if (!/^\d+$/.test(start.trim()) || !/^\d+$/.test(end.trim())) continue
    out.push(`${chrom.trim()}:${start.trim()}-${end.trim()}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** What a run printed and wrote, and how many things failed. */
export interface Tally {
  written: string[]
  failures: number
}

/** The largest piece of a held figure read in one message. */
const CHUNK = 8 * 1024 * 1024

/**
 * One run's tabs, each drawn in a page of its own. Exported for the tests,
 * which drive it through a page that answers as the harness would.
 */
export class Run {
  private readonly errors: string[] = []
  /** What the window said in its notice slot and nothing has printed yet. */
  private readonly notices: string[] = []
  /** The page the tab in hand is drawn in; a new one for every tab (`Browser.openPage`). */
  private page!: CdpPage

  constructor(
    private readonly browser: Pick<Browser, 'openPage'>,
    private readonly server: PlotServer,
    private readonly options: PlotOptions,
    private readonly base: WorkspaceBase,
    private readonly regions: readonly string[],
    private readonly tally: Tally,
  ) {}

  /** Listen to what a page says about itself, for the line under a failure. */
  private listen(page: CdpPage): () => void {
    const stops = [
      page.on('Runtime.exceptionThrown', (params) => {
        const details = params['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined
        this.pageError(details?.exception?.description?.split('\n')[0] ?? details?.text ?? 'an exception')
      }),
      page.on('Runtime.consoleAPICalled', (params) => {
        if (params['type'] !== 'error') return
        const args = (params['args'] as Array<{ value?: unknown; description?: string }> | undefined) ?? []
        this.pageError(args.map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? ''))).join(' '))
      }),
    ]
    return () => {
      for (const stop of stops) stop()
    }
  }

  private pageError(text: string): void {
    this.errors.push(text)
    if (this.errors.length > 20) this.errors.shift()
    if (this.options.verbose) this.say(`    page: ${text}`)
  }

  /** One tab, in a page of its own, from its first read to its last figure. */
  async job(job: Job, index: number, count: number): Promise<void> {
    this.errors.length = 0
    this.notices.length = 0
    const opened = await this.browser.openPage({
      width: this.options.viewport.width,
      height: this.options.viewport.height,
      scheme: this.options.theme,
    })
    this.page = opened.page
    const stop = this.listen(opened.page)
    try {
      await this.draw(job, index, count)
    } finally {
      stop()
      await opened.close()
    }
  }

  private async draw(job: Job, index: number, count: number): Promise<void> {
    const options = this.options
    const tab = rewriteTab(job.config, (name, how) => this.place(name, how)).tab
    const now = fixedNow()
    const text = JSON.stringify(buildWorkspaceFile([tab], 0, now === undefined ? new Date() : new Date(now)))
    const head = `[${index + 1}/${count}] ${job.label}${job.over === null ? '' : ` over ${labelOf(job.over)}`}`
    this.say(head)
    try {
      await this.load(text, job.label)
    } catch (error) {
      this.fail(`  failed: ${messageOf(error)}`)
      return
    }
    const report = await this.describe()
    if (report.failure !== null) {
      this.noted()
      this.fail(`  failed: ${report.failure}`)
      return
    }
    this.say(`  ${report.view ?? 'no'} view of ${labelOf(report.uri ?? '')}`)
    this.noted()

    // The analyses first: a run puts its lanes and its called intervals back on
    // the map, and the figure after it is the one a reader who pressed Run sees.
    if (options.analysis) await this.analyses(job)
    if (options.main) await this.mainFigure(job, report, '')
    if (options.structures) await this.structures(job, report)
    for (const locus of this.regions) {
      const refused = await this.page.call<string | null>('metacoolerPlot', 'goToLocus', locus)
      if (refused !== null) {
        this.fail(`  ${locus}: ${refused}`)
        continue
      }
      await this.settleOrFail(`the figure at ${locus}`)
      await this.mainFigure(job, await this.describe(), `.${safeName(locus)}`)
    }
    if (options.bookmarks) {
      const marks = report.bookmarks
      if (marks.length === 0) this.say('  no bookmarks in this tab')
      for (const [at, mark] of marks.entries()) {
        await this.page.call('metacoolerPlot', 'goToBookmark', at)
        await this.settleOrFail(`bookmark ${at + 1}`)
        const name = mark.label.trim() === '' ? '' : `-${safeName(mark.label)}`
        await this.mainFigure(job, await this.describe(), `.bookmark-${at + 1}${name}`)
      }
    }
    await this.describe()
    this.noted()
  }

  /** A fresh page, the harness, this run's settings, the tab, and the wait. */
  private async load(text: string, label: string): Promise<void> {
    await this.page.send('Page.navigate', { url: this.server.viewerUrl() })
    await this.harness()
    const config: PlotConfig = {
      theme: this.options.theme,
      caption: this.options.caption,
      textScale: this.options.textScale,
      scool: this.options.scool,
      pairs: this.options.pairs,
    }
    await this.page.call('metacoolerPlot', 'configure', config)
    const refused = await this.page.call<string | null>('metacoolerPlot', 'open', text, label)
    if (refused !== null) throw new Error(refused)
    await this.settle()
  }

  /** Wait for the page to install the harness, and check it speaks this command's protocol. */
  private async harness(): Promise<void> {
    const started = Date.now()
    for (;;) {
      const ready = await this.page
        .evaluate<{ protocol: number; build: { producer: string; commit: string } } | null>(
          'window.metacoolerPlot === undefined ? null : { protocol: window.metacoolerPlot.protocol, build: window.metacoolerPlot.build }',
        )
        .catch(() => null)
      if (ready !== null) {
        if (ready.protocol !== PLOT_PROTOCOL) {
          throw new Error(
            `the viewer this command serves (${ready.build.producer}) speaks plot protocol ${ready.protocol}, ` +
              `and this command speaks ${PLOT_PROTOCOL}. Build them together: npm run build:cli.`,
          )
        }
        return
      }
      if (Date.now() - started > 60_000) {
        throw new Error(
          'the viewer did not come up within a minute of being loaded' +
            `${this.errors.length === 0 ? '' : ` — it said: ${this.errors.slice(-3).join(' | ')}`}. ` +
            'If it is a build from before metacooler-plot existed, rebuild it: npm run build:cli.',
        )
      }
      await pause(100)
    }
  }

  private async settle(): Promise<void> {
    await this.page.call('metacoolerPlot', 'settle', this.options.timeoutMs)
  }

  private async settleOrFail(what: string): Promise<boolean> {
    try {
      await this.settle()
      return true
    } catch (error) {
      this.fail(`  ${what}: ${messageOf(error)}`)
      return false
    }
  }

  private async describe(): Promise<TabReport> {
    const report = await this.page.call<TabReport>('metacoolerPlot', 'describe')
    // Every description takes the window's notices with it, so they are kept
    // here until the tab's lines are printed: the one taken by the first
    // description, right after the load, is the one most worth reading.
    this.notices.push(...report.notices)
    return report
  }

  /** Print what the window said since the last time, under the tab it was about. */
  private noted(): void {
    for (const notice of this.notices.splice(0)) this.say(`  note: ${notice}`)
  }

  /** The tab's own figure, as its Export card saves it, in every format asked for. */
  private async mainFigure(job: Job, report: TabReport, suffix: string): Promise<void> {
    if (report.failure !== null) {
      this.fail(`  ${suffix === '' ? 'figure' : suffix.slice(1)}: ${report.failure}`)
      return
    }
    if (report.figure.kind === null) {
      this.say(`  no figure: ${report.figure.why}`)
      return
    }
    for (const format of this.options.formats) {
      await this.save(`${job.stem}${suffix}.${format}`, () =>
        this.page.call<BlobRef | null>('metacoolerPlot', 'figure', this.request(format)),
      )
    }
  }

  private async structures(job: Job, report: TabReport): Promise<void> {
    if (report.structures.length === 0) {
      this.say('  no structure cell in this tab')
      return
    }
    for (const [at, cell] of report.structures.entries()) {
      for (const format of this.options.formats) {
        await this.save(`${job.stem}.structure-${at + 1}-${safeName(cell.label)}.${format}`, () =>
          this.page.call<BlobRef | null>('metacoolerPlot', 'structureFigure', at, this.request(format)),
        )
      }
    }
  }

  /** Every recorded task, run as its Run button would, and every figure it draws. */
  private async analyses(job: Job): Promise<void> {
    const recorded = await this.page.call<RecordedTask[] | null>('metacoolerPlot', 'analyses')
    if (recorded === null) {
      this.say('  no Analysis panel on this tab, so no task to run')
      return
    }
    const wanted = this.options.tasks
    if (wanted !== null) {
      for (const id of wanted) {
        if (!recorded.some((task) => task.id === id)) {
          this.say(`  note: this tab recorded no parameters for ${id}, so it is not run`)
        }
      }
    }
    const tasks = wanted === null ? recorded : recorded.filter((task) => wanted.includes(task.id))
    if (tasks.length === 0 && wanted === null) this.say('  this tab recorded no analysis parameters')
    for (const task of tasks) {
      if (task.state !== 'ready') {
        this.say(
          `  skipped ${task.id}: ${
            task.state === 'waiting'
              ? (task.needs ?? 'it is waiting for something to be loaded')
              : task.state === 'absent'
                ? 'it means nothing on this file'
                : 'this build has no such task'
          }`,
        )
        continue
      }
      this.say(`  running ${task.title}`)
      const result = await this.page
        .call<RunReport>('metacoolerPlot', 'runAnalysis', task.id, this.options.timeoutMs)
        .catch((error: unknown): RunReport => ({ status: 'failed', message: messageOf(error) }))
      if (result.status !== 'done') {
        if (result.status === 'refused') this.say(`  skipped ${task.id}: ${result.message ?? 'refused'}`)
        else this.fail(`  ${task.id} ${result.status}: ${result.message ?? ''}`)
        continue
      }
      for (const note of result.notes ?? []) this.say(`    note: ${note}`)
      if (!(await this.settleOrFail(task.id))) continue
      const figures = result.figures ?? []
      if (figures.length === 0) this.say(`    ${task.id} drew no figure here — its outputs went to the map`)
      for (const figure of figures) {
        if (!figure.drawable) {
          this.say(`    ${figure.label} is a table rather than a figure; metacooler-run writes it as TSV`)
          continue
        }
        for (const format of this.options.formats) {
          await this.save(`${job.stem}.${task.id}.${safeName(figure.output)}.${format}`, () =>
            this.page.call<BlobRef | null>('metacoolerPlot', 'analysisFigure', task.id, figure.index, this.request(format)),
          )
        }
      }
    }
    await this.page.call('metacoolerPlot', 'closeAnalysis')
    await this.settleOrFail('closing the drawer')
  }

  private request(format: 'png' | 'pdf'): WireRequest {
    const now = fixedNow()
    return { format, dpi: this.options.dpi, ...(now === undefined ? {} : { now }) }
  }

  /** Ask for a figure, read its bytes across, write them, and say where. */
  private async save(name: string, ask: () => Promise<BlobRef | null>): Promise<void> {
    let ref: BlobRef | null
    try {
      ref = await ask()
    } catch (error) {
      this.fail(`  ${name}: ${messageOf(error)}`)
      return
    }
    if (ref === null) {
      this.say(`  ${name}: nothing to draw`)
      return
    }
    try {
      const parts: Buffer[] = []
      for (let offset = 0; offset < ref.size; offset += CHUNK) {
        const piece = await this.page.call<string>('metacoolerPlot', 'read', ref.ref, offset, CHUNK)
        parts.push(Buffer.from(piece, 'base64'))
      }
      const path = join(this.options.out, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, Buffer.concat(parts))
      this.tally.written.push(path)
      process.stdout.write(`${path}\n`)
      this.say(`  wrote ${path} · ${sizeText(ref.size)}`)
    } finally {
      await this.page.call('metacoolerPlot', 'drop', ref.ref).catch(() => undefined)
    }
  }

  /** The URL the page reads a name at, or `null` for one that is not there. */
  private place(name: string, how: NameKind): string | null {
    const found = locate(name, how, this.base, this.options.data)
    if (found.kind === 'file') return this.server.urlFor(found.path)
    if (found.kind === 'address') return found.url
    return null
  }

  /** A line on stderr, unless `--quiet` — with each served URL named by its path. */
  private say(line: string): void {
    say(this.options, this.server.localise(line))
  }

  private fail(line: string): void {
    this.tally.failures += 1
    process.stderr.write(`${this.server.localise(line)}\n`)
    if (!this.options.verbose && this.errors.length > 0) {
      process.stderr.write(`    the page said: ${this.server.localise(this.errors.slice(-3).join(' | '))}\n`)
    }
  }
}

/** `SOURCE_DATE_EPOCH`, as an ISO instant, for captions and PDF dates that do not change between runs. */
function fixedNow(): string | undefined {
  const epoch = process.env['SOURCE_DATE_EPOCH']
  if (epoch === undefined || !/^\d+$/.test(epoch)) return undefined
  return new Date(Number(epoch) * 1000).toISOString()
}

function say(options: Pick<PlotOptions, 'quiet'>, line: string): void {
  if (!options.quiet) process.stderr.write(`${line}\n`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

// ---------------------------------------------------------------------------
// Where the viewer is
// ---------------------------------------------------------------------------

/**
 * The viewer this command serves: `--viewer`, then `METACOOLER_VIEWER`, then
 * the build beside this file — `dist/`, which `npm run build:cli` writes and a
 * published package carries.
 */
export function viewerOf(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): ViewerSource | string {
  const named = flag ?? env['METACOOLER_VIEWER']
  if (named !== undefined && named !== '') {
    if (/^https?:\/\//i.test(named)) return { kind: 'url', url: named }
    return isDirectory(named) && isIndexed(named)
      ? { kind: 'dir', path: resolve(named) }
      : `${named} is not a built viewer: there is no index.html in it.`
  }
  const beside = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  if (isDirectory(beside) && isIndexed(beside)) return { kind: 'dir', path: beside }
  return (
    `there is no built viewer at ${beside}. \`npm run build:cli\` builds it beside this command; ` +
    'or name one with --viewer <dir>, or a running `npm run dev` with --viewer http://127.0.0.1:5173/.'
  )
}

function isIndexed(dir: string): boolean {
  try {
    return realpathSync(join(dir, 'index.html')) !== ''
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const USAGE = `metacooler-plot — every figure a saved workspace shows, from a shell

  metacooler-plot <workspace.metacooler.json> [options]

      Opens the workspace in the app itself, headless, and saves each tab's
      figure as its Export card would: the map, the deck of maps beside it, or
      the 1D browser — with its tracks, marks, colour scale and caption.

  What to save (the tab's own figure, unless told otherwise)
      --analysis           also re-run every task the tab recorded parameters
                           for, as its Run button would, and save each figure
                           the drawer draws — styled as the workspace saved it.
                           The lanes those runs add are on the tab's figure too
      --tasks <id,...>     only these tasks (implies --analysis)
      --structures         also save each 3D structure cell
      --bookmarks          also save the tab's figure at each of its bookmarks
      --region <locus>     also save it framed at this locus — chrI:100000-200000,
                           0-based as in a link, or a whole sequence. Repeatable
      --regions <file.bed> a --region per row of a BED
      --no-main            not the tab's own figure, only what the flags above add

  Which tabs, and over which files
      --tab <n,...>        tabs to plot, counted from 1. Default: every tab
      --over <file>        the tab applied to another file, as replay --over
                           does: same tracks, deck, colours and figure styles,
                           with <file> as its first map. Repeatable, or one
                           quoted glob ('runs/*.mcool::resolutions/5000'); with
                           it, the default tab is the one that was in front
      --data <dir>         where to look for the local files a workspace names
                           by bare name (a workspace saved from dropped files).
                           Repeatable. The workspace's own folder is always
                           searched
      --allow-missing      plot even when a track or a companion file cannot
                           be found; it is left out as a reload would leave it

  How
      --out, -o <dir>      where to write (default: .)
      --format <png,pdf>   default png. A map's PDF carries the matrix as an
                           image and everything else as paths; a 1D browser's
                           and a figure's are vector throughout
      --dpi <n>            raster resolution (default 300)
      --no-caption         leave the caption line off, as the Export card's
                           caption switch does
      --theme <light|dark> default light
      --text-scale <n>     the app's text size: ${TEXT_SCALE_STEPS.join(', ')} (default ${DEFAULT_TEXT_SCALE})
      --viewport <WxH>     the window the figures are laid out in, every side
                           column folded (default 1600x1000)
      --bin-size <bp>      how to bin a .pairs the workspace opens, and
      --rungs <n>          how many ladder resolutions to derive (default 1)
      --scool <pieces|whole>  how a single-cell file is read (default pieces)

  The browser
      --browser <path>     the Chromium to drive. Default: METACOOLER_BROWSER,
                           CHROME_PATH, then Chrome, Chromium, Edge or Brave where
                           they are installed, then Playwright's download
      --viewer <dir|url>   the viewer to serve. Default: the build beside this
                           command (npm run build:cli); a URL relays a running
                           npm run dev
      --timeout <s>        longest wait for one picture or one run (default 600)
      --show               run the browser with a window, to watch it work

      --list               say what would be plotted, from which files, and stop
      --quiet, -q          nothing on stderr but failures
      --verbose, -v        also what the page itself logs

  Every file written is printed on stdout, one per line. A file the workspace
  names is served to the page from 127.0.0.1 while the command runs; nothing is
  uploaded anywhere. SOURCE_DATE_EPOCH, when set, is the date in every caption.
`

export async function main(argv: readonly string[]): Promise<number> {
  let options: PlotOptions
  let args: PlotArgs
  try {
    args = parseFlags(argv)
    options = optionsOf(args)
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`)
    return 2
  }
  if (args.switches.get('help') === true || (args.positional.length === 0 && args.values.size === 0 && args.switches.size === 0)) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.switches.get('version') === true) {
    process.stdout.write(`metacooler-plot ${VERSION}${COMMIT === '' ? '' : ` (${COMMIT})`}\n`)
    return 0
  }
  const [workspace, ...extra] = args.positional
  if (workspace === undefined) {
    process.stderr.write('metacooler-plot needs a workspace file: the .metacooler.json the save button writes.\n')
    return 2
  }
  if (extra.length > 0) {
    process.stderr.write(
      `one workspace at a time; ${extra.map((item) => JSON.stringify(item)).join(', ')} ` +
        `${extra.length === 1 ? 'is' : 'are'} not one of the flags. Files to plot the tab over each take an ` +
        `--over, or share one separated by commas, or one quoted glob: --over 'data/*.mcool'.\n`,
    )
    return 2
  }
  // `--over` names files the way a shell does — relative to here, and by glob —
  // where a name inside the workspace is relative to the workspace.
  const over: string[] = []
  for (const value of options.over) {
    const files = expandOver(value)
    if (files.length === 0) {
      process.stderr.write(`--over ${value} names no file.\n`)
      return 2
    }
    over.push(...files)
  }
  options = { ...options, over }

  // Everything that can be wrong with the command is found before a browser is
  // started, and is exit 2 with a sentence: a command that is wrong should say
  // so before it spends an hour being wrong.
  let text: string
  try {
    text = await readWorkspace(workspace)
  } catch (error) {
    process.stderr.write(`${workspace} could not be read: ${messageOf(error)}\n`)
    return 2
  }
  const read = parseWorkspaceFile(text)
  if (isRefusal(read)) {
    process.stderr.write(`${refusalMessage(read, workspace)}\n`)
    return 2
  }
  for (const dir of options.data) {
    if (!isDirectory(dir)) {
      process.stderr.write(`--data ${dir} is not a directory.\n`)
      return 2
    }
  }
  const base = baseOf(workspace)
  let jobs: Job[]
  try {
    jobs = planJobs(read.tabs, read.active, options)
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`)
    return 2
  }
  let regions: string[]
  try {
    regions = [...options.regions]
    for (const file of options.regionFiles) regions.push(...regionsOfBed(await readFile(file, 'utf8')))
  } catch (error) {
    process.stderr.write(`--regions could not be read: ${messageOf(error)}\n`)
    return 2
  }

  const absent = missingFiles(jobs, base, options.data)
  const fatal = absent.filter(({ missing }) =>
    missing.some((file) => !options.allowMissing || file.role === 'the map this tab is of'),
  )
  if (fatal.length > 0) {
    for (const { job, missing } of fatal) {
      process.stderr.write(`${job.label}:\n`)
      for (const file of missing) process.stderr.write(`  ${file.name} — ${file.role} — was not found\n`)
    }
    process.stderr.write(
      `\nA workspace saved from files dropped on the page names them by name alone. Say where they are with ` +
        `--data <dir>${base.kind === 'dir' ? ` (${base.path} is already searched)` : ''}` +
        `${options.allowMissing ? '' : ', or leave the tracks and companions out with --allow-missing'}.\n`,
    )
    return 2
  }

  if (options.list) {
    listPlan(jobs, base, options, regions)
    return 0
  }

  const viewer = viewerOf(options.viewer)
  if (typeof viewer === 'string') {
    process.stderr.write(`${viewer}\n`)
    return 2
  }
  const browserPath = findBrowser(options.browser)
  if (browserPath.path === null) {
    process.stderr.write(
      'metacooler-plot draws with the app itself, in a headless Chromium, and found none. ' +
        `It looked at ${browserPath.tried}. Install Chrome or Chromium, or name one with --browser <path>.\n`,
    )
    return 2
  }

  for (const { job, missing } of absent) {
    for (const file of missing) say(options, `note: ${job.label}: ${file.name} (${file.role}) was not found and is left out`)
  }
  say(
    options,
    `metacooler-plot ${VERSION} · ${jobs.length} tab${jobs.length === 1 ? '' : 's'} from ${workspace}` +
      ` · ${browserPath.path}`,
  )

  const tally: Tally = { written: [], failures: 0 }
  const server = new PlotServer(viewer)
  let browser: Browser | null = null
  // A listener replaces Node's own exit on ^C, so this one has to exit on every
  // road — before the browser is up as well as after, when there is nothing to
  // close but the server.
  const stop = (): void => {
    const closing = browser === null ? Promise.resolve() : browser.close()
    void closing.finally(() => server.close()).finally(() => process.exit(130))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await server.start()
    browser = await Browser.launch({
      executable: browserPath.path,
      width: options.viewport.width,
      height: options.viewport.height,
      show: options.show,
      verbose: options.verbose,
    })
    const run = new Run(browser, server, options, base, regions, tally)
    await mkdir(options.out, { recursive: true })
    for (const [index, job] of jobs.entries()) await run.job(job, index, jobs.length)
  } catch (error) {
    tally.failures += 1
    process.stderr.write(`failed: ${messageOf(error)}\n`)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await browser?.close()
    await server.close()
  }
  say(
    options,
    `${tally.written.length} file${tally.written.length === 1 ? '' : 's'} written` +
      `${tally.failures === 0 ? '' : `, ${tally.failures} failure${tally.failures === 1 ? '' : 's'}`}`,
  )
  return tally.failures === 0 ? 0 : 1
}

/** The workspace's text, from a path or from an address. */
async function readWorkspace(workspace: string): Promise<string> {
  if (isAddress(workspace)) {
    const response = await fetch(workspace)
    if (!response.ok) throw new Error(`the host answered ${response.status} ${response.statusText}`)
    return response.text()
  }
  const path = /^file:/i.test(workspace) ? fileURLToPath(workspace) : workspace
  return readFile(path, 'utf8')
}

/** What `--list` prints: each tab, the files it reads and where, and what it would write. */
function listPlan(jobs: readonly Job[], base: WorkspaceBase, options: PlotOptions, regions: readonly string[]): void {
  for (const job of jobs) {
    const state = job.config.state
    process.stdout.write(`tab ${job.tab + 1} · ${job.label}${job.over === null ? '' : ` over ${job.over}`} · ${state.view} view\n`)
    const seen = new Set<string>()
    rewriteTab(job.config, (name, how) => {
      if (seen.has(name)) return null
      seen.add(name)
      const found = locate(name, how, base, options.data)
      process.stdout.write(
        `  reads ${name} — ${found.kind === 'file' ? found.path : found.kind === 'address' ? 'from its address' : 'NOT FOUND'}\n`,
      )
      return null
    })
    const ext = options.formats.join(',')
    if (options.main) process.stdout.write(`  writes ${join(options.out, job.stem)}.{${ext}}\n`)
    for (const locus of regions) process.stdout.write(`  writes ${join(options.out, `${job.stem}.${safeName(locus)}`)}.{${ext}}\n`)
    if (options.bookmarks) {
      process.stdout.write(`  writes one figure per bookmark (${job.config.bookmarks.length})\n`)
    }
    if (options.analysis) {
      const recorded = Object.keys(job.config.analysis ?? {}).filter(
        (id) => options.tasks === null || options.tasks.includes(id),
      )
      process.stdout.write(
        `  runs ${recorded.length === 0 ? 'no recorded task' : recorded.join(', ')} and writes each figure it draws\n`,
      )
    }
    if (options.structures) process.stdout.write('  writes each structure cell\n')
  }
}

// The same entry-point test `metacooler-run` makes, for the same reason: an
// extensionless `bin` link has `argv[1]` end in `metacooler-plot` while the
// module ends in `.mjs`, so only realpaths compare.
function isEntryPoint(argv1: string | undefined): boolean {
  if (argv1 === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${messageOf(error)}\n`)
      process.exitCode = 1
    })
}
