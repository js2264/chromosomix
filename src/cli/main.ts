/**
 * The analysis panel, without the panel.
 *
 * ## Why this exists
 *
 * The Analysis panel computes fifteen things and every one of them is goldened
 * against cooltools, coolpuppy, chromosight, pyBigWig and numpy (§18.10). That is a lot of
 * verified arithmetic reachable only by clicking, and the moment a reader has
 * two hundred files rather than one, clicking stops being the interface. They
 * leave — for cooltools, which is the right tool and a different set of
 * definitions, so the numbers in the figure and the numbers in the table are no
 * longer the same numbers.
 *
 * So: the same kernels, the same writers, the same provenance lines, driven from
 * a shell. Not a reimplementation and not a port — `RUNNERS` is imported from
 * `analysis/run/index.ts` and the job handed to it is built exactly as
 * `analysis/worker/analysis.worker.ts` builds one. If the two ever disagree, one
 * of them is wrong and there is a golden that says which.
 *
 * ## And why `replay` is the half that matters
 *
 * A subcommand per task is useful and obvious. The subcommand that is neither is
 * `replay`: it takes a **workspace file** — the thing the save button already
 * produces, every open tab in one file — and re-runs the analyses recorded in
 * one of its tabs over any number of other files. That closes the loop the app is missing at both ends. A
 * reader chooses parameters the way parameters should be chosen, by looking at a
 * picture and adjusting until it is right; and then applies exactly those, with
 * no retyping and no transcription error, to the other hundred and ninety-nine.
 *
 * ## The two things it cannot do, and why
 *
 * **No remote files.** `RemoteRangeSource` reads through synchronous
 * `XMLHttpRequest`, which exists in a worker and not in Node. A CLI is on a
 * machine that has the file; `curl` is the missing half and is better at it than
 * anything this could contain.
 *
 * **No dependencies beyond the app's own.** Argument parsing, colouring and
 * table formatting are here rather than depended on, which is the same rule
 * `package.json` already applies to the bundle. It is about forty lines.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MetaCooler } from '../metacooler/MetaCooler'
import { LocalFileSource } from '../sources/LocalFileSource'
import { yieldToEventLoop } from '../async'
import { RUNNERS } from '../analysis/run/index'
import { TASKS, taskById } from '../analysis/registry'
import { abortError } from '../analysis/job'
import type { JobContext } from '../analysis/job'
import { outputToTsv } from '../analysis/write/tsv'
import { profileToBedGraph, type BedGraphContig } from '../analysis/write/bedgraph'
import { writeBigWig } from '../analysis/write/bigwig'
import {
  decodeAnnotationBytes,
  decodeAnnotationText,
  parseBed,
  parseBedpe,
  sniffFormat,
} from '../annotations/parse'
import { hicProBinsNames, isHicProMatrix } from '../annotations/sidecar'
import { parseBins } from '../hicpro/parse'
import { hicProMap } from '../worker/open'
import { isRefusal, refusalMessage } from '../state/SessionConfig'
import { parseWorkspaceFile } from '../state/workspace'
import type { AnalysisFraming, AnalysisTask, Params, TaskResult } from '../analysis/types'
import type { TaskInputs } from '../analysis/worker/protocol'
import { importPairs, probePairs } from '../pairs/import'
import { ViewerError } from '../errors'
import type { ByteSource } from '../types'
import { VERSION } from '../version'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string[]>
}

/**
 * `--key value`, `--key=value`, `--flag`, and everything else positional.
 *
 * Repeated keys accumulate, because `--features a.bed --features b.bed` is a
 * question a reader will ask and silently keeping the last one is the wrong
 * answer to it.
 */
