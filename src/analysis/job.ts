/**
 * What a task is handed when it runs.
 *
 * Worker-side only, and that is the point of it being a separate module from
 * `analysis/types.ts`. A {@link JobContext} names `MetaCooler`, and
 * `worker/reader.worker.ts` opens with the claim that it is the only module in
 * `src/worker/` and `src/ui/` that does. Keeping the *descriptors* (which the
 * panel, the form and the registry all import on the main thread) apart from the
 * *runners* (which only this worker imports) is what keeps that claim true, and
 * it is why every task is two files: `analysis/tasks/<id>.ts` for what the task
 * is, `analysis/run/<id>.ts` for what it does.
 *
 * The four capabilities below are the whole of what a runner may assume, and
 * each is here because leaving it to the runner produced a bug at least once in
 * the modules this design is derived from:
 *
 * - **`throwIfCancelled`** rather than a boolean nobody checks. A scan that
 *   ignores a cancel is a scan the reader cannot get out of, and the honest
 *   place to notice is inside the loop.
 * - **`progress`** with a note, because a composite's honest answer to "why is
 *   this slow" is which of its steps is running.
 * - **`note`** for the things a reader must be told that are not errors —
 *   *412 of 5,000 windows dropped for missing data*. A task that silently
 *   discards a fifth of its input and reports a clean number is a task that
 *   lies, and there is nowhere else for that sentence to go.
 * - **`bp` and `bins` conversions bound to the open file**, because a parameter
 *   is typed in base pairs and every kernel below works in bins, and doing that
 *   arithmetic at each of a dozen call sites is how one of them ends up off by a
 *   bin at a contig edge.
 */

import type { Region, TrackSampleSet } from '../annotations/types'
import type { Contig } from '../genome/assembly'
import type { NameContext } from '../genome/naming'
import type { MetaCooler } from '../metacooler/MetaCooler'
import type { ByteSource } from '../types'
import type { AnalysisFraming, Params, ParamValue, TaskOutput } from './types'
import type { PeerMap, TaskInputs } from './worker/protocol'

export interface JobContext {
  /** The file, mounted by this worker and nobody else. */
  readonly mc: MetaCooler
  readonly params: Params
  readonly framing: AnalysisFraming
  readonly inputs: TaskInputs
  /** `true` once the reader has asked for this job to stop. */
  cancelled(): boolean
  /** @throws an `AbortError` when {@link cancelled}. Call it inside loops. */
  throwIfCancelled(): void
  /**
   * Hand the worker's event loop back, then throw if the reader has stopped it.
   *
   * **`throwIfCancelled` alone cannot see a cancel that has not been
   * delivered.** The flag it reads is set by a `cancel` *message*, and a message
   * is delivered in a task of its own — so a runner that never returns to the
   * event loop never receives one, and asking it a thousand times inside a loop
   * asks a thousand times about a message still sitting in the queue. `await`
   * does not help: an already-resolved promise schedules a microtask, and the
   * microtask queue is drained inside the task that scheduled it (`../async`).
   *
   * That is why cancelling did nothing on exactly the tasks worth cancelling.
   * The reads yield between windows and have always been stoppable; the *compute*
   * — a cubic correlation, a diamond over every bin of every sequence, a pileup
   * over ten thousand windows — ran to completion inside one task with the
   * reader's cancel behind it in the queue, and delivered its result to somebody
   * who had asked for it to stop.
   *
   * Costs a `MessageChannel` round trip, so it belongs at the top of an outer
   * loop — once per sequence, per window, per batch of rows — and never in the
   * inner one.
   */
  breathe(): Promise<void>
  progress(done: number, total: number, note?: string): void
  /** Something the reader should know that is not an error. */
  note(text: string): void
  /** Base pairs for a whole number of bins of this file. */
  toBp(bins: number): number
  /** Bins for a span in base pairs, rounded to at least one. */
  toBins(bp: number): number
  /**
   * Mount another map, for the one task whose question is about two files.
   *
   * **Optional, unlike everything above**, and the asymmetry is the same one
   * {@link TrackJobContext.bases} draws: the rest of this interface is
   * answerable by anything that can run a task at all, and this one is
   * answerable only by a venue that knows how to open a container. A test
   * harness holding a hand-built `MetaCooler` does not, and a runner that needs
   * this says so in a sentence rather than reading `undefined` out of a call
   * that type-checked.
   *
   * The mount is the **caller's to close**, and it is built outside the source
   * cache the first mount uses — see `worker/sources.ts`'s `createDetachedSource`
   * for why a second file opened through the ordinary road would close the first.
   */
  peer?(map: PeerMap): Promise<{ mc: MetaCooler; close(): void }>
  /**
   * Open an address for its **bytes**, for a task that reads a file this
   * application does not mount as a map.
   *
   * One case, and it is `.pairs`: the four orientation curves are a property of
   * records rather than of a matrix (§3.7), so a reader who wants them for a
   * file they never imported is asking for a *read* and not for an open. Handing
   * back a `ByteSource` rather than a container is what keeps that honest —
   * nothing is binned, no map changes, and the caller gets exactly what a
   * contact list is.
   *
   * Optional for {@link peer}'s reason: only a venue that knows how to build a
   * source can answer, and a runner that needs one says so in a sentence.
   *
   * Remote addresses only. A local file has no address — it arrives as a `File`
   * from a drop target — so the road for one is to drop it on the app, which
   * imports it and counts the same curves in the same pass.
   */
  openBytes?(url: string): Promise<ByteSource>
}

