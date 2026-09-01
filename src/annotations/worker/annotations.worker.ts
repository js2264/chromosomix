/**
 * The annotations worker: the only place annotation bytes are read or parsed.
 *
 * Same discipline as the reader worker — all I/O on this side of the boundary,
 * nothing but data crossing it. The two things that make it worth its own
 * thread are both measured rather than assumed: the demo GTF takes ~310 ms to
 * parse, which on the main thread is a third of a second of a page that does not
 * respond to a scroll; and a bigWig sample over sixteen contigs is a burst of
 * range requests that must not be queued behind them.
 *
 * `@gmod/bbi` is imported *only* here, which is the same layering rule `src/h5/`
 * follows for h5wasm: the main-thread bundle never pulls in a file parser.
 */

import { BigBed, BigWig } from '@gmod/bbi'
import { inflateBgzf, isBgzf, matchNames, parseTabix, spansFor } from '../tabix'
import { DEFAULT_EXCLUDE, FLAG, isBam, readHeader, type BamHeader } from '../bam/format'
import { chunksFor, forecastBytes, parseBamIndex, type BamIndex } from '../bam/index'
import { coverageOf, DEFAULT_FILTER, type PileFilter } from '../bam/pile'
import { pileOf } from '../bam/reads'
import {
  IntervalTrack,
  parseBedGraph,
  parseWig,
  sniffSignal,
  type SignalFormat,
} from '../signal'
import type { RefInfo } from '@gmod/bbi'
import { BlobFile, RemoteFile } from 'generic-filehandle2'

import { signS3Request } from '../../s3/sigv4'

import { transfersFor } from '../../worker/protocol'
import { yieldToEventLoop } from '../../async'
import { LOAD_REPORT_MS, startBusyProbe } from '../../perf/busy'
import { looksLikeChromSizes, parseChromSizes, type Contig } from '../../genome/assembly'
import { overlapWith } from '../featureset'
import {
  contigIndexOf,
  renameInto,
  sequencesOf,
  type NamedSequence,
  type Renaming,
} from '../../genome/naming'
import { binVectorSamples, type BinVector } from './binVector'
import { TRACK_RUNNERS } from '../../analysis/run/tracks'
import type { TrackJobContext } from '../../analysis/job'
import type { TaskResult } from '../../analysis/types'
import { COMMIT, VERSION } from '../../version'
import { gcBins, looksLikeFasta, parseFasta, type SequenceStore } from '../fasta'
import {
  decodeAnnotationBytes,
  parseBed,
  parseBedpe,
  parseGtf,
  sniffFormat,
} from '../parse'
import type {
  BaseCounts,
  BaseRegion,
  ContigOverlap,
  FeatureSet,
  ReadPile,
  ReadStyle,
  ReadWindow,
  Region,
  TrackSamples,
  TrackSampleSet,
} from '../types'
import {
  bbiMagic,
  isHdf5,
  type AnnotationRequest,
  type AnnotationResponse,
  type AssemblyResult,
  type BaseResult,
  type DetectedFormat,
  type LoadResult,
  type WireSource,
} from './protocol'

/**
 * Rewrite a parsed set's contig table into the map's vocabulary, in place.
 *
 * Element by element rather than `splice(0, n, ...names)`, which is the obvious
 * way to write it and blows the stack: a spread passes every element as an
 * argument, and a metagenomic BED naming 150 k contigs is 150 k arguments.
 * `RangeError: Maximum call stack size exceeded`, and the file simply fails to
 * load — on exactly the files this viewer exists for.
 */
function renameContigs(contigs: string[], mapContigs: readonly NamedSequence[]): Renaming {
  const renaming = renameInto(sequencesOf(contigs), mapContigs)
  for (let at = 0; at < renaming.names.length; at++) contigs[at] = renaming.names[at]
  return renaming
}

/**
 * The §8.2 overlap report, with the renames the matcher was unsure of.
 *
 * One builder rather than an `overlapWith` call per load path, because the two
 * halves have to travel together: the rename (§5.9) happens *before* the
 * overlap is counted, so a cross-convention match makes the report say **fully
 * matched** — which is right when the two are one sequence and a lie when they
 * are not. An hg19 track's `MT` against an hg38 map's `chrM` is one name
 * apiece, one rename, and two sequences two bases apart, and without this the
 * card would have nothing to say about it.
 */
function overlapReport(
  fileContigs: readonly string[],
  mapContigs: readonly NamedSequence[],
  renaming: Renaming | null,
): ContigOverlap {
  const overlap = overlapWith(fileContigs, namesOf(mapContigs))
  const genomes = genomeOverlap(fileContigs, mapContigs)
  const contested = renaming?.contested ?? []
  return {
    ...overlap,
    ...(genomes === null ? {} : { genomes }),
    ...(contested.length === 0
      ? {}
      : { contested: contested.slice(0, 4).map((match) => `${match.asked} → ${match.name}`) }),
  }
}

/**
 * How many **genomes** a file touches, on a map that has them (§8.5).
 *
 * The sequence counts are the wrong unit for a metagenome and are true in a way
 * that reads as false: a coverage track over three MAGs of fifty says `412 of
 * 20,566 sequences matched`, which is what a file about another organism
 * entirely would also say. What distinguishes them is that the 412 fall inside
 * three *organisms* rather than being scattered over fifty, and that is what a
 * reader is checking for.
 *
 * `null` where the map has no genome layer, which leaves the report exactly as
 * it was on every cooler.
 */
function genomeOverlap(
  fileContigs: readonly string[],
  mapContigs: readonly NamedSequence[],
): { matched: number; total: number; named: string[] } | null {
  const all = new Set<string>()
  for (const sequence of mapContigs) {
    if (sequence.genome !== undefined && sequence.genome !== '') all.add(sequence.genome)
  }
  if (all.size === 0) return null
  const inFile = new Set(fileContigs)
  const hit = new Set<string>()
  for (const sequence of mapContigs) {
    if (sequence.genome === undefined || sequence.genome === '') continue
    if (inFile.has(sequence.name)) hit.add(sequence.genome)
  }
  return { matched: hit.size, total: all.size, named: [...hit].slice(0, 4) }
}

/**
 * A sequence's residues, by whichever name the caller has for it.
 *
 * Exact first — the map this FASTA was loaded against, renamed at the door —
 * then the alias ladder, for the other panels of a deck, which sample through
 * their own blocks' axes and ask by their own files' spellings (§5.9).
 */
function basesOf(store: SequenceStore, name: string): Uint8Array | undefined {
  const direct = store.bases.get(name)
  if (direct !== undefined) return direct
  const at = contigIndexOf(store.contigs, name)
  return at < 0 ? undefined : store.bases.get(store.contigs[at].name)
}

/** Just the names, for the two helpers that ask about spelling and not size. */
function namesOf(sequences: readonly NamedSequence[]): string[] {
  return sequences.map((sequence) => sequence.name)
}

/** An open bigWig, kept for the life of the entry that owns it. */
interface OpenTrack {
  bigwig: BigWig
  /**
   * The map's name for a sequence → the name **this file** spells it with.
   *
   * A map rather than the set of the file's own names it used to be, and the
   * difference is the whole of §5.9 for a bigWig: a `.bw` written against UCSC
   * and dropped on an Ensembl cooler is asked for `1` and has to be queried for
   * `chr1`. It doubles as the filter it replaced — a region the map has that
   * this file does not is simply absent from the map.
   */
  refOf: Map<string, string>
  /**
   * The file's own refNames, in file order — what the ladder searches when a
   * name reaches neither the alignment nor itself. A deck's companions ask by a
   * spelling the alignment never saw, because it was made against the lead.
   */
  refNames: string[]
}

const tracks = new Map<string, OpenTrack>()

/**
 * The text signal files open here — bedGraph and wig.
 *
 * A fourth store beside the bigWigs, the sequences and the computed vectors, and
 * it earns its place the same way the third one did: `sample` looks here too, so
 * a bedGraph answers the request a bigWig answers and every lane, every control
 * and every renderer above is unchanged (§8.2). What it cannot borrow is the
 * bigWig's on-disk zoom levels, so {@link IntervalTrack} computes the summary
 * for the window it is asked about instead.
 */
const signals = new Map<string, IntervalTrack>()

/**
 * The sequences of every open FASTA, by the entry that owns them.
 *
 * Kept here rather than handed over, exactly as a bigWig's handle is: a lane
 * draws a window at a time, and a chromosome sent to the main thread would be
 * twelve megabytes carried across so that a few thousand bases of it could be
 * read (§8.2).
 */
const sequences = new Map<string, SequenceStore>()

/**
 * The computed vectors registered against this file, by the entry that owns them.
 *
 * A third store beside the two above, and it is the reason a synthetic lane
 * needs no renderer of its own: `sample` looks here as well, so an analysis
 * result answers the same request a bigWig does and everything downstream is
 * unchanged (§18.5).
 *
 * Held here rather than on the main thread for a different reason from the other
 * two, and worth stating because it is not the obvious one. A vector is *small*
 * enough to keep on the main thread — a whole yeast genome at 1 kb is 48 kB —
 * so this is not about size. It is about there being exactly one path from a
 * lane to its values, and that path arriving here.
 */
