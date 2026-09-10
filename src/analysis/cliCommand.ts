/**
 * The run that just finished, written as the shell command that repeats it.
 *
 * ## Why a button and not a paragraph of documentation
 *
 * `cli/main.ts` opens with the argument this file finishes: the panel computes
 * sixteen goldened things, and the moment a reader has two hundred files rather
 * than one, clicking stops being the interface. What that command needed was a
 * way in. `metacooler-run tasks` prints every flag a task takes, which answers
 * *what is possible* and not *what did I just do* — so the reader who has spent
 * twenty minutes moving a window and nudging four numbers until the picture is
 * right still has to transcribe those four numbers into a shell, from memory, by
 * eye, once per task. Transcription is the one step in that loop where the
 * numbers in the figure and the numbers in the table can quietly stop being the
 * same numbers, which is the failure the whole subtree exists to prevent.
 *
 * So the drawer copies the command. Same source as `copy provenance` beside it —
 * the {@link Provenance} of the result on screen — because a command built from
 * anything else would be a second account of what was run, and two accounts of
 * one run is how they come to disagree.
 *
 * ## What is in it, and what cannot be
 *
 * Everything the CLI reads: the task, the file, the framing's window and
 * balancing, every parameter the task declares, and the `--features`,
 * `--pairs` and `--sequence` loads that a parameter naming a loaded file
 * implies. The order is the order a person would write it — subject, framing,
 * inputs, parameters — rather than the order the parser happens to accept.
 *
 * Three things a browser knows and a shell cannot be told, and each one is a
 * `#` comment line above the command rather than a silent omission, because a
 * command that runs and answers a slightly different question is worse than one
 * that says what it left out:
 *
 * - **A remote file.** `RemoteRangeSource` reads through synchronous
 *   `XMLHttpRequest`, which exists in a worker and not in Node; `cli/main.ts`
 *   says so at length. The command still names the URL, since the reader's next
 *   step is to fetch it and the name is what they need.
 * - **A window across several sequences.** `--window` takes one locus. A view
 *   spanning part of a metagenome is not one, so the command runs over the whole
 *   file and says that is what it will do.
 * - **A parameter naming something with no file behind it** — a peak set the app
 *   itself called, most often. There is nothing for `--features` to point at.
 *
 * ## And the tasks that cannot run there at all
 *
 * {@link cliCannotRun} moved here from `cli/main.ts` so that one predicate
 * decides both whether the command refuses to start and whether the button that
 * writes it is offered at all. Two copies of that rule would be a button that
 * cheerfully hands over a command line the command rejects — the reader finding
 * out somewhere else, later, with the app closed, which `ui/SyntheticCard.ts`
 * argues at length is the one outcome worse than not offering it.
 */

import type {
  AnalysisContext,
  AnalysisTask,
  ContextContig,
  ParamSpec,
  Params,
  Provenance,
} from './types'
import type { AnnotationEntry } from '../annotations/types'
import type { Extent } from '../types'

/** The command the drawer copies, or the reason there is none. */
export interface CliCommand {
  /**
   * What goes on the clipboard: any `#` notes, then the command, one line each.
   *
   * Empty when {@link refusal} is set. Comment lines rather than a separate
   * field because they are part of what is pasted — a shell reads them as
   * nothing, and a reader who pastes into a script keeps the caveat next to the
   * line it is about.
   */
  text: string
  /** Why this task cannot be run from a shell at all, or `null`. */
  refusal: string | null
}

/**
 * Why this task cannot be run from a shell, or `null` when it can.
 *
 * Moved out of `cli/main.ts` unchanged. The rule is about the *descriptor* and
 * nothing else — a task that reads a track needs `@gmod/bbi`, which is imported
 * by the annotations worker and by nothing else, one of the three layering rules
 * this repository enforces rather than encourages.
 */
export function cliCannotRun(task: AnalysisTask): string | null {
  const tracks = task.params.filter((param) => param.kind === 'track')
  if (tracks.length === 0) return null
  return (
    `${task.id} reads a track (${tracks.map((param) => `--${param.key}`).join(', ')}); ` +
    'the bigWig reader lives in the annotations worker and not in this shell. Run it in the app.'
  )
}

/** Everything the command is built from; `context` supplies the names. */
export interface CliCommandInput {
  task: AnalysisTask
  provenance: Provenance
  /**
   * The session's own facts, or `null`.
   *
   * Two things come from here and from nowhere else in a {@link Provenance}: the
   * contig table, which is what turns the framing's absolute bin extent back
   * into a locus a shell can be given, and the annotation entries, which is what
   * turns a parameter holding an entry id into the name of a file on a disk.
   * Absent, both are simply left out — the command is then the task, the file
   * and the parameters that stand on their own, which still repeats most runs.
   */
  context: AnalysisContext | null
}

/** The command name, as `package.json` puts it on the PATH. */
const COMMAND = 'metacooler-run'

/**
 * Write the command.
 *
 * Pure and total: every branch produces either a refusal or a command, because
 * a button that sometimes copies nothing is a button a reader presses twice.
 */
