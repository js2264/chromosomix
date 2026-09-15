/**
 * The analysis panel, without the panel.
 *
 * ## Why this exists
 *
 * The Analysis panel computes sixteen things and every one of them is goldened
 * against cooltools, coolpuppy, chromosight, pyBigWig and numpy (§18.10). That is a lot of
 * verified arithmetic reachable only by clicking, and the moment a reader has
 * two hundred files rather than one, clicking stops being the interface. They
 * leave — for cooltools, which is the right tool and a different set of
 * definitions, so the numbers in the figure and the numbers in the table are no
 * longer the same numbers.
 *
 * So: the same kernels, the same writers, the same provenance lines, driven from
 * a shell. Not a reimplementation and not a port — `RUNNERS` and `TRACK_RUNNERS`
 * are imported from `analysis/run/`, and the job handed to each is built exactly
 * as `analysis/worker/analysis.worker.ts` and
 * `annotations/worker/annotations.worker.ts` build theirs. If the two ever
 * disagree, one of them is wrong and there is a golden that says which.
 *
 * **Both maps, because there are two venues.** A task states which worker it
 * belongs in (`analysis/job.ts`), and reading only `RUNNERS` is what made this
 * command list sixteen tasks and honour twelve: `motif`, `metaplot`, `trackcorr`
 * and `overlap` were offered with a flag per parameter and then died with *no
 * analysis runner is registered* — after the mount, once per file, exit 1.
 *
 * **Every task, because the console records every run.** For a while the
 * shell honoured what it could and refused the rest by name: the three tasks
 * that read a bigWig, the one that reads a second map, and any run made in a
 * session with no contact map. Each refusal was honest and each was a hole in
 * the console (§23) exactly where a reader looks for a line to paste — a
 * metaplot over two hundred files is the run somebody most wants as a command.
 * So the four capabilities a shell was said not to have are now here, each as
 * the same code the worker runs:
 *
 * - **Tracks.** `--tracks` opens a bigWig, a bedGraph, a wig or a FASTA where it
 *   lies (`cli/tracks.ts`), and `sample` answers from it in the annotations
 *   worker's own shape. A FASTA named for `compartments`' phasing becomes the
 *   per-bin GC vector the session would have shipped.
 * - **A second map.** `--against` names the files `hicrep` compares this one
 *   with, and `peer` mounts each one exactly as the analysis worker does.
 * - **No map at all.** A task of the annotations venue runs with no file
 *   positional, over the assembly the tracks declare — the 1D browser's own
 *   framing (§5.8), so a run made there is a run this can repeat.
 * - **A named `.pairs`.** `expected --stranded --pairsUri` reads a local path
 *   through `openFile`, and a `.pairs` given as the map carries its own four
 *   orientation curves into the run, as an import in the app does.
 *
 * A composite (`magnetwork` requires `magqc`) runs its requirements first, at
 * their defaults, exactly as `AnalysisRunner.plan` does.
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
import { TRACK_RUNNERS } from '../analysis/run/tracks'
import { TASKS, taskById } from '../analysis/registry'
import { abortError } from '../analysis/job'
import type { JobContext, SequenceReader, TrackJobContext } from '../analysis/job'
import {
  gcTrack,
  lengthsOf,
  loadTracks,
  samplerOver,
  trackFor,
  vectorOver,
  type LoadedTrack,
} from './tracks'
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
import { formatIntervals } from '../annotations/export'
import type { StoredEntry } from '../annotations/types'
import { looksLikeFasta, parseFasta, type SequenceStore } from '../annotations/fasta'
import { hicProBinsNames, isHicProMatrix } from '../annotations/sidecar'
import { contigIndexOf } from '../genome/naming'
import { parseBins } from '../hicpro/parse'
import { DEFAULT_COUNT_COLUMN } from '../metacooler/matrix'
import { hicProMap } from '../worker/open'
import { isRefusal, refusalMessage } from '../state/SessionConfig'
import { parseWorkspaceFile } from '../state/workspace'
import {
  defaultParams,
  type AnalysisFraming,
  type AnalysisTask,
  type Params,
  type TaskOutput,
  type TaskResult,
} from '../analysis/types'
import type { PeerMap, TaskInputs } from '../analysis/worker/protocol'
import type { OrientationSummary } from '../worker/protocol'
import { importPairs, probePairs } from '../pairs/import'
import { ViewerError } from '../errors'
import { parseUri } from '../uri'
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
/**
 * `--value`, `--circular` and `--cell`: the framing a session sets from the
 * picture, spelled as flags (see `RESERVED`).
 */