const vectors = new Map<string, BinVector>()

/**
 * An open BAM, and everything about it that is worth not reading twice.
 *
 * The fifth store, and it is a *handle* store like the bigWigs rather than a
 * parsed-payload one like the feature sets — for the reason §8.2 gives and then
 * one of its own. A window of alignments is not merely large, it is unbounded:
 * there is no zoom level in the file and no summary layer, so what a lane can
 * afford depends on the window it is looking at, and that is a question only
 * this side of the boundary can answer.
 *
 * The index is held because it is read once and consulted per frame; the header
 * because the reference table is how a refId becomes a name; and `refIdOf`
 * because resolving a map's spelling to this file's is the §5.9 ladder and a
 * pan asks it sixty times a second.
 */
interface OpenBam {
  handle: BlobFile | RemoteFile
  header: BamHeader
  index: BamIndex
  /** The file's own length, for bounding the last block of a span. */
  size: number
  /** The map's name for a sequence → this file's reference id. */
  refIdOf: Map<string, number>
  /** The file's own reference names, in file order, for the ladder. */
  refNames: string[]
}

const alignments = new Map<string, OpenBam>()

/**
 * How many compressed bytes one window may cost before it is refused.
 *
 * The number that makes an alignment lane bounded, and it is spent against a
 * forecast made from the index alone — so a window too deep to draw costs zero
 * data requests to refuse (§12), rather than being discovered part-way through
 * a fetch.
 *
 * Eight mebibytes is about a second of inflation on the measurements behind
 * §8.13, which is the point past which a lane stops being a picture and starts
 * being a job. It is deliberately a *byte* budget rather than a base-pair one:
 * the same 50 kb window is a handful of blocks over an intergenic region and
 * hundreds over an rDNA repeat, and a limit expressed in base pairs would
 * refuse the first and accept the second.
 */
const WINDOW_BYTE_CAP = 8 << 20

/**
 * How large a FASTA this reads.
 *
 * It is read whole and held whole, which is what makes a pan free — and what
 * makes a mammalian genome the wrong thing to open this way. Three gigabases is
 * three gigabytes here, and the honest answer is a refusal naming the number
 * rather than a tab that stops responding while it allocates.
 */
const FASTA_BYTE_CAP = 300_000_000

/**
 * The last file read whole, so the same one is not parsed twice.
 *
 * Starting a genome browser from a GTF asks this worker two questions about one
 * file — *what genome is this on*, and then *give me its features* — and both
 * answers come from the same parse. The demo GTF is 9.5 MB and ~310 ms of it, so
 * the second question is answered from here instead.
 *
 * One entry, and keyed on name and size rather than on content: the two requests
 * are consecutive and about the same drop, so anything longer-lived would be a
 * cache of files nobody is looking at.
 */
let recent: { key: string; format: DetectedFormat; features: FeatureSet | null } | null = null

/**
 * The last FASTA parsed, for the same two-questions-one-file reason as
 * {@link recent} — and with none of its danger. A sequence store is never
 * transferred, so unlike a `FeatureSet` it cannot be detached out from under the
 * second question.
 */
let recentFasta: { key: string; store: SequenceStore } | null = null

/** A local file's identity for {@link recent}; a URL is its own. */
function cacheKey(source: WireSource): string {
  return source.kind === 'local' ? `${source.name}|${source.file.size}` : source.url
}

self.onmessage = (event: MessageEvent<AnnotationRequest>) => {
  void handle(event.data)
}

// How busy this thread has been, once a second, unasked: parsing a GTF or
// walking a FASTA happens here, and a CPU figure read only on the main thread
// would report those as an idle tab.
const probe = startBusyProbe()
setInterval(() => {
  const response: AnnotationResponse = { type: 'busy', fraction: probe.busy() }
  ;(self as unknown as Worker).postMessage(response)
}, LOAD_REPORT_MS)

/**
 * Requests the main thread has called off.
 *
 * Ids rather than a flag per handler, so a `cancel` can arrive before the work
 * it names has reached its first check — which is the common case, since the
 * pan that cancels is the frame after the one that asked.
 */
const cancelled = new Set<number>()

/**
 * Ids currently being handled, so a `cancel` for a settled one can be dropped.
 *
 * Without it the set only ever shrinks through the target's own `finally`, and
 * a cancel that arrives *after* its target finished — which is the ordinary
 * case, since every `cancellable` caller in this codebase cancels a superseded
 * handle whether or not it has already answered — leaves its id behind for the
 * life of the tab. The counter is monotonic, so that is a slow leak rather than
 * a bounded one.
 */
const inFlight = new Set<number>()

/**
 * The largest id that has been handled, so a cancel can tell "not yet started"
 * from "long finished". Ids are allotted in order by one client, so anything
 * above this has not arrived and anything at or below it is over.
 */
let highestSettled = 0

/** Whether this request has been called off since it started. */
function isCancelled(id: number): boolean {
  return cancelled.has(id)
}

/**
 * Give the thread back, then say whether to carry on.
 *
 * The yield is the point: a `cancel` message cannot be *read* without one, so a
 * loop that checked `cancelled` without yielding would find it empty every time
 * however long it ran. `yieldToEventLoop` is a real task rather than a
 * microtask for exactly this reason — see `async.ts`, where the same mistake is
 * recorded against the overview scan.
 */
async function stillWanted(id: number): Promise<boolean> {
  await yieldToEventLoop()
  return !cancelled.has(id)
}

/** Raised when a request is called off; the client maps it to a quiet no-op. */
function abortError(): Error {
  const err = new Error('cancelled')
  err.name = 'AbortError'
  return err
}

async function handle(request: AnnotationRequest): Promise<void> {
  inFlight.add(request.id)
  try {
    const payload = await dispatch(request)
    // Asked for and then not wanted: the answer is thrown away rather than
    // posted, because a lane that has already moved on would otherwise paint a
    // window the reader has left.
    if (isCancelled(request.id)) throw abortError()
    const response: AnnotationResponse = { type: 'result', id: request.id, payload }
    ;(self as unknown as Worker).postMessage(response, transfersFor(payload))
  } catch (err) {
    const response: AnnotationResponse = {
      type: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.name === 'AbortError' ? { cancelled: true } : {}),
    }
    ;(self as unknown as Worker).postMessage(response)
  } finally {
    // Whatever happened, this id is settled and must not hold an entry in
    // either set: the counter is monotonic, so a set that only grew would be a
    // slow leak for the life of the tab.
    inFlight.delete(request.id)
    cancelled.delete(request.id)
    if (request.id > highestSettled) highestSettled = request.id
  }
}

