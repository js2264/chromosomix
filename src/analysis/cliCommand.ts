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
 * one run is how they come to disagree. The console (§23) writes the same line
 * from the same function when the run starts, which is the other half of that.
 *
 * ## What is in it, and what cannot be
 *
 * Everything the CLI reads: the task, the file, the framing's window and
 * balancing, every parameter the task declares, and the `--features`,
 * `--pairs`, `--sequence` and `--tracks` loads that a parameter naming a
 * loaded file implies. The order is the order a person would write it —
 * subject, framing, inputs, parameters — rather than the order the parser
 * happens to accept.
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
 * ## And the runs that used to have no command at all
 *
 * For a while this file also *refused*: the three tasks that read a bigWig, the
 * one that reads a second map, and any run made in a session with no contact
 * map, each with a sentence saying why a shell could not take it. Every one of
 * those sentences was a hole in the console exactly where a reader looks for a
 * line to paste. `cli/main.ts` now opens tracks (`cli/tracks.ts`), mounts the
 * maps `--against` names, and runs a track task with no file positional — so
 * there is no refusal left to write, and `cliCommandFor` is total: every run
 * has a command.
 *
 * Two of those cases carry a note rather than a refusal, because they name
 * things the **record** does not hold. The maps `hicrep` compared against are
 * the deck's, not the result's, so they come from the session's context and are
 * left to the reader to name when the context is gone; and a session with no
 * map frames its run against the file that declared the assembly, which is
 * written as the `--tracks` load it is rather than as a map to open.
 */

import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  ContextContig,
  ParamSpec,
  Params,
  Provenance,
} from './types'
import type { AnnotationEntry } from '../annotations/types'
import type { Extent } from '../types'

/** The command the drawer copies. */
export interface CliCommand {
  /**
   * What goes on the clipboard: any `#` notes, then the command, one line each.
   *
   * Comment lines rather than a separate field because they are part of what is
   * pasted — a shell reads them as nothing, and a reader who pastes into a
   * script keeps the caveat next to the line it is about.
   */
  text: string
}

/**
 * Whether a framing describes no matrix at all.
 *
 * `AnalysisRunner`'s `tracksFraming` is the only thing that makes one: the
 * track tasks (§18.3) run in a session that has no contact map — a 1D browser
 * (§5.8) — and a result is still a record of *something*, so what it names
 * there is the assembly. It writes a zero-wide extent on both axes, which no
 * view of a real map can have: a window of no bins is not a window, and
 * `run/blocks.ts` refuses one outright.
 *
 * Read rather than flagged because the flag would be a second way of saying the
 * same thing, and the two would eventually disagree about a framing neither of
 * them made. What it decides here is the **subject** of the line: a map is the
 * first argument, and a run with no map has none — `metacooler-run` takes a
 * track task with no positional and runs it over what the tracks declare.
 */
export function coversNoMatrix(framing: AnalysisFraming): boolean {
  return framing.rows[1] <= framing.rows[0] && framing.cols[1] <= framing.cols[0]
}

/** Everything the command is built from; `context` supplies the names. */
export interface CliCommandInput {
  task: AnalysisTask
  provenance: Provenance
  /**
   * The session's own facts, or `null`.
   *
   * Three things come from here and from nowhere else in a {@link Provenance}:
   * the contig table, which is what turns the framing's absolute bin extent
   * back into a locus a shell can be given; the annotation entries, which is
   * what turns a parameter holding an entry id into the name of a file on a
   * disk; and the other maps of the deck, for the one task that compares
   * files. Absent, all three are simply left out — the command is then the
   * task, the file and the parameters that stand on their own, which still
   * repeats most runs, with a note where it cannot.
   */
  context: AnalysisContext | null
}

/** The command name, as `package.json` puts it on the PATH. */
const COMMAND = 'metacooler-run'

/**
 * The score column a shell reads unless told otherwise.
 *
 * `metacooler/matrix.ts`'s `DEFAULT_COUNT_COLUMN`, spelled here rather than
 * imported: this module runs on the main thread (the drawer and the console
 * call it) and that one is the pixel reader, which the main-thread bundle is
 * kept free of by construction (`analysis/registry.ts`).
 */
const COUNT_COLUMN = 'count'

/**
 * Write the command.
 *
 * Pure and total: every run produces a command, because a button that
 * sometimes copies nothing is a button a reader presses twice, and a console
 * row that is a sentence is a hole in a script.
 */