function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  const push = (key: string, value: string): void => {
    const held = flags.get(key)
    if (held === undefined) flags.set(key, [value])
    else held.push(value)
  }
  for (let at = 0; at < argv.length; at++) {
    const token = argv[at]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      push(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[at + 1]
    if (next === undefined || next.startsWith('--')) push(body, 'true')
    else {
      push(body, next)
      at += 1
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags }
}

const one = (args: Args, key: string): string | undefined => args.flags.get(key)?.[0]
const all = (args: Args, key: string): string[] => args.flags.get(key) ?? []

/**
 * `--bin-size` and `--rungs`, or `undefined` when neither was given.
 *
 * Only consulted for a `.pairs`, and harmless everywhere else: a cooler states
 * its own resolutions, so a bin size named on the command line for one would be
 * a second answer to a question the file already answered.
 */
function pairsBinningOf(args: Args): PairsBinning | undefined {
  const base = Number(one(args, 'bin-size') ?? one(args, 'binsize') ?? NaN)
  if (!Number.isFinite(base) || base < 1) return undefined
  const rungs = Number(one(args, 'rungs') ?? 1)
  return { base: Math.floor(base), rungs: Number.isFinite(rungs) ? Math.max(1, Math.floor(rungs)) : 1 }
}
const flag = (args: Args, key: string): boolean => {
  const value = one(args, key)
  return value !== undefined && value !== 'false'
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Turn `--window 100000` into the typed value the descriptor expects.
 *
 * Driven by the descriptor rather than by guessing, so a numeric parameter
 * cannot arrive as the string `"100000"` and a boolean cannot arrive as
 * `"false"` — both of which a runner would read as truthy and act on. An unknown
 * key is an error rather than being ignored: a typo in a batch script that runs
 * for an hour must not silently use the default.
 */
function paramsFor(task: AnalysisTask, args: Args): Params {
  // Built as a mutable record and returned as `Params`, which is readonly: the
  // type is a promise to the *runners* that nothing edits their parameters mid
  // run, not a claim that nobody may assemble one.
  const params: Record<string, Params[string]> = {}
  const known = new Map(task.params.map((param) => [param.key, param]))
  for (const param of task.params) {
    if ('default' in param && param.default !== undefined) {
      params[param.key] = param.default as Params[string]
    }
  }
  for (const [key, values] of args.flags) {
    const param = known.get(key)
    // The task's own parameters win over the CLI's flags where the names
    // collide, and `--balance` is the collision that matters: six tasks declare
    // it. Skipping a reserved name first would have set the framing and left the
    // task at its default, which is precisely the silent-default failure the
    // unknown-key error below exists to prevent.
    if (param === undefined && RESERVED.has(key)) continue
    if (param === undefined) {
      throw new Error(
        `${task.id} has no parameter --${key}. Its parameters are: ` +
          `${task.params.map((entry) => `--${entry.key}`).join(', ') || '(none)'}.`,
      )
    }
    params[key] = coerce(param, values)
  }
  return params
}

/**
 * Flags that belong to the CLI rather than to a task.
 *
 * Consulted only for a name the task does *not* declare. `--balance` is on both
 * lists deliberately: it sets the framing, and where a task also has a `balance`
 * parameter it sets that too, because a reader typing it once means both.
 *
 * `--window` rather than `--region`: `expected` and `fourc` both take a
 * parameter called `region`, meaning *which sequence*, and the framing's window
 * is a different question. One name for two things is how a batch script comes
 * out subtly wrong.
 */
const RESERVED = new Set([
  'out',
  'o',
  'window',
  'balance',
  'features',
  'pairs',
  'over',
  'quiet',
  'help',
  // How a `.pairs` positional is binned (§3.7). Reserved rather than declared
  // per task because it is a property of the *input*, not of the analysis: it
  // decides which grid the file is read on, and every task then runs on that
  // grid exactly as it would over a cooler.
  'bin-size',
  'binsize',
  'rungs',
])

function coerce(param: AnalysisTask['params'][number], values: string[]): Params[string] {
  const kind = (param as { kind?: string }).kind
  if (kind === 'multi' || Array.isArray((param as { default?: unknown }).default)) {
    // A list may arrive as repeated flags or as one comma-separated value; both
    // are things a shell user will write and neither is wrong.
    return values.flatMap((value) => value.split(',')).filter((value) => value !== '')
  }
  const value = values[values.length - 1]
  if (kind === 'toggle' || typeof (param as { default?: unknown }).default === 'boolean') {
    return value !== 'false' && value !== '0'
  }
  if (kind === 'number' || typeof (param as { default?: unknown }).default === 'number') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      throw new Error(`--${param.key} needs a number; got ${JSON.stringify(value)}.`)
    }
    return parsed
  }
  return value
}