/** What a task actually does. Registered in `analysis/run/index.ts`. */
export type TaskRunner = (job: JobContext) => Promise<TaskOutput[]>

// ---------------------------------------------------------------------------
// Reading parameters
// ---------------------------------------------------------------------------

/**
 * The four accessors every runner uses.
 *
 * `Params` is `Record<string, ParamValue>` because it has to survive
 * `postMessage`, `JSON.stringify` and a session file written by an older build —
 * so what arrives is genuinely of unknown shape, and a runner that indexes it
 * directly is a runner that reads `undefined` out of a renamed key and computes
 * with `NaN` all the way to a plot. These narrow, and fall back rather than
 * throw: a missing parameter is a build that changed, not a file that is broken.
 */
export function numParam(params: Params, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function strParam(params: Params, key: string, fallback: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

export function boolParam(params: Params, key: string, fallback: boolean): boolean {
  const value = params[key]
  return typeof value === 'boolean' ? value : fallback
}

/** A multi-select's value, as a plain array of ids. Never `undefined`. */
export function listParam(params: Params, key: string): string[] {
  const value: ParamValue | undefined = params[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' && value !== '' ? [value] : []
}

/** An optional entry choice: the id, or `null` where nothing was picked. */
export function idParam(params: Params, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * A loaded input a parameter chose, told apart from one nobody chose.
 *
 * **The record is keyed by the parameter's key, never by the entry id** — see
 * {@link TaskInputs} and `AnalysisRunner`'s `chosenEntries`, which is where the
 * keys are made. Indexing it by the id read back out of `params` is the mistake
 * this function exists to stop being made a sixth time: it type-checks, it reads
 * as though it must be right, and every task written that way looked up a real
 * set under a key nothing was filed under, found `undefined`, and reported "no
 * set was chosen" about a set the reader had plainly chosen.
 *
 * Two failures with two sentences, which is the other half of the point. Nothing
 * picked is a form to finish; picked-and-gone is a row the reader dropped
 * between filling the form in and pressing Run, and `inputsFor` leaves it out
 * rather than substituting an empty set precisely so this can be said out loud
 * instead of being reported as a clean result over nothing.
 */
export function chosenInput<T>(
  held: Record<string, T> | undefined,
  params: Params,
  key: string,
): { value: T | undefined; chosen: boolean } {
  return { value: held?.[key], chosen: idParam(params, key) !== null }
}

/** What to say about an input that is not there. `null` when it is. */
export function missingInput(
  found: { value: unknown; chosen: boolean },
  what: { unchosen: string; gone: string },
): string | null {
  if (found.value !== undefined) return null
  return found.chosen ? what.gone : what.unchosen
}

// ---------------------------------------------------------------------------
// Naming (§5.9)
// ---------------------------------------------------------------------------

/**
 * This file's id for a sequence somebody **else** named, or `-1`.
 *
 * The read side of §5.9, in the one worker that had none. Every name a task
 * acts on that did not come out of the file it is running against arrives in
 * another file's vocabulary: a ticked sequence list is the *starred* map's
 * spellings, a BED was renamed into the *session's* on the way in, and a region
 * was typed against whatever the reader was looking at. Run a batch across a
 * deck (§18.2) and all three are then asked of every panel — including the
 * `.hic` that writes `1` where the `.cool` beside it writes `chr1`.
 *
 * `MetaCooler.contigId` is deliberately literal — it is a port of cooler's own
 * lookup and refuses anything the file does not spell — so a task that used it
 * on a foreign name matched nothing and said so in whatever words it had for an
 * empty run: *none of the ticked sequences has any bins in it*, *no anchors fell
 * inside a sequence*, *unknown label*. Three sentences, all true, none of them
 * the reason. This is the one place that gets a second opinion, exactly as
 * `parseMetacoolerRange` does for a range and for the same reason: after the
 * literal answer, never instead of it.
 *
 * `from` is the naming context of the list the name **came out of**, where the
 * caller has one — a Roman numeral is Roman by virtue of the list it was
 * written in, and `X` is the tenth chromosome only in a list that also counts
 * past nine that way. Omitted, this file's own context stands in, and the
 * ambiguous single letters are refused rather than guessed (`NameIndex.find`).
 */
export function contigIdFor(mc: MetaCooler, name: string, from?: NameContext): number {
  if (mc.hasContig(name)) return mc.contigId(name)
  const matched = mc.names.find(name, ...(from === undefined ? [] : [{ from }]))
  return matched === null || !mc.hasContig(matched.name) ? -1 : mc.contigId(matched.name)
}

/**
 * The same, for a list — and the names that found nothing, to be said out loud.
 *
 * Both halves are needed by every caller. A sequence the reader ticked that this
 * file has not got is not an error — a deck holds files of different assemblies
 * on purpose — but a run that quietly drops half of what was asked for and
 * reports a clean number is the failure §5.9 is written against.
 *
 * Ids come back **ascending**, whatever order the names were in: a caller
 * walking them is walking the file's own layout, which is what makes a run of
 * bins a contiguous span.
 */
export function contigIdsFor(
  mc: MetaCooler,
  names: readonly string[],
  from?: NameContext,
): { ids: number[]; missing: string[] } {
  const ids = new Set<number>()
  const missing: string[] = []
  for (const name of names) {
    const cid = contigIdFor(mc, name, from)
    if (cid < 0) missing.push(name)
    else ids.add(cid)
  }
  return { ids: [...ids].sort((a, b) => a - b), missing }
}

// ---------------------------------------------------------------------------
// Circular sequences (§8.15)
// ---------------------------------------------------------------------------

/**
 * Whether this run should read `name` as a circle rather than as a line.
 *
 * The flag is the reader's, set on the Map aesthetics card and carried in
 * `AnalysisFraming.circular`, and it is **automatic**: there is no per-task
 * tickbox and deliberately so. A plasmid is circular or it is not; that is a
 * fact about the molecule rather than a setting of the directionality index, and
 * a catalogue in which eleven tasks each carry their own copy of it is a
 * catalogue in which a reader can get ten circular answers and one linear one
 * out of the same file without being told.
 *
 * Matched through {@link contigIdFor}'s rule rather than by string equality, for
 * §5.9's reason and for a case that is entirely ordinary here: the flag is set
 * against the *session's* map, a batch then asks every panel of a deck for it,
 * and the `.hic` beside the `.cool` spells the same plasmid another way. A name
 * this file has not got matches nothing and answers `false`, which is right —
 * the sequence the reader flagged is not in this file.
 */
export function readsAsCircular(job: JobContext, name: string): boolean {
  const flagged = job.framing.circular
  if (flagged === undefined || flagged.length === 0) return false
  if (flagged.includes(name)) return true
  const cid = job.mc.hasContig(name) ? job.mc.contigId(name) : -1
  if (cid < 0) return false
  return flagged.some((entry) => contigIdFor(job.mc, entry) === cid)
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * The rejection a cancelled job produces.
 *
 * `AbortError` by name, because `worker/client.ts`'s `isCancellation` already
 * tests for exactly that and the UI already maps it to a quiet no-op rather than
 * to an error card. A second convention for the same event would mean a
 * cancelled analysis showing a red box saying "cancelled".
 */
export function abortError(): Error {
  const err = new Error('cancelled')
  err.name = 'AbortError'
  return err
}

// ---------------------------------------------------------------------------
// The other venue
// ---------------------------------------------------------------------------

/**
 * What a task is handed when it runs in the **annotations** worker.
 *
 * Two venues rather than one, and the split is the same argument
 * `annotations/worker/protocol.ts` already makes for itself. A metaplot's whole
 * input is bigWigs and feature sets: the handles are already open in that
 * worker, it already answers many regions in one request, and it already picks a
 * zoom level for the batch. Routing that through a third thread would mean
 * shipping the samples out of the worker that has them, into a worker that has
 * no reader for them, to average numbers neither of them needed to move — and
 * would land N × W floats on the main thread on the way past, which is exactly
 * the point §18.8 says would be missed.
 *
 * So a task declares its {@link TaskVenue} and the runner routes. What the two
 * contexts share is deliberate and complete: cancellation, progress, notes and
 * the inputs. What differs is the capability each venue exists for — a mounted
 * `MetaCooler` there, and here the two things this worker is the only holder of:
 * a way to sample a track, and a way to read a reference's residues
 * ({@link SequenceReader}).
 */
/**
 * A loaded reference, read where it lies.
 *
 * The residues of a FASTA are parsed into the annotations worker and
 * deliberately never shipped out whole: a `bases` request answers a *window* and
 * is capped, precisely so that opening a genome does not put twelve megabytes on
 * the main thread (`annotations/worker/protocol.ts`). Every other input a task
 * takes crosses that boundary — a `FeatureSet` is typed arrays and a track
 * arrives as one value per bin — and a genome is the one that must not.
 *
 * So a task that reads sequence is a task that runs *beside* it, and this is the
 * door. Handed out by the worker that holds the store rather than reached for by
 * the runner, for the same reason {@link TrackJobContext.sample} is: the runner
 * names an entry, and what it gets back is bytes it may read and must not keep.
 *
 * `bases` resolves the spelling the way every other reader in that worker does
 * (§5.9), so a FASTA renamed into the map's vocabulary at load time is searched
 * under the names the rest of the application uses.
 */
export interface SequenceReader {
  /** The reference's own sequences, in the reference's own order. */
  readonly contigs: readonly Contig[]
  /** One sequence's residues, one ASCII byte each; `undefined` for a name it has not got. */
  bases(contig: string): Uint8Array | undefined
  /**
   * Why the residues cannot be read here, when they cannot.
   *
   * A FASTA read by range from its index (§8.8) is not held anywhere, and a
   * search over it would be the download it was indexed to avoid — so the
   * reader answers with a sentence instead of a sequence, and the runner
   * reports it as a note rather than as a run that found nothing.
   */
  readonly refusal?: string
}

export interface TrackJobContext {
  readonly params: Params
  readonly framing: AnalysisFraming
  readonly inputs: TaskInputs
  cancelled(): boolean
  throwIfCancelled(): void
  progress(done: number, total: number, note?: string): void
  note(text: string): void
  /**
   * Values over a set of regions, at a chosen resolution.
   *
   * One call per batch rather than per region, because that is what the worker's
   * own `sample` is built to do: it picks a single zoom level for the whole
   * request and coalesces on-disk blocks across region boundaries (§8.2).
   */
  sample(entry: string, regions: Region[], basesPerPixel: number): Promise<TrackSampleSet>
  /** A sequence's length, so a window can be clamped to it rather than past it. */
  lengthOf(contig: string): number | undefined
  /**
   * The residues of a loaded reference, or `undefined` for an entry that is not
   * one — see {@link SequenceReader}.
   *
   * **Optional, unlike everything else here**, and the asymmetry is the point.
   * The four capabilities above are answerable by anything that can run a track
   * task at all: they are the parameters, the record, the inputs it was handed
   * and a sample of a track it named. This one is answerable only by a host that
   * holds a parsed genome — which the annotations worker does and a test
   * harness, a future venue, or a session that has never opened a FASTA does
   * not. Declaring it required would make every one of those a liar; declaring
   * it optional makes a runner that needs it say so in a sentence
   * (`analysis/run/motif.ts`) instead of reading `undefined` out of a call that
   * type-checked.
   */
  residues?(entry: string): SequenceReader | undefined
}

export type TrackTaskRunner = (job: TrackJobContext) => Promise<TaskOutput[]>