async function dispatch(request: AnnotationRequest): Promise<unknown> {
  switch (request.kind) {
    case 'load':
      return load(request.entry, request.source, request.mapContigs)
    case 'sample':
      return sample(request.entry, request.regions, request.basesPerPixel, request.reads, request.id)
    case 'register':
      vectors.set(request.entry, request.vector)
      return null
    case 'run':
      return runTask(request)
    case 'bases':
      return bases(request.entry, request.regions)
    case 'assembly':
      return assemblyOf(request.source)
    case 'reads':
      return readsFor(
        request.entry,
        request.regions,
        request.maxRows,
        request.basesPerPixel,
        request.reads,
        request.id,
      )
    case 'cancel':
      // Recorded for anything that has not already settled — which includes an
      // id that has not *started*, because a `cancel` routinely overtakes the
      // request it names while that one is still awaiting its first read. What
      // is dropped is a cancel for an id already finished with: it can change
      // nothing, and remembering it forever is how the set leaks.
      if (inFlight.has(request.target) || request.target > highestSettled) {
        cancelled.add(request.target)
      }
      return null
    case 'drop': {
      tracks.delete(request.entry)
      // …and let go of the parse behind it. A sequence store is up to three
      // hundred megabytes, and `recentFasta` exists only to answer the second of
      // two consecutive questions about one drop — holding a dropped genome
      // alive afterwards would be the largest leak in the application.
      const store = sequences.get(request.entry)
      if (store !== undefined && recentFasta?.store === store) recentFasta = null
      sequences.delete(request.entry)
      vectors.delete(request.entry)
      signals.delete(request.entry)
      // A BAI for a human WGS file is single-digit megabytes and the handle
      // behind it is a live filehandle; neither should outlive the row.
      alignments.delete(request.entry)
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Analysis tasks that belong here (§18.3)
// ---------------------------------------------------------------------------

/**
 * Run one task against the handles this worker already holds.
 *
 * The second venue. A metaplot's whole input is bigWigs and feature sets, and
 * both are already here — so the alternative is shipping the samples to a third
 * thread that has no reader for them, which lands N × W floats on the main
 * thread on the way past. `analysis/job.ts` sets out the split.
 *
 * `taskVersion` is left at zero and stamped by the main-thread runner, exactly
 * as the analysis worker leaves it: the descriptor lives on the main thread and
 * neither worker imports the registry.
 */
async function runTask(
  request: Extract<AnnotationRequest, { kind: 'run' }>,
): Promise<TaskResult> {
  const runner = TRACK_RUNNERS[request.task]
  if (runner === undefined) {
    throw new Error(`no track analysis runner is registered for the task ${request.task}`)
  }
  const notes: string[] = []
  const started = performance.now()
  const job: TrackJobContext = {
    params: request.params,
    framing: request.framing,
    inputs: request.inputs,
    // This worker has no cancel channel of its own: every task it runs is
    // bounded by the feature set it was given, and the ones that are not belong
    // in the analysis worker where the scan machinery is. Stated rather than
    // stubbed silently, so a long task added here is a decision and not a
    // surprise.
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: (done, total, note) => {
      const response: AnnotationResponse = {
        type: 'progress',
        id: request.id,
        done,
        total,
        ...(note === undefined ? {} : { note }),
      }
      ;(self as unknown as Worker).postMessage(response)
    },
    note: (text) => {
      notes.push(text)
    },
    // Under the *task's* id, so cancelling the analysis cancels the reads it
    // is waiting on rather than leaving them to finish into nothing.
    // No read style: a task asks a track for values, and the lane controls it
    // would otherwise inherit are a property of a *view*. An analysis over a
    // BAM therefore reads the default filter, which is the one `bam/pile.ts`
    // defends and the only one reproducible from the recorded provenance.
    sample: (entry, regions, basesPerPixel) =>
      sample(entry, regions, basesPerPixel, undefined, request.id),
    lengthOf: (contig) => request.inputs.contigLengths?.[contig],
  }
  const outputs = await runner(job)
  return {
    outputs,
    provenance: {
      task: request.task,
      taskVersion: 0,
      params: request.params,
      framing: request.framing,
      app: [VERSION, COMMIT].filter((part) => part !== '').join(' '),
      createdAt: new Date().toISOString(),
    },
    notes,
    ms: performance.now() - started,
  }
}

// ---------------------------------------------------------------------------
// What genome is this on
// ---------------------------------------------------------------------------

/**
 * Identify a file and say what sequences it knows about.
 *
 * The order is the order the answers get cheaper to trust, and it is also the
 * order they get cheaper to obtain:
 *
 * 1. **HDF5** — a contact map. Named and handed straight back, because the
 *    reader worker is what opens one; recognising it here is what lets a `.cool`
 *    dropped on a genome browser switch the session to the map rather than fail
 *    as an unreadable track.
 * 2. **BBI** — a bigWig or a bigBed. Its header carries every sequence and its
 *    true length, in a few kilobytes, at any file size.
 * 3. **`chrom.sizes`** — two columns, and the whole file is checked before it is
 *    believed, because one row of a BED looks exactly like one row of a sizes
 *    file ({@link looksLikeChromSizes}).
 * 4. **A feature file** — no lengths at all, so each sequence is reported as the
 *    end of its last feature. The browser draws it, and says the edges are a
 *    lower bound.
 */
async function assemblyOf(source: WireSource): Promise<AssemblyResult> {
  const handle = handleFor(source)
  // Sixty-four, for the same reason `load` reads sixty-four: eight settles the
  // HDF5 question and a BGZF member header is longer than that.
  const head = await handle.read(64, 0)
  if (isHdf5(head)) return { format: 'hdf5', contigs: [], origin: 'features', exact: true }

  const magic = bbiMagic(head)
  if (magic !== null) {
    const bbi =
      magic === 'bigwig'
        ? new BigWig({ filehandle: handleFor(source) })
        : new BigBed({ filehandle: handleFor(source) })
    const header = await bbi.getHeader()
    return {
      format: magic,
      contigs: contigsOfHeader(header),
      origin: magic,
      exact: true,
    }
  }

  // A BAM's `@SQ` table is every sequence and its exact length, so a dropped
  // `.bam` can start a browser session on its own — the same claim a FASTA
  // makes below, and the reason both are answered here rather than routed to
  // the reader worker. No index is needed to read a header, so this question is
  // answerable for a file that {@link load} would go on to refuse.
  if (isBgzf(head)) {
    const size = await sizeOf(handle)
    const header = await readBamFront(handle, size ?? Number.MAX_SAFE_INTEGER)
    if (header !== null) {
      return {
        format: 'bam',
        contigs: header.refs.map((ref) => ({ name: ref.name, length: ref.length })),
        // Its own origin, not `features`. `lengthsAreExact` reads this, and a
        // BAM's `@SQ` table carries a length per reference — so calling it a
        // feature file made the browser tell a reader its chromosomes end at
        // their last read, when they end where the header says.
        origin: 'bam',
        exact: true,
      }
    }
  }

  // A FASTA answers this question better than anything else can: it carries
  // every sequence *and* its exact length, like a `chrom.sizes`, and it is the
  // genome those lengths describe rather than a file asserting them.
  if (looksLikeFasta(head)) {
    const store = await readFasta(source, handle)
    return { format: 'fasta', contigs: store.contigs, origin: 'fasta', exact: true }
  }

  const raw = await handle.readFile()
  const bytes = await decodeAnnotationBytes(raw)
  // …and a gzipped one is only recognisable here, once it has been inflated.
  if (looksLikeFasta(bytes)) {
    const store = keepFasta(source, bytes)
    return { format: 'fasta', contigs: store.contigs, origin: 'fasta', exact: true }
  }
  const text = new TextDecoder().decode(bytes)
  if (text.trim() === '') throw new Error('This file is empty.')

  if (looksLikeChromSizes(text, source.name)) {
    recent = { key: cacheKey(source), format: 'sizes', features: null }
    return { format: 'sizes', contigs: parseChromSizes(text), origin: 'sizes', exact: true }
  }

  // Same order as `load`, and for the same reason: a bedGraph is BED-shaped and
  // would otherwise declare its assembly as a feature file's. The lengths are a
  // lower bound either way, so the answer is the same shape — but the *format*
  // is what routes the drop, and getting it wrong here sends a signal file to
  // the segments path.
  const signal = sniffSignal(text)
  if (signal !== null) {
    const set = signal === 'wig' ? parseWig(text) : parseBedGraph(text)
    recent = { key: cacheKey(source), format: signal, features: null }
    const ends = new Map<string, number>()
    for (const contig of set.contigs) {
      // The furthest *end*, not the last one: the intervals are sorted by start,
      // and a long interval early in a contig outruns every short one after it.
      let furthest = 0
      for (const end of contig.ends) if (end > furthest) furthest = end
      note(ends, contig.name, furthest)
    }
    return { format: signal, contigs: contigsOf(ends), origin: 'features', exact: false }
  }

  const format = sniffFormat(text, source.name)
  if (format === 'bedpe') {
    const data = parseBedpe(text)
    recent = { key: cacheKey(source), format, features: null }
    const ends = new Map<string, number>()
    for (let i = 0; i < data.length; i++) {
      note(ends, data.contigs[data.contig1[i]], data.end1[i])
      note(ends, data.contigs[data.contig2[i]], data.end2[i])
    }
    return { format, contigs: contigsOf(ends), origin: 'features', exact: false }
  }

  const data = format === 'gtf' ? parseGtf(text) : parseBed(text, source.name)
  recent = { key: cacheKey(source), format, features: data }
  const ends = new Map<string, number>()
  for (let i = 0; i < data.length; i++) note(ends, data.contigs[data.contig[i]], data.end[i])
  return { format, contigs: contigsOf(ends), origin: 'features', exact: false }
}

/**
 * Sequence names and lengths out of a BBI header, in the file's own order.
 *
 * `refsByNumber` rather than `refsByName`, because the latter is a map to
 * integer ids and carries no lengths — and because the file's own numbering is
 * the order a bigWig was written in, which is the order a reader expects its
 * chromosomes listed in.
 */
function contigsOfHeader(header: { refsByNumber: Record<number, RefInfo> }): Contig[] {
  return Object.values(header.refsByNumber)
    .sort((a, b) => a.id - b.id)
    .map((ref) => ({ name: ref.name, length: ref.length }))
}

/** Keep the furthest coordinate seen on a sequence. */
function note(ends: Map<string, number>, contig: string, end: number): void {
  const seen = ends.get(contig)
  if (seen === undefined || end > seen) ends.set(contig, end)
}

/**
 * Inferred lengths, in first-mention order.
 *
 * Rounded *up* to a round number, so a browser opened on a peak set does not
 * end each chromosome exactly on the last peak — which reads as a sequence that
 * stops there rather than as the limit of what this file knows.
 */
function contigsOf(ends: Map<string, number>): Contig[] {
  const out: Contig[] = []
  for (const [name, end] of ends) {
    const magnitude = 10 ** Math.max(3, Math.floor(Math.log10(Math.max(1, end))))
    out.push({ name, length: Math.ceil(end / magnitude) * magnitude })
  }
  return out
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * A read handle over a track file, signed when the bucket wants it signed.
 *
 * `generic-filehandle2` takes a `fetch` override, which is the whole hook: it
 * builds its own `Range` headers and calls through, so wrapping the fetcher
 * signs every read it makes — the first four magic bytes, a bigWig's header and
 * R-tree, and every zoom block afterwards — without this file knowing how many
 * requests that is.
 *
 * The signature is computed per call rather than once per handle, because
 * `x-amz-date` is signed and S3 refuses a stamp older than fifteen minutes. A
 * bigWig handle outlives that easily: it is kept for as long as the track is on
 * screen and re-read on every pan.
 */
function handleFor(source: WireSource): BlobFile | RemoteFile {
  if (source.kind === 'local') return new BlobFile(source.file)
  const { credential } = source
  if (credential === undefined) return new RemoteFile(source.url)
  return new RemoteFile(source.url, {
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      return fetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...signS3Request({ method: init?.method ?? 'GET', url, credential }),
        },
      })
    },
  })
}