function framingFlags(args: Args): Pick<RunOptions, 'value' | 'circular' | 'cells'> {
  const value = one(args, 'value')
  return {
    ...(value === undefined || value === '' ? {} : { value }),
    circular: all(args, 'circular').flatMap((item) => item.split(',')).filter((item) => item !== ''),
    cells: all(args, 'cell').flatMap((item) => item.split(',')).filter((item) => item !== ''),
  }
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
  'sequence',
  // A track to load without a parameter choosing it, for `replay`: a workspace
  // records the app's entry ids under `tracks`, and this is how the file behind
  // one is named. A direct run needs no such flag — the task's own `--tracks`
  // is a path, and loads what it names.
  'track',
  // The other maps `hicrep` compares this one with (§16). A shell has one file
  // and one mount, and this is the flag that stands in for the deck.
  'against',
  // The three facts of a *framing* a session sets from the picture and a shell
  // has to be told: which score column the map is drawn from (§3.5), which
  // sequences the reader declared circular (§8.15), and which cells of an
  // `.scool` are ticked (§3.8). Each is an input to the arithmetic, so a line
  // without them repeats a different run.
  'value',
  'circular',
  'cell',
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
  // `sequences` by name as well as `multi`, and it is not a tidy-up: the runners
  // read that key with `Array.isArray` and fall back to *every sequence* when it
  // is anything else. A plain string is anything else, so `--sequences chr18`
  // typed at a shell scanned all twenty-one of them and reported a number from
  // the wrong one — a silent widening, which is the failure mode a batch script
  // cannot see. It has no `default`, so the array rule below never caught it.
  const multiple = (param as { multiple?: boolean }).multiple === true
  if (
    kind === 'multi' ||
    kind === 'sequences' ||
    multiple ||
    Array.isArray((param as { default?: unknown }).default)
  ) {
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
  /**
   * References named with `--sequence`, by the string the reader typed.
   *
   * Beside `inputs` rather than inside it, because {@link TaskInputs} is what
   * crosses a `postMessage` and a parsed genome is the one input this codebase
   * deliberately never sends anywhere (`analysis/job.ts`, {@link SequenceReader}).
   * Here it does not have to: the store and the runner are on one stack.
   */
  sequences: Map<string, SequenceStore>
  /**
   * Tracks named with `--tracks` or `--track`, by the string the reader typed.
   *
   * Beside `inputs` for the reason `sequences` is: a bigWig handle is the one
   * thing the annotations worker exists to hold and never ship, and here it
   * need not be shipped — `sample` is answered on the same stack.
   */
  tracks: Map<string, LoadedTrack>
  /** The other maps a task that compares files is run against (`--against`). */
  peers: readonly string[]
  /** The score column to read, or `undefined` for the count (§3.5). */
  value?: string | undefined
  /** Sequences declared circular (§8.15), by this file's names. */
  circular: readonly string[]
  /** The cells of an `.scool` to sum; empty is every cell (§3.8). */
  cells: readonly string[]
  quiet: boolean
  /** How to bin a `.pairs`, which states no resolution of its own (§3.7). */
  binning?: PairsBinning | undefined
}

/** A map opened for a run, with the one fact an import carries that a mount does not. */
interface Opened {
  mc: MetaCooler
  source: ByteSource
  /** The four orientation curves counted while binning a `.pairs`, or `null`. */
  orientation: OrientationSummary | null
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
async function openForTask(uri: string, source: ByteSource, options: RunOptions): Promise<Opened> {
  const path = parseUri(uri).path
  try {
    return { mc: await MetaCooler.open(uri, source), source, orientation: null }
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
    const pixels = imported.tables.get(imported.rungs[0])!
    // The curves the pass just counted, as `worker/reader.worker.ts` hands them
    // to the session: the records are gone once the table exists, and the task
    // that draws them (`expected --stranded`) runs on the table.
    const counted = pixels.orientation ?? null
    return {
      mc: MetaCooler.fromPairs({
        uri: path,
        header: imported.header,
        pixels,
        rungs: imported.rungs,
        indexed: imported.indexed,
        declaredRecords: imported.declaredRecords,
      }),
      source,
      orientation:
        counted === null
          ? null
          : { edges: counted.edges, counts: counted.counts, total: counted.total },
    }
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
async function openLocal(uri: string, options: RunOptions): Promise<Opened> {
  // **The `::` is addressed to the container, not to the filesystem.** An
  // `.mcool` is a collection of coolers and `detect.ts` refuses one at its root
  // with a sentence naming the resolutions and telling the reader to write
  // `file.mcool::/resolutions/25000` — advice this shell then could not take,
  // because the whole string went to `stat` and there is no such file. So the
  // path is split off for the filesystem and the *uri* is what the container is
  // opened with, which is where `parseUri` reads the group from.
  const path = parseUri(uri).path
  const name = basename(path)
  if (!isHicProMatrix(name)) {
    // The HDF5 road, and the `.pairs` import that hangs off its one refusal.
    const source = await LocalFileSource.fromPath(path)
    return openForTask(uri, source, options)
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
  const opened = await hicProMap(
    path,
    { bytes: matrixBytes, name },
    parsedBins,
    basename(beside),
    binBytes.length,
  )
  return { ...opened, orientation: null }
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
  const opened = await openLocal(resolve(path), options)
  const { mc } = opened
  try {
    // The ticked cells, as the analysis worker selects them before any task
    // runs: an `.scool` sums whichever cells are chosen, and a task over "the
    // map" is a task over that sum (§3.8).
    if (options.cells.length > 0) {
      if (mc.cells.length === 0) {
        throw new Error(
          `${basename(parseUri(path).path)} has no cells to choose from; --cell is for an .scool.`,
        )
      }
      mc.selectCells(options.cells)
    }
    const value = options.value ?? DEFAULT_COUNT_COLUMN
    if (value !== DEFAULT_COUNT_COLUMN && !mc.scoreColumns.includes(value)) {
      throw new Error(
        `${basename(parseUri(path).path)} has no score column ${JSON.stringify(value)}. It has: ` +
          `${mc.scoreColumns.join(', ') || DEFAULT_COUNT_COLUMN}.`,
      )
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
      value,
      normalise: null,
      level: 'bin',
      label:
        `${options.window ?? 'whole file'} at ${mc.binsize} bp` +
        `${balance ? ', balanced' : ''}, ${value}` +
        `${options.circular.length === 0 ? '' : `, circular ${options.circular.join(',')}`}` +
        `${options.cells.length === 0 ? '' : `, ${options.cells.length} cells`}`,
      ...(options.circular.length === 0 ? {} : { circular: [...options.circular] }),
    }
    // The assembly travels with the result rather than being fetched again: a
    // second open costs a second mount and a second metadata walk to learn
    // something this one already knows.
    const contigs: BedGraphContig[] = mc.chromnames.map((name, id) => {
      const [startBin, endBin] = mc.coords.contigBinExtent(id)
      return { name, startBin, bins: endBin - startBin, length: mc.coords.contigLengths[id] }
    })

    const notes: string[] = []
    const started = Date.now()
    let lastPercent = -1
    const shared = {
      cancelled: () => false,
      throwIfCancelled: () => {
        // Nothing can cancel a CLI run but Ctrl-C, which the process handles.
        // Present so the runners' calls are not conditional on the venue.
        void abortError
      },
      breathe: async () => {
        await yieldToEventLoop()
      },
      progress: (done: number, total: number) => {
        if (options.quiet || total <= 0) return
        const percent = Math.floor((done / total) * 100)
        // Only on a change, and only to stderr: a progress line interleaved with
        // a TSV on stdout is a TSV nobody can pipe.
        if (percent === lastPercent) return
        lastPercent = percent
        process.stderr.write(`\r  ${task.title}: ${percent}%   `)
      },
      note: (text: string) => {
        notes.push(text)
      },
    }
    const baseInputs: TaskInputs = {
      ...options.inputs,
      contigLengths: Object.fromEntries(mc.chromsizes),
      ...(opened.orientation === null ? {} : { orientation: opened.orientation }),
      ...(options.peers.length === 0 ? {} : { peers: peersOf(options.peers) }),
    }

    /**
     * The job for one step of the chain, built as `analysis.worker.ts` builds
     * its own — with the three capabilities a shell answers differently from a
     * worker: `peer` and `openFile` read the filesystem, and `vectors` is
     * computed here rather than asked of another thread.
     */
    const jobFor = async (
      step: AnalysisTask,
      stepParams: Params,
      upstream: Record<string, TaskResult>,
    ): Promise<JobContext> => ({
      mc,
      params: stepParams,
      framing,
      inputs: {
        ...baseInputs,
        ...(await vectorsFor(step, stepParams, options, { contigs, binsize: mc.binsize, nBins: mc.nBins })),
        ...(Object.keys(upstream).length === 0 ? {} : { upstream: { ...upstream } }),
      },
      ...shared,
      toBp: (bins) => bins * mc.binsize,
      toBins: (bp) => Math.max(1, Math.round(bp / mc.binsize)),
      // A second mount for the length of one run, closed by the runner: the
      // analysis worker's own `peer`, against a filesystem instead of a
      // `SourceSpec`. Mounted through `openLocal`, so a `.pairs` or a HiC-Pro
      // pair beside the map opens by the same road the map did.
      peer: async (map) => {
        const other = await openLocal(resolve(map.uri), options)
        return {
          mc: other.mc,
          close: () => {
            other.mc.close()
            other.source.close()
          },
        }
      },
      // A file this process can read and does not mount — a `.pairs` named for
      // its orientation curves. `openBytes` stays unanswered: it is for an
      // address, and a shell fetches those with `curl`.
      openFile: async (file) => {
        // Mounted, because a path-backed source reads through the mount and
        // refuses a range before one exists — and mounted rather than read
        // whole, since a contact list is the one input here that is routinely
        // larger than memory.
        const source = await LocalFileSource.fromPath(resolve(file))
        await source.mount()
        return source
      },
    })

    const outputs = await runChain(task, params, framing, jobFor, options)
    if (!options.quiet) process.stderr.write('\r')
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

/**
 * The other maps, as the analysis worker is handed them.
 *
 * A `PeerMap` carries the reader's own name for a panel and a `SourceSpec` for
 * the worker's mount cache; here the name is the file's and the spec is the
 * path spelled as a URL, which `peer` above never reads — it opens `uri`. The
 * label is what the coefficient matrix's axes say, so it is the base name and
 * not the whole path a batch script would have expanded.
 */
function peersOf(paths: readonly string[]): PeerMap[] {
  return paths.map((path) => ({
    label: basename(parseUri(path).path),
    uri: path,
    source: { kind: 'remote', url: pathToFileURL(resolve(parseUri(path).path)).href },
  }))
}

/**
 * The per-bin vectors a task of the *analysis* venue reads a track or a
 * sequence through (§18.6).
 *
 * `AnalysisRunner.inputsFor` asks the annotations worker for one vector per
 * chosen entry of those two kinds and ships it under the parameter's key; the
 * runner then reads `inputs.vectors[key]` and never learns a file was involved.
 * A shell that loaded the FASTA under `--sequence` and never did this left
 * `compartments --phaseSequence` reporting that the sequence *could not be
 * read*, about a file the command had just parsed. So the same vector is
 * computed here, from the loaded track or from the reference as a GC track.
 */
async function vectorsFor(
  task: AnalysisTask,
  params: Params,
  options: RunOptions,
  grid: { contigs: readonly BedGraphContig[]; binsize: number; nBins: number },
): Promise<Pick<TaskInputs, 'vectors'>> {
  if (task.venue === 'annotations') return {}
  const vectors: Record<string, Float32Array> = {}
  for (const spec of task.params) {
    if (spec.kind !== 'track' && spec.kind !== 'sequence') continue
    const chosen = params[spec.key]
    const named = typeof chosen === 'string' && chosen !== '' ? chosen : null
    if (named === null) continue
    const track =
      spec.kind === 'track'
        ? trackFor(options.tracks, named)
        : gcTrackFor(options.sequences, named)
    if (track === undefined) continue
    vectors[spec.key] = await vectorOver(track, {
      contigs: grid.contigs.map((contig) => ({
        name: contig.name,
        startBin: contig.startBin,
        length: contig.length,
      })),
      binsize: grid.binsize,
      nBins: grid.nBins,
    })
  }
  return Object.keys(vectors).length === 0 ? {} : { vectors }
}

/** A loaded reference as the GC track the session would have sampled it as. */
function gcTrackFor(
  held: Map<string, SequenceStore>,
  entry: string,
): LoadedTrack | undefined {
  const found = storeFor(held, entry)
  return found === undefined ? undefined : gcTrack(found[0], basename(found[0]), found[1])
}

/**
 * The task and everything it `requires`, required tasks first.
 *
 * `AnalysisRunner.plan`, without the cache: depth first, each requirement at
 * its own defaults — the reader configured the network and not the QC under
 * it, and inventing parameters for a form they never opened would be putting
 * numbers in their mouth — and de-duplicated, so two steps wanting one
 * upstream result compute it once. A cycle is a catalogue mistake and is named
 * rather than run into.
 */
async function runChain(
  task: AnalysisTask,
  params: Params,
  framing: AnalysisFraming,
  jobFor: (
    step: AnalysisTask,
    stepParams: Params,
    upstream: Record<string, TaskResult>,
  ) => Promise<JobContext>,
  options: Pick<RunOptions, 'sequences' | 'tracks'>,
): Promise<TaskOutput[]> {
  const upstream: Record<string, TaskResult> = {}
  const active = new Set<string>()
  const walk = async (node: AnalysisTask, nodeParams: Params): Promise<TaskOutput[]> => {
    if (active.has(node.id)) throw new Error(`the analysis task ${node.id} requires itself`)
    active.add(node.id)
    for (const id of node.requires ?? []) {
      if (id in upstream) continue
      const required = taskById(id)
      if (required === undefined) {
        throw new Error(`${node.id} requires the task ${id}, which this build does not have`)
      }
      const requiredParams = defaultParams(required.params)
      const started = Date.now()
      const outputs = await walk(required, requiredParams)
      upstream[id] = {
        outputs,
        provenance: {
          task: required.id,
          taskVersion: required.version ?? 0,
          params: requiredParams,
          framing,
          app: `metacooler-run ${VERSION}`,
          createdAt: new Date().toISOString(),
        },
        notes: [],
        ms: Date.now() - started,
      }
    }
    active.delete(node.id)
    return runFor(node, await jobFor(node, nodeParams, upstream), options)
  }
  return walk(task, params)
}

/**
 * A task of the annotations venue, run with **no contact map** at all.
 *
 * The 1D browser (§5.8) is a session with tracks and an assembly and no
 * matrix, and five tasks run there. `AnalysisRunner.tracksFraming` frames such
 * a run against the file that declared the assembly, over a zero-wide extent —
 * and the console recorded it as a sentence, because this command opened its
 * first argument as a map and there was none to name. Now there need not be:
 * with no positional, a track task runs over the assembly the loaded files
 * declare, framed exactly as the session frames it, so the line the console
 * writes for a browser run is a line this can take.
 */
async function runTracksOnly(
  options: Omit<RunOptions, 'path'>,
): Promise<TaskResult & { contigs: BedGraphContig[] }> {
  const { task, params } = options
  const lengths = lengthsOf(options.tracks, options.sequences)
  const named = [...options.tracks.values()][0]?.path ?? [...options.sequences.keys()][0] ?? ''
  const framing: AnalysisFraming = {
    uri: named,
    rows: [0, 0],
    cols: [0, 0],
    binsize: 0,
    binsPerCell: 1,
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
    label: `${basename(named)} · loaded tracks, no contact map`,
  }
  const notes: string[] = []
  const started = Date.now()
  let lastPercent = -1
  const job: TrackJobContext = {
    params,
    framing,
    inputs: { ...options.inputs, contigLengths: lengths },
    cancelled: () => false,
    throwIfCancelled: () => {
      void abortError
    },
    progress: (done, total) => {
      if (options.quiet || total <= 0) return
      const percent = Math.floor((done / total) * 100)
      if (percent === lastPercent) return
      lastPercent = percent
      process.stderr.write(`\r  ${task.title}: ${percent}%   `)
    },
    note: (text) => {
      notes.push(text)
    },
    sample: samplerOver(options.tracks),
    lengthOf: (contig) => lengths[contig],
    residues: (entry) => readerFor(options.sequences, entry),
  }
  const runner = TRACK_RUNNERS[task.id]
  if (runner === undefined) {
    throw new Error(`no analysis runner is registered for the task ${task.id}`)
  }
  const outputs = await runner(job)
  if (!options.quiet) process.stderr.write('\r')
  // No grid, so no profile can come out of this — but a writer that is handed
  // the assembly anyway writes a BED against the right names.
  const contigs: BedGraphContig[] = Object.entries(lengths).map(([name, length]) => ({
    name,
    startBin: 0,
    bins: 0,
    length,
  }))
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
}

// ---------------------------------------------------------------------------
// The other venue
// ---------------------------------------------------------------------------

/**
 * Hand the job to whichever map holds this task's runner.
 *
 * A task declares the worker it belongs in and there are two of them
 * (`analysis/job.ts`), so there are two runner maps and this is the only place
 * that has to know it. Dispatching on `task.venue` rather than on which map
 * happens to answer is deliberate: the venue is the fact the descriptor states,
 * and a task present in both maps under one id would be a build error worth
 * failing on rather than a coin toss resolved by lookup order.
 *
 * A shell can be either venue, which is what the split does *not* say and what
 * this is allowed to exploit. The annotations worker earns its own context by
 * holding open bigWig handles and a parsed genome; the reason a task runs beside
 * them is that the data must not be shipped, and nothing is shipped here — the
 * store, the runner and the writer are one stack in one process.
 */
async function runFor(
  task: AnalysisTask,
  job: JobContext,
  loaded: Pick<RunOptions, 'sequences' | 'tracks'>,
): Promise<TaskOutput[]> {
  if (task.venue === 'annotations') {
    const runner = TRACK_RUNNERS[task.id]
    if (runner === undefined) {
      throw new Error(`no analysis runner is registered for the task ${task.id}`)
    }
    return runner(trackJobOf(job, loaded))
  }
  const runner = RUNNERS[task.id]
  if (runner === undefined) {
    throw new Error(`no analysis runner is registered for the task ${task.id}`)
  }
  return runner(job)
}

/**
 * The same job, seen from the annotations venue.
 *
 * `analysis/job.ts` says what the two contexts share — parameters, framing,
 * inputs, cancellation, progress and notes — and this is that sentence as code:
 * each of those is the very function the map venue was handed, not a second one
 * built from the same ingredients, so the two cannot come to differ in this
 * file. What is added is the pair of capabilities that venue exists for:
 * residues are a reference this process parsed, and a sample is answered from
 * a track it opened (`cli/tracks.ts`), in the worker's own shape.
 */
function trackJobOf(
  job: JobContext,
  loaded: Pick<RunOptions, 'sequences' | 'tracks'>,
): TrackJobContext {
  return {
    params: job.params,
    framing: job.framing,
    inputs: job.inputs,
    cancelled: job.cancelled,
    throwIfCancelled: job.throwIfCancelled,
    progress: job.progress,
    note: job.note,
    sample: samplerOver(loaded.tracks),
    // Exactly the annotations worker's own answer: the assembly is what
    // `inputs.contigLengths` carries, because this venue is handed no other.
    lengthOf: (contig) => job.inputs.contigLengths?.[contig],
    residues: (entry) => readerFor(loaded.sequences, entry),
  }
}

/**
 * A loaded reference, by whatever name the `sequence` parameter holds.
 *
 * Three steps, because the parameter arrives by three roads. Typed on the
 * command line it is a **path**, and that is the key `loadSequences` filed it
 * under. Recorded in a workspace it is an **entry id** — `a3` — allocated by a
 * store this process does not have, which is the absence `bindInputs` is a
 * whole paragraph about; so a replay that named one reference gets that one,
 * there being nothing else it could have meant. Two references and an id that
 * matches neither is genuinely ambiguous and answers `undefined`, which
 * `analysis/run/motif.ts` turns into a sentence rather than a guess.
 */
function readerFor(
  held: Map<string, SequenceStore>,
  entry: string,
): SequenceReader | undefined {
  const store = storeFor(held, entry)?.[1]
  if (store === undefined) return undefined
  return {
    contigs: store.contigs,
    // The worker's `basesOf`, step for step: exact first, then the §5.9 ladder,
    // because a FASTA writes `chrI` where a `.hic` beside it writes `I` and a
    // search under the map's spelling has to reach the reference's.
    bases: (contig) => {
      const direct = store.bases.get(contig)
      if (direct !== undefined) return direct
      const at = contigIndexOf(store.contigs, contig)
      return at < 0 ? undefined : store.bases.get(store.contigs[at].name)
    },
  }
}

/** The loaded reference an entry names, with the path it was filed under. */
function storeFor(
  held: Map<string, SequenceStore>,
  entry: string,
): [string, SequenceStore] | undefined {
  const direct = held.get(entry)
  if (direct !== undefined) return [entry, direct]
  return (
    [...held].find(([path]) => basename(path) === basename(entry)) ??
    (held.size === 1 ? [...held][0] : undefined)
  )
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
    // The same rule as the drawer's, which has carried a BED button beside every
    // called interval set since there were any: a profile leaves as bedGraph and
    // bigWig, a set of intervals leaves as BED. Only the first half was here, so
    // a boundary set called in a shell came out as a TSV with a provenance
    // header — readable, and not what bedtools takes.
    if (output.kind === 'intervals') {
      await put(
        `${stem}.${output.payload.kind === 'pairs' ? 'bedpe' : 'bed'}`,
        formatIntervals(output.payload, {
          label: output.label,
          file: result.provenance.framing.label,
          created: result.provenance.createdAt,
        }),
      )
    }
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
 * References named with `--sequence`, parsed where they lie.
 *
 * {@link SequenceReader} is declared optional on its context precisely because
 * the hosts that can answer it are *"the annotations worker"* and not *"a test
 * harness, a future venue, or a session that has never opened a FASTA"*
 * (`analysis/job.ts`). This is that future venue, and it is the cheap half of
 * it: `parseFasta` is the same parser the worker runs, over bytes read from the
 * disk the file is already on, with no thread to cross and therefore none of
 * the reason for the cap that keeps a genome inside that worker.
 *
 * Keyed by the string the reader typed, because that string is what comes back
 * out of `params.sequence` — there is no entry store here to allocate an id
 * from, which is the same absence `bindInputs` argues about at length.
 *
 * Through `decodeAnnotationBytes` rather than `readFile` alone, so a `.fa.gz`
 * is a reference and not a parse error: every other path into this command
 * already accepts one, and a reference is the file most likely to be big enough
 * that somebody kept it compressed.
 */
async function loadSequences(args: Args): Promise<Map<string, SequenceStore>> {
  const held = new Map<string, SequenceStore>()
  for (const path of all(args, 'sequence')) {
    const bytes = await decodeAnnotationBytes(new Uint8Array(await readFile(path)))
    if (!looksLikeFasta(bytes)) {
      throw new Error(
        `${basename(path)} is not a FASTA: a reference begins with a > line naming its first ` +
          'sequence, and this one does not.',
      )
    }
    held.set(path, parseFasta(bytes))
  }
  return held
}

/**
 * Tracks named on the command line, by both roads a name arrives.
 *
 * A task's own `--tracks` is the path of a file to open, so a direct run needs
 * no second flag: what the parameter names is what is loaded, which is the
 * arrangement `--sequence` and `motif` already have. `--track` is the other
 * road, for `replay`, where the parameter holds the app's entry id and the file
 * has to be named beside it. A workspace also records what each id *was* — the
 * tab's own track list, name and all — so an id is filed against the loaded
 * file of that name and the recorded parameters resolve without anybody
 * retyping them, which is the whole point of `replay`.
 *
 * Opened before any map, so an unreadable track is exit 2 with a sentence
 * rather than the same failure once per file — and so is a name that looks like
 * a path and is not one.
 */
async function loadTrackFiles(
  tasks: readonly { task: AnalysisTask; params: Params }[],
  args: Args,
  stored: readonly StoredEntry[] = [],
): Promise<Map<string, LoadedTrack>> {
  const paths: string[] = [...all(args, 'track')]
  const unresolved: string[] = []
  for (const { task, params } of tasks) {
    for (const spec of task.params) {
      if (spec.kind !== 'track') continue
      const chosen = params[spec.key]
      const named = Array.isArray(chosen)
        ? chosen.filter((item): item is string => typeof item === 'string')
        : typeof chosen === 'string' && chosen !== ''
          ? [chosen]
          : []
      for (const path of named) {
        if (existsSync(path)) paths.push(path)
        else unresolved.push(path)
      }
    }
  }
  const held = await loadTracks(paths)
  // The app's ids, filed against the files they named: `a1` was `signal.bw`
  // when the workspace was saved, and `--track signal.bw` is on the line.
  for (const entry of stored) {
    if (entry.kind !== 'track' || held.has(entry.id)) continue
    const name = basename(entry.source.url ?? entry.source.name)
    const match = [...held.values()].find((track) => track.name === name)
    if (match !== undefined) held.set(entry.id, match)
  }
  for (const name of unresolved) {
    if (trackFor(held, name) !== undefined) continue
    throw new Error(
      /[./\\]/.test(name)
        ? `--tracks names ${name}, which is not there.`
        : `${name} is a track the workspace recorded by the app's own id. Name the file ` +
            'with --track <file>.',
    )
  }
  return held
}

/**
 * What each loaded track is **called**, beside the labels the sets carry.
 *
 * A figure's axis reads `inputs.labels[entry]` and falls back to the entry
 * itself, which here is the path as typed — so a correlation matrix's axes
 * read as `/data/run3/signal.bw` until this says they are `signal.bw`, the
 * same base name a feature set is filed under.
 */
function withTrackLabels(inputs: TaskInputs, tracks: ReadonlyMap<string, LoadedTrack>): TaskInputs {
  if (tracks.size === 0) return inputs
  const labels: Record<string, string> = { ...inputs.labels }
  for (const [key, track] of tracks) labels[key] = track.name
  return { ...inputs, labels }
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
      --sequence <ref.fa>  a reference, for a task that reads residues (motif)
                           or phases by GC content (compartments). Gzipped or not
      --pairs <file>       a BEDPE, for an off-diagonal pileup. Note this is a
                           *feature* table and not a contact list — a .pairs
                           file to bin is a positional argument, and takes
                           --bin-size below
      --against <file>     another contact map, for a task that compares two
                           (hicrep). Repeat it for a third
      --value <column>     the score column to read, for a file that carries
                           more than the count (default: count)
      --circular <name>    a sequence to read as a circle (a plasmid); repeat
                           or separate with commas
      --cell <name>        a cell of an .scool to sum into the map; repeat or
                           separate with commas. Default: every cell
      --bin-size <bp>      required for a .pairs input, which states no
                           resolution of its own; ignored for every other format
      --rungs <n>          how many ladder resolutions to build from it
                           (1-2-5 series from the base). Default 1
      --quiet              no progress on stderr
      --<param> <value>    any parameter the task takes; see \`tasks\`. A task
                           that reads tracks (metaplot, trackcorr, frip) takes
                           them as --tracks <file.bw>, repeated or
                           comma-separated: a bigWig, a bedGraph, a wig, or a
                           FASTA read as GC content

  metacooler-run <task> --tracks <file.bw> --features <file.bed> [...]
      A task that reads tracks and no matrix (metaplot, trackcorr, frip, overlap,
      motif), run with no contact map at all — what a 1D browser session runs.
      The assembly is what the tracks and references declare.

  metacooler-run replay <workspace.metacooler.json> --over <file> [...]
      Re-run every analysis recorded in a saved workspace, with the parameters
      it recorded, over the files named by --over. The workspace is what the
      app's Save button produces: every open tab in one file.
      --tab <n>            which tab to replay, 1-based. Default: the one that
                           was in front when the workspace was saved.
      --track <file.bw>    the file behind a track the workspace recorded by
                           the app's own id. Repeat it per track
      --against <file>     the other maps a recorded hicrep compared against

Remote files are not supported: the reader uses synchronous range requests,
which exist in a worker and not in Node. Fetch it first.
`

function listTasks(): void {
  for (const task of TASKS) {
    process.stdout.write(`${task.id}\n    ${task.title}\n`)
    if (task.needsPeers === true) {
      // The one flag a task takes that is not a parameter of its own: the deck
      // it compares against, which a shell spells as files.
      process.stdout.write('      --against <file>  The other maps to compare with; repeat per map\n')
    }
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
  // Parameters and inputs are resolved *before* any file is opened, and a
  // failure in either is exit 2 with a sentence rather than a stack: they are
  // faults in the command, and a command that is wrong should say so before it
  // spends an hour being wrong two hundred times.
  let params: Params
  let inputs: TaskInputs
  let sequences: Map<string, SequenceStore>
  let tracks: Map<string, LoadedTrack>
  try {
    params = paramsFor(task, args)
    inputs = bindInputs(task, params, await loadInputs(args))
    sequences = await loadSequences(args)
    tracks = await loadTrackFiles([{ task, params }], args)
    inputs = withTrackLabels(inputs, tracks)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const peers = all(args, 'against')
  if (task.needsPeers === true && peers.length === 0) {
    // The deck, which a shell has not got: the task's whole question is about
    // two files, and a run with one would note "no second map is open" after
    // the mount. Said here instead, before anything is opened.
    process.stderr.write(
      `${task.id} compares this map with another. Name the other with --against <file>.\n`,
    )
    return 2
  }
  const directory = one(args, 'out') ?? one(args, 'o') ?? '.'
  const quiet = flag(args, 'quiet')

  if (args.positional.length === 0) {
    // No map, which is the 1D browser's own case (§5.8) and only makes sense
    // for a task that reads none: a track task over whatever the loaded files
    // declare as the assembly. Everything else needs a file to open.
    if (task.venue !== 'annotations' || (tracks.size === 0 && sequences.size === 0)) {
      process.stderr.write(`${task.id} needs at least one file.\n`)
      return 2
    }
    try {
      const result = await runTracksOnly({
        task,
        params,
        inputs,
        sequences,
        tracks,
        peers,
        ...framingFlags(args),
        quiet,
      })
      for (const note of result.notes) process.stderr.write(`  note: ${note}\n`)
      await writeOutputs(
        result,
        stemOf(result.provenance.framing.uri),
        directory,
        result.contigs,
        quiet,
      )
      return 0
    } catch (error) {
      process.stderr.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

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
        sequences,
        tracks,
        peers,
        ...framingFlags(args),
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
  const sequences = await loadSequences(args)
  const tracks = await loadTrackFiles(
    recorded.flatMap((entry) => {
      const task = taskById(entry.task)
      return task === undefined ? [] : [{ task, params: entry.params }]
    }),
    args,
    config.tracks,
  )
  const loaded = withTrackLabels(await loadInputs(args), tracks)
  const peers = all(args, 'against')

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
      if (task.needsPeers === true && peers.length === 0) {
        // Beside the skip above and for the same reason: the count printed a
        // moment ago said how many tasks would run, and a tab that recorded a
        // reproducibility run is owed the reason one of them did not. Skipped
        // rather than attempted, so it costs no mount and does not turn a
        // replay's exit code into a failure over a flag that was not given.
        process.stderr.write(
          `  skipped ${entry.task}: it compares this map with another; name the other with ` +
            '--against <file>\n',
        )
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
          sequences,
          tracks,
          peers,
          ...framingFlags(args),
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
  // The `::` half is the *group inside the container*, so a file addressed as
  // `sample.mcool::/resolutions/1000` is still `sample` — it was `1000`, which
  // is `basename` of a group path and named every output after a number. The
  // group's last segment is kept as a suffix so two resolutions of one file
  // written to one `--out` are two sets of results rather than one overwritten
  // twice.
  const { path: file, group } = parseUri(path)
  const name = basename(file)
  const dot = name.indexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : (name || 'output')
  if (group === '/') return stem
  const last = group.split('/').filter((part) => part !== '').pop()
  return last === undefined ? stem : `${stem}_${last}`
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