// ---------------------------------------------------------------------------
// Running one task on one file
// ---------------------------------------------------------------------------

interface RunOptions {
  task: AnalysisTask
  params: Params
  path: string
  window?: string | undefined
  balance?: boolean | undefined
  inputs: TaskInputs
  quiet: boolean
  /** How to bin a `.pairs`, which states no resolution of its own (§3.7). */
  binning?: PairsBinning | undefined
}

/** `--bin-size` and `--rungs`, the CLI's answer to the browser's dialog. */
interface PairsBinning {
  base: number
  rungs: number
}

/**
 * Open a file for a task, importing it first when it is a `.pairs`.
 *
 * The browser answers "at what resolution?" with a dialog; a shell answers it
 * with a flag, and the refusal names the flag rather than describing a dialog
 * nobody here can see. Everything after the open is identical, which is the
 * point of GAPS G4: a number computed in a batch and a number computed by
 * clicking come out of one implementation.
 *
 * The ladder is built even though a task reads one rung, and that is deliberate
 * rather than wasteful — it costs a walk over the base pixel table, and it is
 * what makes `--out` able to carry a `.mcool` that opens in the app at the same
 * resolutions a session would have had.
 */
async function openForTask(path: string, source: ByteSource, options: RunOptions): Promise<MetaCooler> {
  try {
    return await MetaCooler.open(path, source)
  } catch (error) {
    if (!(error instanceof ViewerError) || error.code !== 'pairs-binning-needed') throw error
    const binning = options.binning
    if (binning === undefined) {
      throw new ViewerError(
        'pairs-binning-needed',
        `${basename(path)} is a .pairs file: a list of contacts with no resolution of its own. ` +
          'Say what to bin it at, e.g. `--bin-size 5000 --rungs 4`.',
        error.detail,
      )
    }
    const probe = await probePairs(source, () => openPairsIndex(path))
    if (!options.quiet) {
      const known = probe.records === null ? 'an unindexed file' : `${probe.records.toLocaleString()} records`
      process.stderr.write(`  binning ${known} at ${binning.base} bp\n`)
    }
    const imported = await importPairs(source, probe, {
      base: binning.base,
      rungs: binning.rungs,
      ...(options.quiet
        ? {}
        : {
            onProgress: (done, total, note) => {
              if (total > 0 && done % Math.max(1, Math.floor(total / 10)) < 2) {
                process.stderr.write(`  ${note ?? 'working'} ${Math.round((done / total) * 100)}%\n`)
              }
            },
          }),
    })
    if (imported === null) throw new Error('the pairs import was interrupted')
    return MetaCooler.fromPairs({
      uri: path,
      header: imported.header,
      pixels: imported.tables.get(imported.rungs[0])!,
      rungs: imported.rungs,
      indexed: imported.indexed,
      declaredRecords: imported.declaredRecords,
    })
  }
}

/**
 * The `.px2` beside a pairs file on disk, or `null`.
 *
 * Both spellings `pairix` writes, most specific first — the same rule
 * `annotations/sidecar.ts` states for a `.bai`, and for the same reason: a
 * reader must not have to know which convention produced the pair they have.
 */