/**
 * The text of just the sequences this map is about, or `null` to read it whole.
 *
 * Four conditions, and every one of them falls back rather than failing: there
 * has to be a sidecar, it has to inflate, it has to be a tabix index, and the
 * file itself has to be BGZF. A plain `.gz` with a `.tbi` beside it is a
 * mislabelled pair and is read whole, which is what happened before this
 * function existed.
 */
async function tryIndexedText(
  source: WireSource,
  handle: BlobFile | RemoteFile,
  head: Uint8Array,
  mapContigs: NamedSequence[],
): Promise<string | null> {
  const indexSource = indexSourceFor(source)
  if (indexSource === null) return null
  if (!isBgzf(head)) return null
  try {
    const indexBytes = await inflateBgzf(await handleFor(indexSource).readFile())
    const index = parseTabix(indexBytes)
    const size = await sizeOf(handle)
    if (size === null) return null
    const spans = spansFor(index, matchNames(index, namesOf(mapContigs)), size)
    if (spans.length === 0) return null
    // A "saving" that reads most of the file is not one, and the cost of finding
    // out was one small request. Below a fifth the index has earned its round
    // trip; above it the whole-file read is simpler and no slower.
    const bytes = spans.reduce((sum, span) => sum + (span.to - span.from), 0)
    if (bytes > size * 0.8) return null
    const parts: string[] = []
    for (const span of spans) {
      const compressed = await handle.read(span.to - span.from, span.from)
      // `span.lastBlock` is where the records stop mattering; everything past it
      // is the slack the fetch had to over-ask for. Fetched, not decoded.
      parts.push(
        new TextDecoder().decode(await inflateBgzf(compressed, span.lastBlock - span.from)),
      )
    }
    return parts.join('\n')
  } catch {
    // Every failure here is "this index did not work", and the answer to that is
    // the read that always worked. A sidecar that is corrupt, truncated, for a
    // different file or in a format this does not know must never be the reason
    // a track cannot be opened.
    return null
  }
}

/** The sidecar named beside this source, as a source of its own. */
function indexSourceFor(source: WireSource): WireSource | null {
  if (source.kind === 'local') {
    return source.index === undefined
      ? null
      : { kind: 'local', file: source.index, name: source.index.name }
  }
  if (source.index === undefined) return null
  return {
    kind: 'remote',
    url: source.index,
    name: source.index,
    ...(source.credential === undefined ? {} : { credential: source.credential }),
  }
}

/** The file's length, however the handle knows it. */
async function sizeOf(handle: BlobFile | RemoteFile): Promise<number | null> {
  const stat = (handle as { stat?: () => Promise<{ size: number }> }).stat
  if (typeof stat === 'function') {
    try {
      return (await stat.call(handle)).size
    } catch {
      return null
    }
  }
  return null
}

/**
 * Identify a file and read it, however it identifies itself.
 *
 * The first four bytes are read before anything else, and they are the whole of
 * the binary-or-text question: a BBI magic number means a bigWig or bigBed, and
 * everything else is decoded as text and sniffed by its columns. That order
 * matters — decoding 23 MB of bigWig as UTF-8 to discover it is not a BED would
 * be both slow and, for a remote file, a whole-file download.
 */
async function load(entry: string, source: WireSource, mapContigs: NamedSequence[]): Promise<LoadResult> {
  const handle = handleFor(source)
  // Sixty-four rather than four. A BBI magic number is four bytes and was all
  // this ever needed; recognising a BGZF member takes twelve plus its extra
  // field, and it is the same range request either way.
  const head = await handle.read(64, 0)
  const magic = bbiMagic(head)

  if (magic === 'bigwig') return loadBigWig(entry, source, mapContigs)
  if (magic === 'bigbed') return loadBigBed(source, mapContigs)
  // Asked before the text road, and only for a BGZF file: a BAM is a BGZF
  // container, so the question is one inflate of the first block deep. A
  // bgzipped *text* file falls through it and takes the tabix path it always
  // did.
  if (isBgzf(head)) {
    const size = await sizeOf(handle)
    const header = await readBamFront(handle, size ?? Number.MAX_SAFE_INTEGER)
    // A BGZF file that is not a BAM is a bgzipped text file, and takes the
    // tabix road below exactly as it always did.
    if (header !== null) {
      if (size === null) {
        throw new Error(`${source.name} cannot be measured, and a BAM is read by byte range.`)
      }
      return loadBam(entry, source, handle, mapContigs, header, size)
    }
  }
  if (looksLikeFasta(head)) return loadFasta(entry, await readFasta(source, handle), mapContigs)

  // The parse this file already had, when the browser asked what genome it was
  // on a moment ago. Same bytes, same answer; the overlap report is recomputed
  // because it is about the *map*, which that request knew nothing about.
  const cached = recent
  if (cached !== null && cached.key === cacheKey(source) && cached.features !== null) {
    // Spent by being handed over. `handle` posts this payload with
    // `transfersFor`, which moves the typed arrays' buffers to the main thread
    // and **detaches** them here — so the entry that answered this request is
    // now a set of arrays with no memory behind them. Left in place, the next
    // request for the same file hits it and `postMessage` refuses the whole
    // message with "ArrayBuffer at index 0 is already detached": dropping a
    // track and re-adding the same file drew nothing, while re-adding it under
    // a different name worked, because the name is half the cache key.
    recent = null
    return featureResult(cached.format, cached.features, mapContigs)
  }

  // The whole point of the index: read the sequences the map is about, and not
  // the other twenty-three. Falls through to the whole-file read below whenever
  // there is no sidecar, the sidecar is not a tabix index, or the file is a
  // plain `.gz` rather than a BGZF one — every one of which used to be the only
  // path and still is a working one (`annotations/tabix.ts`).
  const indexed = await tryIndexedText(source, handle, head, mapContigs)
  const bytes = indexed === null ? await decodeAnnotationBytes(await handle.readFile()) : null
  if (bytes !== null && looksLikeFasta(bytes)) {
    return loadFasta(entry, keepFasta(source, bytes), mapContigs)
  }
  const text = indexed ?? new TextDecoder().decode(bytes as Uint8Array)
  if (text.trim() === '') throw new Error('This file is empty.')

  // Asked before the feature sniffer, because the two overlap: a four-column
  // bedGraph is BED-shaped and `sniffFormat` would call it a BED, putting its
  // value column in `name` and drawing a lane of featureless boxes. The signal
  // sniffer is the stricter of the two — exactly four columns, numeric on every
  // row it looks at, or a declaration line saying so — which is what lets it go
  // first without capturing anything that is really a BED.
  const signal = sniffSignal(text)
  if (signal !== null) return loadSignal(entry, signal, text, mapContigs)

  const format: DetectedFormat = sniffFormat(text, source.name)
  if (format === 'bedpe') {
    const data = parseBedpe(text)
    const renaming = renameContigs(data.contigs, mapContigs)
    return {
      format,
      contigs: data.contigs,
      overlap: overlapReport(data.contigs, mapContigs, renaming),
      summary: `${count(data.length)} pair${data.length === 1 ? '' : 's'}`,
      payload: { kind: 'pairs', data },
    }
  }

  const data = format === 'gtf' ? parseGtf(text) : parseBed(text, source.name)
  // Deliberately *not* cached. This branch is about to hand `data` to the main
  // thread by transfer, so an entry made here would be detached before anything
  // could read it — the cache exists for the other order, where a genome was
  // identified from this file a moment ago and the parse can be reused.
  return featureResult(format, data, mapContigs)
}

/** One shape of answer for every format that resolves to intervals. */
function featureResult(
  format: DetectedFormat,
  data: FeatureSet,
  mapContigs: NamedSequence[],
): LoadResult {
  const exons = data.exonStart.length
  // Rewritten **in place**, which is what makes the rename cost nothing: every
  // row of the set indexes this array by position, so replacing the strings
  // renames every feature at once and no coordinate moves.
  const renaming = renameContigs(data.contigs, mapContigs)
  return {
    format,
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary:
      format === 'gtf'
        ? `${count(data.length)} transcripts · ${count(exons)} exons`
        : `${count(data.length)} feature${data.length === 1 ? '' : 's'}`,
    payload: { kind: 'features', data },
  }
}

// ---------------------------------------------------------------------------
// FASTA
// ---------------------------------------------------------------------------

/**
 * The file's sequences, parsed once however many times they are asked for.
 *
 * Opening a browser from a FASTA asks this worker the same two questions any
 * other file gets — *what genome is this* and then *give me its data* — and here
 * they have the same answer, so the second is served from {@link recentFasta}.
 * That cache is safe in a way {@link recent} is not: a sequence store is never
 * transferred, so there is no way for the entry to come back detached.
 */