export function cliCommandFor(input: CliCommandInput): CliCommand {
  const notes: string[] = []
  const args: string[] = [COMMAND, input.task.id]
  const { framing, params } = input.provenance
  const mapless = coversNoMatrix(framing)

  if (!mapless) {
    args.push(quote(framing.uri))
    if (isRemote(framing.uri)) {
      notes.push(
        'This file is remote, and the command reads local files only — the reader uses ' +
          'synchronous range requests, which exist in a worker and not in Node. Fetch it first.',
      )
    }
    // A contact list declares no resolution of its own (§3.7): the session
    // answered the import dialog, and the shell's answer is a flag. The bin
    // size the run was framed at is that answer.
    if (isPairsFile(framing.uri) && framing.binsize > 0) {
      args.push('--bin-size', String(framing.binsize))
    }
  }

  // The framing's window, where the task has not claimed the name for itself.
  // `apa` declares a parameter called `window`, and `cli/main.ts` therefore
  // ignores `--window` for it — so writing one here would be a flag the command
  // silently drops and, worse, a locus assigned to a half-width in bins.
  const claimsWindow = input.task.params.some((param) => param.key === 'window')
  if (!mapless && !claimsWindow) {
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
  // answer there and is never absent. A run with no matrix has nothing to
  // balance, and says nothing.
  const declared = input.task.params.find((param) => param.key === 'balance')
  const balance =
    declared === undefined || typeof params.balance !== 'boolean'
      ? framing.balance
      : params.balance
  if (!mapless) args.push(balance ? '--balance' : '--balance=false')
  if (!mapless && declared !== undefined && balance !== framing.balance) {
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

  // The facts of a framing a session sets from the picture and a shell has to
  // be told — each an input to the arithmetic, so a line without it repeats a
  // different run. The count column and no circular sequence are the shell's
  // own defaults and go unsaid, as the defaults of the parameters do not: they
  // are properties of the file rather than of a build.
  //
  // What the molecules are declared to be first, with a map or without one: a
  // task on the sequence reads a circle as surely as one on the matrix (§8.15).
  const circular = (framing.circular ?? []).filter((name) => name !== '')
  if (circular.length > 0) args.push('--circular', quote(circular.join(',')))
  // 1-based on the line, as a reader reads it off the Origin and terminus
  // table; the framing keeps it 0-based, like every coordinate it holds.
  const origins = Object.entries(framing.origins ?? {}).filter(
    ([name, at]) => name !== '' && Number.isFinite(at),
  )
  if (origins.length > 0) {
    args.push('--origin', quote(origins.map(([name, at]) => `${name}:${at + 1}`).join(',')))
  }
  if (!mapless) {
    if (framing.value !== '' && framing.value !== COUNT_COLUMN) {
      args.push('--value', quote(framing.value))
    }
    // The ticked cells of an `.scool` are the session's and not the record's
    // (§3.8), so they are read off the context, and a command written with no
    // context to ask is told what it cannot say.
    const cells = input.context?.selectedCells ?? []
    if (cells.length > 0) args.push('--cell', quote(cells.join(',')))
    else if (
      input.context !== null &&
      (input.context.cells ?? 0) > 0 &&
      (input.context.activeCells ?? input.context.cells ?? 0) < (input.context.cells ?? 0)
    ) {
      notes.push(
        'The map was summed from a subset of the file’s cells, and the record does not name ' +
          'them. Add --cell <name> for each.',
      )
    }
  }

  // The other maps, for the one task whose unit is a pair of files. They are
  // the deck's and not the result's — a `Provenance` records what was asked of
  // *this* map — so they are read off the session, and a command written with
  // no session to ask is told what it is missing.
  if (input.task.needsPeers === true) {
    const peers = input.context?.peers ?? []
    for (const peer of peers) {
      args.push('--against', quote(peer.uri))
      if (isRemote(peer.uri)) {
        notes.push(`${peer.label} is remote; fetch it first, as with the file itself.`)
      }
    }
    if (peers.length === 0) {
      notes.push(
        `${input.task.id} compares this map with the others on screen, and the record does not ` +
          'name them. Add --against <file> for each.',
      )
    }
  }

  // The loads a parameter implies, before the parameters that bind them: a
  // reader scanning the line sees which files it needs before it says what to do
  // with them, and `--features`/`--sequence`/`--tracks` is how `cli/main.ts`
  // reads them.
  const entries = input.context?.entries ?? []
  const loads: string[] = []
  /**
   * Parameters whose load *is* their binding, so the loop below leaves them be.
   *
   * A load is written under the flag the CLI reads files from — `--features`,
   * `--pairs`, `--sequence` — and a task may declare a parameter under one of
   * those very names: `motif` calls its reference `sequence`. There the two are
   * one token pair, because `loadSequences` files a reference under the path it
   * was given and `params.sequence` holds that same path. Written twice, the
   * line said `--sequence ref.fa --sequence ref.fa`, which parses the file
   * twice to arrive at the same answer and reads like a mistake in a command a
   * reader is about to run over two hundred files.
   *
   * A **track** parameter is always its own load: `cli/main.ts` opens whatever
   * `--tracks` names, so the flag is the parameter's own key and there is no
   * second spelling to reconcile.
   */
  const boundByLoad = new Set<string>()
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
      const flag =
        spec.kind === 'sequence'
          ? '--sequence'
          : spec.kind === 'pairSet'
            ? '--pairs'
            : spec.kind === 'track'
              ? `--${spec.key}`
              : '--features'
      if (flag === `--${spec.key}`) boundByLoad.add(spec.key)
      const written = `${flag} ${quote(named)}`
      // One load per file, however many parameters chose it: two flags naming
      // one path is two parses of the same file, under one key in the end.
      if (!loads.includes(written)) loads.push(written)
    }
  }
  for (const load of loads) args.push(...load.split(' '))

  for (const spec of input.task.params) {
    if (spec.key === 'balance') continue
    // The load already wrote this one, and wrote it the way the CLI reads a
    // list: one flag per file. The parameter loop writes a *comma-joined* value,
    // which `coerce` splits for a multiple parameter and `readFile` does not —
    // so where the two collide, the load's spelling is the one that works.
    if (boundByLoad.has(spec.key)) continue
    const written = flagFor(spec, params[spec.key], entries)
    if (written !== null) args.push(...written)
  }

  const command = args.join(' ')
  const lines = [...notes.map((note) => `# ${note}`), command]
  return { text: lines.join('\n') }
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

/** Whether a URI names a `.pairs` — the one input a shell has to be told a bin size for. */
function isPairsFile(uri: string): boolean {
  return /\.pairs(\.gz)?$/i.test(uri.split('::')[0].split(/[?#]/)[0])
}
