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
 * - **A named `.pairs`.** `pairsqc --pairs` (and the retired `expected
 *   --stranded --pairsUri`) reads a local path through `openFile`, and a
 *   `.pairs` given as the map carries what its import counted into the run —
 *   the four orientation curves and `pairtools stats` — as an import in the
 *   app does, and its own file for a task that reads the records again.
 *
 * A composite (`magnetwork` requires `magqc`) runs its requirements first, at
 * their defaults — or as the task's own flags answered them for it, Pairs QC's
 * reference and enzyme being the restriction step's — exactly as
 * `AnalysisRunner.plan` does.
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
 * ## The two things it does differently, and why
 *
 * **A remote file is fetched first, whole.** `RemoteRangeSource` reads through
 * synchronous `XMLHttpRequest`, which exists in a worker and not in Node, so an
 * address cannot be read by range from here. It is downloaded to a temporary
 * directory instead and read where it lies (`cli/remote.ts`) — which is what the
 * README always said happened, and for a while did not: the address went to
 * `stat` as a path.
 *
 * **No dependencies beyond the app's own.** Argument parsing, colouring and
 * table formatting are here rather than depended on, which is the same rule
 * `package.json` already applies to the bundle. The parser is typed by the
 * task descriptors (`parseArgs`), which is the one thing no general-purpose
 * parser could have done for it: whether `--stranded` takes the word after it
 * is a fact about the task.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainThread } from 'node:worker_threads'

import { MetaCooler } from '../metacooler/MetaCooler'
import { LocalFileSource } from '../sources/LocalFileSource'
import { inflationCap } from '../sources/untrusted'
import { yieldToEventLoop } from '../async'
import { chosenEntries } from '../analysis/runner'
import { RUNNERS } from '../analysis/run/index'
import { TRACK_RUNNERS } from '../analysis/run/tracks'
import { TASKS, taskById } from '../analysis/registry'
import { abortError, runnerParams } from '../analysis/job'
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
import { gridAt } from '../analysis/context'
import {
  CIRCULAR_SCORE,
  JUNCTION_BINS,
  MIN_JUNCTION_SEQUENCE_BINS,
  junctionCandidates,
  junctionQuorum,
  measureJunctions,
  placeCandidate,
} from '../analysis/circularity'
import { profileToBedGraph, type BedGraphContig } from '../analysis/write/bedgraph'
import { writeBigWig } from '../analysis/write/bigwig'
import {
  WHOLE_FILE_INFLATION,
  decodeAnnotationBytes,
  decodeAnnotationText,
  parseBed,
  parseBedpe,
  parseGtf,
  sniffFormat,
} from '../annotations/parse'
import { parseBarChart, sniffBarChart } from '../annotations/barchart'
import { parseCytoBand, sniffCytoBand } from '../annotations/cytoband'
import { parseGenePred, sniffGenePred } from '../annotations/genepred'
import { parseInteract, sniffInteract } from '../annotations/interact'
import { parseJunctions, sniffJunctions } from '../annotations/junctions'
import { parseLongRange, sniffLongRange } from '../annotations/longrange'
import { parseVcf, sniffVcf } from '../annotations/vcf'
import { formatIntervals } from '../annotations/export'
import { cleanLabel } from '../annotations/names'
import { parseBed3d, parseG3d, sniffBed3d, sniffG3d, writeBed3d } from '../annotations/g3d'
import { parsePdb, pdbRefusal, sniffPdb, writePdb } from '../annotations/pdb'
import type { FeatureSet, PairSet, StoredEntry } from '../annotations/types'
import { hicProBinsNames, isHicProMatrix } from '../annotations/sidecar'
import { openReference, type Reference } from './reference'
import { Downloads, SIDE_CACHE_BYTES, addressDirectories, displayOf, fileNameOf, isAddress } from './remote'
import { DEFAULT_THREADS, serveIfHelper, useThreads } from './threads'
import { quote, referenceKeyOf } from '../analysis/cliCommand'
import { regionLabel, typedLocusToRegion } from '../genome/assembly'
import { parseBins } from '../hicpro/parse'
import { DEFAULT_COUNT_COLUMN } from '../metacooler/matrix'
import { BOOST_ALPHA, BOOST_MAX_BINS, boostSteps } from '../metacooler/boost'
import { cisSquare } from '../metacooler/resample'
import { contactsText, depthPhrase, parseContacts, type DrawnDepth } from '../contacts'
import { hicProMap } from '../worker/open'
import { isRefusal, refusalMessage } from '../state/SessionConfig'
import { parseWorkspaceFile } from '../state/workspace'
import {
  defaultParams,
  paramDerived,
  type AnalysisFraming,
  type AnalysisTask,
  type ParamSpec,
  type ParamValue,
  type Params,
  type TaskOutput,
  type TaskResult,
  upstreamParamsOf,
} from '../analysis/types'
import type { PeerMap, TaskInputs } from '../analysis/worker/protocol'
import type { OrientationSummary, SourceSpec } from '../worker/protocol'
import { importPairs, probePairs } from '../pairs/import'
import { binPairs } from '../pairs/bin'
import { isPairsFile, readPairsHeader } from '../pairs/format'
import { writePairtoolsStats, type PairStats } from '../pairs/stats'
import { ViewerError } from '../errors'
import { parseUri } from '../uri'
import type { ByteSource } from '../types'
import { COMMIT, VERSION } from '../version'

/**
 * Which build wrote a file, after the `# chromosomix` every export opens with:
 * the version and `cli`, as the app's own exports give its version and commit.
 * The command shares the app's name, so naming it here as well would print it
 * twice.
 */
const APP = `${VERSION} cli`

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface Args {
  command: string
  positional: string[]
  flags: Map<string, string[]>
}

/**
 * A fault in the command line itself — a flag nothing takes, a value that is
 * not one, a switch handed a word.
 *
 * Exit 2 with the sentence, before any file is opened, against 1 for a file
 * that failed: a command that is wrong should say so before it spends an hour
 * being wrong two hundred times.
 */
class UsageError extends Error {}

/** One flag a command takes, as the parser needs it. */
interface FlagSpec {
  /** A switch takes nothing after it; a value flag takes the word after it. */
  arity: 'switch' | 'value'
  /** Where it is filed: `--no-stranded` files `false` under `stranded`. */
  key: string
  /** `--no-x`, the switch that turns `x` off. */
  negates: boolean
}

/**
 * The words a switch's value may be written as, and what each means.
 *
 * Only after `=`: `--stranded=false`. The same words written *after* a switch,
 * as a word of their own, are refused (`parseArgs`), since that was how a
 * switch was turned off when switches took the word after them.
 */
const SWITCH_WORDS: ReadonlyMap<string, boolean> = new Map([
  ['true', true],
  ['false', false],
  ['yes', true],
  ['no', false],
  ['on', true],
  ['off', false],
  ['1', true],
  ['0', false],
])

/** Whether a parameter is on or off — the rule `coerce` reads it by. */
function isSwitch(param: ParamSpec): boolean {
  return param.kind === 'toggle' || typeof (param as { default?: unknown }).default === 'boolean'
}

/**
 * Every flag `command` takes, and what each takes after it.
 *
 * The CLI's own first, and then the task's, from its descriptor — which is what
 * makes the parse typed: a toggle is a switch, `--no-` before its key turns it
 * off, and anything else takes a value. The task's are entered last, so a name
 * both use — coverage's `--balance`, apa's `--window` — has the task's meaning,
 * which is `paramsFor`'s rule as well. `--no-balance` stays the CLI's: it reads
 * the raw counts, framing and parameter alike, and is never the negation of
 * coverage's own `--balance`.
 */
function flagsFor(command: string): Map<string, FlagSpec> {
  const table = new Map<string, FlagSpec>()
  for (const key of RESERVED) {
    table.set(key, { arity: SWITCHES.has(key) ? 'switch' : 'value', key, negates: false })
  }
  // A switch wherever it is written, so that `main` refuses it by name — it is
  // the default now — rather than the file after it being taken as its value.
  table.set('balance', { arity: 'switch', key: 'balance', negates: false })
  if (command === 'replay') table.set('tab', { arity: 'value', key: 'tab', negates: false })
  // `boost` is no task either, so its own two are named here, as `replay`'s `--tab` is.
  if (command === 'boost') {
    for (const key of ['sequences', 'alpha']) table.set(key, { arity: 'value', key, negates: false })
  }
  for (const param of taskById(command)?.params ?? []) {
    const on = isSwitch(param)
    table.set(param.key, { arity: on ? 'switch' : 'value', key: param.key, negates: false })
    const off = `no-${param.key}`
    if (on && !RESERVED.has(off)) table.set(off, { arity: 'switch', key: param.key, negates: true })
  }
  return table
}

/** The sentence for a flag `command` does not take. */
function unknownFlag(command: string, name: string): string {
  const task = taskById(command)
  if (task !== undefined) {
    return (
      `${task.id} has no parameter --${name}. Its parameters are: ` +
      `${task.params.map((entry) => `--${entry.key}`).join(', ') || '(none)'}.`
    )
  }
  return `${command} has no flag --${name}. \`chromosomix help\` lists the ones it takes.`
}

/**
 * The command: the first word that is neither a flag nor the value of one.
 *
 * Only the CLI's own flags may come before it, because only theirs are known
 * before the command is — what a task's `--x` takes is a fact about the task.
 * A task's flag ahead of its task is refused rather than guessed at, unless the
 * line holds no command at all (`chromosomix --verbose`), which is the usage.
 */
function commandOf(argv: readonly string[]): string {
  const own = flagsFor('')
  for (let at = 0; at < argv.length; at++) {
    const token = argv[at]
    if (!token.startsWith('--')) return token
    const body = token.slice(2)
    if (body.includes('=')) continue
    const spec = own.get(body)
    if (spec === undefined) {
      if (argv.slice(at + 1).every((rest) => rest.startsWith('--'))) return ''
      throw new UsageError(
        `--${body} is not one of the command line's own flags, and a task's flags come after the ` +
          `task: chromosomix <task> <file> --${body} …`,
      )
    }
    if (spec.arity === 'value') at += 1
  }
  return ''
}

/**
 * `--key value`, `--key=value`, `--switch`, `--no-switch`, and every other word
 * positional — typed by what `command` takes.
 *
 * It was untyped: a flag took the next word as its value unless that word began
 * with `--`. So `coverage a.cool --no-balance b.hic --out d` read `b.hic` as the
 * value of `--no-balance`, ran over `a.cool` alone and exited 0;
 * `coverage --quiet a.cool` read the file as `--quiet`'s value and refused
 * itself for having none; and `--out --quiet` wrote into a directory called
 * `true`. Now a switch never takes the word after it, a flag that takes a value
 * is refused without one, and a flag nothing takes is refused by name — for
 * `replay` and `circular` as for a task, since a typo in a batch that runs for
 * an hour must not quietly run the default.
 *
 * A switch's old value written as a word, `--stranded false`, is refused rather
 * than read as a file called `false`: the script that wrote it meant something
 * else by it, and is told what to write instead.
 *
 * Repeated keys accumulate, because `--features a.bed --features b.bed` is a
 * question a reader will ask and silently keeping the last one is the wrong
 * answer to it.
 */