async function readFasta(
  source: WireSource,
  handle: BlobFile | RemoteFile,
): Promise<SequenceStore> {
  const held = recentFasta
  if (held !== null && held.key === cacheKey(source)) return held.store
  // Refused before it is read, where the size is known without reading it. A
  // local file's is free; a remote one is found out the hard way, below.
  if (source.kind === 'local' && source.file.size > FASTA_BYTE_CAP) {
    throw tooLarge(source.file.size)
  }
  return keepFasta(source, await decodeAnnotationBytes(await handle.readFile()))
}

function keepFasta(source: WireSource, bytes: Uint8Array): SequenceStore {
  if (bytes.length > FASTA_BYTE_CAP) throw tooLarge(bytes.length)
  const store = parseFasta(bytes)
  if (store.contigs.length === 0) {
    throw new Error('This looks like a FASTA but holds no sequences.')
  }
  recentFasta = { key: cacheKey(source), store }
  return store
}

function tooLarge(size: number): Error {
  return new Error(
    `This FASTA is ${count(Math.round(size / 1e6))} MB. It would be read whole and held whole — ` +
      `which is what makes panning free — so anything over ${count(FASTA_BYTE_CAP / 1e6)} MB is ` +
      'refused rather than allowed to take the tab with it. A chrom.sizes declares the same ' +
      'genome for a few kilobytes.',
  )
}

/** A FASTA as a row: the sequences stay here, the summary goes back. */
function loadFasta(entry: string, store: SequenceStore, mapContigs: NamedSequence[]): LoadResult {
  const renaming = renameSequences(store, mapContigs)
  sequences.set(entry, store)
  const names = store.contigs.map((contig) => contig.name)
  return {
    format: 'fasta',
    contigs: names,
    overlap: overlapReport(names, mapContigs, renaming),
    summary: `${count(names.length)} sequence${names.length === 1 ? '' : 's'} · ${count(store.total)} bp`,
  }
}

/**
 * A FASTA's sequences, renamed into the map's vocabulary (§5.9).
 *
 * Both halves of the store, because they are looked up by different callers:
 * `contigs` is what the assembly and the sequence lane are built from, and
 * `bases` is what {@link gcSamples} indexes by the name of the region it was
 * asked about — which is the map's. A rename of one and not the other would
 * leave a sequence lane that draws its ruler and no residues.
 */
function renameSequences(store: SequenceStore, mapContigs: NamedSequence[]): Renaming {
  const renaming = renameInto(store.contigs, mapContigs)
  if (renaming.renamed === 0) return renaming
  const bases = new Map<string, Uint8Array>()
  store.contigs.forEach((contig, at) => {
    const held = store.bases.get(contig.name)
    contig.name = renaming.names[at]
    if (held !== undefined) bases.set(contig.name, held)
  })
  store.bases = bases
  return renaming
}

/**
 * GC content, in the shape a value track takes.
 *
 * Deliberately answered through `sample` rather than through a request of its
 * own: a GC profile *is* a value per window, so the caching, the power-of-two
 * resolution ladder and the per-pixel reduction that every bigWig already goes
 * through are exactly right for it, and reproducing any of that for one format
 * would be a second copy of the hard part (§8.4).
 *
 * `summary: true` because a bin is a mean over its bases in the same sense a
 * bigWig's zoom level is — the flag is what tells the readout that the number
 * under the pointer describes a window rather than a position.
 */
function gcSamples(
  store: SequenceStore,
  regions: Region[],
  basesPerPixel: number,
): TrackSampleSet {
  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const region of regions) {
    const seq = basesOf(store, region.contig)
    if (seq === undefined || !(region.end > region.start)) continue
    const bins = gcBins(seq, region.start, region.end, basesPerPixel)
    if (bins.values.length === 0) continue
    for (const value of bins.values) {
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    out.push({
      contig: region.contig,
      start: region.start,
      end: region.end,
      starts: bins.starts,
      ends: bins.ends,
      values: bins.values,
      min: null,
      max: null,
      summary: true,
    })
  }
  return { basesPerPixel, regions: out, extent: min <= max ? { min, max } : null }
}

/**
 * How many residues one request may bring back.
 *
 * Only asked for at a zoom where a base is at least a pixel, so a screen's worth
 * is a few thousand and this is two orders of magnitude of headroom. It is a
 * backstop against a caller asking for a chromosome, not a working limit.
 */
const BASES_PER_REQUEST = 400_000

/** The residues of each visible window, for a view drawing them one by one. */
function bases(entry: string, regions: Region[]): BaseResult {
  const store = sequences.get(entry)
  if (store === undefined) {
    throw new Error('This sequence is no longer open. Drop the file again.')
  }
  const out: BaseRegion[] = []
  let budget = BASES_PER_REQUEST
  for (const region of regions) {
    const seq = basesOf(store, region.contig)
    if (seq === undefined) continue
    const start = Math.max(0, Math.floor(region.start))
    const end = Math.min(seq.length, Math.ceil(region.end), start + budget)
    if (!(end > start)) continue
    budget -= end - start
    // `slice`, not `subarray`. The reply is posted with `transfersFor`, which
    // moves the buffer behind whatever typed arrays it finds — and a view onto
    // the store would take the entire chromosome with it, leaving this worker
    // holding a detached genome.
    out.push({ contig: region.contig, start, end, bases: seq.slice(start, end) })
    if (budget <= 0) break
  }
  return { regions: out }
}

/**
 * How many intervals a bigBed may contribute before it is cut off.
 *
 * A bigBed is read whole, exactly as a BED is, and for the same reason: a
 * `FeatureSet` lives on the main thread so that a pan redraws with no round trip
 * (§8.4), and a windowed one would give that up. Most bigBeds are gene models or
 * peak calls and are well under this; a variant track is not, and the cap is
 * what stops one from taking the tab with it. It is *reported* rather than
 * silently applied — a truncated track that says so is usable, one that does not
 * is a lie about the genome.
 */
const BIGBED_FEATURE_CAP = 1_000_000

/**
 * A bigBed, read whole and parsed as the BED it is.
 *
 * bbi hands back `{ start, end, rest }` per feature, where `rest` is the
 * remaining BED columns exactly as they were written. Re-joining them into BED
 * lines and running the ordinary parser is not a shortcut: it is what makes a
 * bigBed12 draw its exons, a bigNarrowPeak keep its score, and a renamed column
 * behave the same way it does in the text file it came from — one parser, one
 * set of rules, one place where BED's quirks live.
 */
async function loadBigBed(source: WireSource, mapContigs: NamedSequence[]): Promise<LoadResult> {
  const bigbed = new BigBed({ filehandle: handleFor(source) })
  const header = await bigbed.getHeader()
  const refs = contigsOfHeader(header)
  const lines: string[] = []
  let truncated = false
  for (const ref of refs) {
    if (lines.length >= BIGBED_FEATURE_CAP) {
      truncated = true
      break
    }
    const features = await bigbed.getFeatures(ref.name, 0, ref.length)
    for (const feature of features) {
      if (lines.length >= BIGBED_FEATURE_CAP) {
        truncated = true
        break
      }
      const rest = typeof feature.rest === 'string' && feature.rest !== '' ? `\t${feature.rest}` : ''
      lines.push(`${ref.name}\t${feature.start}\t${feature.end}${rest}`)
    }
  }
  const data = parseBed(lines.join('\n'), source.name)
  const result = featureResult('bigbed', data, mapContigs)
  return {
    ...result,
    summary: truncated
      ? `${count(data.length)} features · cut off at ${count(BIGBED_FEATURE_CAP)}`
      : result.summary,
  }
}

async function loadBigWig(
  entry: string,
  source: WireSource,
  mapContigs: NamedSequence[],
): Promise<LoadResult> {
  const bigwig = new BigWig({ filehandle: handleFor(source) })
  const header = await bigwig.getHeader()
  // Renamed into the map's vocabulary at the door (§5.9), so the contig list
  // this reports, the overlap it is judged by and the regions it is later asked
  // for are all in one spelling. `sourceOf` is the way back to the file's own,
  // which is the one thing about a bigWig that cannot be rewritten.
  // **With the lengths the header carries**, via `contigsOfHeader`. Names alone
  // leave the matcher with nothing to check itself against: an hg19 track on an
  // hg38 map would rename `MT` onto `chrM` and report it as an ordinary match,
  // and a map holding both `chrM` and `chrMT` could not be chosen between at
  // all (§5.9).
  const renaming = renameInto(contigsOfHeader(header), mapContigs)
  const contigs = renaming.names
  tracks.set(entry, {
    bigwig,
    refOf: renaming.sourceOf,
    refNames: Object.keys(header.refsByName),
  })

  const total = header.totalSummary
  // A file whose header carries no summary block reports zeros; that is not a
  // range, and offering `[0, 0]` as a starting clip would paint a blank lane.
  const usable =
    total !== undefined &&
    Number.isFinite(total.scoreMin) &&
    Number.isFinite(total.scoreMax) &&
    total.scoreMax > total.scoreMin

  return {
    format: 'bigwig',
    contigs,
    overlap: overlapReport(contigs, mapContigs, renaming),
    // The zoom-level count used to lead this line. It is a fact about how the
    // file was built, not about what is in it: nothing the reader can act on,
    // and it pushed the one number they can — the value range — onto a second
    // line in a narrow panel.
    summary:
      `${count(contigs.length)} contigs` +
      (usable ? ` · ${trim(total.scoreMin)} to ${trim(total.scoreMax)}` : ''),
    ...(usable ? { fileExtent: { min: total.scoreMin, max: total.scoreMax } } : {}),
  }
}