export function cliCommandFor(input: CliCommandInput): CliCommand {
  const refusal = cliCannotRun(input.task)
  if (refusal !== null) return { text: '', refusal }

  const notes: string[] = []
  const args: string[] = [COMMAND, input.task.id]
  const { framing, params } = input.provenance

  args.push(quote(framing.uri))
  if (isRemote(framing.uri)) {
    notes.push(
      'This file is remote, and the command reads local files only — the reader uses ' +
        'synchronous range requests, which exist in a worker and not in Node. Fetch it first.',
    )
  }

  // The framing's window, where the task has not claimed the name for itself.
  // `apa` declares a parameter called `window`, and `cli/main.ts` therefore
  // ignores `--window` for it — so writing one here would be a flag the command
  // silently drops and, worse, a locus assigned to a half-width in bins.
  const claimsWindow = input.task.params.some((param) => param.key === 'window')
  if (!claimsWindow) {
    const window = windowFor(framing.rows, framing.cols, input.context)
    if (window.locus !== null) args.push('--window', quote(window.locus))
    if (window.note !== null) notes.push(window.note)
  }

  // Balancing, once, because `--balance` sets both the framing and a `balance`
  // parameter where the task declares one. A declared one is what the
  // arithmetic actually read, so it wins — but only when the record carries it.
  // A provenance written without it (an older session, a task that gained the
  // parameter since) would otherwise be read as *unbalanced*, turning a missing
  // field into a positive claim about the numbers; the framing is the better
  // answer there and is never absent.
  const declared = input.task.params.find((param) => param.key === 'balance')
  const balance =
    declared === undefined || typeof params.balance !== 'boolean'
      ? framing.balance
      : params.balance
  args.push(balance ? '--balance' : '--balance=false')
  if (declared !== undefined && balance !== framing.balance) {
    // Worth a line, and worth being exact about what it costs. The two are one
    // flag in a shell, so the command cannot say that the *map* was drawn one
    // way while the *task* read it the other — but only the first of those is
    // lost. The arithmetic is `params.balance`, which is what this follows, and
    // the framing a shell run records is a label rather than an input: with no
    // view to borrow a block from, `run/blocks.ts` never consults it.
    notes.push(
      `The map was drawn ${framing.balance ? 'balanced' : 'unbalanced'} while the task read it ` +
        `${balance ? 'balanced' : 'unbalanced'}, and --balance sets both together. This follows ` +
        'the task, so the numbers match; only the framing line the run records will differ.',
    )
  }

  // The loads a parameter implies, before the parameters that bind them: a
  // reader scanning the line sees which files it needs before it says what to do
  // with them, and `--features`/`--sequence` is how `cli/main.ts` reads them.
  const entries = input.context?.entries ?? []
  const loads: string[] = []
  for (const spec of input.task.params) {
    if (!isEntryParam(spec)) continue
    for (const id of idsOf(params[spec.key])) {
      const named = fileNameOf(entries, id)
      if (named === null) {
        notes.push(
          `--${spec.key} named something with no file behind it${labelOf(entries, id)} — a set ` +
            'this app computed, most likely. Point it at a file, or export that row first.',
        )
        continue
      }
      const flag = spec.kind === 'sequence' ? '--sequence' : spec.kind === 'pairSet' ? '--pairs' : '--features'
      const written = `${flag} ${quote(named)}`
      // One load per file, however many parameters chose it: two flags naming
      // one path is two parses of the same file, under one key in the end.
      if (!loads.includes(written)) loads.push(written)
    }
  }
  for (const load of loads) args.push(...load.split(' '))

  for (const spec of input.task.params) {
    if (spec.key === 'balance') continue
    const written = flagFor(spec, params[spec.key], entries)
    if (written !== null) args.push(...written)
  }

  const command = args.join(' ')
  const lines = [...notes.map((note) => `# ${note}`), command]
  return { text: lines.join('\n'), refusal: null }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function isEntryParam(spec: ParamSpec): boolean {
  return (
    spec.kind === 'featureSet' ||
    spec.kind === 'pairSet' ||
    spec.kind === 'track' ||
    spec.kind === 'sequence'
  )
}

/** One id, several, or none — an entry parameter may be `multiple` or optional. */
function idsOf(value: Params[string]): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

/**
 * One parameter as the flag and value a shell takes, or `null` for one that
 * cannot be written.
 *
 * **Every parameter the run had, including the ones left at their defaults.**
 * The command is a record of what was computed, and a default is a property of
 * the build that wrote it: a command that leans on one repeats this run today
 * and some other run after the default moves. `copy provenance` beside this
 * button lists them all for the same reason (§18.4).
 */
function flagFor(
  spec: ParamSpec,
  value: Params[string],
  entries: readonly AnnotationEntry[],
): string[] | null {
  if (value === undefined || value === null) return null

  if (isEntryParam(spec)) {
    // The entry *id* is a handle a store allocated in this tab; what the shell
    // needs is the file it stands for. `cli/main.ts` files each load under its
    // base name and looks the parameter up by that, so the two meet here.
    const named = idsOf(value)
      .map((id) => fileNameOf(entries, id))
      .filter((name): name is string => name !== null)
    return named.length === 0 ? null : [`--${spec.key}`, quote(named.join(','))]
  }

  if (typeof value === 'boolean') return [value ? `--${spec.key}` : `--${spec.key}=false`]

  if (Array.isArray(value)) {
    // Comma-separated, which `coerce` splits — and which survives being pasted
    // into a script without quoting rules of its own. An empty list is the
    // parameter never answered, and the task's own fallback is wider than any
    // list this could write (`sequences` means *every* sequence).
    const written = value.filter((item) => item !== null && item !== undefined).map(String)
    return written.length === 0 ? null : [`--${spec.key}`, quote(written.join(','))]
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? [`--${spec.key}`, String(value)] : null
  }

  return value === '' ? null : [`--${spec.key}`, quote(String(value))]
}

/**
 * The file behind an entry id, or `null` when there is no file.
 *
 * `null` is a real answer and not a failure to look: a computed interval set is
 * a row like any other and can be chosen as a task's input, and it has no path
 * because nothing on a disk produced it.
 */
function fileNameOf(entries: readonly AnnotationEntry[], id: string): string | null {
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) return null
  const source = entry.source
  if (source.kind === 'local' || source.kind === 'detached') return source.name
  if (source.kind === 'remote') return baseNameOf(source.url)
  return null
}