function parseArgs(argv: readonly string[], command: string): Args {
  const table = flagsFor(command)
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
    const name = eq >= 0 ? body.slice(0, eq) : body
    const spec = table.get(name)
    if (spec === undefined) throw new UsageError(unknownFlag(command, name))
    if (spec.arity === 'value') {
      if (eq >= 0) {
        push(spec.key, body.slice(eq + 1))
        continue
      }
      const next = argv[at + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${name} needs a value after it: --${name} <value>.`)
      }
      push(spec.key, next)
      at += 1
      continue
    }
    if (eq >= 0) {
      if (spec.negates) {
        throw new UsageError(`--${name} takes no value: it is --${spec.key}=false already.`)
      }
      push(spec.key, String(switchValue(name, body.slice(eq + 1))))
      continue
    }
    const next = argv[at + 1]
    const meant = next === undefined ? undefined : SWITCH_WORDS.get(next.toLowerCase())
    if (meant !== undefined) {
      throw new UsageError(
        `--${name} is a switch and takes nothing after it, so “${next}” would be read as a file. ` +
          `Write ${switchAdvice(table, name, spec, meant)} — or ./${next}, if it is a file.`,
      )
    }
    push(spec.key, spec.negates ? 'false' : 'true')
  }
  // The command is the first positional by construction: before it, only the
  // CLI's own flags can stand, and they take here what `commandOf` took.
  return { command: positional[0] ?? '', positional: positional.slice(1), flags }
}

/**
 * A line as `main` reads it — its command, its files and its flags — or the
 * refusal `main` would print, thrown. Exported so that the lines the console
 * writes (`analysis/cliCommand.ts`) can be held to the parser that has to take
 * them, which is the one place the two meet.
 */
export function parseCommandLine(argv: readonly string[]): Args {
  return parseArgs(argv, commandOf(argv))
}

/**
 * What to write for `--name <word>`, where the word meant `meant`: the switch
 * alone to say yes, and its `=false` — or its `--no-` — to say no.
 */
function switchAdvice(
  table: ReadonlyMap<string, FlagSpec>,
  name: string,
  spec: FlagSpec,
  meant: boolean,
): string {
  // `--no-stranded false` is a double negative, and the switch it negates is
  // the plain way to say what it means.
  if (spec.negates) return meant ? `--${name} alone` : `--${spec.key}`
  if (meant) return `--${name} alone`
  return table.get(`no-${spec.key}`)?.negates === true
    ? `--${name}=false or --no-${spec.key}`
    : `--${name}=false`
}

/** An explicit switch value, `--stranded=off`, as the boolean it means. */
function switchValue(name: string, text: string): boolean {
  const value = SWITCH_WORDS.get(text.trim().toLowerCase())
  if (value === undefined) {
    throw new UsageError(
      `--${name}=${text}: a switch is true or false, or yes or no, on or off, 1 or 0.`,
    )
  }
  return value
}

const one = (args: Args, key: string): string | undefined => args.flags.get(key)?.[0]
const all = (args: Args, key: string): string[] => args.flags.get(key) ?? []

/**
 * `--bin-size` and `--rungs`, or `undefined` when neither was given.
 *
 * Only consulted for a `.pairs`, and harmless everywhere else: a cooler states
 * its own resolutions, so a bin size named on the command line for one would be
 * a second answer to a question the file already answered.
 *
 * Read once, before any file is opened, and refused when it is not a whole
 * number: `--rungs abc` built one rung and said nothing, and `--bin-size 0` was
 * taken for no bin size at all. `--binsize` is the task's where the task claims
 * the name — track correlation's window — as `--window` is apa's.
 */
function pairsBinningOf(args: Args, task?: AnalysisTask): PairsBinning | undefined {
  const claimed = task?.params.some((param) => param.key === 'binsize') === true
  const named = one(args, 'bin-size') ?? (claimed ? undefined : one(args, 'binsize'))
  if (named === undefined) return undefined
  const base = numberValue('bin-size', named)
  if (!Number.isInteger(base) || base < 1) {
    throw new UsageError(`--bin-size is a whole number of base pairs, 1 or more; got “${named}”.`)
  }
  const asked = one(args, 'rungs')
  const rungs = asked === undefined ? 1 : numberValue('rungs', asked)
  if (!Number.isInteger(rungs) || rungs < 1) {
    throw new UsageError(`--rungs is how many resolutions to build, 1 or more; got “${asked}”.`)
  }
  return { base, rungs }
}
/**
 * `--value`, `--circular` and `--cell`: the framing a session sets from the
 * picture, spelled as flags (see `RESERVED`).
 */
function framingFlags(
  args: Args,
  task?: AnalysisTask,
): Pick<RunOptions, 'value' | 'circular' | 'cells' | 'origins' | 'contacts' | 'coarsen'> {
  const value = one(args, 'value')
  const contacts = contactsOf(args, task)
  const coarsen = coarsenOf(args)
  return {
    ...(value === undefined || value === '' ? {} : { value }),
    ...(contacts === undefined ? {} : { contacts }),
    ...(coarsen === undefined ? {} : { coarsen }),
    circular: all(args, 'circular').flatMap((item) => item.split(',')).filter((item) => item !== ''),
    cells: all(args, 'cell').flatMap((item) => item.split(',')).filter((item) => item !== ''),
    origins: originsOf(all(args, 'origin')),
  }
}

/**
 * `--coarsen BP`: the resolution to read the map at (§3.4), a whole number of
 * the file's bins summed — what the app writes for a run on a resolution the
 * reader added. Digits may be grouped, as the app prints them.
 */
function coarsenOf(args: Args): number | undefined {
  const text = one(args, 'coarsen')
  if (text === undefined) return undefined
  const binsize = numberValue('coarsen', text.replace(/[,_]/g, ''))
  if (!Number.isInteger(binsize) || binsize < 1) {
    throw new UsageError(`--coarsen is a bin size in whole base pairs; got “${text}”.`)
  }
  return binsize
}

/**
 * A map read at `binsize` (§3.4): its own bins summed, a whole number at a
 * time, as the app reads a resolution the reader added — or the map itself,
 * where its bins are that size already.
 */
function atResolution(mc: MetaCooler, binsize: number, path: string): MetaCooler {
  if (binsize === mc.binsize) return mc
  const factor = binsize / mc.binsize
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(
      `--coarsen ${binsize}: ${fileNameOf(path)} is at ${mc.binsize.toLocaleString('en-US')} bp, and ` +
        `${binsize.toLocaleString('en-US')} bp is not a whole number of its bins: name a bin size ` +
        'that is, or open the file at a resolution that divides this one.',
    )
  }
  const seen = MetaCooler.coarsened(mc, factor)
  if (seen.refusal !== null) throw new Error(`--coarsen ${binsize}: ${seen.refusal}`)
  return seen.map
}

/**
 * `--contacts N`: the total to draw the map to (§6.5), typed as the breadcrumb's
 * box takes it — `10M`, `23,000,000`, `2.5e7`.
 */
function contactsOf(args: Args, task?: AnalysisTask): number | undefined {
  // Only the words the task does not claim: Compartments' `--contacts cis` is
  // its own choice, and the total beside it on the same line is this (`shareOf`).
  const text = shareOf(task, 'contacts', all(args, 'contacts')).own[0]
  if (text === undefined) return undefined
  const parsed = parseContacts(text)
  if (parsed === null) return undefined
  if (typeof parsed !== 'number') {
    const param = task?.params.find((entry) => entry.key === 'contacts')
    if (param?.kind === 'choice') {
      const choices = param.options.map((option) => option.value).join(', ')
      throw new UsageError(
        `--contacts ${text} is neither a choice of ${task?.id} (${choices}) nor a number of ` +
          'contacts to draw the map to: type one like 10M or 23,000,000.',
      )
    }
    throw new UsageError(`--contacts: ${parsed.refused}`)
  }
  return parsed
}

/**
 * `--origin NAME:POS`, repeated or comma-separated: where each sequence's
 * replication origin is (§8.15), in the **display** form — 1-based, the number
 * the Origin and terminus table prints — and kept 0-based in the framing, like
 * every coordinate a worker is handed (§26.1). Digit grouping is allowed, since
 * the number is copied from a table that groups it.
 */
function originsOf(items: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  // A comma separates two origins only where a name and its colon follow it:
  // `LR657304.1:6,374,501` — the form the framing line prints — is one origin
  // with its digits grouped, not three.
  for (const item of items.flatMap((entry) => entry.split(/,(?=[^,]*:)/))) {
    const at = item.lastIndexOf(':')
    if (at <= 0) {
      if (item.trim() !== '') throw new Error(`--origin ${item} is not NAME:POSITION.`)
      continue
    }
    const name = item.slice(0, at)
    const position = Number(item.slice(at + 1).replace(/[,_]/g, ''))
    if (!Number.isFinite(position) || position < 1) {
      throw new Error(`--origin ${item}: the position is 1-based and at least 1.`)
    }
    out[name] = Math.floor(position) - 1
  }
  return out
}

/** `LR657304.1:6,374,501` — the origins as a reader would type them back. */
function originLabel(origins: Readonly<Record<string, number>>): string {
  return Object.entries(origins)
    .map(([name, at]) => `${name}:${(at + 1).toLocaleString('en-US')}`)
    .join(', ')
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
 * for an hour must not silently use the default. And so is a value the form
 * could not have held ({@link refusalOf}), for the same reason.
 */
/**
 * The words of a flag the command line and the task both use, shared out by what
 * each can mean (§23.1).
 *
 * The rule elsewhere is one name, one meaning, decided by whether the task
 * claims it: apa's `--window` is its half-width and never the locus, coverage's
 * `--balance` its own switch. `--contacts` is the exception that rule cannot
 * serve. It is the total a map is drawn to (§6.5) on every task, and it is also
 * Compartments' own choice of which contacts to correlate — and the console
 * writes both on one line, `--contacts cis --contacts 10000000`. Given wholly to
 * the task, the total of a drawn map was lost from every compartments line;
 * given wholly to the command line, `cis` was read as a total and refused, which
 * is what every compartments line the console had ever written did.
 *
 * The two meanings never meet: a choice is one of a handful of words and a total
 * is a number. So where the task's parameter of that name is a choice, its
 * options are the task's and every other word is the command line's; where it is
 * anything else, the task has the name outright, as it always had.
 */
function shareOf(
  task: AnalysisTask | undefined,
  key: string,
  values: readonly string[],
): { task: string[]; own: string[] } {
  const param = task?.params.find((entry) => entry.key === key)
  if (param === undefined) return { task: [], own: [...values] }
  if (param.kind !== 'choice') return { task: [...values], own: [] }
  const options = new Set(param.options.map((option) => option.value))
  return {
    task: values.filter((value) => options.has(value)),
    own: values.filter((value) => !options.has(value)),
  }
}

function paramsFor(task: AnalysisTask, args: Args): Params {
  // Built as a mutable record and returned as `Params`, which is readonly: the
  // type is a promise to the *runners* that nothing edits their parameters mid
  // run, not a claim that nobody may assemble one.
  const params: Record<string, Params[string]> = {}
  const known = new Map(task.params.map((param) => [param.key, param]))
  for (const param of task.params) {
    // A number whose default is the context's (`NumberParam.seed`) is left
    // unanswered, and the runner decides it from the framing — the map's own
    // resolution where a map was named — as the form would have.
    if (param.kind === 'number' && param.seed !== undefined) continue
    // Nor a parameter the form answers from the file (`paramDerived`) — *use
    // balancing weights* — which `runOne` answers from the file it opens.
    if (paramDerived(param)) continue
    if ('default' in param && param.default !== undefined) {
      params[param.key] = param.default as Params[string]
    }
  }
  for (const [key, values] of args.flags) {
    const param = known.get(key)
    // The task's own parameters win over the CLI's flags where the names
    // collide: coverage's own `--balance`, which is off by default, is that
    // task's and not the framing's. Skipping a reserved name first would have
    // set the framing and left the task at its default, which is precisely the
    // silent-default failure the unknown-key error below exists to prevent.
    if (param === undefined && RESERVED.has(key)) continue
    // `parseArgs` has refused it already, against the same table; said again
    // here because this is the function whose silence would cost the hour.
    if (param === undefined) throw new UsageError(unknownFlag(task.id, key))
    // Of a flag the command line shares, only the task's own words (`shareOf`).
    const share = RESERVED.has(key) ? shareOf(task, key, values).task : values
    if (share.length === 0) continue
    params[key] = coerce(param, share)
  }
  // `--no-balance` answers the parameter the file otherwise would: off, as the
  // framing then is.
  if (flag(args, 'no-balance')) {
    for (const param of task.params) if (paramDerived(param)) params[param.key] = false
  }
  for (const param of task.params) {
    const refused = refusalOf(param, params[param.key])
    if (refused !== null) throw new UsageError(refused)
  }
  return params
}

/**
 * Why `value` cannot be handed to a runner as `spec`, or `null` when it can.
 *
 * The runners read a choice with a fallback — `strParam(params, 'quantity',
 * 'density') === 'expected'` — so that a stored session from a later build
 * cannot change what the numbers on screen mean. The form never reaches it: it
 * moves a held value onto an option it offers before any run
 * (`resolveChoiceDefaults`). A shell had no such step, so `expected --quantity
 * expectd` ran the density and wrote `# param quantity: expectd` above it — a
 * provenance naming a computation nobody performed — and a replayed workspace
 * naming an option this build has not got did the same. So the shell asks what
 * the form would have offered, and refuses the rest with the values there are.
 * A switch and a number the same way, since `boolParam` and `numParam` fall back
 * too, for anything that is not one.
 *
 * Every option the descriptor lists, not only those this file is offered:
 * which those are is a fact about a file that is not open yet, and the runner
 * refuses the rest by name — a per-genome P(s) of a cooler is a sentence, not a
 * fallback.
 */
function refusalOf(spec: ParamSpec, value: ParamValue | undefined): string | null {
  if (value === undefined) return null
  // The text `"false"` is not `false`, and a sentence saying so has to show
  // which of the two it was handed.
  const shown = typeof value === 'string' ? `the text “${value}”` : JSON.stringify(value)
  switch (spec.kind) {
    case 'choice': {
      const values = spec.options.map((option) => option.value)
      if (typeof value === 'string' && values.includes(value)) return null
      const named = typeof value === 'string' ? `“${value}”` : shown
      return `There is no --${spec.key} ${named}. It is ${eitherOf(values.map(quote))}.`
    }
    case 'toggle':
      return typeof value === 'boolean' ? null : `--${spec.key} is true or false, not ${shown}.`
    case 'number':
    case 'seed':
      // `null` is a number the context decides (`NumberParam.seed`), as a
      // workspace records one the reader never typed.
      return value === null || (typeof value === 'number' && Number.isFinite(value))
        ? null
        : `--${spec.key} is a number, not ${shown}.`
    default:
      return null
  }
}

/** `a`, `a or b`, `a, b or c`. */
function eitherOf(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`
}

/**
 * A number as a reader types one: digits, a point, an exponent.
 *
 * Not `Number` alone, which reads `''` as zero — so `--factor=` ran at a factor
 * of nought and recorded it — and `0x10` as sixteen.
 */
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i

function numberValue(key: string, text: string): number {
  const parsed = NUMBER.test(text.trim()) ? Number(text.trim()) : Number.NaN
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`--${key} needs a number; got ${JSON.stringify(text)}.`)
  }
  return parsed
}

/**
 * A task's parameters with the ones the file answers filled in.
 *
 * *Use balancing weights* is the one there is (`BALANCE_PARAM`). A form never
 * shows it and sets it from the file (`ParamForm`), and a shell now does the
 * same: on wherever the file carries weights, as the framing is — so a command
 * that says nothing about balancing reads what the app would have read. Only
 * where the command left it open: `--no-balance` has already answered it.
 */
function withDerived(task: AnalysisTask, params: Params, balance: boolean): Params {
  if (!task.params.some((spec) => paramDerived(spec) && params[spec.key] === undefined)) return params
  const out: Record<string, Params[string]> = { ...params }
  for (const spec of task.params) {
    if (paramDerived(spec) && out[spec.key] === undefined) out[spec.key] = balance
  }
  return out
}

/**
 * Whether `--balance` means something to this command.
 *
 * Balanced counts are the default wherever the file carries weights, so the
 * flag that used to ask for them asks for nothing — and a flag that asks for the
 * default reads as though the default were the other one, which is how a run
 * came out unbalanced three times over for want of it. It survives only as a
 * task's own parameter where one is declared and is *not* the file's to answer:
 * coverage's, which is off because raw coverage is the point of it.
 */
function takesBalance(command: string): boolean {
  return (
    taskById(command)?.params.some((spec) => spec.key === 'balance' && !paramDerived(spec)) ?? false
  )
}

/**
 * Flags that belong to the CLI rather than to a task.
 *
 * Consulted only for a name the task does *not* declare. `--no-balance` reads
 * the raw counts: it sets the framing, and the `balance` parameter of every task
 * whose form answers it from the file, because a reader typing it once means
 * both (`paramsFor`, `withDerived`).
 *
 * `--window` rather than `--region`: the reconstruction and the model
 * comparison both take a parameter called `region`, meaning *which sequences*,
 * and the framing's window is a different question. One name for two things is
 * how a batch script comes out subtly wrong.
 */
const RESERVED = new Set([
  'out',
  'o',
  'window',
  'no-balance',
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
  // Where each sequence's replication origin is (§8.15), which the arm-frame
  // expectation and the inter-arm alignment read their arms from.
  'origin',
  'cell',
  'over',
  // How many threads the tasks that share their work may use (`cli/threads.ts`).
  // A property of the machine, not of the run: the results are the same bits on
  // any number, so a line without it repeats the same run.
  'threads',
  'quiet',
  'help',
  'version',
  // How a `.pairs` positional is binned (§3.7). Reserved rather than declared
  // per task because it is a property of the *input*, not of the analysis: it
  // decides which grid the file is read on, and every task then runs on that
  // grid exactly as it would over a cooler.
  'bin-size',
  'binsize',
  'rungs',
  // The total the map is drawn to before any task reads it (§6.5): a subsample
  // below the file's own, an oversample through Boost-HiC above it. A property
  // of the input, like the binning, so every task reads the drawn map.
  'contacts',
  // The resolution it is read at, where that is the file's bins summed (§3.4):
  // a property of the input too, for the same reason.
  'coarsen',
])

/**
 * Of those, the ones that take no value: `--quiet`, and never `--quiet true`.
 *
 * What `parseArgs` is typed by, with each task's toggles. The rest take the
 * word after them, and refuse to be the last word on the line.
 */
const SWITCHES = new Set(['no-balance', 'quiet', 'help', 'version'])

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
  // A switch's value is `true` or `false` by the time it is here — `parseArgs`
  // files `--no-x` and `--x=off` that way — and anything else is refused, where
  // every word but `false` and `0` used to be read as on: `--x=no` was a yes.
  if (isSwitch(param)) return switchValue(param.key, value)
  if (kind === 'number' || typeof (param as { default?: unknown }).default === 'number') {
    return numberValue(param.key, value)
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
  /**
   * The command's addresses: how a map named by one is read — by range, or
   * from a copy fetched whole — and what a run names as it goes, an
   * `--against` or a `.pairs`. A map is opened *as* the address the reader
   * typed, so its framing, its provenance and every sentence about it name
   * that rather than a temporary file.
   */
  downloads: Downloads
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
  sequences: Map<string, Reference>
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
  /** Declared replication origins, 0-based base pairs by this file's names (§8.15). */
  origins: Readonly<Record<string, number>>
  /** The cells of an `.scool` to sum; empty is every cell (§3.8). */
  cells: readonly string[]
  quiet: boolean
  /** How to bin a `.pairs`, which states no resolution of its own (§3.7). */
  binning?: PairsBinning | undefined
  /** The total the map is drawn to before the task reads it (§6.5). */
  contacts?: number | undefined
  /** The bin size the map is read at, its own bins summed (§3.4). */
  coarsen?: number | undefined
}

/**
 * Draw an open map to `contacts` (§6.5), saying on stderr what the census counted
 * and which way it went; `null` when no total was asked for.
 */
async function drawnTo(
  mc: MetaCooler,
  contacts: number | undefined,
  quiet: boolean,
): Promise<DrawnDepth | null> {
  if (contacts === undefined) return null
  const plan = await mc.resample({ contacts })
  if (plan === null) return null
  const depth: DrawnDepth = { contacts: plan.contacts, total: plan.total, mode: plan.mode }
  if (!quiet) {
    process.stderr.write(
      depth.mode === 'none'
        ? `  ${contactsText(depth.total)} contacts, the file's own: read as stored\n`
        : `  ${depthPhrase(depth)}\n`,
    )
  }
  return depth
}

/** A map opened for a run, with the facts an import carries that a mount does not. */
interface Opened {
  mc: MetaCooler
  source: ByteSource
  /** The four orientation curves counted while binning a `.pairs`, or `null`. */
  orientation: OrientationSummary | null
  /** What `pairtools stats` counted in the same pass, or `null`. */
  stats?: PairStats | null
  /** Whether the map was binned from a `.pairs` here, rather than opened. */
  binned?: boolean
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
 *
 * `uri` is what the map is called and `path` where its bytes are — one file
 * for a path, the address itself for one read by range, and its downloaded
 * copy for one fetched whole. A `.pairs` file's `.px2` is looked for beside it.
 */
async function openForTask(
  uri: string,
  source: ByteSource,
  options: Pick<RunOptions, 'binning' | 'quiet' | 'downloads'>,
  path: string,
): Promise<Opened> {
  const named = parseUri(uri).path
  try {
    return { mc: await MetaCooler.open(uri, source), source, orientation: null }
  } catch (error) {
    if (!(error instanceof ViewerError) || error.code !== 'pairs-binning-needed') throw error
    const binning = options.binning
    if (binning === undefined) {
      throw new ViewerError(
        'pairs-binning-needed',
        `${fileNameOf(named)} is a .pairs file: a list of contacts with no resolution of its own. ` +
          'Say what to bin it at, e.g. `--bin-size 5000 --rungs 4`.',
        error.detail,
      )
    }
    const probe = await probePairs(source, () => openPairsIndex(path, options.downloads))
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
      // …and its `pairtools stats`, for Pairs QC, which the session hands it the
      // same way (`TaskInputs.pairsStats`).
      stats: pixels.stats ?? null,
      binned: true,
      mc: MetaCooler.fromPairs({
        uri: named,
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
 * The `.px2` beside a pairs file, on disk or at the address beside it, or `null`.
 *
 * Both spellings `pairix` writes, most specific first — the same rule
 * `annotations/sidecar.ts` states for a `.bai`, and for the same reason: a
 * reader must not have to know which convention produced the pair they have.
 */
async function openPairsIndex(path: string, downloads: Downloads): Promise<ByteSource | null> {
  if (isAddress(path)) {
    const name = fileNameOf(path)
    for (const candidate of [`${name}.px2`, `${name.replace(/\.b?gz$/i, '')}.px2`]) {
      const source = await downloads.sidecarRanged(path, candidate)
      if (source !== null) return source
    }
    return null
  }
  for (const candidate of [`${path}.px2`, `${path.replace(/\.b?gz$/i, '')}.px2`]) {
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
 *
 * An address is read **by range**, as the app reads it (§23.1): every road
 * below but HiC-Pro's opens a byte source, and a range source is one. Where its
 * host serves no range, and for a HiC-Pro matrix, which is read whole beside
 * its bin file, it is fetched to disk by `cli/remote.ts` under the address's own
 * file name, so every road that reads a name reads the one the reader typed.
 * `keep` holds that copy to the end of the command — an `--against` every run
 * reads — rather than letting it go once this run is done.
 */
async function openLocal(
  uri: string,
  options: Pick<RunOptions, 'binning' | 'quiet' | 'downloads'>,
  keep = false,
): Promise<Opened> {
  // **The `::` is addressed to the container, not to the filesystem.** An
  // `.mcool` is a collection of coolers and `detect.ts` refuses one at its root
  // with a sentence naming the resolutions and telling the reader to write
  // `file.mcool::/resolutions/25000` — advice this shell then could not take,
  // because the whole string went to `stat` and there is no such file. So the
  // path is split off for the filesystem and the *uri* is what the container is
  // opened with, which is where `parseUri` reads the group from.
  const named = parseUri(uri).path
  if (isAddress(named) && !isHicProMatrix(fileNameOf(named))) {
    const ranged = await options.downloads.ranged(named)
    if (ranged !== null) {
      try {
        return await openForTask(uri, ranged, options, named)
      } catch (error) {
        ranged.close()
        throw error
      }
    }
  }
  const path = (await options.downloads.local(named, keep)) ?? named
  const name = basename(path)
  if (!isHicProMatrix(name)) {
    // The HDF5 road, and the `.pairs` import that hangs off its one refusal.
    const source = await LocalFileSource.fromPath(path)
    return openForTask(uri, source, options, path)
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
  const binBytes = await decodeWhole(readFileSync(beside))
  const parsedBins = parseBins(binBytes, basename(beside))
  const matrixBytes = await decodeWhole(readFileSync(path))
  const opened = await hicProMap(
    named,
    { bytes: matrixBytes, name },
    parsedBins,
    basename(beside),
    binBytes.length,
  )
  return { ...opened, orientation: null }
}

/**
 * One half of a HiC-Pro pair, read whole and un-gzipped if it is gzipped.
 *
 * Capped in proportion to the file rather than at the text ceiling, as the
 * worker's own read of the pair is (`worker/sources.ts`): both halves are parsed
 * from their bytes, and a matrix may be past a gigabyte (§3.9).
 */
function decodeWhole(read: Buffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(read)
  return decodeAnnotationBytes(bytes, inflationCap(bytes.length, WHOLE_FILE_INFLATION))
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
  const { task, path } = options
  options.downloads.refuseScheme(path)
  const opened = await openLocal(uriOf(path), options)
  let mc = opened.mc
  try {
    // The ticked cells, as the analysis worker selects them before any task
    // runs: an `.scool` sums whichever cells are chosen, and a task over "the
    // map" is a task over that sum (§3.8).
    if (options.cells.length > 0) {
      if (mc.cells.length === 0) {
        throw new Error(`${fileNameOf(path)} has no cells to choose from; --cell is for an .scool.`)
      }
      mc.selectCells(options.cells)
    }
    // Drawn to the total asked for before anything reads it, as the analysis
    // worker draws its mount (§6.5); the seed is the app's, so the pixels are.
    const depth = await drawnTo(mc, options.contacts, options.quiet)
    // At the resolution asked for, the file's bins summed (§3.4) — last, as the
    // analysis worker sums its mount, so the cells and the total are summed.
    const fileBinsize = mc.binsize
    if (options.coarsen !== undefined) mc = atResolution(mc, options.coarsen, path)
    const coarsened = mc.binsize !== fileBinsize
    const value = options.value ?? DEFAULT_COUNT_COLUMN
    if (value !== DEFAULT_COUNT_COLUMN && !mc.scoreColumns.includes(value)) {
      throw new Error(
        `${fileNameOf(path)} has no score column ${JSON.stringify(value)}. It has: ` +
          `${mc.scoreColumns.join(', ') || DEFAULT_COUNT_COLUMN}.`,
      )
    }
    // An origin on a sequence the file has not got, or past its end, is a
    // typing mistake — refused by name rather than read as *no origin*.
    for (const [name, at] of Object.entries(options.origins)) {
      const id = mc.chromnames.indexOf(name)
      if (id < 0) {
        throw new Error(`--origin ${name}: ${fileNameOf(path)} has no sequence of that name.`)
      }
      const length = mc.coords.contigLengths[id]
      if (at >= length) {
        throw new Error(
          `--origin ${name}:${(at + 1).toLocaleString('en-US')} is past its end, at ` +
            `${length.toLocaleString('en-US')} bp.`,
        )
      }
    }
    // The window as a reader writes one — 1-based and inclusive, digits grouped
    // or not, `IV:1,000,001-1,400,000` — which is what the console writes and
    // what every locus box in the app reads (§26.1), and in cooler's grammar
    // from here on. It used to be read in that grammar as typed, so the digits
    // a reader copied off the app's own breadcrumb named a window starting one
    // base later at a shell than on the screen they came from.
    const region = options.window === undefined ? undefined : typedLocusToRegion(options.window)
    const extent =
      region === undefined
        ? ([0, mc.nBins] as [number, number])
        : mc.extent(region)
    const balance = options.balance ?? mc.hasWeights
    const params = withDerived(task, options.params, balance)
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
        `${region === undefined ? 'whole file' : regionLabel(region)} at ${mc.binsize} bp` +
        `${coarsened ? ` (${fileBinsize} bp bins summed)` : ''}` +
        `${balance ? ', balanced' : ''}, ${value}` +
        `${options.circular.length === 0 ? '' : `, circular ${options.circular.join(',')}`}` +
        `${Object.keys(options.origins).length === 0 ? '' : `, origin ${originLabel(options.origins)}`}` +
        `${options.cells.length === 0 ? '' : `, ${options.cells.length} cells`}` +
        `${depth === null || depth.mode === 'none' ? '' : `, ${depthPhrase(depth)}`}`,
      ...(options.circular.length === 0 ? {} : { circular: [...options.circular] }),
      ...(Object.keys(options.origins).length === 0 ? {} : { origins: { ...options.origins } }),
      ...(options.contacts === undefined ? {} : { contacts: options.contacts }),
      ...(coarsened ? { coarsen: mc.binsize } : {}),
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
      // The records themselves, where the map was binned from them here: what
      // their import counted, and the file again for a task that reads them
      // (Pairs QC's fragments) — named as `peersOf` names a map, a path as a
      // `file:` URL, and opened by `openSource` below.
      ...(opened.stats === undefined || opened.stats === null ? {} : { pairsStats: opened.stats }),
      ...(opened.binned === true ? { mapSource: specOf(path) } : {}),
      ...(options.peers.length === 0 ? {} : { peers: peersOf(options.peers) }),
      // This map by its base name too, as `peersOf` names the others, so the
      // matrix's axes and the tables name every file the same way.
      ...(options.peers.length === 0 ? {} : { mapLabel: fileNameOf(options.path) }),
    }

    /**
     * The job for one step of the chain, built as `analysis.worker.ts` builds
     * its own — with the capabilities a shell answers differently from a
     * worker: `peer`, `openFile` and `openBytes` read the filesystem, an address
     * once it is fetched, and `vectors` is computed here rather than asked of
     * another thread.
     */
    const jobFor = async (
      step: AnalysisTask,
      stepParams: Params,
      upstream: Record<string, TaskResult>,
    ): Promise<JobContext> => ({
      mc,
      // Every locus in cooler's grammar, as the analysis worker is handed it
      // (`runnerParams`); the provenance below keeps the one that was typed.
      params: runnerParams(step.params, stepParams),
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
      // pair beside the map opens by the same road the map did — and an address
      // by range, or from the copy of one whose host serves none.
      peer: async (map) => {
        const other = await openLocal(uriOf(map.uri), options, true)
        // Every map of a comparison at the one depth (§6.5).
        try {
          await drawnTo(other.mc, options.contacts, options.quiet)
        } catch (error) {
          other.mc.close()
          other.source.close()
          throw error
        }
        // …and at the one resolution where its bins sum to it (§3.4); where they
        // do not, as it is, and the task says the two are at different ones.
        let read = other.mc
        if (options.coarsen !== undefined) {
          try {
            read = atResolution(other.mc, options.coarsen, map.uri)
          } catch {
            read = other.mc
          }
        }
        return {
          mc: read,
          close: () => {
            read.close()
            other.source.close()
          },
        }
      },
      // A file this process can read and does not mount — a `.pairs` named for
      // its orientation curves.
      openFile: async (file) => {
        // Mounted, because a path-backed source reads through the mount and
        // refuses a range before one exists — and mounted rather than read
        // whole, since a contact list is the one input here that is routinely
        // larger than memory.
        const source = await LocalFileSource.fromPath(resolve(file))
        await source.mount()
        return source
      },
      // The same, named by an address — read by range, as the worker reads
      // it and as a map is read here, or from a copy where its host serves none.
      openBytes: async (url) => openAddress(url, options.downloads),
      // A file handed over as a `SourceSpec` — here only ever the map's own
      // `.pairs`, as `specOf` spelled it: a path as a `file:` URL, read where it
      // lies, or an address, read as `openBytes` reads one.
      openSource: async (spec) => {
        if (spec.kind !== 'remote') {
          throw new Error('a file handed over in a browser cannot be read from a shell')
        }
        if (spec.url.startsWith('file:')) {
          const source = await LocalFileSource.fromPath(fileURLToPath(spec.url))
          await source.mount()
          return source
        }
        return openAddress(spec.url, options.downloads)
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
        app: APP,
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
 * path spelled as a URL — or the address, for one — which `peer` above never
 * reads: it opens `uri`. The label is what the coefficient matrix's axes say,
 * so it is the file's name and not the whole path a batch script would have
 * expanded, nor an address's query.
 */
function peersOf(paths: readonly string[]): PeerMap[] {
  return paths.map((path) => {
    const file = parseUri(path).path
    return {
      label: fileNameOf(path),
      uri: path,
      source: { kind: 'remote', url: isAddress(file) ? file : pathToFileURL(resolve(file)).href },
    }
  })
}

/**
 * The name a file is opened under: an address as it was typed, and a path
 * made absolute, as the framing has always recorded one.
 */
function uriOf(path: string): string {
  return isAddress(path) ? path.trim() : resolve(path)
}

/**
 * A file named on the line as the `SourceSpec` a task is handed: an address as
 * it is, and a path as the `file:` URL `peersOf` writes for one — which the job's
 * own `openSource` reads back where it lies.
 */
function specOf(path: string): SourceSpec {
  const file = parseUri(path).path
  return { kind: 'remote', url: isAddress(file) ? file.trim() : pathToFileURL(resolve(file)).href }
}

/** An address opened for its bytes: by range, or from a copy where its host serves none. */
async function openAddress(url: string, downloads: Downloads): Promise<ByteSource> {
  const where = await downloads.where(url, true)
  const source = where.kind === 'range' ? where.source : await LocalFileSource.fromPath(where.path)
  await source.mount()
  return source
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
 *
 * **Under the runner's own keys**, which is what {@link chosenEntries} is
 * exported for, and both halves of that matter: a parameter that takes several
 * entries files each under `key:entryId`, and it is a *list* rather than a
 * string. Read as a single string, `apa --tracks signal.bw` chose nothing at
 * all, and the pileup came back with the note that one of one tracks could not
 * be read — about a file the command had just opened.
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
    for (const [key, named] of chosenEntries(spec, params)) {
      const track =
        spec.kind === 'track'
          ? trackFor(options.tracks, named)
          : gcTrackFor(options.sequences, named)
      if (track === undefined) continue
      vectors[key] = await vectorOver(track, {
        contigs: grid.contigs.map((contig) => ({
          name: contig.name,
          startBin: contig.startBin,
          length: contig.length,
        })),
        binsize: grid.binsize,
        nBins: grid.nBins,
      })
    }
  }
  return Object.keys(vectors).length === 0 ? {} : { vectors }
}

/** A loaded reference as the GC track the session would have sampled it as. */
function gcTrackFor(
  held: Map<string, Reference>,
  entry: string,
): LoadedTrack | undefined {
  const found = storeFor(held, entry)
  return found === undefined ? undefined : gcTrack(found[0], fileNameOf(found[0]), found[1])
}

/**
 * The task and everything it `requires`, required tasks first.
 *
 * `AnalysisRunner.plan`, without the cache: depth first, each requirement at
 * its own defaults — the reader configured the network and not the QC under
 * it, and inventing parameters for a form they never opened would be putting
 * numbers in their mouth — except what the task's own flags answered for the
 * step (`upstreamParams`: Pairs QC's `--sequence` and `--enzyme` are the
 * restriction step's), laid over them, and a step the task says to leave out,
 * which is not run at all. De-duplicated, so two steps wanting one upstream
 * result compute it once. A cycle is a catalogue mistake and is named rather
 * than run into.
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
      // What the task answered for the step, or that it is to be left out —
      // `upstreamParamsOf`, the function `AnalysisRunner.plan` asks too.
      const answered = upstreamParamsOf(node, id, nodeParams)
      if (answered === null) continue
      // Its own defaults under those answers, and balancing as the framing reads
      // the file — which a required step's form would have set from the file too.
      const requiredParams = withDerived(
        required,
        Object.fromEntries(
          Object.entries({ ...defaultParams(required.params), ...answered }).filter(
            ([key]) => !required.params.some((spec) => spec.key === key && paramDerived(spec)),
          ),
        ),
        framing.balance,
      )
      const started = Date.now()
      const outputs = await walk(required, requiredParams)
      upstream[id] = {
        outputs,
        provenance: {
          task: required.id,
          taskVersion: required.version ?? 0,
          params: requiredParams,
          framing,
          app: APP,
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
    label:
      `${fileNameOf(named)} · ${task.mapless === true ? 'sequences' : 'loaded tracks'}, no contact map` +
      `${options.circular.length === 0 ? '' : `, circular ${options.circular.join(',')}`}` +
      `${Object.keys(options.origins).length === 0 ? '' : `, origin ${originLabel(options.origins)}`}`,
    // A task on the sequence reads what the molecules are as surely as one on
    // the map (§8.15): an origin call on a circle read as a line splits an
    // origin at the first base between the two ends.
    ...(options.circular.length === 0 ? {} : { circular: [...options.circular] }),
    ...(Object.keys(options.origins).length === 0 ? {} : { origins: { ...options.origins } }),
  }
  const notes: string[] = []
  const started = Date.now()
  let lastPercent = -1
  const job: TrackJobContext = {
    params: runnerParams(task.params, params),
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
  // No map, so no grid of its own: the one profile that can come out of this —
  // base composition's, on bins it picked (§18.8) — is written over these
  // sequences cut at its bin size, and a BED against the right names.
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
      app: APP,
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
  held: Map<string, Reference>,
  entry: string,
): SequenceReader | undefined {
  const store = storeFor(held, entry)?.[1]
  if (store === undefined) return undefined
  // The worker's reader, step for step: `bases` by the §5.9 ladder, because a
  // FASTA writes `chrI` where a `.hic` beside it writes `I` and a search under
  // the map's spelling has to reach the reference's — and `read` beside it for
  // a reference opened by range, which the motif search walks a piece at a
  // time (`cli/reference.ts`).
  return {
    contigs: store.contigs,
    bases: (contig) => store.bases(contig),
    ...(store.read === undefined ? {} : { read: store.read.bind(store) }),
  }
}

/** The loaded reference an entry names, with the path it was filed under. */
function storeFor(
  held: Map<string, Reference>,
  entry: string,
): [string, Reference] | undefined {
  const direct = held.get(entry)
  if (direct !== undefined) return [entry, direct]
  return (
    [...held].find(([path]) => fileNameOf(path) === fileNameOf(entry)) ??
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
 *
 * `earlier` is every file this command has written so far, and none of them is
 * written over. The stems are made unique before the first run ({@link
 * stemsOf}), so this is the floor under that rather than the rule: a second run
 * replacing the first one's tables with exit 0 is a batch whose every result
 * looks fine and half of which is missing.
 */
async function writeOutputs(
  result: TaskResult,
  base: string,
  directory: string,
  contigs: readonly BedGraphContig[],
  quiet: boolean,
  earlier: Set<string>,
): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  const written: string[] = []
  const put = async (name: string, body: string | Uint8Array): Promise<void> => {
    const at = join(directory, name)
    // Without case, as a Mac's disk and Windows' compare names.
    const key = resolve(at).toLowerCase()
    if (earlier.has(key)) {
      throw new Error(`${at} was written earlier by this command, and is not written over.`)
    }
    await writeFile(at, body)
    earlier.add(key)
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
    //
    // **A model leaves as a bed3d** (§25.7), and the road a computed row shares
    // with called intervals is this one too. A reconstruction's rows carry three
    // coordinates each and BED6 has nowhere to put them: `reconstruct3d --out`
    // wrote `chrom start end region_1 0 .` per bin — the assembly back, and the
    // only thing the run computed gone — beside a TSV whose every row was blank.
    // The writer is the drawer's own, so the file a batch produces is the file
    // its button produces, and §25.2 reads it back.
    if (output.kind === 'intervals') {
      const payload = output.payload
      const model = output.entryKind === 'structure' && payload.kind === 'features'
      const context = {
        label: output.label,
        file: result.provenance.framing.label,
        created: result.provenance.createdAt,
      }
      await put(
        `${stem}.${model ? 'bed3d' : payload.kind === 'pairs' ? 'bedpe' : 'bed'}`,
        model && payload.kind === 'features'
          ? writeBed3d(payload.data, context)
          : formatIntervals(payload, context),
      )
      // And as a PDB beside it, for PyMOL, as the drawer and the Structures card
      // offer one (§25.7) — except where the format's columns cannot number the
      // model, which is said rather than skipped: a batch that silently wrote
      // one file fewer is a folder somebody finds short a week later.
      if (model && payload.kind === 'features') {
        const refusal = pdbRefusal(payload.data)
        if (refusal === null) await put(`${stem}.pdb`, writePdb(payload.data, context))
        else if (!quiet) process.stderr.write(`  no PDB for ${stem}: ${refusal}\n`)
      }
    }
    if (output.kind === 'profile') {
      // Over the grid the values are on: the map's, for every task that reads at
      // its resolution, and the same sequences cut at the output's own bin size
      // for the one that picks its own (§18.8) — which is also the only grid
      // there is with no map named.
      const grid =
        output.binsize === result.provenance.framing.binsize ? contigs : gridAt(contigs, output.binsize)
      await put(`${stem}.bedGraph`, profileToBedGraph(output, grid, result.provenance))
      // The same three arguments the drawer's own bigWig button passes, so the
      // two writers cannot drift: one implementation, one byte layout, one set
      // of round-trip tests behind it.
      //
      // Deflated by Node's own zlib, synchronously: the bytes `CompressionStream`
      // makes, without a stream a block (`BigWigWriting`).
      const blob = await writeBigWig(
        {
          contigs: grid.map((contig) => ({ name: contig.name, length: contig.length })),
          values: output.values,
          firstBin: output.extent[0],
          binsize: output.binsize,
        },
        { deflate: (bytes) => deflateSync(bytes) },
      )
      await put(`${stem}.bw`, new Uint8Array(await blob.arrayBuffer()))
    }
  }
  return written
}

// ---------------------------------------------------------------------------
// Inputs a task may need
// ---------------------------------------------------------------------------

/**
 * One file named with `--features`, read as the app's loader reads it (§8).
 *
 * The worker's text road, in its order and through its parsers, as far as that
 * road ends in a feature set or a pair set — so a file the browser draws as a
 * gene model, a loop set or a karyotype reaches a task run from a shell as the
 * same thing. Every format here is asked before `sniffFormat` for the worker's
 * reason (§8.17): that function's last line is `return 'bed'`, so a format it
 * has not been taught is never refused, only read as a BED, and here that was
 * quiet. A genePred, a GTF and a VCF came out as nothing, each having a word
 * where a BED has its start or its end; an interact as one box spanning both
 * its anchors, or as a bedpe of the wrong columns; and a longrange as a BED4
 * whose names were its arcs.
 */
export function readFeatureText(
  text: string,
  path: string,
): { features: FeatureSet } | { pairs: PairSet } {
  // Called variants (§8.14), first as in the worker: eight columns or more,
  // with a variant's ID where a BED has its end, so nothing below can take one
  // and it can take nothing below.
  if (sniffVcf(text)) return { features: parseVcf(text) }
  // Asked before `sniffFormat` for the reason the worker asks it there
  // (§8.17): the BED sniffer never answers "not one of mine", so a barChart
  // read here as a BED would reach a task as intervals with no chart on them
  // — which is fine for a metaplot and silently wrong for anything that reads
  // the vector.
  if (sniffBarChart(text, path)) return { features: parseBarChart(text, path) }
  // A karyotype's bands, scored by how dark each stains (§8.22): read as a
  // BED they kept their spans and lost the one column a task splitting light
  // from dark bands would read.
  if (sniffCytoBand(text)) return { features: parseCytoBand(text) }
  // Introns, whatever shape the aligner wrote them in (§8.23). A STAR table
  // read as a BED is intervals one base too wide with no count on them.
  if (sniffJunctions(text, path) !== null) return { features: parseJunctions(text, path) }
  // A model — the bed3d `reconstruct3d` writes, or a text g3d — is a set whose
  // rows carry coordinates, which is what the structure tasks read (§25). Read
  // as a BED it kept its intervals and lost the model, and Spatial tracks said
  // the row it had just been handed was not a structure. A PDB first, by its
  // name or its records: one this app wrote reads back as its model, and any
  // other is refused with the reason rather than read as a BED of nonsense.
  if (sniffPdb(text, path)) return { features: parsePdb(text, path) }
  if (sniffBed3d(text, path)) return { features: parseBed3d(text, path) }
  if (sniffG3d(text, path)) return { features: parseG3d(text, path) }
  // UCSC's two interaction formats and its gene-model tables (§8.18, §8.19),
  // in the worker's order, which matters nowhere since none can take another's
  // file. An interact and a longrange are loop sets — a `PairSet`, as a bedpe
  // is — and a genePred is transcripts with their exons, as a GTF's are.
  if (sniffInteract(text, path)) return { pairs: parseInteract(text) }
  if (sniffLongRange(text, path)) return { pairs: parseLongRange(text) }
  if (sniffGenePred(text, path)) return { features: parseGenePred(text) }
  const format = sniffFormat(text, path)
  if (format === 'bedpe') return { pairs: parseBedpe(text) }
  if (format === 'gtf') return { features: parseGtf(text) }
  return { features: parseBed(text, path) }
}

/**
 * One file named with `--pairs`: a loop table in whichever of the three paired
 * formats it is written (§8.18).
 *
 * A bedpe unless its bytes say interact or longrange. The flag has already said
 * what the file is for, so a bedpe the BED sniffer would not recognise — an
 * Ensembl genome's, whose second contig is called `1` — is still read as one,
 * as it always was here.
 */
export function readPairText(text: string, path: string): PairSet {
  if (sniffInteract(text, path)) return parseInteract(text)
  if (sniffLongRange(text, path)) return parseLongRange(text)
  return parseBedpe(text)
}

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
 * heatmap's axes read as filenames rather than as `a1`. An address is fetched
 * first and named by its file, query and all left off.
 */
async function loadInputs(
  args: Args,
  downloads: Downloads,
  task?: AnalysisTask,
): Promise<TaskInputs> {
  const inputs: TaskInputs = {}
  const labels: Record<string, string> = {}
  for (const path of all(args, 'features')) {
    const at = (await downloads.local(path, true)) ?? path
    const text = await decodeAnnotationText(new Uint8Array(await readFile(at)))
    const id = fileNameOf(path)
    const read = readFeatureText(text, at)
    if ('pairs' in read) inputs.pairs = { ...inputs.pairs, [id]: read.pairs }
    else inputs.features = { ...inputs.features, [id]: read.features }
    labels[id] = id
  }
  // **Not where the task claims the name for a contact list** — Pairs QC's
  // `--pairs` is the `.pairs` its records are read from, one name and one
  // meaning as `--window` is apa's. Read here as a loop table, a contact list
  // of gigabytes was fetched whole and parsed as a BEDPE before anything ran.
  const claimed = task?.params.some((spec) => spec.key === 'pairs' && spec.kind === 'file') === true
  for (const path of claimed ? [] : all(args, 'pairs')) {
    const at = (await downloads.local(path, true)) ?? path
    const text = await decodeAnnotationText(new Uint8Array(await readFile(at)))
    const id = fileNameOf(path)
    inputs.pairs = { ...inputs.pairs, [id]: readPairText(text, at) }
    labels[id] = id
  }
  if (Object.keys(labels).length > 0) inputs.labels = labels
  return inputs
}

/**
 * References named with `--sequence`, opened where they lie.
 *
 * {@link SequenceReader} is declared optional on its context precisely because
 * the hosts that can answer it are *"the annotations worker"* and not *"a test
 * harness, a future venue, or a session that has never opened a FASTA"*
 * (`analysis/job.ts`). This is that future venue: the same parser the worker
 * runs, over bytes read from the disk the file is already on — and, for a
 * FASTA with its `.fai` beside it or a `.2bit`, the same arithmetic the worker
 * reads by range with, so a mammalian genome is a reference here as it is in
 * the browser (`cli/reference.ts`).
 *
 * Keyed by the string the reader typed, because that string is what comes back
 * out of `params.sequence` — there is no entry store here to allocate an id
 * from, which is the same absence `bindInputs` argues about at length. An
 * address is read by range where it is, with the `.fai` beside it where the
 * server has one, so a remote genome is never fetched whole for a window.
 */
async function loadSequences(
  args: Args,
  downloads: Downloads,
  also: readonly string[] = [],
): Promise<Map<string, Reference>> {
  const held = new Map<string, Reference>()
  for (const path of [...all(args, 'sequence'), ...also]) {
    if (held.has(path)) continue
    const where = await downloads.where(path, true, SIDE_CACHE_BYTES)
    held.set(path, await openReference(where, (name) => downloads.sidecarText(path, name)))
  }
  return held
}

/**
 * The reference a task's own flag names that `--sequence` did not load, as a
 * list of none or one.
 *
 * What a parameter names is what is loaded, which is `--tracks`' arrangement:
 * `pairsqc --reference ref.fa` reads the file it names rather than running with
 * no digest and a note saying the reference was never opened. Only for the
 * parameter `--sequence` answers by itself ({@link referenceKeyOf}), the one a
 * task hands on to the step it requires.
 */
function referenceNamed(task: AnalysisTask, params: Params): string[] {
  const key = referenceKeyOf(task)
  if (key === null || key === 'sequence') return []
  const value = params[key]
  // A path that is there, or an address: a workspace's entry id (`a3`) names no
  // file, and is resolved against what `--sequence` loaded instead (`storeFor`).
  return typeof value === 'string' && value !== '' && (isAddress(value) || existsSync(value)) ? [value] : []
}

/**
 * A task's reference answered by the one `--sequence` the line loaded, where
 * its own flag left it open.
 *
 * Pairs QC's `reference` is the restriction step's `sequence`, handed on
 * (`upstreamParams`), so a line spells it as that step does: `pairsqc
 * sample.pairs.gz --sequence ref.fa --enzyme DpnII`, which is the line the
 * console writes (`analysis/cliCommand.ts`'s `referenceKeyOf`, the rule both
 * sides read). Motif's is called `sequence` and is answered by the flag's own
 * name already; two references loaded is two answers, and neither is guessed.
 */
function withReference(
  task: AnalysisTask,
  params: Params,
  sequences: ReadonlyMap<string, Reference>,
): Params {
  const key = referenceKeyOf(task)
  if (key === null || key === 'sequence' || sequences.size !== 1) return params
  const held = params[key]
  if (typeof held === 'string' && held !== '') return params
  return { ...params, [key]: [...sequences.keys()][0] }
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
 * a path and is not one. An address is opened then too — a bigWig or a `.2bit`
 * by range, a text track in one request — and filed under the address it was
 * named by.
 */
async function loadTrackFiles(
  tasks: readonly { task: AnalysisTask; params: Params }[],
  args: Args,
  downloads: Downloads,
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
        if (isAddress(path) || existsSync(path)) paths.push(path)
        else unresolved.push(path)
      }
    }
  }
  const held = await loadTracks(paths, (path) => downloads.where(path, true, SIDE_CACHE_BYTES))
  // The app's ids, filed against the files they named: `a1` was `signal.bw`
  // when the workspace was saved, and `--track signal.bw` is on the line.
  for (const entry of stored) {
    if (entry.kind !== 'track' || held.has(entry.id)) continue
    const name = fileNameOf(entry.source.url ?? entry.source.name)
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
 * read as `/data/run3/signal.bw` until this says what they are. And what they
 * are is what the app calls the same file once it is dropped: `signal`, its
 * row's label (`annotations/names.ts`). The base name, `signal.bw`, was what
 * this said until the two were run side by side (`notebooks/parity.qmd`): a
 * metaplot's columns, a correlation's axes and FRiP's rows then named one
 * track two ways, and a table from the shell could not be laid beside the
 * drawer's by its headers.
 */
function withTrackLabels(inputs: TaskInputs, tracks: ReadonlyMap<string, LoadedTrack>): TaskInputs {
  if (tracks.size === 0) return inputs
  const labels: Record<string, string> = { ...inputs.labels }
  for (const [key, track] of tracks) labels[key] = cleanLabel(track.name)
  return { ...inputs, labels }
}

/**
 * What each loaded reference is called: its file name, as a track's is.
 *
 * The tasks that read one name their outputs after it — *GC content · PAK.fa*,
 * the name the app's own entry has — and fall back to the word *reference*
 * where the label is missing, which here it always was.
 */
function withSequenceLabels(
  inputs: TaskInputs,
  sequences: ReadonlyMap<string, Reference>,
): TaskInputs {
  if (sequences.size === 0) return inputs
  const labels: Record<string, string> = { ...inputs.labels }
  for (const path of sequences.keys()) labels[path] = fileNameOf(path)
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
    const name = fileNameOf(chosen)
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

const USAGE = `chromosomix — the Analysis panel, from a shell

  chromosomix tasks
      Every task, its id, and the parameters it takes.

  chromosomix <task> <file.cool|file.mcool|file.metacool|file.hic|file.pairs.gz> [...]
      Run one task over one or more files. Each file's outputs are named after
      it, up to its first dot: sample.coverage.coverage-total.tsv. Two files
      that would share a name keep more of theirs — HCT116.rep1 and
      HCT116.rep2, then dirA_sample and dirB_sample — and nothing one command
      writes is written over by it.

      --out <dir>          where to write (default: .)
      --window <chr:a-b>   a window rather than the whole file, 1-based and
                           inclusive as the app, IGV and samtools write it,
                           digits grouped or not: chrIV:1,000,001-1,400,000
      --no-balance         read the raw counts. A map is read balanced wherever
                           the file carries weights, as the app reads it
      --features <file>    a feature or loop file a task needs, read as the app
                           reads it: BED, narrowPeak, GTF, genePred, VCF,
                           cytoBand, barChart, junctions, bedpe, interact,
                           longrange
      --sequence <ref.fa>  a reference, for a task that reads residues (motif,
                           restriction, and pairsqc's digest) or phases by GC
                           content (compartments). Gzipped or not; read by
                           range where its .fai is beside it, or a .2bit
      --pairs <file>       a BEDPE, interact or longrange, for an off-diagonal
                           pileup. Note this is a *feature* table and not a
                           contact list — a .pairs file to bin is a positional
                           argument, and takes --bin-size below. pairsqc's own
                           --pairs is the exception: the contact list a matrix
                           was made from, read for its records
      --against <file>     another contact map, for a task that compares two
                           (hicrep). Repeat it for a third
      --value <column>     the score column to read, for a file that carries
                           more than the count (default: count)
      --origin <name:pos>  where a sequence's replication origin is, 1-based,
                           as the Origin and terminus task reports it; repeat
                           or separate with commas
      --circular <name>    a sequence to read as a circle (a plasmid); repeat
                           or separate with commas
      --cell <name>        a cell of an .scool to sum into the map; repeat or
                           separate with commas. Default: every cell
      --contacts <n>       draw the map to n contacts before the task reads it:
                           below the file's own total, an exact subsample
                           (cooltools random-sample --count n --exact); above
                           it, an oversample through Boost-HiC. Takes 10M,
                           23,000,000 or 2.5e7; --against maps are drawn to it
                           too. The same seed as the app, so the same pixels
      --coarsen <bp>       read the map at this bin size, a whole number of the
                           file's own bins summed along each sequence — what
                           the app does at a resolution you added (3 kb*).
                           Counts sum exactly; a bin's weight is the harmonic
                           mean of its bins' weights. --against maps are summed
                           to it too
      --bin-size <bp>      required for a .pairs input, which states no
                           resolution of its own; ignored for every other format
      --rungs <n>          how many ladder resolutions to build from it
                           (1-2-5 series from the base). Default 1
      --threads <n>        threads for a task that shares its work —
                           pastis-NB's MDS start and likelihood in
                           reconstruct3d. Default 1, so a time is one core's;
                           the results are the same bits on any number
      --quiet              no progress on stderr
      --<param> <value>    any parameter the task takes; see \`tasks\`. A choice
                           is one of its values and a number is a number: any
                           other is refused before a file is opened, with the
                           values it takes. A locus (fourc's --anchor, the 3D
                           tasks' --region and --locus) is read as --window is.
                           A task that reads tracks (metaplot, trackcorr, frip,
                           groupsignal) takes them as --tracks <file.bw>,
                           repeated or comma-separated: a bigWig, a bedGraph, a
                           wig, or a FASTA read as GC content
      --<switch>           a parameter that is on or off, which takes no value
                           after it: --derivative turns one on, and
                           --derivative=false or --no-derivative turns it off

  chromosomix <task> --tracks <file.bw> --features <file.bed> [...]
      A task that reads tracks and no matrix (metaplot, trackcorr, frip,
      groupsignal, overlap, motif, composition, oriter), run with no contact map
      at all — what a 1D browser session runs. The assembly is what the tracks
      and references declare.

  chromosomix circular <file.mcool::/resolutions/<bp>> [...]
      Which sequences join their own ends: the junction test the app runs when
      a map is first opened, as a table on stdout — sequence, length, score,
      and yes or no where it could be decided: a sequence needs 50 bins at the
      resolution read. The names to hand every other run as --circular.

  chromosomix boost <file.mcool::/resolutions/<bp>> [...]
      The boosted map of each sequence: what an oversample (--contacts above
      the file's own total) draws the sequence's new contacts from — the bins
      the outlier filter keeps, and the boosted map over them in SCN units.
      One square TSV per sequence, rows and columns named by each kept bin's
      start, into --out.
      --sequences <a,b>    the sequences to boost. Default: every one; a
                           sequence past 3,000 bins is refused by name
      --alpha <a>          the exponent of the distances, 1/SCN^a.
                           Default: 0.2

  chromosomix stats <file.pairs.gz> [...]
      What \`pairtools stats\` writes for a .pairs file, counted by the pass the
      app's import makes: records mapped on both sides, on one and on neither,
      duplicates, cis and trans and cis past 1 to 40 kb, every pair type, the
      four orientations by separation and where they converge, and the
      library's size. One <name>.stats per file into --out, in pairtools' own
      format, which MultiQC and \`pairtools stats --merge\` read; to stdout
      without --out.

  chromosomix replay <workspace.chromosomix.json> --over <file> [...]
      Re-run every analysis recorded in a saved workspace, with the parameters
      it recorded, over the files named by --over and after the workspace —
      --over data/*.hic as a shell expands it. The workspace is what the
      app's Save button produces: every open tab in one file. A locus it
      recorded is read as --window is, as the app's form showed it; a value
      it recorded that this build cannot run is refused, before any file is.
      --tab <n>            which tab to replay, 1-based. Default: the one that
                           was in front when the workspace was saved.
      --track <file.bw>    the file behind a track the workspace recorded by
                           the app's own id. Repeat it per track
      --against <file>     the other maps a recorded hicrep compared against

  chromosomix --version
      Which build this is: chromosomix, its version and the commit it was
      built from, on the first line, as every file it writes opens with them.
      Then what the version does not fix — the Node it runs on, and the
      h5wasm and @gmod/bbi installed beside it, which read every map and track.

A file may be an http or https address — a map, or what --against,
--sequence, --tracks, --features or --pairs names. A map, a bigWig, a .2bit
and an indexed FASTA are read by range, as the app reads them, and nothing of
them is written to disk. What is read whole — a feature file, a HiC-Pro
matrix, a workspace, or any file whose host serves no range — is fetched into
$TMPDIR, with its progress on stderr, and removed when the command ends.
`

/**
 * What `--version` prints: which build this is, and what it is running on.
 *
 * The first line is the name and the version, with the commit the bundle was
 * built from where it was built in a repository — the words every file the
 * command writes opens with (`# chromosomix 0.13.0 cli`), so `head -1` is the
 * line a pipeline records and a methods section cites.
 *
 * The rest is what a version does not fix. The Node the command runs on, with
 * its platform; and the two libraries every map and every track is read
 * through, `h5wasm` — which is HDF5 — and `@gmod/bbi`. Both are ranges in
 * `package.json`, settled when the package is installed rather than when it was
 * built, so two installs of one version can read a file through two builds of
 * either; which is why their numbers are read off the copies installed beside
 * this file, and not baked in. npm is not among them: it installs the command
 * and takes no part in a run.
 */
function versionText(): string {
  const lines = [
    `chromosomix ${VERSION}${COMMIT === '' ? '' : ` (${COMMIT})`}`,
    `node ${process.versions.node} on ${process.platform}-${process.arch}`,
    ...['h5wasm', '@gmod/bbi'].map((name) => `${name} ${installedVersion(name) ?? '(not found)'}`),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The version of `name` as installed where this file imports it from, or
 * `undefined` where it is not.
 *
 * Node's own walk for a bare specifier — `node_modules/` beside this file and
 * beside every directory above it — rather than `require.resolve`, which both
 * packages refuse: each exports an `import` condition alone, and neither
 * exports its `package.json`. The walk finds the copy a global install nests
 * under the package and the one `npx` hoists beside it alike.
 */
function installedVersion(name: string): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (basename(directory) !== 'node_modules') {
      try {
        const manifest = JSON.parse(
          readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'),
        ) as { version?: unknown }
        if (typeof manifest.version === 'string') return manifest.version
      } catch {
        // Not installed at this level; the next one up may have it.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function listTasks(): void {
  for (const task of TASKS) {
    process.stdout.write(`${task.id}\n    ${task.title}\n`)
    if (task.needsPeers === true) {
      // The one flag a task takes that is not a parameter of its own: the deck
      // it compares against, which a shell spells as files.
      process.stdout.write('      --against <file>  The other maps to compare with; repeat per map\n')
    }
    for (const param of task.params) {
      // A retired question is still taken, as a stored line carries it, and not
      // offered: the task it moved to lists it under its own name.
      if (param.retired === true) continue
      if (paramDerived(param) && param.key === 'balance') {
        process.stdout.write(
          '      --no-balance  read the raw counts (balanced by default where the file carries weights)\n',
        )
        continue
      }
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

async function runCommand(args: Args, downloads: Downloads): Promise<number> {
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
  let sequences: Map<string, Reference>
  let tracks: Map<string, LoadedTrack>
  let binning: PairsBinning | undefined
  let framing: ReturnType<typeof framingFlags>
  try {
    params = paramsFor(task, args)
    binning = pairsBinningOf(args, task)
    framing = framingFlags(args, task)
    inputs = bindInputs(task, params, await loadInputs(args, downloads, task))
    sequences = await loadSequences(args, downloads, referenceNamed(task, params))
    params = withReference(task, params, sequences)
    tracks = await loadTrackFiles([{ task, params }], args, downloads)
    inputs = withSequenceLabels(withTrackLabels(inputs, tracks), sequences)
    // The other maps, reached now where they are addresses: every run mounts
    // them, and one that cannot be had is a fault in the command rather than in
    // the two hundredth file.
    for (const peer of all(args, 'against')) await downloads.reach(peer, true)
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
  const written = new Set<string>()

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
        downloads,
        ...framing,
        quiet,
      })
      for (const note of result.notes) process.stderr.write(`  note: ${note}\n`)
      await writeOutputs(
        result,
        stemOf(result.provenance.framing.uri),
        directory,
        result.contigs,
        quiet,
        written,
      )
      return 0
    } catch (error) {
      process.stderr.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const stems = stemsOf(args.positional)
  let failures = 0
  for (const [index, path] of args.positional.entries()) {
    try {
      if (!quiet) process.stderr.write(`${displayOf(path)}\n`)
      const result = await runOne({
        task,
        params,
        path,
        downloads,
        binning,
        // Not `one(args, 'window')`. `apa` declares a parameter of that name —
        // a half-width in bins — and `paramsFor` already gives a task's own
        // parameters the flag where the two collide. The framing was reading it
        // anyway, so `apa --window 8` set the half-width *and* tried to resolve
        // `8` as a locus, and the run died with "Unknown sequence label: 8".
        // One name, one meaning, decided by whether the task claims it.
        window: task.params.some((param) => param.key === 'window')
          ? undefined
          : one(args, 'window'),
        balance: flag(args, 'no-balance') ? false : undefined,
        inputs,
        sequences,
        tracks,
        peers,
        ...framing,
        quiet,
      })
      for (const note of result.notes) process.stderr.write(`  note: ${note}\n`)
      // Named for the resolution it was measured at where that is the file's
      // bins summed (§3.4): beside a run on the file's own rung in one `--out`,
      // `sample_1000` and `sample_1000_coarsen4000` are two sets of numbers.
      const coarsen = result.provenance.framing.coarsen
      const stem = coarsen === undefined ? stems[index] : `${stems[index]}_coarsen${coarsen}`
      await writeOutputs(result, stem, directory, result.contigs, quiet, written)
    } catch (error) {
      failures += 1
      // Named and carried on, rather than stopping: a batch of two hundred
      // files where the eleventh is truncated should produce a hundred and
      // ninety-nine results and one message, not eleven results and a stack.
      process.stderr.write(
        `  failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    } finally {
      // A fetched map no later file names again is let go here, so a batch over
      // two hundred addresses holds one of them at a time.
      if (!namedAgain(args.positional, index)) await downloads.release(path)
    }
  }
  return failures === 0 ? 0 : 1
}

/** Whether a file after `index` names the same file — another resolution of one `.mcool`. */
function namedAgain(paths: readonly string[], index: number): boolean {
  // Split by hand rather than by `parseUri`, which refuses an empty file half:
  // this runs in a `finally`, and must not throw for a positional that failed.
  const fileOf = (path: string): string => path.split('::')[0].trim()
  return paths.slice(index + 1).some((later) => fileOf(later) === fileOf(paths[index]))
}

/**
 * Re-run a saved tab's analyses over other files.
 *
 * The parameters come from `analysis` in the tab — the same block the drawer
 * restores a form from — so what runs here is what the reader settled on by
 * looking at a picture. Nothing is retyped, which is the whole point: a
 * transcription error in a batch of two hundred is two hundred wrong numbers
 * that look right.
 *
 * The files are the ones `--over` names and any named after the workspace, so
 * `--over data/*.hic` replays every file the shell expands it to. Every one
 * after the first was a positional this command never read, and it replayed the
 * first alone with exit 0.
 */
async function replayCommand(args: Args, downloads: Downloads): Promise<number> {
  const path = args.positional[0]
  if (path === undefined) {
    process.stderr.write('replay needs a workspace file.\n')
    return 2
  }
  let text: string
  try {
    text = await readFile((await downloads.local(path, true)) ?? path, 'utf8')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const read = parseWorkspaceFile(text)
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
  // What was recorded is checked as a typed value is (`refusalOf`), before any
  // file is opened: a workspace naming an option this build has not got would
  // otherwise run the runner's fallback under the recorded name — the false
  // provenance a direct run is now refused for.
  for (const entry of recorded) {
    const task = taskById(entry.task)
    for (const spec of task?.params ?? []) {
      const refused = refusalOf(spec, entry.params[spec.key])
      if (refused === null) continue
      process.stderr.write(
        `${fileNameOf(path)} recorded ${entry.task} with a value this build cannot run, so ` +
          `nothing was replayed. ${refused}\n`,
      )
      return 2
    }
  }
  const over = [...all(args, 'over'), ...args.positional.slice(1)]
  const files = over.length > 0 ? over : [config.state.uri]
  const directory = one(args, 'out') ?? one(args, 'o') ?? '.'
  const quiet = flag(args, 'quiet')
  let sequences: Map<string, Reference>
  let tracks: Map<string, LoadedTrack>
  let loaded: TaskInputs
  let binning: PairsBinning | undefined
  let framing: ReturnType<typeof framingFlags>
  try {
    binning = pairsBinningOf(args)
    framing = framingFlags(args)
    sequences = await loadSequences(args, downloads)
    tracks = await loadTrackFiles(
      recorded.flatMap((entry) => {
        const task = taskById(entry.task)
        return task === undefined ? [] : [{ task, params: entry.params }]
      }),
      args,
      downloads,
      config.tracks,
    )
    loaded = withSequenceLabels(withTrackLabels(await loadInputs(args, downloads), tracks), sequences)
    for (const peer of all(args, 'against')) await downloads.reach(peer, true)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const peers = all(args, 'against')

  process.stderr.write(
    `${recorded.length} task${recorded.length === 1 ? '' : 's'} from ${fileNameOf(path)}, ` +
      `over ${files.length} file${files.length === 1 ? '' : 's'}\n`,
  )
  const stems = stemsOf(files)
  const written = new Set<string>()
  let failures = 0
  for (const [at, file] of files.entries()) {
    // Opened by each task it is replayed under — by range, or from one copy
    // fetched whole and let go after the last of them; an address that cannot
    // be had fails each of them by name.
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
        if (!quiet) process.stderr.write(`${displayOf(file)} · ${task.title}\n`)
        const result = await runOne({
          task,
          params: entry.params,
          path: file,
          downloads,
          balance: undefined,
          binning,
          // Per task, because a replayed workspace can hold several that name
          // different sets under different keys.
          inputs: bindInputs(task, entry.params, loaded),
          sequences,
          tracks,
          peers,
          ...framing,
          quiet,
        })
        await writeOutputs(result, stems[at], directory, result.contigs, quiet, written)
      } catch (error) {
        failures += 1
        process.stderr.write(
          `  failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }
    if (!namedAgain(files, at)) await downloads.release(file)
  }
  return failures === 0 ? 0 : 1
}

/**
 * Which sequences of a map join their own ends: the junction test a session
 * runs on a map's first open (§8.15), as a table on stdout.
 *
 * A declaration frames every run after it, so a batch has to make it before the
 * first task and hand the same names to each with `--circular` — and a batch
 * over eighty genomes, a few of them linear, can neither declare them all round
 * nor ask a person which. The same candidates, reads, threshold and balancing
 * as the session's (`analysis/circularity.ts`), so what a suite declares is
 * what the viewer would have ticked on opening the file at that resolution.
 *
 * Every sequence gets a row, in the file's order: a score and a verdict where
 * the test was run and decided, both empty where it was not — fewer than fifty
 * bins at the resolution read, past the fifty longest, or ends that leave fewer
 * than two of the three separations to compare: one the balancer dropped, or one
 * with nothing on its diagonal. A batch that wants a small plasmid decided reads
 * the map at a resolution that gives it fifty bins.
 */
async function circularCommand(args: Args, downloads: Downloads): Promise<number> {
  if (args.positional.length === 0) {
    process.stderr.write('circular needs at least one file.\n')
    return 2
  }
  const quiet = flag(args, 'quiet')
  let binning: PairsBinning | undefined
  try {
    binning = pairsBinningOf(args)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  let failures = 0
  for (const [index, path] of args.positional.entries()) {
    try {
      downloads.refuseScheme(path)
      const { mc } = await openLocal(uriOf(path), { binning, quiet, downloads })
      try {
        const balance = flag(args, 'no-balance') ? false : mc.hasWeights
        const pairs = mc.chromnames.map((name, id) => [name, mc.coords.contigLengths[id]] as const)
        // Each where the file puts it, not where `ceil(length / binsize)` would.
        const placed = junctionCandidates(pairs, mc.binsize).flatMap((listed) => {
          const candidate = placeCandidate(listed, mc.contigExtent(listed.name))
          return candidate === null ? [] : [candidate]
        })
        const measured = await measureJunctions(
          placed,
          async (rows, cols) => (await mc.matrix({ rows, cols, balance })).values,
        )
        const lines = [
          `# chromosomix ${APP}`,
          `# file: ${path}`,
          `# test: contacts across each sequence's ends over the diagonal's at ${JUNCTION_BINS} bins ` +
            `or fewer, at ${junctionQuorum()} of them at least, on sequences of ` +
            `${MIN_JUNCTION_SEQUENCE_BINS} bins or more; circular at ${CIRCULAR_SCORE} or more (§8.15)`,
          `# framing: ${mc.binsize} bp${balance ? ', balanced' : ''}`,
          ['sequence', 'length', 'score', 'circular'].join('\t'),
        ]
        for (const [name, length] of pairs) {
          const score = measured?.scores[name]
          lines.push(
            [
              name,
              String(length),
              score === undefined ? '' : score.toFixed(4),
              score === undefined ? '' : score >= CIRCULAR_SCORE ? 'yes' : 'no',
            ].join('\t'),
          )
        }
        process.stdout.write(`${lines.join('\n')}\n`)
      } finally {
        mc.close()
      }
    } catch (error) {
      failures += 1
      process.stderr.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      if (!namedAgain(args.positional, index)) await downloads.release(path)
    }
  }
  return failures === 0 ? 0 : 1
}

/**
 * `pairtools stats` for each `.pairs` named, as the app's import counts it (§3.7).
 *
 * The counts are the import's own (`pairs/stats.ts`), made by the import's own
 * pass — binned at one bin a sequence, which costs nothing, so that what this
 * writes and what the General column shows of the same file are one count. A
 * file with no `#chromsize:` is refused as the import refuses it: the sizes are
 * the last section of the file, and the bin table the pass is built on.
 *
 * The one file this command writes with no `#` lines over it. pairtools reads a
 * `.stats` back a `key<TAB>value` a line and refuses any other, and the point
 * of writing its format is that it is read by what reads pairtools' — MultiQC,
 * `pairtools stats --merge`. Where it came from is said on stderr instead.
 */
async function statsCommand(args: Args, downloads: Downloads): Promise<number> {
  if (args.positional.length === 0) {
    process.stderr.write('stats needs at least one .pairs file.\n')
    return 2
  }
  const directory = one(args, 'out') ?? one(args, 'o')
  const quiet = flag(args, 'quiet')
  const stems = stemsOf(args.positional)
  let failures = 0
  for (const [index, path] of args.positional.entries()) {
    let source: ByteSource | null = null
    try {
      if (!quiet) process.stderr.write(`${displayOf(path)}\n`)
      downloads.refuseScheme(path)
      const where = await downloads.where(uriOf(path), false)
      source = where.kind === 'range' ? where.source : await LocalFileSource.fromPath(where.path)
      await source.mount()
      if (!(await isPairsFile(source))) {
        throw new Error(`${fileNameOf(path)} is not a .pairs file: it does not begin with a \`## pairs format\` line.`)
      }
      const header = await readPairsHeader(source)
      const widest = header.contigs.reduce((most, contig) => Math.max(most, contig.length), 1)
      let shown = -1
      const binned = await binPairs(source, {
        binSize: widest,
        contigs: header.contigs,
        columns: header.columns,
        ...(quiet
          ? {}
          : {
              onProgress: (done: number, total: number) => {
                const percent = total > 0 ? Math.floor((done / total) * 100) : 0
                if (percent === shown) return
                shown = percent
                process.stderr.write(`\r  counting records: ${percent}%   `)
              },
            }),
      })
      if (!quiet) process.stderr.write('\r')
      if (binned?.stats == null) throw new Error('the count was interrupted')
      const text = writePairtoolsStats(binned.stats)
      if (directory === undefined) {
        process.stdout.write(text)
      } else {
        await mkdir(directory, { recursive: true })
        const at = join(directory, `${stems[index]}.stats`)
        await writeFile(at, text)
        if (!quiet) process.stderr.write(`  wrote ${at}\n`)
      }
      if (!quiet) process.stderr.write(`  ${statsLine(binned.stats)}\n`)
    } catch (error) {
      failures += 1
      process.stderr.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      source?.close()
      if (!namedAgain(args.positional, index)) await downloads.release(path)
    }
  }
  return failures === 0 ? 0 : 1
}

/** The few numbers a reader looks at first, on one line of stderr. */
function statsLine(stats: PairStats): string {
  const pct = (part: number, whole: number): string => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '—')
  return (
    `${stats.total.toLocaleString('en-US')} records · ${pct(stats.totalMapped, stats.total)} mapped · ` +
    `${pct(stats.totalDups, stats.totalMapped)} duplicates · ${pct(stats.cis, stats.totalNodups)} cis`
  )
}

/**
 * Boost-HiC's map of each sequence, as an oversample makes it (§6.5) and as
 * Boost-HiC's own `main.py` writes it.
 *
 * An oversample draws a sequence's new contacts from that map, and nothing else
 * shows it: what reaches the screen is a draw from it, and a draw is a poor way
 * to hold a port to its upstream. So this hands Boost-HiC the square an
 * oversample hands it — the sequence's stored counts through `cisSquare` and
 * `boostSteps` — and writes what `main.py` writes, `boostedmat`: the boosted
 * map over the bins its outlier filter kept, in SCN units: the map to hold the
 * port to Boost-HiC's Python by, cell for cell over whole chromosomes, where the
 * golden holds a hundred bins.
 *
 * One square per sequence, rows and columns named by each kept bin's start;
 * the bins the filter took out are the ones not named. A sequence past
 * {@link BOOST_MAX_BINS} is refused by name, as an oversample refuses it, and
 * the others are still written.
 */
async function boostCommand(args: Args, downloads: Downloads): Promise<number> {
  if (args.positional.length === 0) {
    process.stderr.write('boost needs at least one file.\n')
    return 2
  }
  const asked = one(args, 'alpha')
  const alpha = asked === undefined ? BOOST_ALPHA : Number(asked)
  if (!Number.isFinite(alpha) || alpha <= 0) {
    process.stderr.write(`--alpha needs a positive number; got ${JSON.stringify(asked)}.\n`)
    return 2
  }
  const named = all(args, 'sequences').flatMap((item) => item.split(',')).filter((item) => item !== '')
  const directory = one(args, 'out') ?? one(args, 'o') ?? '.'
  const quiet = flag(args, 'quiet')
  let failures = 0
  for (const [index, path] of args.positional.entries()) {
    try {
      if (!quiet) process.stderr.write(`${path}\n`)
      downloads.refuseScheme(path)
      const { mc } = await openLocal(uriOf(path), { binning: pairsBinningOf(args), quiet, downloads })
      try {
        // The two maps an oversample refuses, for the reasons it gives (§6.5):
        // a sum of cells is not one library, and a square store holds every
        // contact twice, which the square below would then count twice.
        if (mc.cells.length > 0) {
          throw new Error('a single-cell container’s map is a sum of its cells rather than one library.')
        }
        if (mc.storageMode !== 'symmetric-upper') {
          throw new Error('this map stores both triangles, and a boost reads an upper-triangular one.')
        }
        for (const name of named.length === 0 ? mc.chromnames : named) {
          const id = mc.chromnames.indexOf(name)
          if (id < 0) {
            failures += 1
            process.stderr.write(`  failed: ${fileNameOf(path)} has no sequence ${name}.\n`)
            continue
          }
          const [from, to] = mc.contigExtent(id)
          const n = to - from
          if (n > BOOST_MAX_BINS) {
            failures += 1
            process.stderr.write(
              `  failed: ${name} is ${n.toLocaleString('en-US')} bins at this resolution, and a boost ` +
                `walks every path between them: at most ${BOOST_MAX_BINS.toLocaleString('en-US')}. ` +
                'Open a coarser resolution.\n',
            )
            continue
          }
          const started = Date.now()
          const steps = boostSteps(cisSquare(await cisPixels(mc, from, to), from, n), n, alpha)
          if (steps === null) {
            process.stderr.write(`  note: ${name}: fewer than two bins survive the outlier filter.\n`)
            continue
          }
          const lines = [
            `# chromosomix ${APP}`,
            `# created: ${new Date().toISOString()}`,
            `# file: ${path}`,
            '# method: Boost-HiC (Carron et al. 2019): the outlier filter, SCN, shortest paths on ' +
              '1/SCN^alpha, adjusted to P(s) (§6.5)',
            `# alpha: ${alpha}`,
            `# sequence: ${name}, ${n} bins at ${mc.binsize} bp, ${steps.kept.length} kept`,
            '# units: SCN',
          ]
          const starts = Array.from(steps.kept, (bin) => String(bin * mc.binsize))
          lines.push(['start', ...starts].join('\t'))
          const size = steps.kept.length
          for (let row = 0; row < size; row++) {
            const cells = [starts[row]]
            for (let col = 0; col < size; col++) {
              cells.push(String(Number(steps.boosted[row * size + col].toPrecision(10))))
            }
            lines.push(cells.join('\t'))
          }
          await mkdir(directory, { recursive: true })
          const file = join(directory, `${stemOf(path)}.boost-${name.replace(/[\\/\s]+/g, '_')}.tsv`)
          await writeFile(file, `${lines.join('\n')}\n`)
          if (!quiet) {
            process.stderr.write(
              `  ${name}: ${steps.kept.length} of ${n} bins kept, ${((Date.now() - started) / 1000).toFixed(1)} s; ` +
                `wrote ${file}\n`,
            )
          }
        }
      } finally {
        mc.close()
      }
    } catch (error) {
      failures += 1
      process.stderr.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      if (!namedAgain(args.positional, index)) await downloads.release(path)
    }
  }
  return failures === 0 ? 0 : 1
}

/**
 * The stored pixels of one sequence's own block, as an oversample collects them
 * before it draws: every row of the sequence read as a band, kept where the
 * column is in it too, an empty pixel skipped.
 */
async function cisPixels(
  mc: MetaCooler,
  from: number,
  to: number,
): Promise<{ bin1: Int32Array; bin2: Int32Array; count: Float64Array }> {
  const bin1: number[] = []
  const bin2: number[] = []
  const count: number[] = []
  await mc.storedPixels.forEachBands([[from, to]], (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.count[i] === 0 || chunk.bin2[i] < from || chunk.bin2[i] >= to) continue
      bin1.push(chunk.bin1[i])
      bin2.push(chunk.bin2[i])
      count.push(chunk.count[i])
    }
  })
  return { bin1: Int32Array.from(bin1), bin2: Int32Array.from(bin2), count: Float64Array.from(count) }
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
  const { path: file, group } = uriParts(path)
  const name = fileNameOf(file)
  const dot = name.indexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : (name || 'output')
  return `${stem}${groupSuffix(group)}`
}

/**
 * `parseUri`, without its refusal of an empty file half: the stems of a batch
 * are named before its first run, and a positional the run would refuse is
 * refused there, as that file's failure, rather than here as the batch's.
 */
function uriParts(path: string): { path: string; group: string } {
  try {
    return parseUri(path)
  } catch {
    return { path: '', group: '/' }
  }
}

/** `_1000` for `::/resolutions/1000`, and nothing for a file's root. */
function groupSuffix(group: string): string {
  if (group === '/') return ''
  const last = group.split('/').filter((part) => part !== '').pop()
  return last === undefined ? '' : `_${last}`
}

/**
 * One stem per input of a command, no two alike: the names its outputs are
 * written under.
 *
 * {@link stemOf} of each wherever that is unique, so a command over one file —
 * or over files that differ before their first dot — names its outputs as it
 * always has, and a script reading them back keeps working. It was the only
 * rule, so `coverage HCT116.rep1.cool HCT116.rep2.cool` wrote
 * `HCT116.coverage.*` twice, the second run's files over the first's, with exit
 * 0; and `dirA/sample.mcool dirB/sample.mcool` did the same. Where two would
 * share a stem, those two keep more of their names, a step at a time, until
 * they differ:
 *
 * 1. the whole name less its format extension, and a `.gz` before it:
 *    `HCT116.rep1` and `HCT116.rep2`;
 * 2. the whole name: `sample.cool` and `sample.hic`;
 * 3. the directories it is in, nearest first, joined with `_` — an address's
 *    path, then its host: `dirA_sample` and `dirB_sample`;
 * 4. and a file named twice is numbered in the order given: `sample`,
 *    `sample_2`.
 *
 * Compared without case, because two names that differ only in it are one file
 * on a Mac's disk and on Windows'.
 */
export function stemsOf(paths: readonly string[]): string[] {
  const ladders = paths.map(stemLadder)
  // What each input *is*: one file named twice, or two names differing only in
  // case, can never be told apart by more of its name, and climbing for it
  // would only end at a stem made of every directory up to the root.
  const identity = paths.map((path) => {
    const { path: file, group } = uriParts(path)
    return `${isAddress(file) ? file : resolve(file)}::${group}`.toLowerCase()
  })
  const rung = paths.map(() => 0)
  const stems = ladders.map((ladder) => ladder[0])
  for (;;) {
    const holders = new Map<string, number[]>()
    stems.forEach((stem, index) => {
      const key = stem.toLowerCase()
      holders.set(key, [...(holders.get(key) ?? []), index])
    })
    const climbing = [...holders.values()].flatMap((held) =>
      held.filter(
        (index) =>
          rung[index] < ladders[index].length - 1 &&
          held.some((other) => identity[other] !== identity[index]),
      ),
    )
    if (climbing.length === 0) break
    for (const index of climbing) {
      rung[index] += 1
      stems[index] = ladders[index][rung[index]]
    }
  }
  const taken = new Set<string>()
  return stems.map((stem) => {
    let named = stem
    for (let count = 2; taken.has(named.toLowerCase()); count++) named = `${stem}_${count}`
    taken.add(named.toLowerCase())
    return named
  })
}

/** Every stem {@link stemsOf} may give one input, least specific first. */
function stemLadder(path: string): string[] {
  const { path: file, group } = uriParts(path)
  const name = fileNameOf(file)
  const suffix = groupSuffix(group)
  const bare = name.replace(/\.(gz|bgz|bz2|xz|zst)$/i, '')
  const dot = bare.lastIndexOf('.')
  const long = `${dot > 0 ? bare.slice(0, dot) : bare || name || 'output'}${suffix}`
  const ladder = [stemOf(path), long, `${name || 'output'}${suffix}`]
  const directories = isAddress(file)
    ? addressDirectories(file)
    : resolve(file)
        .split(/[\\/]/)
        .filter((part) => part !== '')
        .slice(0, -1)
        .reverse()
  let prefix = ''
  for (const directory of directories) {
    // `:` and the separators are no part of a file's name: a drive on Windows,
    // the port of an address's host, a `%2F` an address decoded to.
    const safe = directory.replace(/[:\\/]/g, '_')
    prefix = prefix === '' ? safe : `${safe}_${prefix}`
    ladder.push(`${prefix}_${long}`)
  }
  return ladder.filter((stem, at) => ladder.indexOf(stem) === at)
}

export async function main(argv: readonly string[]): Promise<number> {
  // Asked for anywhere, the help, before the rest is checked: a reader who
  // types `--help` after half a command wants the usage, not a refusal of the half.
  if (argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  // The version on the same terms — after the help, which is the longer answer
  // to a line that asks for both.
  if (argv.includes('--version')) {
    process.stdout.write(versionText())
    return 0
  }
  let args: Args
  try {
    const command = commandOf(argv)
    if (command === '' || command === 'help') {
      process.stdout.write(USAGE)
      return 0
    }
    if (command === 'tasks') {
      listTasks()
      return 0
    }
    if (!['replay', 'circular', 'boost', 'stats'].includes(command) && taskById(command) === undefined) {
      process.stderr.write(`Unknown task ${JSON.stringify(command)}. Try \`tasks\`.\n`)
      return 2
    }
    args = parseArgs(argv, command)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`${error.message}\n`)
    return 2
  }
  if (flag(args, 'help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.flags.has('balance') && !takesBalance(args.command)) {
    process.stderr.write(
      '--balance is the default now: a map is read balanced wherever the file carries weights. ' +
        'Drop it, or use --no-balance for the raw counts.\n',
    )
    return 2
  }
  const threads = one(args, 'threads')
  const count = threads === undefined ? DEFAULT_THREADS : Number(threads)
  if (!Number.isInteger(count) || count < 1) {
    process.stderr.write(`--threads ${threads}: a whole number of threads, 1 or more.\n`)
    return 2
  }
  useThreads(count)
  // One directory of fetched addresses per command, gone when it ends — after
  // a failure as after a success, which is what the `finally` is for.
  const downloads = new Downloads({ quiet: flag(args, 'quiet') })
  try {
    if (args.command === 'replay') return await replayCommand(args, downloads)
    if (args.command === 'circular') return await circularCommand(args, downloads)
    if (args.command === 'boost') return await boostCommand(args, downloads)
    if (args.command === 'stats') return await statsCommand(args, downloads)
    return await runCommand(args, downloads)
  } finally {
    await downloads.close()
  }
}

// `import.meta.url` against `process.argv[1]` is the ESM spelling of "am I the
// entry point"; importing this module from a test must not run it. Compared
// by realpath rather than by name: Node resolves the entry file's own symlinks
// before it becomes `import.meta.url`, so an extensionless `bin` link — the
// whole point of `package.json`'s `bin` field — has `argv[1]` end in
// `chromosomix` while the module it loaded ends in `chromosomix.mjs`.
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

/**
 * Let a reader stop reading.
 *
 * `chromosomix tasks | head -1`, or a `less` quit before the end: the other end
 * of the pipe closes, and Node reports the next write as an error on the stream
 * — `EPIPE`, or `EOF` on Windows — which unheard is an uncaught exception, so
 * the command died with a stack trace and exit 1 the moment `head` had its
 * line. Heard, what was left to print is dropped, and the command finishes what
 * it was doing and exits with the status it would have had. Not with a
 * `process.exit()` on the spot: a task's progress and notes go to stderr, so
 * `insulation map.cool 2>&1 | head -1` would have stopped with its files half
 * written under an exit code that said nothing was wrong. Any other error on
 * the stream is thrown, as it was.
 */
export function ignoreClosedPipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'EOF') return
    throw error
  })
}

// A helper thread runs this same file (`cli/threads.ts`), and has the same
// `argv[1]`: it serves the thread that started it, and is no command at all.
const invoked = !serveIfHelper() && isMainThread && isEntryPoint(process.argv[1])
if (invoked) {
  ignoreClosedPipe(process.stdout)
  ignoreClosedPipe(process.stderr)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