/**
 * Read a bedGraph or a wig, and keep it.
 *
 * Unlike every other text format, the parsed result is **not** returned to the
 * main thread. It is a track, and a track's data lives in the worker and is
 * sampled per view — which is the whole reason a bedGraph gets a range, a
 * ceiling and an autoscale without one line of new UI.
 */
function loadSignal(
  entry: string,
  format: SignalFormat,
  text: string,
  mapContigs: NamedSequence[],
): LoadResult {
  const set = format === 'wig' ? parseWig(text) : parseBedGraph(text)
  if (set.length === 0) {
    throw new Error(
      `This looks like a ${format === 'wig' ? 'wig' : 'bedGraph'} but holds no usable intervals.`,
    )
  }
  const renaming = renameInto(
    set.contigs.map((contig) => ({ name: contig.name })),
    mapContigs,
  )
  set.contigs.forEach((contig, at) => {
    contig.name = renaming.names[at]
  })
  const track = new IntervalTrack(set)
  signals.set(entry, track)
  const contigs = track.contigNames
  const { min, max } = track.extent
  const usable = Number.isFinite(min) && Number.isFinite(max) && max > min
  return {
    format,
    contigs,
    overlap: overlapReport(contigs, mapContigs, renaming),
    summary:
      `${count(track.length)} intervals · ${count(contigs.length)} contigs` +
      (usable ? ` · ${trim(min)} to ${trim(max)}` : ''),
    ...(usable ? { fileExtent: { min, max } } : {}),
  }
}