/** ` (“Insulation boundaries”)`, for a note about a row a reader can find. */
function labelOf(entries: readonly AnnotationEntry[], id: string): string {
  const entry = entries.find((candidate) => candidate.id === id)
  return entry === undefined ? '' : ` (“${entry.label}”)`
}

function baseNameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0]
  const last = withoutQuery.split('/').filter((part) => part !== '').pop()
  return last === undefined || last === '' ? url : last
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

interface WindowText {
  locus: string | null
  note: string | null
}

/**
 * The framing's bin extent as a locus `--window` accepts.
 *
 * Four answers, and the fourth is why this is not two lines. The whole file
 * needs no flag. A whole sequence is named rather than spelled out, because
 * `chrIV` is what a reader recognises and what `parse_metacooler_range` resolves
 * without arithmetic. A stretch inside one sequence is `name:start-end`, in the
 * 0-based half-open numbers cooler's own parser reads the digits as
 * (`metacooler/range.ts` is explicit that no 1-based conversion happens
 * anywhere). And a view across several sequences is **none of those** — a
 * metagenome pane holding forty contigs is not a locus — so the command runs
 * over the whole file and says so, rather than naming the first contig and
 * quietly answering a smaller question.
 *
 * Rows and columns are both consulted: an off-diagonal block is a pair of
 * different windows and `--window` is one, so that too is a run over the whole
 * file with a note.
 */
function windowFor(
  rows: Extent,
  cols: Extent,
  context: AnalysisContext | null,
): WindowText {
  if (context === null) return { locus: null, note: null }
  const total = context.nBins
  const whole = rows[0] === 0 && rows[1] >= total && cols[0] === 0 && cols[1] >= total
  if (whole || total === 0) return { locus: null, note: null }

  if (rows[0] !== cols[0] || rows[1] !== cols[1]) {
    return {
      locus: null,
      note:
        'The view was an off-diagonal block — two different windows on the two axes — and ' +
        '--window names one. This runs over the whole file.',
    }
  }

  // A genome first, exactly as `parse_metacooler_range` resolves a label:
  // genome names are tested before contig names, so a name that is both means
  // the genome, and writing the genome here is what makes the two agree.
  const genome = context.genomes?.find(
    (entry) => entry.extent[0] === rows[0] && entry.extent[1] === rows[1],
  )
  if (genome !== undefined) return { locus: genome.name, note: null }

  const contig = containing(context.contigs, rows)
  if (contig === null) {
    return {
      locus: null,
      note:
        'The view covered several sequences without covering the file, and --window names one ' +
        'locus. This runs over the whole file.',
    }
  }
  if (rows[0] === contig.startBin && rows[1] >= contig.startBin + contig.bins) {
    return { locus: contig.name, note: null }
  }
  const start = (rows[0] - contig.startBin) * context.binsize
  const end = Math.min(contig.length, (rows[1] - contig.startBin) * context.binsize)
  return { locus: `${contig.name}:${start}-${end}`, note: null }
}

/** The one contig an extent lies inside, or `null` when it lies across several. */
function containing(contigs: readonly ContextContig[], extent: Extent): ContextContig | null {
  for (const contig of contigs) {
    if (contig.bins === 0) continue
    const from = contig.startBin
    const to = contig.startBin + contig.bins
    if (extent[0] >= from && extent[1] <= to) return contig
  }
  return null
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * A value a shell will hand back unchanged.
 *
 * Single quotes and the `'\''` dance, which is the only quoting that is right
 * for every byte: inside single quotes a POSIX shell interprets nothing at all,
 * so a file called `my data (copy).cool` and a pattern full of brackets survive.
 * Left bare where nothing needs it, because a line of unnecessary quotes is a
 * line a reader has to check before trusting.
 */
export function quote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isRemote(uri: string): boolean {
  return /^https?:\/\//i.test(uri)
}