async function openPairsIndex(path: string): Promise<ByteSource | null> {
  for (const candidate of [`${path}.px2`, `${path.replace(/\.gz$/i, '')}.px2`]) {
    if (!existsSync(candidate)) continue
    try {
      return await LocalFileSource.fromPath(candidate)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Open a file named on the command line, by whichever road it needs.
 *
 * The browser's two roads (`worker/open.ts`), against a filesystem instead of a
 * `SourceSpec`: an HDF5 container mounts, and a HiC-Pro matrix is read whole
 * beside its bin file. Written here rather than reused wholesale because the
 * discovery step is genuinely different — a path is `existsSync`, not a `HEAD`
 * — but the parse below is the shared one, so a number computed in a shell and
 * a number computed by clicking come out of the same implementation.
 */
async function openLocal(
  path: string,
  options: RunOptions,
): Promise<{ mc: MetaCooler; source: ByteSource }> {
  const name = basename(path)
  if (!isHicProMatrix(name)) {
    // The HDF5 road, and the `.pairs` import that hangs off its one refusal.
    const source = await LocalFileSource.fromPath(path)
    return { mc: await openForTask(path, source, options), source }
  }
  const beside = hicProBinsNames(name)
    .map((n) => join(dirname(path), n))
    .find((candidate) => existsSync(candidate))
  if (beside === undefined) {
    throw new Error(
      `${name} is a HiC-Pro matrix, which is half of a contact map: the bin file beside it — ` +
        `${hicProBinsNames(name).join(' or ')} — is what says which genomic interval each bin ` +
        `id means, and there are no coordinates without it.`,
    )
  }
  const binBytes = await decodeAnnotationBytes(new Uint8Array(readFileSync(beside)))
  const parsedBins = parseBins(binBytes, basename(beside))
  const matrixBytes = await decodeAnnotationBytes(new Uint8Array(readFileSync(path)))
  return hicProMap(
    path,
    { bytes: matrixBytes, name },
    parsedBins,
    basename(beside),
    binBytes.length,
  )
}

/**
 * One task, one file, one result — the CLI's whole unit of work.
 *
 * The `JobContext` here is the one `analysis/worker/analysis.worker.ts` builds,
 * with the two differences a shell makes: nothing can be cancelled, so
 * `cancelled` is constant, and progress goes to stderr rather than into a
 * message. `breathe` still yields, because the runners call it in their outer
 * loops and a promise that never resolves would hang.
 */
async function runOne(options: RunOptions): Promise<TaskResult & { contigs: BedGraphContig[] }> {
  const { task, params, path } = options
  const { mc } = await openLocal(resolve(path), options)
  try {
    const runner = RUNNERS[task.id]
    if (runner === undefined) {
      throw new Error(`no analysis runner is registered for the task ${task.id}`)
    }
    const extent =
      options.window === undefined
        ? ([0, mc.nBins] as [number, number])
        : mc.extent(options.window)
    const balance = options.balance ?? mc.hasWeights
    const framing: AnalysisFraming = {
      uri: mc.uri,
      rows: extent,
      cols: extent,
      binsize: mc.binsize,
      binsPerCell: 1,
      balance,
      value: 'count',
      normalise: null,
      level: 'bin',
      label:
        `${options.window ?? 'whole file'} at ${mc.binsize} bp` +
        `${balance ? ', balanced' : ''}, count`,
    }

    const notes: string[] = []
    const started = Date.now()
    let lastPercent = -1
    const job: JobContext = {
      mc,
      params,
      framing,
      inputs: {
        ...options.inputs,
        contigLengths: Object.fromEntries(mc.chromsizes),
      },
      cancelled: () => false,
      throwIfCancelled: () => {
        // Nothing can cancel a CLI run but Ctrl-C, which the process handles.
        // Present so the runners' calls are not conditional on the venue.
        void abortError
      },
      breathe: async () => {
        await yieldToEventLoop()
      },
      progress: (done, total) => {
        if (options.quiet || total <= 0) return
        const percent = Math.floor((done / total) * 100)
        // Only on a change, and only to stderr: a progress line interleaved with
        // a TSV on stdout is a TSV nobody can pipe.
        if (percent === lastPercent) return
        lastPercent = percent
        process.stderr.write(`\r  ${task.title}: ${percent}%   `)
      },
      note: (text) => {
        notes.push(text)
      },
      toBp: (bins) => bins * mc.binsize,
      toBins: (bp) => Math.max(1, Math.round(bp / mc.binsize)),
    }

    const outputs = await runner(job)
    if (!options.quiet) process.stderr.write('\r')
    // The assembly travels with the result rather than being fetched again: a
    // second open costs a second mount and a second metadata walk to learn
    // something this one already knows.
    const contigs: BedGraphContig[] = mc.chromnames.map((name, id) => {
      const [startBin, endBin] = mc.coords.contigBinExtent(id)
      return { name, startBin, bins: endBin - startBin, length: mc.coords.contigLengths[id] }
    })
    return {
      contigs,
      outputs,
      provenance: {
        task: task.id,
        taskVersion: task.version ?? 0,
        params,
        framing,
        app: `metacooler-run ${VERSION}`,
        createdAt: new Date().toISOString(),
      },
      notes,
      ms: Date.now() - started,
    }
  } finally {
    mc.close()
  }
}

// ---------------------------------------------------------------------------
// Writing what came back
// ---------------------------------------------------------------------------

/**
 * Every output, in every format that means anything for its kind.
 *
 * The same rule §18.7 states for the drawer — *bigWig for a signal, bedGraph,
 * BED, TSV* — and the same writers, so a file produced here and a file produced
 * by clicking are byte-identical given the same inputs. That is worth more than
 * it sounds: it means a figure made in the browser and a table made in a batch
 * can be compared without anybody wondering whether the difference is the tool.
 */
async function writeOutputs(
  result: TaskResult,
  base: string,
  directory: string,
  contigs: readonly BedGraphContig[],
  quiet: boolean,
): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  const written: string[] = []
  const put = async (name: string, body: string | Uint8Array): Promise<void> => {
    const at = join(directory, name)
    await writeFile(at, body)
    written.push(at)
    if (!quiet) process.stderr.write(`  wrote ${at}\n`)
  }

  for (const output of result.outputs) {
    const stem = `${base}.${result.provenance.task}.${output.id}`
    await put(`${stem}.tsv`, outputToTsv(output, result.provenance))
    if (output.kind === 'profile') {
      await put(`${stem}.bedGraph`, profileToBedGraph(output, contigs, result.provenance))
      // The same three arguments the drawer's own bigWig button passes, so the
      // two writers cannot drift: one implementation, one byte layout, one set
      // of round-trip tests behind it.
      const blob = await writeBigWig({
        contigs: contigs.map((contig) => ({ name: contig.name, length: contig.length })),
        values: output.values,
        firstBin: output.extent[0],
        binsize: output.binsize,
      })
      await put(`${stem}.bw`, new Uint8Array(await blob.arrayBuffer()))
    }
  }
  return written
}

// ---------------------------------------------------------------------------
// Inputs a task may need
// ---------------------------------------------------------------------------

/**
 * Feature and pair sets named on the command line.
 *
 * Parsed by the app's own parsers, so a loop table the browser accepts is a loop
 * table this accepts — including the headed TSV that most callers actually emit,
 * which is the case `annotations/parse.ts` exists to get right.
 *
 * Keyed by the *file's base name* rather than by an entry id, because there is
 * no store here to allocate one from and a name is what a reader would use to
 * refer to it anyway. The same name goes into `labels`, so a correlation
 * heatmap's axes read as filenames rather than as `a1`.
 */
async function loadInputs(args: Args): Promise<TaskInputs> {
  const inputs: TaskInputs = {}
  const labels: Record<string, string> = {}
  for (const path of all(args, 'features')) {
    const text = await decodeAnnotationText(new Uint8Array(await readFile(path)))
    const id = basename(path)
    const format = sniffFormat(text, path)
    if (format === 'bedpe') {
      inputs.pairs = { ...inputs.pairs, [id]: parseBedpe(text) }
    } else {
      inputs.features = { ...inputs.features, [id]: parseBed(text, path) }
    }
    labels[id] = id
  }
  for (const path of all(args, 'pairs')) {
    const text = await decodeAnnotationText(new Uint8Array(await readFile(path)))
    const id = basename(path)
    inputs.pairs = { ...inputs.pairs, [id]: parseBedpe(text) }
    labels[id] = id
  }
  if (Object.keys(labels).length > 0) inputs.labels = labels
  return inputs
}

/**
 * File each loaded set under the **parameter key** that chose it.
 *
 * {@link TaskInputs} is keyed by parameter key — `analysis/job.ts`'s
 * `chosenInput` is a whole paragraph about not indexing it by the entry id —
 * and this side had been filing everything by file name and then setting the
 * parameter to a *path*. The two never met: every task that takes a feature or
 * pair set found `undefined` under its own key and reported "the set chosen is
 * no longer loaded" about a file it had just parsed. It type-checks, it reads
 * as though it must work, and it is the exact mistake that function exists to
 * stop, made from the one venue that has no store to allocate ids in.
 *
 * So the name a reader typed still names the input, and the parameter key is an
 * alias for it. Both, because `labels` is keyed by the first and the runners
 * look up the second.
 */
function bindInputs(task: AnalysisTask, params: Params, inputs: TaskInputs): TaskInputs {
  const bound: TaskInputs = { ...inputs }
  for (const spec of task.params) {
    if (spec.kind !== 'featureSet' && spec.kind !== 'pairSet') continue
    const chosen = params[spec.key]
    if (typeof chosen !== 'string' || chosen === '') continue
    const name = basename(chosen)
    if (spec.kind === 'pairSet') {
      const set = inputs.pairs?.[chosen] ?? inputs.pairs?.[name]
      if (set !== undefined) bound.pairs = { ...bound.pairs, [spec.key]: set }
    } else {
      const set = inputs.features?.[chosen] ?? inputs.features?.[name]
      if (set !== undefined) bound.features = { ...bound.features, [spec.key]: set }
    }
  }
  return bound
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const USAGE = `metacooler-run — the Analysis panel, from a shell

  metacooler-run tasks
      Every task, its id, and the parameters it takes.

  metacooler-run <task> <file.cool|file.mcool|file.metacool|file.hic|file.pairs.gz> [...]
      Run one task over one or more files.

      --out <dir>          where to write (default: .)
      --window <chr:a-b>   a window rather than the whole file
      --balance            force balancing on; --balance=false forces it off
      --features <file>    a BED/narrowPeak/loop table a task needs
      --pairs <file>       a BEDPE, for an off-diagonal pileup. Note this is a
                           *feature* table and not a contact list — a .pairs
                           file to bin is a positional argument, and takes
                           --bin-size below
      --bin-size <bp>      required for a .pairs input, which states no
                           resolution of its own; ignored for every other format
      --rungs <n>          how many ladder resolutions to build from it
                           (1-2-5 series from the base). Default 1
      --quiet              no progress on stderr
      --<param> <value>    any parameter the task takes; see \`tasks\`

  metacooler-run replay <workspace.metacooler.json> --over <file> [...]
      Re-run every analysis recorded in a saved workspace, with the parameters
      it recorded, over the files named by --over. The workspace is what the
      app's Save button produces: every open tab in one file.
      --tab <n>            which tab to replay, 1-based. Default: the one that
                           was in front when the workspace was saved.

Remote files are not supported: the reader uses synchronous range requests,
which exist in a worker and not in Node. Fetch it first.
`

function listTasks(): void {
  for (const task of TASKS) {
    process.stdout.write(`${task.id}\n    ${task.title}\n`)
    for (const param of task.params) {
      const fallback = (param as { default?: unknown }).default
      process.stdout.write(
        `      --${param.key}` +
          (fallback === undefined ? '' : ` (default ${JSON.stringify(fallback)})`) +
          `${param.label === undefined ? '' : `  ${param.label}`}\n`,
      )
    }
    process.stdout.write('\n')
  }
}

async function runCommand(args: Args): Promise<number> {
  const task = taskById(args.command)
  if (task === undefined) {
    process.stderr.write(`Unknown task ${JSON.stringify(args.command)}. Try \`tasks\`.\n`)
    return 2
  }
  if (args.positional.length === 0) {
    process.stderr.write(`${task.id} needs at least one file.\n`)
    return 2
  }
  // Parameters and inputs are resolved *before* any file is opened, and a
  // failure in either is exit 2 with a sentence rather than a stack: they are
  // faults in the command, and a command that is wrong should say so before it
  // spends an hour being wrong two hundred times.
  let params: Params
  let inputs: TaskInputs
  try {
    params = paramsFor(task, args)
    inputs = bindInputs(task, params, await loadInputs(args))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const directory = one(args, 'out') ?? one(args, 'o') ?? '.'
  const quiet = flag(args, 'quiet')

  let failures = 0
  for (const path of args.positional) {
    try {
      if (!quiet) process.stderr.write(`${path}\n`)
      const result = await runOne({
        task,
        params,
        path,
        binning: pairsBinningOf(args),
        // Not `one(args, 'window')`. `apa` declares a parameter of that name —
        // a half-width in bins — and `paramsFor` already gives a task's own
        // parameters the flag where the two collide. The framing was reading it
        // anyway, so `apa --window 8` set the half-width *and* tried to resolve
        // `8` as a locus, and the run died with "Unknown sequence label: 8".
        // One name, one meaning, decided by whether the task claims it.
        window: task.params.some((param) => param.key === 'window')
          ? undefined
          : one(args, 'window'),
        balance: args.flags.has('balance') ? flag(args, 'balance') : undefined,
        inputs,
        quiet,
      })
      for (const note of result.notes) process.stderr.write(`  note: ${note}\n`)
      await writeOutputs(result, stemOf(path), directory, result.contigs, quiet)
    } catch (error) {
      failures += 1
      // Named and carried on, rather than stopping: a batch of two hundred
      // files where the eleventh is truncated should produce a hundred and
      // ninety-nine results and one message, not eleven results and a stack.
      process.stderr.write(
        `  failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
  return failures === 0 ? 0 : 1
}

/**
 * Re-run a saved tab's analyses over other files.
 *
 * The parameters come from `analysis` in the tab — the same block the drawer
 * restores a form from — so what runs here is what the reader settled on by
 * looking at a picture. Nothing is retyped, which is the whole point: a
 * transcription error in a batch of two hundred is two hundred wrong numbers
 * that look right.
 */
async function replayCommand(args: Args): Promise<number> {
  const path = args.positional[0]
  if (path === undefined) {
    process.stderr.write('replay needs a workspace file.\n')
    return 2
  }
  const read = parseWorkspaceFile(await readFile(path, 'utf8'))
  if (isRefusal(read)) {
    // The reason rather than one blanket sentence: a workspace from a newer
    // build is a different problem from a file that is not one, and only one of
    // them is fixed by looking at the file.
    process.stderr.write(`${refusalMessage(read, path)}\n`)
    return 2
  }
  // A workspace holds every tab the window had. Replaying "the session" means
  // one of them, so it is the tab that was in front unless `--tab` names
  // another — printed one-based, because that is how the reader counted them.
  const wanted = one(args, 'tab')
  const index = wanted === undefined ? read.active : Number(wanted) - 1
  if (!Number.isInteger(index) || index < 0 || index >= read.tabs.length) {
    process.stderr.write(
      `${path} holds ${read.tabs.length} tab${read.tabs.length === 1 ? '' : 's'}; ` +
        `--tab must name one of them.\n`,
    )
    return 2
  }
  const config = read.tabs[index]
  const recorded = recordedTasks(config)
  if (recorded.length === 0) {
    process.stderr.write(
      `${path} records no analysis parameters. Run a task in the app and save again.\n`,
    )
    return 2
  }
  const over = all(args, 'over')
  const files = over.length > 0 ? over : [config.state.uri]
  const directory = one(args, 'out') ?? one(args, 'o') ?? '.'
  const quiet = flag(args, 'quiet')
  const loaded = await loadInputs(args)

  process.stderr.write(
    `${recorded.length} task${recorded.length === 1 ? '' : 's'} from ${basename(path)}, ` +
      `over ${files.length} file${files.length === 1 ? '' : 's'}\n`,
  )
  let failures = 0
  for (const file of files) {
    for (const entry of recorded) {
      const task = taskById(entry.task)
      if (task === undefined) {
        // A session from a newer build, or one whose task has been withdrawn.
        // Named rather than skipped in silence: the count above said how many
        // would run and this is why one of them did not.
        process.stderr.write(`  skipped ${entry.task}: this build has no such task\n`)
        continue
      }
      try {
        if (!quiet) process.stderr.write(`${file} · ${task.title}\n`)
        const result = await runOne({
          task,
          params: entry.params,
          path: file,
          balance: undefined,
          binning: pairsBinningOf(args),
          // Per task, because a replayed workspace can hold several that name
          // different sets under different keys.
          inputs: bindInputs(task, entry.params, loaded),
          quiet,
        })
        await writeOutputs(result, stemOf(file), directory, result.contigs, quiet)
      } catch (error) {
        failures += 1
        process.stderr.write(
          `  failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }
  }
  return failures === 0 ? 0 : 1
}

/** The tasks a session recorded parameters for, in catalogue order. */
export function recordedTasks(config: {
  analysis?: Record<string, Params> | undefined
}): Array<{ task: string; params: Params }> {
  const held = config.analysis
  if (held === undefined || held === null) return []
  const out: Array<{ task: string; params: Params }> = []
  for (const task of TASKS) {
    const params = held[task.id]
    if (params !== undefined) out.push({ task: task.id, params })
  }
  // A task this build does not know is still reported, so `replay` can say so
  // rather than quietly running fewer than it announced.
  for (const [id, params] of Object.entries(held)) {
    if (!out.some((entry) => entry.task === id)) out.push({ task: id, params })
  }
  return out
}

/** `demo/yeast/Yeast_microC.cool` → `Yeast_microC`. */
export function stemOf(path: string): string {
  const name = basename(path)
  const dot = name.indexOf('.')
  return dot > 0 ? name.slice(0, dot) : (name || 'output')
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === '' || args.command === 'help' || flag(args, 'help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.command === 'tasks') {
    listTasks()
    return 0
  }
  if (args.command === 'replay') return replayCommand(args)
  return runCommand(args)
}

// `import.meta.url` against `process.argv[1]` is the ESM spelling of "am I the
// entry point"; importing this module from a test must not run it. Compared
// by realpath rather than by name: Node resolves the entry file's own symlinks
// before it becomes `import.meta.url`, so an extensionless `bin` link — the
// whole point of `package.json`'s `bin` field — has `argv[1]` end in
// `metacooler-run` while the module it loaded ends in `metacooler-run.mjs`.
// A name or suffix comparison never matches there; realpath resolves both
// sides to the same file underneath the symlink.
function isEntryPoint(argv1: string | undefined): boolean {
  if (argv1 === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    // Not a path Node can stat — cannot be the file that is executing.
    return false
  }
}
const invoked = isEntryPoint(process.argv[1])
if (invoked) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