/** One `sample` answer from a text signal file. */
function signalSamples(
  track: IntervalTrack,
  regions: readonly Region[],
  basesPerPixel: number,
): TrackSampleSet {
  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const region of regions) {
    if (!track.has(region.contig) || region.end <= region.start) continue
    const got = track.samples(region.contig, region.start, region.end, basesPerPixel)
    if (got === null) continue
    for (const value of got.values) {
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    out.push({ contig: region.contig, start: region.start, end: region.end, ...got })
  }
  return { basesPerPixel, regions: out, extent: min <= max ? { min, max } : null }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * The values a view needs, for every visible region at once.
 *
 * One `getFeaturesAsArraysMulti` call rather than a call per contig: it picks a
 * single zoom level for the whole request, coalesces on-disk blocks that happen
 * to be adjacent *across* region boundaries, and packs everything into one set
 * of typed arrays. On a whole-genome view of yeast that is sixteen regions
 * answered by a handful of range requests instead of sixteen independent
 * round trips.
 *
 * Regions naming a contig this file has never heard of are dropped here rather
 * than sent: bbi answers them with an empty array, which is correct but costs a
 * slot in the packed result that the caller would then have to reconcile.
 */
async function sample(
  entry: string,
  regions: Region[],
  basesPerPixel: number,
  style: ReadStyle | undefined,
  id: number,
): Promise<TrackSampleSet> {
  // Asked first, because it is the only probe that can decline and the only one
  // that can be called off — and because an alignment entry is in no other
  // store, so reaching any of them would mean it had already gone wrong.
  const open = alignments.get(entry)
  if (open !== undefined) return alignmentSamples(id, open, regions, basesPerPixel, style)

  // A FASTA answers the same question with the same shape of answer, and this
  // is where the two formats part company: one has zoom levels on disk, the
  // other computes its summary from the residues it is holding.
  const sequence = sequences.get(entry)
  if (sequence !== undefined) return gcSamples(sequence, regions, basesPerPixel)

  // A text signal file is the fourth, and the closest of them to a bigWig: the
  // same intervals-and-values answer, summarised here rather than on disk.
  const signal = signals.get(entry)
  if (signal !== undefined) return signalSamples(signal, regions, basesPerPixel)

  // And a computed vector is the third: no file, no zoom levels, a summary
  // built for the window it was asked about (§18.5, `binVector.ts`). It is
  // looked up here, in the one function every lane's values come out of, which
  // is precisely what stops a synthetic track needing a renderer of its own.
  const vector = vectors.get(entry)
  if (vector !== undefined) return binVectorSamples(vector, regions, basesPerPixel)

  const track = tracks.get(entry)
  if (track === undefined) {
    throw new Error('This track is no longer open. Drop the file again.')
  }
  // `refOf` holds the map this track was loaded against, plus every refName
  // answering to itself. A *companion* of a deck asks by a third spelling — its
  // own — so a name that reaches neither gets the ladder (§5.9), and what it
  // finds is remembered, so the next frame of the same pan is one `Map` probe.
  const refOf = (name: string): string | undefined => {
    const held = track.refOf.get(name)
    if (held !== undefined) return held
    const at = contigIndexOf(track.refNames, name)
    if (at < 0) return undefined
    track.refOf.set(name, track.refNames[at])
    return track.refNames[at]
  }
  const wanted = regions.filter(
    (region) => refOf(region.contig) !== undefined && region.end > region.start,
  )
  if (wanted.length === 0) return { basesPerPixel, regions: [], extent: null }

  const packed = await track.bigwig.getFeaturesAsArraysMulti(
    wanted.map((region) => ({
      // The file's own spelling goes to the reader; the map's comes back out
      // below, so nothing downstream of here sees two vocabularies.
      refName: refOf(region.contig) ?? region.contig,
      start: Math.max(0, Math.floor(region.start)),
      end: Math.ceil(region.end),
    })),
    // bbi calls it `basesPerSpan`; it is bases per pixel, and it is what selects
    // the file's own pre-computed zoom level (§8.2). Never below 1: asking for
    // a fraction of a base is asking for base resolution, which is what 1 means.
    { basesPerSpan: Math.max(1, basesPerPixel) },
  )

  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < wanted.length; i++) {
    const from = packed.regionOffsets[i]
    const to = packed.regionOffsets[i + 1]
    const values = packed.scores.slice(from, to)
    for (let k = 0; k < values.length; k++) {
      const value = values[k]
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    // `slice`, not `subarray`: each region's arrays are transferred separately,
    // and views sharing one buffer would detach each other on the way across.
    out.push({
      contig: wanted[i].contig,
      start: wanted[i].start,
      end: wanted[i].end,
      starts: packed.starts.slice(from, to),
      ends: packed.ends.slice(from, to),
      values,
      min: packed.isSummary ? packed.minScores.slice(from, to) : null,
      max: packed.isSummary ? packed.maxScores.slice(from, to) : null,
      summary: packed.isSummary,
    })
  }

  return {
    basesPerPixel,
    regions: out,
    extent: min <= max ? { min, max } : null,
  }
}

// ---------------------------------------------------------------------------
// Alignments (§8.13)
// ---------------------------------------------------------------------------

/**
 * How much of the file to inflate looking for the end of the header.
 *
 * Grown rather than guessed, because the reference table is not small on the
 * files this viewer exists for: a co-assembly of twenty thousand contigs writes
 * about a megabyte of names and lengths, spanning a dozen BGZF blocks. "Inflate
 * the first block and parse" is wrong on precisely those, and wrong silently —
 * it reads as a corrupt file.
 */
const HEADER_FIRST_READ = 1 << 18
const HEADER_MAX_READ = 1 << 24

/**
 * Whether a BGZF file's first block begins a BAM.
 *
 * One block, which is always enough: `BAM\\1` is the first four bytes of the
 * first block's *inflated* content, and no BGZF block exceeds 64 KiB
 * compressed. A bgzipped GTF answers `false` here and goes down the tabix road
 * it always did.
 */
/**
 * The front of a BGZF file, inflated once and answered twice.
 *
 * *Is this a BAM* and *what is in its header* are two questions about the same
 * bytes, and asking them separately cost two range requests over the same span
 * — plus a third, because `load` had already read the first sixty-four bytes to
 * decide the file was BGZF at all. On a remote file that is §12's whole budget
 * for opening one, spent before the index is even fetched.
 *
 * `null` means the file is BGZF and is not a BAM, which is an ordinary answer:
 * a bgzipped GTF takes the tabix road from here.
 */
async function readBamFront(
  handle: BlobFile | RemoteFile,
  size: number,
): Promise<BamHeader | null> {
  let want = HEADER_FIRST_READ
  for (;;) {
    let inflated: Uint8Array
    try {
      inflated = await inflateBgzf(await handle.read(Math.min(want, size), 0))
    } catch {
      // Not inflatable is not a BAM, and is not this function's error to raise:
      // the road it falls through to reads the file whole and reports properly.
      return null
    }
    if (!isBam(inflated)) return null
    const header = readHeader(inflated)
    if (header !== null) return header
    // `null` from `readHeader` means the buffer stopped mid-table — the
    // multi-block header of a co-assembly — and nothing else does.
    if (want >= size || want >= HEADER_MAX_READ) {
      throw new Error('This BAM\'s header is truncated: its reference table does not end.')
    }
    want = Math.min(want * 4, HEADER_MAX_READ)
  }
}

/**
 * Open a BAM, or say exactly why not.
 *
 * Two refusals, and both name the command that fixes them (§10). They are the
 * price of §8.13's carve-out from §13 and they have to be legible, because a
 * reader who is told only "this file cannot be opened" will reasonably conclude
 * the app cannot read BAMs at all.
 */
async function loadBam(
  entry: string,
  source: WireSource,
  handle: BlobFile | RemoteFile,
  mapContigs: NamedSequence[],
  /** Already read, by whichever branch decided this was a BAM — never re-read. */
  header: BamHeader,
  size: number,
): Promise<LoadResult> {
  if (header.sortOrder === 'queryname' || header.sortOrder === 'unsorted') {
    // Not a technicality: every byte this reader fetches is addressed by an
    // index that only describes a coordinate-sorted file, so a name-sorted one
    // handed to a region query answers with whatever was in those blocks.
    throw new Error(
      `${source.name} is sorted by ${header.sortOrder === 'queryname' ? 'read name' : 'nothing'}, ` +
        'and reads are drawn by region. Run ' +
        `\`samtools sort -o sorted.bam ${source.name}\` and index the result.`,
    )
  }

  const indexSource = indexSourceFor(source)
  if (indexSource === null) {
    throw new Error(
      `${source.name} has no index beside it. Unlike every other format here a BAM has no ` +
        'whole-file fallback — it is read by region, and the index is the only thing that ' +
        `makes that bounded. Drop \`${source.name}.bai\` alongside it, or run ` +
        `\`samtools index ${source.name}\`.`,
    )
  }
  let index: BamIndex
  try {
    index = await parseBamIndex(await handleFor(indexSource).readFile())
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    // Three different fixes, so three different messages. A reader who has just
    // dropped a file wants to know which of them happened.
    //
    // The remote case is the one worth separating: the sidecar URL there was
    // **guessed** — `<url>.bai`, never probed, because §12 has no request to
    // spend finding out that a file has no index — so the commonest failure is
    // not a corrupt index but no index at that address at all. Saying "could
    // not be read" would send a reader looking for a broken file that does not
    // exist, when what they need is the `#index=` convention or a `samtools
    // index` run on the host.
    if (source.kind === 'remote') {
      throw new Error(
        `No index could be read for ${source.name} at ${indexSource.kind === 'remote' ? indexSource.url : ''} — ${why} ` +
          'A BAM is read by region and cannot be opened without one. If the index is published ' +
          `elsewhere, name it: \`${source.url}#index=<url of the .bai>\`.`,
      )
    }
    throw new Error(
      `${source.name}'s index could not be read: ${why} ` +
        `Re-make it with \`samtools index ${source.name}\`.`,
    )
  }

  // Renamed into the map's vocabulary at the door (§5.9), exactly as a bigWig
  // is and for the same reason: the contig list this reports, the overlap it is
  // judged by and the regions it is later asked for are then all in one
  // spelling. **With the lengths** the `@SQ` table carries, because a matcher
  // given names alone has nothing to check its own guesses against — an hg19
  // alignment on an hg38 map would rename `MT` onto `chrM` and report it as an
  // ordinary match.
  const renaming = renameInto(header.refs, mapContigs)
  const contigs = renaming.names

  // The map's spelling to this file's reference id. `renameInto` preserves the
  // source order, so index *is* the id; the file's own spellings are added
  // after and never overwrite a rename, for the deck companion that asks by a
  // third convention.
  const refIdOf = new Map<string, number>()
  for (let id = 0; id < contigs.length; id++) refIdOf.set(contigs[id], id)
  for (let id = 0; id < header.refs.length; id++) {
    if (!refIdOf.has(header.refs[id].name)) refIdOf.set(header.refs[id].name, id)
  }

  alignments.set(entry, {
    handle,
    header,
    index,
    size,
    refIdOf,
    refNames: header.refs.map((ref) => ref.name),
  })

  return {
    format: 'bam',
    contigs,
    overlap: overlapReport(contigs, mapContigs, renaming),
    summary: `${count(header.refs.length)} reference${header.refs.length === 1 ? '' : 's'} · ${index.format.toUpperCase()}`,
  }
}

/**
 * Depth per pixel over the regions a lane is drawing (§8.13).
 *
 * The fifth probe in {@link sample}, and the one that can decline. Every other
 * kind can answer any window: a bigWig picks a zoom level, a FASTA is held
 * whole, a computed vector spans what it was computed over. A BAM has no
 * summary layer at all, so depth over a window is a full read of the reads
 * under it — and the honest behaviour above what that can cost is to draw
 * nothing and say why, rather than to draw an estimate of a different quantity.
 *
 * The estimate that was considered and rejected is the BAI linear index's byte
 * density. It is compressed *bytes* per 16 kb, not depth; it is wrong wherever
 * read length or compressibility varies; and CSI has no linear index at all, so
 * it would simply be absent on the files with the longest chromosomes. Drawing
 * it on a depth axis would be the first quantitative lane here that means
 * something other than what it says — the rule `__unbinned__` and the bigBed
 * truncation notice are both instances of.
 */
/**
 * The record filter a lane's controls come to, for **depth**.
 *
 * The part of a `ReadStyle` that decides what is *counted*, read on every
 * request rather than stored: see the note on the `sample` request in
 * `protocol.ts` for why the controls travel rather than being configured.
 *
 * `hideDuplicates` adds to the default exclusions rather than replacing them,
 * so turning it on cannot quietly re-admit the secondary and supplementary
 * alignments that `bam/pile.ts` argues out of every count. Nothing here can
 * admit a supplementary alignment at all — see {@link pileFilterOf}.
 */
function filterOf(style: ReadStyle | undefined): PileFilter {
  if (style === undefined) return DEFAULT_FILTER
  return {
    exclude: DEFAULT_EXCLUDE | (style.hideDuplicates ? FLAG.DUPLICATE : 0),
    minMapq: style.minMapq,
  }
}

/**
 * The same, for the **pile** — where one switch more is allowed.
 *
 * `splits` admits supplementary alignments, and this is the only place in the
 * application where they are admitted. The asymmetry is the point and it is
 * not an oversight: a supplementary record is a second piece of one molecule,
 * so drawing it shows a reader where the molecule went, and counting it would
 * report one fragment as two. Depth therefore never sees them, however the
 * lane is set.
 */
function pileFilterOf(style: ReadStyle): PileFilter {
  const base = filterOf(style)
  return style.splits ? { ...base, exclude: base.exclude & ~FLAG.SUPPLEMENTARY } : base
}

async function alignmentSamples(
  id: number,
  open: OpenBam,
  regions: Region[],
  basesPerPixel: number,
  style: ReadStyle | undefined,
): Promise<TrackSampleSet> {
  const refIdOf = (name: string): number | undefined => {
    const held = open.refIdOf.get(name)
    if (held !== undefined) return held
    const at = contigIndexOf(open.refNames, name)
    if (at < 0) return undefined
    open.refIdOf.set(name, at)
    return at
  }

  const wanted = regions.filter(
    (region) => refIdOf(region.contig) !== undefined && region.end > region.start,
  )
  if (wanted.length === 0) return { basesPerPixel, regions: [], extent: null }

  // The forecast, before a byte of alignment data is read. Every region at
  // once, because a whole-genome view asks for one window per contig and
  // refusing them one at a time would draw a lane that is partly there.
  const plans = wanted.map((region) => ({
    region,
    refId: refIdOf(region.contig) as number,
    spans: chunksFor(
      open.index,
      refIdOf(region.contig) as number,
      Math.max(0, Math.floor(region.start)),
      Math.ceil(region.end),
      open.size,
    ),
  }))
  const forecast = plans.reduce((sum, plan) => sum + forecastBytes(plan.spans), 0)
  if (forecast > WINDOW_BYTE_CAP) {
    return {
      basesPerPixel,
      regions: [],
      extent: null,
      // Short on purpose. It is drawn where a lane's value range goes, and that
      // sits in the name column's gutter: a sentence of advice there widens the
      // gutter for every lane in the stack. The number and the way out are what
      // a reader can act on; the bigWig-sidecar suggestion lives in §8.13.
      note: `${formatBytes(forecast)} of reads — zoom in`,
    }
  }

  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const plan of plans) {
    const span = plan.region.end - plan.region.start
    const bins = Math.max(1, Math.min(4096, Math.round(span / Math.max(1, basesPerPixel))))
    const depth = new Float64Array(bins)
    for (const byteSpan of plan.spans) {
      // Between blocks, so a pan that has moved on stops this rather than
      // holding the one thread every other lane's `sample` is waiting on.
      if (!(await stillWanted(id))) throw abortError()
      const compressed = await open.handle.read(byteSpan.to - byteSpan.from, byteSpan.from)
      const inflated = await inflateBgzf(compressed, byteSpan.lastBlock - byteSpan.from)
      const result = coverageOf(
        inflated,
        // Not zero. A BGZF block boundary is not a record boundary, so the
        // first wanted record starts wherever the chunk's virtual offset says
        // inside this block — see `bam/index.ts`'s `ByteSpan.dataFrom`.
        byteSpan.dataFrom,
        plan.refId,
        Math.floor(plan.region.start),
        Math.ceil(plan.region.end),
        bins,
        filterOf(style),
      )
      // Summed across spans rather than concatenated: a read overlapping the
      // window may live in any of them, and the bins are the same bins.
      for (let i = 0; i < bins; i++) depth[i] += result.depth[i]
    }

    const starts = new Int32Array(bins)
    const ends = new Int32Array(bins)
    const values = new Float32Array(bins)
    const width = span / bins
    for (let i = 0; i < bins; i++) {
      starts[i] = Math.round(plan.region.start + i * width)
      ends[i] = Math.round(plan.region.start + (i + 1) * width)
      values[i] = depth[i]
      if (depth[i] < min) min = depth[i]
      if (depth[i] > max) max = depth[i]
    }
    out.push({
      contig: plan.region.contig,
      start: plan.region.start,
      end: plan.region.end,
      starts,
      ends,
      values,
      min: null,
      max: null,
      // Depth *is* the summary — there is no finer value behind it to have
      // rolled up, so claiming one would put a min/max band on a lane that has
      // none.
      summary: false,
    })
  }

  return {
    basesPerPixel,
    regions: out,
    // Two decisions in one line.
    //
    // The floor is a real zero rather than the smallest value sampled, because
    // depth is a count: a lane autoscaled from 3 to 40 draws a region with
    // three reads on it as though it had none, and one with forty as though it
    // were saturated.
    //
    // And an all-zero window has **no** extent rather than `{0, 0}`. A region
    // with no reads in it is still answered — the lane draws a flat line on its
    // baseline, which is the honest picture and is distinguishable from a lane
    // that was never asked — but a zero-height axis is not a range, and handing
    // one to `resolveLimits` is how a lane ends up rescaled to nothing the
    // moment a reader pans across an empty contig.
    extent: min <= max && max > 0 ? { min: 0, max } : null,
  }
}

/**
 * How many compressed bytes a *read* window may cost.
 *
 * Lower than the coverage cap, and deliberately. A coverage band answers a
 * question about a whole region and is worth waiting a moment for; a pile is
 * only legible at a width where the bytes under it are few, so a pile that
 * needs four megabytes is a pile nobody can read anyway. Refusing early is
 * kinder than drawing twenty thousand one-pixel rectangles.
 */
const READ_BYTE_CAP = 4 << 20

/**
 * The widest window that is offered reads at all.
 *
 * Independent of the byte cap and needed beside it: a sparse region can be
 * cheap in bytes and still be a megabase wide, where a 100 bp read is a fifth
 * of a pixel. Reads stop meaning anything long before the bytes run out.
 */
const READ_MAX_SPAN = 200_000

/**
 * The bases-per-pixel at which a read's *name* could be read off the screen.
 *
 * Names are the largest thing in a pile — one string per read — and they are
 * only ever wanted for a dialog. But they are also what joins two records into
 * one template, so they are always *read* in the worker and only sometimes
 * shipped (`bam/reads.ts`).
 */
const NAMES_BELOW = 40

/**
 * The reads under a window, packed and ready to draw (§8.13).
 *
 * The second road out of an open BAM, standing to {@link alignmentSamples}
 * exactly as `bases` stands to `sample`: a different kind of answer over a
 * narrower window, asked for only by a surface that can draw it.
 */
async function readsFor(
  entry: string,
  regions: Region[],
  maxRows: number,
  basesPerPixel: number,
  style: ReadStyle,
  id: number,
): Promise<ReadWindow> {
  const open = alignments.get(entry)
  if (open === undefined) {
    throw new Error('This track is no longer open. Drop the file again.')
  }
  const empty: ReadWindow = {
    piles: [], bases: [], total: 0, kept: 0, capped: false, rows: 0, diffs: 'none',
  }

  const refIdOf = (name: string): number | undefined => {
    const held = open.refIdOf.get(name)
    if (held !== undefined) return held
    const at = contigIndexOf(open.refNames, name)
    if (at < 0) return undefined
    open.refIdOf.set(name, at)
    return at
  }

  const wanted = regions.filter(
    (region) => refIdOf(region.contig) !== undefined && region.end > region.start,
  )
  if (wanted.length === 0) return empty

  const span = wanted.reduce((sum, region) => sum + (region.end - region.start), 0)
  if (span > READ_MAX_SPAN) {
    return { ...empty, note: `${trim(span / 1000)} kb — too wide to draw reads` }
  }

  const plans = wanted.map((region) => ({
    region,
    refId: refIdOf(region.contig) as number,
    spans: chunksFor(
      open.index,
      refIdOf(region.contig) as number,
      Math.max(0, Math.floor(region.start)),
      Math.ceil(region.end),
      open.size,
    ),
  }))
  const forecast = plans.reduce((sum, plan) => sum + forecastBytes(plan.spans), 0)
  if (forecast > READ_BYTE_CAP) {
    return { ...empty, note: `${formatBytes(forecast)} of reads here — zoom in` }
  }

  const piles: ReadPile[] = []
  const bases: BaseCounts[] = []
  let total = 0
  let kept = 0
  let capped = false
  let rows = 0
  let usedMd = false
  let usedCigar = false
  let usedReference = false

  for (const plan of plans) {
    // Residues for this window, if some FASTA in this worker happens to hold
    // them. Free where it answers, and the only mismatch source that works on
    // an assembly nobody has published — see `bam/reads.ts`.
    const reference = residuesFor(plan.region)
    if (reference !== undefined) usedReference = true

    for (const byteSpan of plan.spans) {
      if (!(await stillWanted(id))) throw abortError()
      const compressed = await open.handle.read(byteSpan.to - byteSpan.from, byteSpan.from)
      const inflated = await inflateBgzf(compressed, byteSpan.lastBlock - byteSpan.from)
      const result = pileOf(
        inflated,
        byteSpan.dataFrom,
        plan.region.contig,
        plan.refId,
        Math.floor(plan.region.start),
        Math.ceil(plan.region.end),
        {
          // Two filters, and the asymmetry is the whole of the split-read
          // switch: `filter` is what is counted and never sees a supplementary
          // alignment, `pile` is what is drawn and does when the reader asks.
          filter: filterOf(style),
          pile: pileFilterOf(style),
          maxRows,
          maxReads: MAX_READS,
          colourBy: style.colourBy,
          withNames: basesPerPixel <= NAMES_BELOW,
          // The header's own table, which is the only place a `next_refID`
          // means anything. Held here rather than sent: `nameMates` asks it for
          // the handful of ids a window's mates actually land on.
          refNameOf: (id: number) => open.refNames[id],
          ...(reference === undefined ? {} : { reference }),
        },
      )
      total += result.total
      kept += result.kept
      capped = capped || result.capped
      rows = Math.max(rows, result.rows)
      usedMd = usedMd || result.usedMd
      usedCigar = usedCigar || result.usedCigar
      if (result.pile.length > 0 || piles.length === 0) {
        piles.push(result.pile)
        bases.push(result.counts)
      }
    }
  }

  return {
    piles,
    bases,
    total,
    kept,
    capped,
    rows,
    // In the order `bam/reads.ts` tries them, so the lane names the most direct
    // source that actually answered.
    diffs: usedCigar ? 'cigar' : usedMd ? 'md' : usedReference ? 'reference' : 'none',
  }
}

/** A hard ceiling on reads, whatever the rows allow. */
const MAX_READS = 20_000

/**
 * Residues covering a region, from any FASTA this worker already holds.
 *
 * A scan across the open sequence stores rather than one lookup, because they
 * are keyed by the *entry* that owns them and an alignment lane has no idea
 * which row a genome was dropped as. Cheap: there is rarely more than one, and
 * this runs once per fetched window rather than per frame.
 */
function residuesFor(region: Region): { start: number; bases: Uint8Array } | undefined {
  for (const store of sequences.values()) {
    const held = basesOf(store, region.contig)
    if (held === undefined) continue
    const start = Math.max(0, Math.floor(region.start))
    const end = Math.min(held.length, Math.ceil(region.end))
    if (end <= start) continue
    return { start, bases: held.subarray(start, end) }
  }
  return undefined
}

/** `8.4 MB`, for a refusal that has to name a number a reader can act on. */
function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} kB`
}

// ---------------------------------------------------------------------------
// Formatting, for the one-line summaries
// ---------------------------------------------------------------------------

function count(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

/** A header statistic with enough digits to be useful and no more. */
function trim(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  if (magnitude >= 1000 || magnitude === 0) return value.toFixed(0)
  if (magnitude >= 1) return value.toFixed(2).replace(/\.?0+$/, '')
  return value.toPrecision(2)
}
