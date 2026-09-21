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
import {
  blockSize,
  inflateBgzf,
  isBgzf,
  matchNames,
  parseTabix,
  spansFor,
  type ByteSpan,
} from '../tabix'
import { parseVcf, samplesIn, sniffVcf, vcfContigs } from '../vcf'
import { barChartSummary, isBarChartSchema, parseBarChart, sniffBarChart } from '../barchart'
import { g3dSummary, parseBed3d, parseG3d, sniffBed3d, sniffG3d } from '../g3d'
import { g3dBinaryNote, isG3dBinary, readG3dHeader, readG3dModel, type G3dHeader } from '../g3dBinary'
import { DEFAULT_EXCLUDE, FLAG, isBam, readHeader, type BamHeader } from '../bam/format'
import { chunksFor, forecastBytes, parseBamIndex, type BamIndex, type ByteSpan as BamByteSpan } from '../bam/index'
import { BamSearch, placeLabel, UnsortedError } from '../bam/search'
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
import { CachedRemoteFile } from './cachedFile'

import { applyAccess } from '../../sources/access'

import { transfersFor } from '../../worker/protocol'
import { yieldToEventLoop } from '../../async'
import { LOAD_REPORT_MS, startBusyProbe } from '../../perf/busy'
import { looksLikeChromSizes, parseChromSizes, type Contig } from '../../genome/assembly'
import { fmt } from '../../units'
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
import { byteRange, contigsOf as contigsOfIndex, parseFai, residuesIn, type FaiRecord } from '../fai'
import { FASTA_NAME, guessedIndexUrl } from '../sidecar'
import { interactSummary, isInteractSchema, parseInteract, sniffInteract } from '../interact'
import { longRangeSummary, parseLongRange, sniffLongRange } from '../longrange'
import { genePredSummary, isGenePredSchema, parseGenePred, sniffGenePred } from '../genepred'
import {
  bedMethylSummary,
  isBedMethylSchema,
  parseBedMethyl,
  sniffBedMethyl,
  type BedMethylResult,
} from '../bedmethyl'
import {
  contigsOfRecords,
  dnaByteRange,
  looksLikeTwoBit,
  openTwoBit,
  unpackDna,
  type TwoBitRecord,
} from '../twobit'
import {
  decodeAnnotationBytes,
  parseBed,
  parseBedpe,
  parseGtf,
  sniffFormat,
} from '../parse'
import type {
  BaseRegion,
  ContigOverlap,
  FeatureSet,
  PairSet,
  ReadPile,
  ReadStyle,
  ReadWindow,
  Region,
  TrackSamples,
  TrackSampleSet,
} from '../types'
import { DETAIL_SEP } from '../types'
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

/**
 * {@link basesOf} for a ranged store: the record, by the same ladder of names.
 *
 * Generic over the two record types because the ladder is about *spelling* and
 * knows nothing about what a record holds — and writing it twice is how the
 * `.2bit` arm would come to disagree with the `.fai` one about which alias to
 * try next.
 */
function recordOf<T extends { name: string }>(
  store: { records: Map<string, T>; contigs: Contig[] },
  name: string,
): T | undefined {
  const direct = store.records.get(name)
  if (direct !== undefined) return direct
  const at = contigIndexOf(store.contigs, name)
  return at < 0 ? undefined : store.records.get(store.contigs[at].name)
}

/**
 * The residues `[start, end)` of one sequence of a ranged store, read by
 * range — or out of the slab the last read left, when that reaches.
 *
 * `undefined` for a name the store has not got, exactly as {@link basesOf};
 * empty for a window that holds no residues. The slab is replaced rather than
 * grown: a lane asks for a padded window and then for the next padded window,
 * and keeping both would be keeping the genome, a screen at a time.
 *
 * The two store kinds differ in exactly two lines — which range to ask for, and
 * what the bytes mean once they arrive. A FASTA's are residues with line
 * endings in them, so `residuesIn` strips those; a `.2bit`'s are four bases a
 * byte with the assembly's gaps recorded elsewhere, so `unpackDna` expands them
 * and paints the gaps back on. Everything around those two lines — the name
 * ladder, the clamp, the slab — is one piece of code because it is one idea.
 */
async function residuesOf(
  store: RangedSequences,
  name: string,
  start: number,
  end: number,
  report?: Report,
): Promise<Uint8Array | undefined> {
  const record = recordOf<FaiRecord | TwoBitRecord>(store, name)
  if (record === undefined) return undefined
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(record.length, Math.ceil(end))
  if (!(to > from)) return new Uint8Array(0)
  const held = store.held.get(record.name)
  if (held !== undefined && held.start <= from && held.start + held.bases.length >= to) {
    return held.bases.subarray(from - held.start, to - held.start)
  }
  const options = report === undefined ? {} : { onProgress: report }
  let bases: Uint8Array
  if (isTwoBit(store)) {
    const packed = record as TwoBitRecord
    const range = dnaByteRange(packed, from, to)
    const raw = await store.handle.read(range.to - range.from, range.from, options)
    bases = unpackDna(raw, range.firstBase, packed, from, to)
  } else {
    const range = byteRange(record as FaiRecord, from, to)
    bases = residuesIn(await store.handle.read(range.to - range.from, range.from, options))
  }
  store.held.set(record.name, { start: from, bases })
  return bases
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
 * A FASTA read by its `.fai` rather than held whole (§8.8).
 *
 * What the index gives is the assembly — its first two columns are a
 * `chrom.sizes` — and, for any window of any sequence, the byte range that
 * holds it (`annotations/fai.ts`). So nothing is read until a lane asks for a
 * window, and then one ranged read answers it: the shape a bigWig has always
 * had here, applied to the one format that used to be the exception. What it
 * costs is everything that needed the whole sequence in memory — GC content
 * at a zoom where a window is tens of megabases, and the motif search — and
 * each of those says so where it declines rather than reading a genome to
 * answer.
 */
interface IndexedSequences {
  readonly indexed: true
  /** Names in file order, renamed into the map's vocabulary at load time (§5.9). */
  contigs: Contig[]
  /** By the name a sequence goes by *now*, which after a rename is the map's. */
  records: Map<string, FaiRecord>
  handle: BlobFile | RemoteFile
  /** Residues across every sequence, for the one-line summary. */
  total: number
  /**
   * The last slab read per sequence, so a pan that stays inside it and the
   * second question about one window read nothing twice. One slab per
   * sequence and never more: this is a cache of what is on screen, not of the
   * genome.
   */
  held: Map<string, { start: number; bases: Uint8Array }>
}

/**
 * A `.2bit`, held as its index and read by range (§8.21).
 *
 * The same shape {@link IndexedSequences} has, and deliberately so: both are
 * "an assembly in memory and a way to turn a window into a byte range", and
 * every caller above them — the GC lane, the residue lane, the rename — wants
 * exactly that and nothing more. What differs is two functions' worth of
 * arithmetic (`annotations/twobit.ts`), which is why they are two types with one
 * predicate over them rather than one type with a mode flag.
 *
 * The **records are read at open**, all of them, and that is the cost this
 * format asks for: a record header is `dnaSize`, the gap runs and two counts,
 * and there is one per sequence. For a human assembly that is a few hundred
 * small reads out of a handle that caches 256 KiB chunks, so it is a handful of
 * requests; for an assembly of fifty thousand scaffolds it would be worse, and
 * `twobit.ts`'s `TWOBIT_MAX_SEQUENCES` is where that is refused rather than
 * discovered.
 */
interface TwoBitSequences {
  readonly twobit: true
  contigs: Contig[]
  /** By the name a sequence goes by *now*, which after a rename is the map's. */
  records: Map<string, TwoBitRecord>
  handle: BlobFile | RemoteFile
  total: number
  /** The last slab read per sequence, exactly as {@link IndexedSequences.held}. */
  held: Map<string, { start: number; bases: Uint8Array }>
}

type Sequences = SequenceStore | IndexedSequences | TwoBitSequences

/** The two that are read by range rather than held whole. */
type RangedSequences = IndexedSequences | TwoBitSequences

function isIndexed(store: Sequences): store is IndexedSequences {
  return (store as IndexedSequences).indexed === true
}

function isTwoBit(store: Sequences): store is TwoBitSequences {
  return (store as TwoBitSequences).twobit === true
}

/**
 * Whether this store answers a window with a read rather than with a slice.
 *
 * The predicate every caller outside this file's sequence section wants: the GC
 * gate, the motif refusal and the residue path all care that a window costs a
 * request, and none of them cares whether the arithmetic behind it is a `.fai`'s
 * line arithmetic or a `.2bit`'s bit arithmetic.
 */
function isRanged(store: Sequences): store is RangedSequences {
  return isIndexed(store) || isTwoBit(store)
}

/**
 * The sequences of every open FASTA, by the entry that owns them.
 *
 * Kept here rather than handed over, exactly as a bigWig's handle is: a lane
 * draws a window at a time, and a chromosome sent to the main thread would be
 * twelve megabytes carried across so that a few thousand bases of it could be
 * read (§8.2). Held whole for a small file, and read by range for a large one
 * that came with its index ({@link IndexedSequences}).
 */
const sequences = new Map<string, Sequences>()

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
  /** The index, where the file has one. */
  index: BamIndex | null
  /**
   * What stands in for the index where the file has none (`bam/search.ts`).
   * Exactly one of the two is set.
   */
  search: BamSearch | null
  /** Why the file is searched rather than indexed, for the row's summary; empty with an index. */
  searched: string
  /** The file's own length, for bounding the last block of a span. */
  size: number
  /** The map's name for a sequence → this file's reference id. */
  refIdOf: Map<string, number>
  /** The file's own reference names, in file order, for the ladder. */
  refNames: string[]
}

/**
 * Every entry's open BAM — and, behind them, one open file per *file*.
 *
 * A BAM now opens as two rows, a coverage track and a pile of reads (§8.13), and
 * they are the same bytes. Keyed by entry alone, the second row would open a
 * second filehandle and parse the index again — and an index is the one part of
 * opening a BAM that is not small: §12 budgets it in *bytes* precisely because a
 * BAI for a human WGS file is single-digit megabytes. So the entry map holds a
 * reference to a shared record, and the record is reference-counted: the last
 * row to be dropped is the one that lets the file go.
 */
const alignments = new Map<string, OpenBam>()

/** One record per file, by {@link fileKey}, with the rows holding it. */
const openFiles = new Map<string, { open: OpenBam; holders: Set<string> }>()

/**
 * An open BAM's identity, for sharing one handle and one parsed index between
 * the two rows a BAM imports as.
 *
 * Name and size for a local file, the URL for a remote one — the same key
 * {@link cacheKey} uses, and for the same reason: two `File` objects for one
 * file are not `===`, so identity has to be something the file itself carries.
 *
 * **And its index**, because both halves are what a row actually reads through:
 * a `.bai` and a `.csi` beside the same reads are two index formats over one
 * file, and a key naming only the reads would hand the second row an index the
 * first one built from a different sidecar.
 */
function fileKey(source: WireSource, index: WireSource): string {
  return `${cacheKey(source)}|${cacheKey(index)}`
}

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
 * How large a FASTA this reads **whole**.
 *
 * Read whole and held whole is what makes a pan free — and what makes a
 * mammalian genome the wrong thing to open this way. Three gigabases is three
 * gigabytes here, and the honest answer for a file this size with no index is
 * a refusal naming the number and the command that writes the index, rather
 * than a tab that stops responding while it allocates.
 */
const FASTA_BYTE_CAP = 300_000_000

/**
 * Under this many bytes a FASTA is read whole, index or no index.
 *
 * The two ways of holding a genome trade against each other (§8.8): whole,
 * every zoom draws GC content and the motif search has something to search,
 * at the price of the download and the memory; by range, the browser is on
 * screen the moment the index is read, and the two things that need the
 * whole sequence decline. A yeast genome is twelve megabytes and a fly's is a
 * hundred and forty; the line is drawn where the download stops being a
 * pause and starts being a wait, and it is drawn on the file's size rather
 * than on whether an index happens to be beside it, so that a small genome
 * reads the same whichever bucket it came from.
 */
const FASTA_WHOLE_MAX = 64_000_000

/**
 * The widest window an indexed sequence answers for GC content, in residues.
 *
 * A GC lane over an indexed genome reads the residues it draws, so the cost of
 * a frame is the width of the window, and at a chromosome's width that is a
 * hundred megabytes for one lane of one frame. Four megabases is about one
 * second on an ordinary connection and the widest a window can be while its
 * profile is still a profile rather than a flat line; past it the lane draws
 * nothing and the readout says why.
 */
const INDEXED_GC_WINDOW = 4_000_000

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
let recentFasta: { key: string; store: Sequences } | null = null

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

/**
 * How far a read has got, posted under the request that asked for it.
 *
 * The same `progress` message an analysis task sends (§18.3), now sent for
 * the two reads that are slow enough to be watched: a whole file being
 * downloaded — a FASTA under the line, a BAM's index, a text track — and a
 * window of an indexed sequence fetched by range (§8.8). Neither happens in
 * milliseconds on a genome, and a lane that sits blank for ten seconds reads
 * as a lane that failed. `generic-filehandle2` throttles the ticks to one
 * every fifty milliseconds and always sends the last, so this is a message
 * every frame or so and never a flood.
 */
type Report = (done: number, total?: number) => void

function reporter(id: number): Report {
  return (done, total) => {
    // `total` is what the host declared, and a host that declared nothing
    // sends `0`: the bar is then drawn as "on its way" rather than at a
    // fraction of nothing.
    const response: AnnotationResponse = { type: 'progress', id, done, total: total ?? 0 }
    ;(self as unknown as Worker).postMessage(response)
  }
}

async function dispatch(request: AnnotationRequest): Promise<unknown> {
  switch (request.kind) {
    case 'load':
      return load(request.entry, request.source, request.mapContigs, reporter(request.id))
    case 'sample':
      return sample(
        request.entry,
        request.regions,
        request.basesPerPixel,
        request.reads,
        request.id,
        request.exact === true,
      )
    case 'register':
      vectors.set(request.entry, request.vector)
      return null
    case 'run':
      return runTask(request)
    case 'bases':
      return bases(request.entry, request.regions, reporter(request.id))
    case 'assembly':
      return assemblyOf(request.source, reporter(request.id))
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
      // behind it is a live filehandle; neither should outlive the *last* row
      // holding it. Two rows share one open file, so this is a release rather
      // than a delete — dropping the coverage track while the pile is still on
      // screen must not close the file under it.
      alignments.delete(request.entry)
      for (const [key, held] of openFiles) {
        if (!held.holders.delete(request.entry)) continue
        if (held.holders.size === 0) openFiles.delete(key)
        break
      }
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
    // The second capability this venue exists for, beside `sample`, and the
    // reason a motif search is a task here rather than a request of its own
    // (§8.3, §18.3): the residues are in this thread and nowhere else. A genome
    // is parsed in here and deliberately never shipped out whole — `bases`
    // answers a window and is capped — so a search that ran anywhere else would
    // mean hauling twelve megabytes across the boundary or stitching thirty
    // windowed reads back together at the seams.
    //
    // Handed out as a reader rather than as an array of bytes, so the task takes
    // one sequence at a time and this worker keeps the store: a runner that
    // copied a chromosome would double a genome's memory for the length of the
    // run, and one that kept a reference past it would hold a dropped file open.
    // `undefined` for an entry that is not a loaded sequence, which is a form
    // the reader filled in against a row that has since gone — a sentence for
    // the runner to say, not a throw (`analysis/run/motif.ts`).
    residues: (entry) => {
      const store = sequences.get(entry)
      if (store === undefined) return undefined
      if (isRanged(store)) {
        // Not held, so not searchable here — and reading it whole for the
        // search would be the download it was indexed to avoid (§8.8, §8.21).
        return {
          contigs: store.contigs,
          bases: () => undefined,
          refusal: isTwoBit(store)
            ? 'This .2bit is read by range rather than held, so its sequences are not here to ' +
              `search. A FASTA under ${fmt.int(FASTA_WHOLE_MAX / 1e6)} MB is held whole and can be ` +
              'searched (`twoBitToFa`).'
            : 'This FASTA is read by range from its index rather than held, so its sequences are ' +
              `not here to search. A FASTA under ${fmt.int(FASTA_WHOLE_MAX / 1e6)} MB is held whole ` +
              'and can be searched.',
        }
      }
      return {
        contigs: store.contigs,
        // Through `basesOf`, so a FASTA renamed into the map's vocabulary at
        // load time is searched under the names the rest of the app uses (§5.9).
        bases: (contig) => basesOf(store, contig),
      }
    },
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
async function assemblyOf(source: WireSource, report: Report): Promise<AssemblyResult> {
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
    const size = await sizeOf(handle, source)
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
    const store = await readSequence(source, handle, report)
    return { format: 'fasta', contigs: store.contigs, origin: 'fasta', exact: true }
  }

  // A `.2bit` answers this question better than any other sequence file can, and
  // answers it for almost nothing: every sequence and its exact length are in
  // the index, so an 800 MB hg38 declares its assembly in a few hundred
  // kilobytes and never reads a base to do it (§8.21). `origin: 'twobit'`
  // rather than `'fasta'` because the Genome card says where lengths came from,
  // and they came from an index rather than from the residues.
  if (looksLikeTwoBit(head)) {
    const store = await readTwoBit(source, handle, report)
    return { format: 'twobit', contigs: store.contigs, origin: 'twobit', exact: true }
  }

  const raw = await handle.readFile({ onProgress: report })
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

  // Same order as `load`, and for the same reason: `sniffFormat` answers `bed`
  // for anything it does not know, so every sniffer stricter than it has to be
  // asked first or the file is routed as a BED. Getting this wrong here does
  // not merely mislabel the row — it decides which road the *drop* takes.
  //
  // A VCF is the one text format that can answer this question **exactly**. Its
  // `##contig=<ID=…,length=…>` lines are a chrom.sizes written inside the file:
  // declared rather than inferred, which is the tier a BAM's `@SQ` table and a
  // bigWig's header sit at, and a tier above the "ends at its last feature"
  // lower bound every other feature file can offer. So a dropped VCF opens a
  // browser session over its real chromosomes (§5.8) — and where it declares
  // none, which is legal and common, it falls back to that lower bound like any
  // other feature file rather than claiming a precision it has not got.
  if (sniffVcf(text)) {
    const declared = vcfContigs(text)
    if (declared.length > 0) {
      // `origin`, not `exact`, is what `lengthsAreExact` reads. Reporting
      // `features` here would put "lengths inferred from the features in this
      // file" under a genome whose lengths the file states outright — which is
      // the mistake the `bam` origin was added to undo, made a second time.
      return { format: 'vcf', contigs: declared, origin: 'vcf', exact: true }
    }
    const data = parseVcf(text)
    const ends = new Map<string, number>()
    for (let i = 0; i < data.length; i++) note(ends, data.contigs[data.contig[i]], data.end[i])
    return { format: 'vcf', contigs: contigsOf(ends), origin: 'features', exact: false }
  }

  // A structure dropped on an empty session declares a genome the way any
  // feature file does — every sequence ends at its last bead — and opens a
  // browser over it (§5.8, §25). Same place in the order as in `load`.
  if (isG3dBinary(head)) {
    const data = await readFinestG3d(handle)
    const ends = new Map<string, number>()
    for (let i = 0; i < data.length; i++) note(ends, data.contigs[data.contig[i]], data.end[i])
    return { format: 'structure', contigs: contigsOf(ends), origin: 'features', exact: false }
  }
  if (sniffG3d(text, source.name) || sniffBed3d(text, source.name)) {
    const data = sniffG3d(text, source.name) ? parseG3d(text, source.name) : parseBed3d(text, source.name)
    const ends = new Map<string, number>()
    for (let i = 0; i < data.length; i++) note(ends, data.contigs[data.contig[i]], data.end[i])
    return { format: 'structure', contigs: contigsOf(ends), origin: 'features', exact: false }
  }

  // Same place in the order as in `load`, and it has to be: this decides which
  // road a *drop* takes, and a barChart routed as a BED here would open as one
  // however well the loader knew better (§8.17). Its lengths are the ordinary
  // "ends at its last feature" lower bound — the format declares no genome.
  if (sniffBarChart(text, source.name)) {
    const data = parseBarChart(text, source.name)
    const ends = new Map<string, number>()
    for (let i = 0; i < data.length; i++) note(ends, data.contigs[data.contig[i]], data.end[i])
    return { format: 'barchart', contigs: contigsOf(ends), origin: 'features', exact: false }
  }

  // The same five, in the same order as `load`, and it has to be: this is what
  // decides which road a *drop* takes, so a genePred routed as a BED here would
  // open as one however well the loader knew better. Every one of them gives the
  // ordinary "ends at its last feature" lower bound — none of these formats
  // declares a genome, unlike the VCF above.
  if (sniffInteract(text, source.name)) {
    const data = parseInteract(text)
    return { format: 'interact', contigs: endsOfPairs(data), origin: 'features', exact: false }
  }
  if (sniffLongRange(text, source.name)) {
    const data = parseLongRange(text)
    return { format: 'longrange', contigs: endsOfPairs(data), origin: 'features', exact: false }
  }
  if (sniffGenePred(text, source.name)) {
    const data = parseGenePred(text)
    recent = { key: cacheKey(source), format: 'genepred', features: data }
    const ends = new Map<string, number>()
    for (let i = 0; i < data.length; i++) note(ends, data.contigs[data.contig[i]], data.end[i])
    return { format: 'genepred', contigs: contigsOf(ends), origin: 'features', exact: false }
  }
  if (sniffBedMethyl(text, source.name)) {
    const { signal: set } = parseBedMethyl(text)
    const ends = new Map<string, number>()
    for (const contig of set.contigs) {
      let furthest = 0
      for (const end of contig.ends) if (end > furthest) furthest = end
      note(ends, contig.name, furthest)
    }
    return { format: 'bedmethyl', contigs: contigsOf(ends), origin: 'features', exact: false }
  }

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
    return { format, contigs: endsOfPairs(data), origin: 'features', exact: false }
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
 * The inferred assembly of a paired file: both ends of every row.
 *
 * Both ends, which is the whole of why this is a function rather than a loop
 * inlined at each of its three call sites (bedpe, interact, longrange). A
 * paired format's second end is routinely on a sequence its first end never
 * mentions — that is what a trans interaction *is* — and a reader that walked
 * only `contig1` would open a browser missing every chromosome that appears
 * solely as a target.
 */
function endsOfPairs(data: PairSet): Contig[] {
  const ends = new Map<string, number>()
  for (let i = 0; i < data.length; i++) {
    note(ends, data.contigs[data.contig1[i]], data.end1[i])
    note(ends, data.contigs[data.contig2[i]], data.end2[i])
  }
  return contigsOf(ends)
}

/**
 * Inferred lengths, in first-mention order.
 *
 * Rounded *up* to a round number, so a browser opened on a peak set does not
 * end each chromosome exactly on the last peak — which reads as a sequence that
 * stops there rather than as the limit of what this file knows. That intent is
 * right; the size of the rounding is what was wrong.
 *
 * The step is **two orders of magnitude below** the coordinate — three
 * significant figures — and it used to be the coordinate's *own* order of
 * magnitude, one significant figure. One figure is not a nudge: the step grows
 * tenfold at every power of ten, so just past one it is almost the whole value.
 * Yeast VII, whose last feature ends at 1,090,940, was handed 2,000,000 — and
 * so was IV at 1,531,933, two chromosomes 441 kb apart given exactly the same
 * length, which is the failure a reader sees. It shows up three ways at once:
 * every sequence gets a blank pannable margin on its right (VII 83% of it), the
 * SEQUENCES card draws each bar as `length / longest` and so draws a genome
 * that is not this one, and the whole yeast annotation set came out as 15.99 Mb
 * of a 12.16 Mb genome. At three figures VII is 1,100,000 and IV 1,540,000, and
 * the total lands within 1% — the overshoot is under one step, and a step is at
 * most a hundredth of the value, so the margin is never more than 1% for any
 * coordinate of 1 kb or more and never jumps at a power of ten.
 *
 * `floor(end / step) + 1` rather than `ceil(end / step)`, because the point is
 * a length **strictly** greater than the furthest coordinate: a peak set whose
 * last peak ends at exactly 1,200,000 would round to 1,200,000 under `ceil` and
 * be back to ending on its own last feature — the very reading this rounding
 * exists to avoid — and it is the round numbers, not the ragged ones, that a
 * feature file is most likely to end on. The step floors at 1 bp so a contig
 * whose only feature ends at 0 or 1 still gets a positive length; `assemblyOf`
 * drops a contig of length 0 outright, and a sequence silently missing from the
 * axis is worse than a one-base one.
 */
export function contigsOf(ends: Map<string, number>): Contig[] {
  const out: Contig[] = []
  for (const [name, end] of ends) {
    const step = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, end))) - 2)
    out.push({ name, length: (Math.floor(end / step) + 1) * step })
  }
  return out
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * A read handle over a track file, authorised however its host wants.
 *
 * `generic-filehandle2` takes a `fetch` override, which is the whole hook: it
 * builds its own `Range` headers and calls through, so wrapping the fetcher
 * authorises every read it makes — the first four magic bytes, a bigWig's header
 * and R-tree, and every zoom block afterwards — without this file knowing how
 * many requests that is.
 *
 * Two things go on, and they compose in one order: the static headers a URL
 * needs (a Google API key, a bearer token — SPECS §24.7) and then the SigV4
 * signature over them. The signature is computed per call rather than once per
 * handle, because `x-amz-date` is signed and S3 refuses a stamp older than
 * fifteen minutes; a bigWig handle outlives that easily, since it is kept for as
 * long as the track is on screen and re-read on every pan. `sources/access.ts`
 * owns both, and is the same module the reader worker's range source uses — so a
 * private bigWig and a private cooler are authorised identically rather than by
 * two copies of the same three lines.
 *
 * A source with neither gets the library's own `fetch` and no wrapper at all,
 * which is every public track.
 */
/**
 * The remote handles this worker holds, by address and access, most recently
 * used last. One per file rather than one per question, because the handle
 * caches what it reads (`cachedFile.ts`): the three opens on the way to a
 * browser — the assembly question, the load, the first window — then read the
 * file's header once. Eight, because a session's worker has a handful of
 * remote tracks and a bounded map is what keeps a long session from holding
 * a chunk cache for every file it ever glanced at.
 */
const remoteHandles = new Map<string, CachedRemoteFile>()
const REMOTE_HANDLES_KEPT = 8

function handleFor(source: WireSource): BlobFile | RemoteFile {
  if (source.kind === 'local') return new BlobFile(source.file)
  const { credential, headers } = source
  const key = `${source.url}|${credential === undefined ? '' : JSON.stringify(credential)}|${
    headers === undefined ? '' : JSON.stringify(headers)
  }`
  const held = remoteHandles.get(key)
  if (held !== undefined) {
    remoteHandles.delete(key)
    remoteHandles.set(key, held)
    return held
  }
  const made =
    credential === undefined && headers === undefined
      ? new CachedRemoteFile(source.url)
      : new CachedRemoteFile(source.url, {
          fetch: (input, init) => {
            const url = typeof input === 'string' ? input : (input as Request).url
            return fetch(
              input,
              applyAccess(init, {
                url,
                ...(headers === undefined ? {} : { headers }),
                ...(credential === undefined ? {} : { credential }),
              }),
            )
          },
        })
  remoteHandles.set(key, made)
  while (remoteHandles.size > REMOTE_HANDLES_KEPT) {
    const oldest = remoteHandles.keys().next().value as string
    remoteHandles.delete(oldest)
  }
  return made
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
    const size = await sizeOf(handle, source)
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
      const part = new TextDecoder().decode(
        await inflateBgzf(compressed, span.lastBlock - span.from),
      )
      // …and what comes back is not lines. See {@link wholeLines}: a block
      // boundary is not a line boundary, so every span but the file's first
      // opens mid-record and every one but the file's last stops mid-record.
      parts.push(wholeLines(part, span.from === 0, decodesToFileEnd(compressed, span, size)))
    }
    // Joined with nothing rather than with a newline, because every part now
    // ends in one — except a final unterminated line, which only the last span
    // of the file can hold.
    const text = parts.join('')
    // Nothing whole in any span is an index that did not work, and the answer to
    // that is the read that always worked — not "this file is empty", which is
    // what `load` would tell the reader about a file that is nothing of the kind.
    return text === '' ? null : text
  } catch {
    // Every failure here is "this index did not work", and the answer to that is
    // the read that always worked. A sidecar that is corrupt, truncated, for a
    // different file or in a format this does not know must never be the reason
    // a track cannot be opened.
    return null
  }
}

/**
 * The whole lines of one decoded span, and nothing else.
 *
 * **A BGZF block boundary is not a line boundary.** `bgzf_write` copies bytes
 * into a 64 KiB buffer and flushes it when it is full, without looking at what
 * it is cutting — which is the whole reason a tabix virtual offset carries a
 * 16-bit *within-block* part beside the block's own offset. `tabix.ts` reads
 * only the block half of it (it is the half a byte range is made of), so a span
 * begins at the first byte of the block holding the wanted contig's first
 * record — routinely the tail of the record the previous block ran out on — and
 * ends at the last byte of the block holding its last one, routinely mid-record
 * again.
 *
 * Handing those two fragments to the sniffers is what used to happen, and it
 * lost the file: `sniffFormat` read the piece of a GTF attribute column that
 * opened the span as its first data row, found no integers where a GTF keeps
 * them, and fell through to its last line, `return 'bed'` — so an indexed
 * `.gtf.gz` was refused by `parseBed` with *"all N lines failed the contig,
 * start, end test"*, a message naming a format the reader never handed over.
 * `sniffVcf` answered `false` on the same fragment and the VCF was refused with
 * that same BED message, which defeats §8.14's shape road exactly where it is
 * load-bearing: the indexed path is the one where every `#` line is in the part
 * of the file that was never fetched. Which of the two happens depends on where
 * the boundary fell inside the record before, and the minority is no better —
 * swept across one GENCODE-shaped line, better than nine cuts in ten refuse the
 * file and most of the rest sniff `bed` and open a **one-row** track. At the
 * other seam a record cut mid-coordinate still parses: `chrB 45000 455` becomes
 * a feature and `FeatureBuilder.add` orders its ends into a 44.5 kb box drawn
 * where nothing exists, and a fragment cut inside a contig name puts a contig
 * called `A` in the set and in the §8.2 overlap report. None of it is rare: the
 * seam is on every span the index serves, and the 80% guard means it fires only
 * on the subset map the index exists for.
 *
 * The two ends are **not** symmetric, and the obvious rule — drop the first and
 * last line of every part — is wrong at both of them:
 *
 * - `atFileStart`: the file's first span really does begin at a line start, and
 *   that line is a VCF's `##fileformat`, a headed TSV's column names, or simply
 *   the first record. Trimming there throws away the line the sniffers most
 *   need.
 * - `atFileEnd`: a file's last line need not be terminated. Trimming an
 *   unterminated tail that is really the end of the data drops a record the
 *   whole-file road keeps, and the index is only ever allowed to make the same
 *   file *cheaper* (§3.4), never to change what it says.
 *
 * What is deliberately *not* a case: two fragments meeting across the join of
 * two parts. `spansFor` merges any two spans within a mebibyte of each other,
 * so two spans that survive as separate entries have more than a mebibyte of
 * unfetched file between them — the fragment ending one part and the fragment
 * opening the next are halves of two *different* records whose other halves
 * were never read. Joining them would fabricate a record rather than repair
 * one, which is why the parts are trimmed independently and then concatenated.
 *
 * A part with no newline in it at all is one long fragment of a record that
 * began before the span, so it is dropped whole rather than kept as a line. The
 * cost of all this is at most one record per seam: a block boundary that
 * happens to land exactly on a newline (about one in a line-length, so under
 * 1% of spans) loses the record after it, which is the cheap side of the trade
 * against refusing the file. Carrying the within-block offset through
 * `tabix.ts` would settle the leading seam exactly, but not the trailing one.
 */
export function wholeLines(text: string, atFileStart: boolean, atFileEnd: boolean): string {
  let out = text
  if (!atFileStart) {
    const firstBreak = out.indexOf('\n')
    out = firstBreak < 0 ? '' : out.slice(firstBreak + 1)
  }
  if (!atFileEnd && !out.endsWith('\n')) {
    const lastBreak = out.lastIndexOf('\n')
    out = lastBreak < 0 ? '' : out.slice(0, lastBreak + 1)
  }
  return out
}

/** The 28 bytes of the empty BGZF member a bgzipped file ends with. */
const BGZF_EOF_BYTES = 28

/**
 * Whether the text decoded from this span runs to the end of the file's data.
 *
 * Which is *not* the question `span.to >= size` answers. That one says the
 * fetch reached the end of the file, and the fetch over-asks by a whole block
 * on purpose — so on any file whose last wanted record sits within 64 KiB of
 * the end, `spansFor` clamps `to` to `size` while `inflateBgzf` still stops
 * after the block at `lastBlock`, several blocks short of it. Trusting `to`
 * alone would keep an unterminated fragment on every such file, which includes
 * the everyday one: a `.gtf.gz` whose final contig is a `chrM` the map does not
 * have.
 *
 * So the bytes are asked instead. The block at `lastBlock` is measured from its
 * own `BSIZE`, and what follows it in the buffer has to be nothing at all or
 * the empty member the file ends with; anything longer is another block with
 * records in it. A file ending in two empty members answers `false` and loses
 * an unterminated last line — the conservative direction, and the one that
 * cannot draw a feature that does not exist.
 */
function decodesToFileEnd(compressed: Uint8Array, span: ByteSpan, size: number): boolean {
  if (span.to < size) return false
  const at = span.lastBlock - span.from
  if (at < 0 || at >= compressed.length) return false
  const length = blockSize(compressed.subarray(at, Math.min(at + 64, compressed.length)))
  if (length === null || at + length > compressed.length) return false
  return compressed.length - (at + length) <= BGZF_EOF_BYTES
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
    // Both halves of the file's access, on its sidecar: a `.tbi` beside a
    // `.gz` and a `.bai` beside a `.bam` sit under the same prefix on the same
    // host, so whatever authorises the one authorises the other.
    ...(source.credential === undefined ? {} : { credential: source.credential }),
    ...(source.headers === undefined ? {} : { headers: source.headers }),
  }
}

/**
 * The file's length, however it can be learnt — or `null`, never zero.
 *
 * A local file knows its own. A remote one is read off the `Content-Range`
 * of the handle's first ranged request, which is how every bucket that
 * follows `docs/hosting.md` answers — and how 4DN's open-data bucket does
 * not: it exposes `ETag` and nothing else, so the browser sees no
 * `Content-Range` and the handle reports a size of nought. Taken at its word
 * that was a header read of nought bytes, "not a BAM", and the file read
 * whole — a hundred gigabytes of alignments fetched to find out what its
 * first block says. So a size the handle cannot give is asked for with a
 * `HEAD`, whose `Content-Length` is one of the handful of headers CORS lets
 * every page read without being told it may, and a size nothing will state
 * is `null`, which every caller already treats as *unknown* rather than
 * *empty*.
 */
async function sizeOf(handle: BlobFile | RemoteFile, source?: WireSource): Promise<number | null> {
  const stat = (handle as { stat?: () => Promise<{ size: number }> }).stat
  if (typeof stat === 'function') {
    try {
      const size = (await stat.call(handle)).size
      if (Number.isFinite(size) && size > 0) return size
    } catch {
      // Fall through to the probe below.
    }
  }
  if (source === undefined || source.kind !== 'remote') return null
  try {
    const { credential, headers } = source
    const response = await fetch(
      source.url,
      applyAccess(
        { method: 'HEAD', mode: 'cors' },
        {
          url: source.url,
          method: 'HEAD',
          ...(headers === undefined ? {} : { headers }),
          ...(credential === undefined ? {} : { credential }),
        },
      ),
    )
    if (!response.ok) return null
    const declared = Number(response.headers.get('Content-Length') ?? Number.NaN)
    return Number.isFinite(declared) && declared > 0 ? declared : null
  } catch {
    return null
  }
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
async function load(
  entry: string,
  source: WireSource,
  mapContigs: NamedSequence[],
  report: Report,
): Promise<LoadResult> {
  const handle = handleFor(source)
  // Sixty-four rather than four. A BBI magic number is four bytes and was all
  // this ever needed; recognising a BGZF member takes twelve plus its extra
  // field, and it is the same range request either way.
  const head = await handle.read(64, 0)
  const magic = bbiMagic(head)

  if (magic === 'bigwig') return loadBigWig(entry, source, mapContigs)
  if (magic === 'bigbed') return loadBigBed(entry, source, mapContigs)
  // Asked before the text road, and only for a BGZF file: a BAM is a BGZF
  // container, so the question is one inflate of the first block deep. A
  // bgzipped *text* file falls through it and takes the tabix path it always
  // did.
  if (isBgzf(head)) {
    const size = await sizeOf(handle, source)
    const header = await readBamFront(handle, size ?? Number.MAX_SAFE_INTEGER)
    // A BGZF file that is not a BAM is a bgzipped text file, and takes the
    // tabix road below exactly as it always did.
    if (header !== null) {
      if (size === null) {
        throw new Error(
          `${source.name} cannot be measured — its host states neither Content-Range nor ` +
            'Content-Length to a page — and a BAM is read by byte range.',
        )
      }
      return loadBam(entry, source, handle, mapContigs, header, size, report)
    }
  }
  if (looksLikeFasta(head)) {
    return loadFasta(entry, await readSequence(source, handle, report), mapContigs)
  }
  // A `.2bit` is a magic number like a BBI file is, so it is settled here rather
  // than on the text road: nothing is decompressed, nothing is sniffed, and the
  // 800 MB the file may be is never a candidate for the whole-file read below
  // (§8.21).
  if (looksLikeTwoBit(head)) {
    return loadFasta(entry, await readTwoBit(source, handle, report), mapContigs)
  }
  // WashU's container, by its magic (§25.2): a 64 000-byte msgpack header
  // and one zlib block per resolution, read by range like a BAM rather than
  // whole like a text — the header says where each block is.
  if (isG3dBinary(head)) return loadG3dBinary(handle, mapContigs)

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
  const bytes =
    indexed === null ? await decodeAnnotationBytes(await handle.readFile({ onProgress: report })) : null
  if (bytes !== null && looksLikeFasta(bytes)) {
    return loadFasta(entry, keepFasta(source, bytes), mapContigs)
  }
  const text = indexed ?? new TextDecoder().decode(bytes as Uint8Array)
  if (text.trim() === '') throw new Error('This file is empty.')

  // Both asked before the feature sniffer, and for the one reason: `sniffFormat`
  // never answers "not one of mine" — its last line is `return 'bed'` — so any
  // format it does not know is silently parsed as a BED. That is what a
  // four-column bedGraph did before `sniffSignal` existed (its value column
  // landed in `name`), and it is what a VCF did before `sniffVcf` did: refused
  // with a message naming a format the reader never handed over.
  //
  // Both are stricter than the sniffer they precede, which is what lets them go
  // first without capturing anything that is really a BED. `sniffVcf` is asked
  // first of the two only because it is the cheaper question on a file that is
  // neither: a VCF has at least eight columns and a bedGraph has exactly four,
  // so neither can capture the other whichever order they are asked in.
  if (sniffVcf(text)) return loadVcf(text, mapContigs)

  // A 3D model (§25), asked here for the reason every sniffer in this block is:
  // a five-column g3d read as a BED is a lane of boxes whose "end" is a
  // coordinate in space. It cannot capture a VCF (eight columns, a non-integer
  // in column 2) and nothing below it can capture a g3d (five or six columns,
  // three coordinates where a BED has an integer end).
  if (sniffG3d(text, source.name)) return loadG3d(text, source.name, mapContigs)
  if (sniffBed3d(text, source.name)) return loadG3d(text, source.name, mapContigs, parseBed3d)

  // Third of the three, and stricter than the BED sniffer it precedes for the
  // same reason the two above are (§8.17): a barChart read as a BED is a lane
  // of boxes whose ninth column — the whole of what the file is about — was
  // never mentioned. It cannot capture either of the two above it: a VCF has a
  // non-integer in column 2 and a bedGraph has four columns, where this needs
  // nine and an integer count in column 8 that matches its own list.
  if (sniffBarChart(text, source.name)) return loadBarChart(text, source.name, mapContigs)

  // The five UCSC formats of §8.18–§8.20, all of them in front of the BED
  // sniffer and every one of them for its reason. This block is the price of
  // `sniffFormat`'s last line being `return 'bed'`: a format it has not been
  // taught is never refused, only silently drawn as something it is not, so
  // every format that is not a BED has to be recognised *before* it is asked.
  //
  // The order inside the block matters only where two could match one file, and
  // none of these can. An interact is eighteen columns whose bounding span
  // contains its own anchors; a longrange is four whose last packs a locus; a
  // genePred has a strand in column 3 and two comma lists that tile a
  // transcript; a bedMethyl is a one-base BED9 with a depth and a percentage.
  // They are written in the order a reader is most likely to bring one.
  if (sniffInteract(text, source.name)) return loadInteract(text, mapContigs)
  if (sniffLongRange(text, source.name)) return loadLongRange(text, mapContigs)
  if (sniffGenePred(text, source.name)) return loadGenePred(text, mapContigs)
  if (sniffBedMethyl(text, source.name)) return loadBedMethyl(entry, text, mapContigs)

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
      summary: `${fmt.int(data.length)} pair${data.length === 1 ? '' : 's'}`,
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

/**
 * A VCF, as intervals (§8.14).
 *
 * Its own arm rather than a line in {@link featureResult}, because two things
 * about the summary are the format's alone. A variant file's rows are
 * *variants* and not *features* — the word a reader is looking for under the
 * lane's name is the word their file uses. And the **samples are counted and
 * said**: a VCF's genotype columns are a matrix of variants × samples, which is
 * a picture this app does not draw (§13), so a reader who brought a
 * thousand-genome file is told what the lane is showing them rather than left to
 * work it out from a lane that looks complete.
 */
function loadVcf(text: string, mapContigs: NamedSequence[]): LoadResult {
  const data = parseVcf(text)
  const renaming = renameContigs(data.contigs, mapContigs)
  const samples = samplesIn(text)
  return {
    format: 'vcf',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary:
      `${fmt.int(data.length)} variant${data.length === 1 ? '' : 's'}` +
      (samples === 0 ? '' : ` · ${fmt.int(samples)} sample${samples === 1 ? '' : 's'} not drawn`),
    payload: { kind: 'features', data },
  }
}

/**
 * An `interact`, text or bigBed, as the arcs it is (§8.18).
 *
 * One function for both roads for §8.7's reason, and here the reason is
 * sharper than usual: a `bigInteract` is a bigBed whose *rows* are ordinary
 * interact rows, so re-joining them into text and running this parser is not a
 * shortcut — it is what makes the two files draw identically, down to the
 * strand arrow in a tooltip.
 */
function loadInteract(text: string, mapContigs: NamedSequence[]): LoadResult {
  const data = parseInteract(text)
  const renaming = renameContigs(data.contigs, mapContigs)
  return {
    format: 'interact',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary: interactSummary(data),
    payload: { kind: 'pairs', data },
  }
}

/** A `longrange`, as the arcs it is, with its reciprocal lines folded (§8.18). */
function loadLongRange(text: string, mapContigs: NamedSequence[]): LoadResult {
  const data = parseLongRange(text)
  const renaming = renameContigs(data.contigs, mapContigs)
  return {
    format: 'longrange',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary: longRangeSummary(data),
    payload: { kind: 'pairs', data },
  }
}

/**
 * A `genePred`, `genePredExt` or `refFlat`, as the transcripts it holds (§8.19).
 *
 * Its own arm rather than a line in {@link featureResult} for `loadVcf`'s
 * reason: the summary is the format's. A gene-model file's rows are
 * *transcripts*, and how many of them code is the thing that explains a lane
 * with no thick spans in it.
 */
function loadGenePred(text: string, mapContigs: NamedSequence[]): LoadResult {
  const data = parseGenePred(text)
  const renaming = renameContigs(data.contigs, mapContigs)
  return {
    format: 'genepred',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary: genePredSummary(data),
    payload: { kind: 'features', data },
  }
}

/**
 * A `bedMethyl` or `bigMethyl`, as the track of percentages it is (§8.20).
 *
 * Registered in {@link signals} beside the bedGraphs, which is the whole of what
 * makes it a track: `sample` looks there, so every lane, control and renderer
 * above is unchanged — the range, the ceiling, the autoscale and the ⌘-scroll
 * all arrive for free, exactly as they did for a bedGraph (§8.2).
 *
 * The extent is seeded to the file's own, which for a percentage is the one
 * case where the honest starting clip is *not* the data's range: a lane
 * autoscaled to 12–94 % says nothing about how methylated anything is. So the
 * clip offered is 0–100, the scale a percentage is read against, and a reader
 * who wants the data's own range has the autoscale button that every track has.
 */
function loadBedMethyl(entry: string, text: string, mapContigs: NamedSequence[]): LoadResult {
  const result: BedMethylResult = parseBedMethyl(text)
  const set = result.signal
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
  return {
    format: 'bedmethyl',
    contigs,
    overlap: overlapReport(contigs, mapContigs, renaming),
    summary: bedMethylSummary(result),
    fileExtent: { min: 0, max: 100 },
  }
}

/**
 * A barChart, text or bigBed, read into intervals with a chart on each (§8.17).
 *
 * One function for both roads because there is one parser: a bigBarChart's rows
 * are re-joined into BED lines by {@link loadBigBed} and handed here, which is
 * §8.7's arrangement unchanged — one parser, one set of rules, one place where
 * the format's quirks live. What the bigBed road cannot bring with it is the
 * `track` line, so its categories are numbered; see `annotations/barchart.ts`.
 */
function loadBarChart(
  text: string,
  fileName: string,
  mapContigs: NamedSequence[],
): LoadResult {
  const data = parseBarChart(text, fileName)
  const renaming = renameContigs(data.contigs, mapContigs)
  return {
    format: 'barchart',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary: barChartSummary(data),
    payload: { kind: 'features', data },
  }
}

/**
 * A g3d, read into beads with a place on each (§25).
 *
 * Its own arm for the summary's sake, which is the one place the inferred
 * spacing is said: a reader whose file was meant to be at 10 kb reads `1.04 Mb`
 * under the row and has been told the one thing this reader could have got
 * wrong. The rename into the map's vocabulary is the generic one, so `chr7`
 * meets `7` here exactly as a BED's does.
 */
function loadG3d(
  text: string,
  fileName: string,
  mapContigs: NamedSequence[],
  parse: (text: string, fileName: string) => FeatureSet = parseG3d,
): LoadResult {
  const data = parse(text, fileName)
  const renaming = renameContigs(data.contigs, mapContigs)
  return {
    format: 'structure',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary: g3dSummary(data),
    payload: { kind: 'features', data },
  }
}

/**
 * The finest model of a binary g3d, with the header it came from.
 *
 * The finest rather than the map's rung, because a structure's spacing is a
 * fact about how it was modelled and not about the map it is drawn beside
 * (§25.2): the same file opens the same way next to a 1 kb map and a 50 kb
 * one, and the coarser rungs are named under the row so a reader knows they
 * exist. Two range reads: the header, then the one block.
 */
async function readFinestG3d(
  handle: BlobFile | RemoteFile,
): Promise<FeatureSet & { header: G3dHeader }> {
  const read = (length: number, position: number): Promise<Uint8Array> => handle.read(length, position)
  const size = await sizeOf(handle)
  const header = await readG3dHeader(read, size ?? undefined)
  const finest = Math.min(...header.resolutions)
  const data = await readG3dModel(read, header, finest)
  return Object.assign(data, { header })
}

async function loadG3dBinary(handle: BlobFile | RemoteFile, mapContigs: NamedSequence[]): Promise<LoadResult> {
  const data = await readFinestG3d(handle)
  const renaming = renameContigs(data.contigs, mapContigs)
  const others = data.header.resolutions.filter((resolution) => resolution !== data.model?.width)
  const summary = [
    g3dSummary(data),
    g3dBinaryNote(data.header),
    ...(others.length === 0 ? [] : [`also at ${others.join(', ')} bp`]),
  ].join(DETAIL_SEP)
  return {
    format: 'structure',
    contigs: data.contigs,
    overlap: overlapReport(data.contigs, mapContigs, renaming),
    summary,
    payload: { kind: 'features', data },
  }
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
        ? `${fmt.int(data.length)} transcripts · ${fmt.int(exons)} exons`
        : `${fmt.int(data.length)} feature${data.length === 1 ? '' : 's'}`,
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
/**
 * A FASTA, however it is going to be held (§8.8).
 *
 * Whole under {@link FASTA_WHOLE_MAX}, whatever sits beside it. Over it, by
 * its index where one can be found — named on the source, or guessed as
 * `<url>.fai` for a plain remote FASTA — and whole again where none can be,
 * which is the read that always worked and is refused past
 * {@link FASTA_BYTE_CAP} exactly as before. The size is asked for before a
 * byte of sequence is read: a local file's is free, and a remote one's is one
 * ranged request the handle keeps.
 */
async function readSequence(
  source: WireSource,
  handle: BlobFile | RemoteFile,
  report: Report,
): Promise<Sequences> {
  const held = recentFasta
  if (held !== null && held.key === cacheKey(source)) return held.store
  const size = source.kind === 'local' ? source.file.size : await sizeOf(handle, source)
  const known = size !== null && size > 0
  if (known && size <= FASTA_WHOLE_MAX) return readWhole(source, handle, report)
  const indexed = await readFastaIndex(source, handle)
  if (indexed !== null) {
    recentFasta = { key: cacheKey(source), store: indexed }
    return indexed
  }
  // Refused before it is read, where the size is known without reading it. A
  // remote one whose server would not say is found out the hard way, below.
  if (known && size > FASTA_BYTE_CAP) throw tooLarge(size, source)
  return readWhole(source, handle, report)
}

async function readWhole(
  source: WireSource,
  handle: BlobFile | RemoteFile,
  report: Report,
): Promise<SequenceStore> {
  return keepFasta(source, await decodeAnnotationBytes(await handle.readFile({ onProgress: report })))
}

/**
 * The `.fai` beside a FASTA, read into an {@link IndexedSequences} — or `null`
 * where there is none, none that answers, or none that parses. Every failure
 * is "this index did not work", and the answer to that is the read that
 * always worked, on the terms `tryIndexedText` gives for a tabix sidecar.
 */
async function readFastaIndex(
  source: WireSource,
  handle: BlobFile | RemoteFile,
): Promise<IndexedSequences | null> {
  const named =
    source.index !== undefined
      ? source
      : source.kind === 'remote' && FASTA_NAME.test(source.url)
        ? { ...source, index: guessedIndexUrl(source.url) }
        : null
  const indexSource = named === null ? null : indexSourceFor(named)
  if (indexSource === null) return null
  try {
    const records = parseFai(new TextDecoder().decode(await handleFor(indexSource).readFile()))
    if (records.length === 0) return null
    return {
      indexed: true,
      contigs: contigsOfIndex(records),
      records: new Map(records.map((record) => [record.name, record])),
      handle,
      total: records.reduce((sum, record) => sum + record.length, 0),
      held: new Map(),
    }
  } catch {
    return null
  }
}

/**
 * A `.2bit`, opened: its index read, its records read, no base fetched (§8.21).
 *
 * The reading itself is `annotations/twobit.ts`'s, over a `read` this supplies —
 * so the CLI, whose handle is a local file with no progress to report, runs the
 * same loops over the same arithmetic. What is left here is what the worker
 * owns: the cache, and turning the records into the store the sequence lane
 * asks questions of.
 */
async function readTwoBit(
  source: WireSource,
  handle: BlobFile | RemoteFile,
  report: Report,
): Promise<TwoBitSequences> {
  const cached = recentFasta
  if (cached !== null && cached.key === cacheKey(source) && isTwoBit(cached.store)) {
    return cached.store
  }
  const file = await openTwoBit((length, position) =>
    handle.read(length, position, { onProgress: report }),
  )
  const store: TwoBitSequences = {
    twobit: true,
    contigs: contigsOfRecords(file.ordered),
    records: file.records,
    handle,
    total: file.total,
    held: new Map(),
  }
  recentFasta = { key: cacheKey(source), store }
  return store
}

function keepFasta(source: WireSource, bytes: Uint8Array): SequenceStore {
  if (bytes.length > FASTA_BYTE_CAP) throw tooLarge(bytes.length, source)
  const store = parseFasta(bytes)
  if (store.contigs.length === 0) {
    throw new Error('This looks like a FASTA but holds no sequences.')
  }
  recentFasta = { key: cacheKey(source), store }
  return store
}

function tooLarge(size: number, source: WireSource): Error {
  const name = source.name.replace(/[#?].*$/, '') || 'genome.fa'
  return new Error(
    `This FASTA is ${fmt.int(Math.round(size / 1e6))} MB and has no index. It would be read whole ` +
      `and held whole — which is what makes panning free — so anything over ` +
      `${fmt.int(FASTA_BYTE_CAP / 1e6)} MB is refused rather than allowed to take the tab with it. ` +
      `Index it (\`samtools faidx ${name}\`) and ${
        source.kind === 'local'
          ? 'drop the .fai with it'
          : 'publish the .fai beside it, or name it with #index=<url>'
      }: an indexed FASTA opens at once and is read by range.`,
  )
}

/**
 * A sequence file as a row: the sequences stay here, the summary goes back.
 *
 * One function for the three ways a genome arrives — a FASTA held whole, a
 * FASTA read through its `.fai`, a `.2bit` read through its own index — because
 * from the row's point of view they are one thing. The `format` is the only
 * place they differ, and it differs because it is what the *bytes* were.
 */
function loadFasta(entry: string, store: Sequences, mapContigs: NamedSequence[]): LoadResult {
  const renaming = renameSequences(store, mapContigs)
  sequences.set(entry, store)
  const names = store.contigs.map((contig) => contig.name)
  return {
    format: isTwoBit(store) ? 'twobit' : 'fasta',
    contigs: names,
    overlap: overlapReport(names, mapContigs, renaming),
    summary:
      // `fmt.bp`, not a full base count: this is a measured span (§26.2), and the
      // Genome card two columns to the left prints the *same* number as
      // `12.11 Mb` while this row printed `12,110,231 bp` — one quantity spelled
      // two ways on one screen, which is the whole of what §26.2 is for.
      `${sequenceCount(names.length)} · ${fmt.bp(store.total)}` +
      (isTwoBit(store)
        ? ' · read by range, two bits a base'
        : isIndexed(store)
          ? ' · read by range from its index'
          : ''),
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
function renameSequences(store: Sequences, mapContigs: NamedSequence[]): Renaming {
  const renaming = renameInto(store.contigs, mapContigs)
  if (renaming.renamed === 0) return renaming
  // Both ranged stores keep their sequences in a `records` map keyed by name, so
  // one helper serves them — two call sites rather than one because narrowing a
  // union by its records' type is what `recordOf`'s type parameter exists to
  // avoid having to do here.
  if (isTwoBit(store)) {
    store.records = renameRecords(store.records, store.contigs, renaming.names)
    store.held.clear()
    return renaming
  }
  if (isIndexed(store)) {
    store.records = renameRecords(store.records, store.contigs, renaming.names)
    store.held.clear()
    return renaming
  }
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
 * A ranged store's records, re-keyed by the map's spelling of each sequence.
 *
 * Renames `contigs` in place as it goes, which is what the two callers'
 * `store.contigs.forEach` used to do inline and is the half that must not be
 * forgotten: a store whose records moved and whose contigs did not is a
 * sequence lane that draws its ruler and no residues.
 */
function renameRecords<T extends { name: string }>(
  records: Map<string, T>,
  contigs: Contig[],
  names: readonly string[],
): Map<string, T> {
  const out = new Map<string, T>()
  contigs.forEach((contig, at) => {
    const record = records.get(contig.name)
    contig.name = names[at]
    if (record !== undefined) out.set(contig.name, { ...record, name: contig.name })
  })
  return out
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
async function gcSamples(
  store: Sequences,
  regions: Region[],
  basesPerPixel: number,
  report: Report,
): Promise<TrackSampleSet> {
  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  if (isRanged(store)) {
    // A window wider than the read it would take draws nothing, and says so
    // rather than sitting blank (§8.8). Summed over every region of the
    // request and not judged one region at a time: a whole-genome view of a
    // cow is thirty chromosomes, each far over the line, and two thousand
    // scaffolds each under it — and reading the scaffolds one ranged request
    // apiece was a lane that stayed empty for minutes while it did.
    const wanted = regions.reduce((sum, region) => sum + Math.max(0, region.end - region.start), 0)
    if (wanted > INDEXED_GC_WINDOW) {
      return {
        basesPerPixel,
        regions: [],
        extent: null,
        note: `GC under ${fmt.int(INDEXED_GC_WINDOW / 1e6)} Mb, letters at base resolution — zoom in`,
      }
    }
  }
  for (const region of regions) {
    if (!(region.end > region.start)) continue
    let bins
    if (isRanged(store)) {
      const from = Math.max(0, Math.floor(region.start))
      const window = await residuesOf(store, region.contig, from, region.end, report)
      if (window === undefined || window.length === 0) continue
      bins = gcBins(window, 0, window.length, basesPerPixel)
      // The window's own coordinates, put back on the sequence's.
      for (let i = 0; i < bins.starts.length; i++) {
        bins.starts[i] += from
        bins.ends[i] += from
      }
    } else {
      const seq = basesOf(store, region.contig)
      if (seq === undefined) continue
      bins = gcBins(seq, region.start, region.end, basesPerPixel)
    }
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
      variant: null,
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
async function bases(entry: string, regions: Region[], report: Report): Promise<BaseResult> {
  const store = sequences.get(entry)
  if (store === undefined) {
    throw new Error('This sequence is no longer open. Drop the file again.')
  }
  const out: BaseRegion[] = []
  let budget = BASES_PER_REQUEST
  for (const region of regions) {
    const start = Math.max(0, Math.floor(region.start))
    if (isRanged(store)) {
      const window = await residuesOf(
        store,
        region.contig,
        start,
        Math.min(Math.ceil(region.end), start + budget),
        report,
      )
      if (window === undefined || window.length === 0) continue
      budget -= window.length
      // `slice` here too: the slab behind `window` is the store's cache.
      out.push({ contig: region.contig, start, end: start + window.length, bases: window.slice() })
      if (budget <= 0) break
      continue
    }
    const seq = basesOf(store, region.contig)
    if (seq === undefined) continue
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
async function loadBigBed(
  entry: string,
  source: WireSource,
  mapContigs: NamedSequence[],
): Promise<LoadResult> {
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
  const text = lines.join('\n')
  // A bigBarChart is a bigBed whose schema says so, and the schema is the file's
  // own declaration rather than a guess from its column shapes (§8.17). Asked
  // of the header, which was already read, so it costs nothing on the bigBeds
  // that are not one.
  // The three bigBed schemas whose payload is *not* in the first twelve columns,
  // asked of the file's own autoSql. §8.7's "read it as the BED it holds" is
  // right for bigGenePred, bigPsl, bigNarrowPeak, bigChain and bigMaf — their
  // leading columns really are a BED12, so they draw their exons and their
  // blocks correctly through the ordinary parser — and it is wrong for exactly
  // these three, whose meaning starts at column 9 or 10. A bigInteract read as a
  // BED is one box spanning both its anchors; a bigMethyl read as a BED is a
  // perfectly plausible lane of coloured boxes with the percentage missing.
  const schema = header.autoSql ?? ''
  if (isBarChartSchema(schema)) {
    const result = loadBarChart(text, source.name, mapContigs)
    return truncated ? { ...result, summary: cutOff(result.summary) } : result
  }
  if (isInteractSchema(schema)) {
    const result = loadInteract(text, mapContigs)
    return truncated ? { ...result, summary: cutOff(result.summary) } : result
  }
  if (isBedMethylSchema(schema)) {
    const result = loadBedMethyl(entry, text, mapContigs)
    return truncated ? { ...result, summary: cutOff(result.summary) } : result
  }
  const data = parseBed(text, source.name)
  // A `bigGenePred` is the one schema here that does *not* change how the rows
  // are read — they are a BED12 and `parseBed` has already read them correctly.
  // What it changes is what they are: a gene model rather than a peak set, which
  // decides the kind, the glyph and the summary (`annotations/genepred.ts`).
  if (isGenePredSchema(schema)) {
    const renaming = renameContigs(data.contigs, mapContigs)
    const result: LoadResult = {
      format: 'genepred',
      contigs: data.contigs,
      overlap: overlapReport(data.contigs, mapContigs, renaming),
      summary: genePredSummary(data),
      payload: { kind: 'features', data },
    }
    return truncated ? { ...result, summary: cutOff(result.summary) } : result
  }
  const result = featureResult('bigbed', data, mapContigs)
  return {
    ...result,
    summary: truncated ? cutOff(result.summary) : result.summary,
  }
}

/** What a summary says once {@link BIGBED_FEATURE_CAP} has bitten. */
function cutOff(summary: string): string {
  return `${summary} · cut off at ${fmt.int(BIGBED_FEATURE_CAP)}`
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
    //
    // **Sequences**, the word the FASTA row above it, the Sequences card, the
    // minimap and the Genome card all use. It said `contigs`, fixed, so a yeast
    // cooler whose breadcrumb reads Chromosomes and whose File card counts
    // chromosomes had every track row calling the same sixteen things contigs —
    // three nouns for one list, in one column. The file-kind noun belongs to the
    // surfaces that report what a file calls its own table, and a track row is
    // not one of those. The **en dash** between the bounds is the app's mark for
    // a range of values (§26.1 keeps the hyphen for a locus).
    summary:
      sequenceCount(contigs.length) +
      (usable ? ` · ${trim(total.scoreMin)}–${trim(total.scoreMax)}` : ''),
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
      `${fmt.int(track.length)} intervals · ${sequenceCount(contigs.length)}` +
      (usable ? ` · ${trim(min)}–${trim(max)}` : ''),
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
    // A bigWig has no reference to disagree with; only an alignment lane fills
    // this in, and it is `null` rather than empty so the two states stay apart.
    out.push({ contig: region.contig, start: region.start, end: region.end, variant: null, ...got })
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
  /** Answer at the data's own resolution; see {@link AnnotationRequest}. */
  exact = false,
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
  if (sequence !== undefined) return gcSamples(sequence, regions, basesPerPixel, reporter(id))

  // A text signal file is the fourth, and the closest of them to a bigWig: the
  // same intervals-and-values answer, summarised here rather than on disk.
  const signal = signals.get(entry)
  if (signal !== undefined) return signalSamples(signal, regions, basesPerPixel)

  // And a computed vector is the third: no file, no zoom levels, a summary
  // built for the window it was asked about (§18.5, `binVector.ts`). It is
  // looked up here, in the one function every lane's values come out of, which
  // is precisely what stops a synthetic track needing a renderer of its own.
  const vector = vectors.get(entry)
  if (vector !== undefined) return binVectorSamples(vector, regions, basesPerPixel, exact)

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
      variant: null,
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
  // A size nobody could state is not a size of nought: a ranged read past the
  // end of a file is a short read, so the bound is only ever a courtesy to a
  // small file, and an unknown one gets the full first read.
  const bound = Number.isFinite(size) && size > 0 ? size : Number.MAX_SAFE_INTEGER
  let want = HEADER_FIRST_READ
  for (;;) {
    let inflated: Uint8Array
    try {
      inflated = await inflateBgzf(await handle.read(Math.min(want, bound), 0))
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
    if (want >= bound || want >= HEADER_MAX_READ) {
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
  report: Report,
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
  // Keyed on the file and its index where there is one, and on the file alone
  // where a search stands in for it: the two rows then share one search and
  // its probes, which is the whole reason the probes are kept.
  const key = indexSource === null ? `${cacheKey(source)}|search` : fileKey(source, indexSource)
  const shared = openFiles.get(key)
  let index: BamIndex | null = null
  let search: BamSearch | null = null
  let searched = ''
  if (shared !== undefined) {
    index = shared.open.index
    search = shared.open.search
    searched = shared.open.searched
  } else {
    // Read once per file, not once per row. A BAI for a human WGS alignment is
    // single-digit megabytes to fetch and to parse, and a BAM makes two rows —
    // the depth and the pile — so paying that twice and throwing the second
    // copy away is the whole cost of the second row.
    if (indexSource === null) searched = 'no index dropped with it'
    else
      try {
        // The one download a BAM costs, and for a deep alignment file tens of
        // megabytes of it: reported, so the row says how far it has got.
        index = await parseBamIndex(await handleFor(indexSource).readFile({ onProgress: report }))
      } catch (err) {
        // The sidecar of a remote file was **guessed** — `<url>.bai`, never
        // probed, because §12 has no request to spend finding out that a file
        // has no index — and on the two buckets the store drawer offers most
        // the guess is wrong for every BAM they hold, since neither publishes
        // an index at all. So an index that is not there is not a refusal any
        // more: it is the road to `bam/search.ts`, and the row's summary says
        // which road it is on and why.
        const why = err instanceof Error ? err.message : String(err)
        searched =
          indexSource.kind === 'remote'
            ? `no ${indexSource.url.split('?')[0].split('/').pop() ?? 'index'} beside it`
            : `${indexSource.name} could not be read (${why})`
      }
    if (index === null) {
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error(
          `${source.name} has ${searched}, and its length could not be learnt, so its reads cannot be ` +
            'located by search either. A BAM is read by region: publish its index beside it, or name ' +
            `one with \`${source.kind === 'remote' ? source.url : source.name}#index=<url of the .bai>\`.`,
        )
      }
      try {
        // Reported as bytes with no total — the search does not know how many
        // probes it will take — so the row says it is on its way.
        search = await BamSearch.open(handle, size, header, (bytes) => report(bytes, 0))
      } catch (err) {
        if (err instanceof UnsortedError) throw new Error(unsortedMessage(source.name, header, err))
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(
          `${source.name} has ${searched} and could not be read by search: ${why}. A BAM is read by ` +
            `region; run \`samtools index ${source.name}\` and publish the index beside it, or name ` +
            'one with `#index=<url of the .bai>`.',
        )
      }
    }
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

  // A second row over a file already open takes the record the first one made,
  // rather than the handle and index this call just built. The renaming above
  // is per *load* and identical for both rows — same header, same map — so
  // nothing about the first row's record is stale for the second.
  const open: OpenBam = shared?.open ?? {
    handle,
    header,
    index,
    search,
    searched,
    size,
    refIdOf,
    refNames: header.refs.map((ref) => ref.name),
  }
  if (shared === undefined) openFiles.set(key, { open, holders: new Set([entry]) })
  else shared.holders.add(entry)
  alignments.set(entry, open)

  return {
    format: 'bam',
    contigs,
    overlap: overlapReport(contigs, mapContigs, renaming),
    summary: `${fmt.int(header.refs.length)} reference${header.refs.length === 1 ? '' : 's'} · ${
      index !== null ? index.format.toUpperCase() : `${searched} — reads located by search`
    }`,
  }
}

/**
 * Why a file whose reads are out of order cannot be read by region, with the
 * two places in it that prove they are, and what to do about it.
 *
 * The Hi-C sentence is there because that is the file this message is read
 * on: every BAM on 4DN's open-data bucket is a pipeline's alignment output,
 * written in read-pair order for the pairs step that follows it, and a reader
 * who opened one from the store drawer wanted the reads and was never told
 * the file is not that kind of file.
 */
function unsortedMessage(name: string, header: BamHeader, err: UnsortedError): string {
  const claim =
    header.sortOrder === 'coordinate'
      ? 'its header says SO:coordinate, but'
      : 'its header has no @HD line to say so, and'
  return (
    `${name} is not in coordinate order — ${claim} the reads at byte ${fmt.int(err.before.block)} are on ` +
    `${placeLabel(err.before, header.refs)} while those at byte ${fmt.int(err.after.block)}, later in the ` +
    `file, are on ${placeLabel(err.after, header.refs)}. Reads are drawn by region, which needs the file ` +
    `sorted and indexed: run \`samtools sort -o sorted.bam ${name}\` and \`samtools index sorted.bam\`. ` +
    'The alignment file a Hi-C pipeline writes is in read-pair order for its pairs step and is not made ' +
    'for browsing; its .pairs or its contact map is the file to open.'
  )
}

/**
 * How wide a window a searched file will locate, summed over its regions.
 *
 * A search is requests — a dozen ranged reads to bracket one window — so a
 * whole-genome view's window per contig would be dozens of searches for a
 * lane the byte cap (§12) would refuse once they had all answered. Refused
 * here instead, for the price of none: four megabases of any alignment file
 * deep enough to be worth a BAM is past the cap.
 */
const SEARCH_MAX_SPAN = 4_000_000

/** The note a searched file answers a window with instead of searching, or `null` to go ahead. */
function searchDeclines(open: OpenBam, wanted: readonly Region[]): string | null {
  if (open.search === null) return null
  const span = wanted.reduce((sum, region) => sum + (region.end - region.start), 0)
  if (wanted.length > 1 || span > SEARCH_MAX_SPAN) return `${spanLabel(span)} without an index — zoom in`
  return null
}

function spanLabel(bp: number): string {
  return bp >= 1_000_000 ? `${trim(bp / 1_000_000)} Mb` : `${trim(bp / 1000)} kb`
}

/**
 * The byte spans of a window: from the index, or by search where there is none.
 *
 * The one seam between the two roads. Everything after it — the read, the
 * inflation, the walk from `dataFrom` — is the same code over the same shape,
 * which is what lets a file without an index draw exactly what one with an
 * index draws.
 */
async function spansOf(
  open: OpenBam,
  refId: number,
  region: Region,
  id: number,
  /** The caller's byte cap, so a search can stop at *over it* rather than locate an end it will not read to. */
  cap: number,
): Promise<BamByteSpan[]> {
  const start = Math.max(0, Math.floor(region.start))
  const end = Math.ceil(region.end)
  if (open.index !== null) return chunksFor(open.index, refId, start, end, open.size)
  if (open.search === null) return []
  return open.search.spansFor(
    refId,
    start,
    end,
    async () => {
      if (!(await stillWanted(id))) throw abortError()
    },
    cap,
  )
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
 *
 * Which is why the depth is a row of its own and not a band of the pile: the
 * two rows over one BAM (§8.13) are filtered by these two functions, and a
 * split read drawn in the pile must not appear as a second molecule in the
 * curve beside it.
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
 * report one fragment as two. The depth row therefore never sees them, however
 * the pile beside it is set — and `readFilterKey` leaves `splits` out, so
 * flipping the switch does not even invalidate the depth's cached samples.
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

  // Without an index the spans come from a search, and a search is requests:
  // one window at a time, never a window per contig.
  const declined = searchDeclines(open, wanted)
  if (declined !== null) return { basesPerPixel, regions: [], extent: null, note: declined }

  // The forecast, before a byte of alignment data is read. Every region at
  // once, because a whole-genome view asks for one window per contig and
  // refusing them one at a time would draw a lane that is partly there.
  const plans: Array<{ region: Region; refId: number; spans: BamByteSpan[] }> = []
  for (const region of wanted) {
    const refId = refIdOf(region.contig) as number
    plans.push({ region, refId, spans: await spansOf(open, refId, region, id, WINDOW_BYTE_CAP) })
  }
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
      note: `${fmt.bytes(forecast)} of reads — zoom in`,
    }
  }

  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const plan of plans) {
    const span = plan.region.end - plan.region.start
    const bins = Math.max(1, Math.min(4096, Math.round(span / Math.max(1, basesPerPixel))))
    const depth = new Float64Array(bins)
    // Residues for this window, if some FASTA in this worker happens to hold
    // them — the same free source the pile's mismatches use. Only below
    // `VARIANT_BELOW`: finding the disagreements is a walk over every aligned
    // base, which is the one thing here that scales with depth times read
    // length, and a bin a kilobase wide would report the genome's background
    // mismatch rate as a variant at every pixel.
    const reference = basesPerPixel <= VARIANT_BELOW ? residuesFor(plan.region) : undefined
    const variant = reference === undefined ? null : new Float64Array(bins)
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
        reference,
      )
      // Summed across spans rather than concatenated: a read overlapping the
      // window may live in any of them, and the bins are the same bins.
      for (let i = 0; i < bins; i++) depth[i] += result.depth[i]
      if (variant !== null && result.variant !== null) {
        for (let i = 0; i < bins; i++) variant[i] += result.variant[i]
      }
    }

    const starts = new Int32Array(bins)
    const ends = new Int32Array(bins)
    const values = new Float32Array(bins)
    const differing = variant === null ? null : new Float32Array(bins)
    const width = span / bins
    for (let i = 0; i < bins; i++) {
      starts[i] = Math.round(plan.region.start + i * width)
      ends[i] = Math.round(plan.region.start + (i + 1) * width)
      values[i] = depth[i]
      if (differing !== null && variant !== null) differing[i] = variant[i]
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
      variant: differing,
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
    piles: [], total: 0, kept: 0, capped: false, rows: 0, diffs: 'none',
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

  const plans: Array<{ region: Region; refId: number; spans: BamByteSpan[] }> = []
  for (const region of wanted) {
    const refId = refIdOf(region.contig) as number
    plans.push({ region, refId, spans: await spansOf(open, refId, region, id, READ_BYTE_CAP) })
  }
  const forecast = plans.reduce((sum, plan) => sum + forecastBytes(plan.spans), 0)
  if (forecast > READ_BYTE_CAP) {
    return { ...empty, note: `${fmt.bytes(forecast)} of reads here — zoom in` }
  }

  const piles: ReadPile[] = []
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
          // The pile's own filter, which is the only one that admits a
          // supplementary alignment. What is *counted* is the depth row beside
          // this one, and it goes through `filterOf` on its own road.
          filter: pileFilterOf(style),
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
      if (result.pile.length > 0 || piles.length === 0) piles.push(result.pile)
    }
  }

  return {
    piles,
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
 * The bases-per-pixel below which the depth row is checked against a reference.
 *
 * Two limits meet here and both point the same way. The cost: finding the
 * disagreements means walking every *aligned base* of every kept read rather
 * than the blocks of its CIGAR, and the depth scan is the most expensive read
 * in this application (§12) — it must not grow that way at whole-genome widths.
 * The meaning: a variant is a claim about a *position*, and a bin holding two
 * hundred bases reports the genome's background mismatch rate as a coloured
 * pixel everywhere. Sixteen is about the width at which a pixel is still a
 * handful of bases, which is where a reader starts looking for one.
 */
const VARIANT_BELOW = 16

/**
 * Residues covering a region, from any FASTA this worker already holds.
 *
 * A scan across the open sequence stores rather than one lookup, because they
 * are keyed by the *entry* that owns them and an alignment lane has no idea
 * which row a genome was dropped as. Cheap: there is rarely more than one, and
 * this runs once per fetched window rather than per frame.
 */
function residuesFor(region: Region): { start: number; bases: Uint8Array } | undefined {
  const start = Math.max(0, Math.floor(region.start))
  for (const store of sequences.values()) {
    if (isRanged(store)) {
      // Never fetched for (§8.13): what a ranged sequence has is the slab its
      // own lane last drew, and the pile reads that or nothing. True of a
      // `.2bit` for the same reason it is true of an indexed FASTA — colouring
      // a read pile is not worth a request, whichever format would serve it.
      const record = recordOf<FaiRecord | TwoBitRecord>(store, region.contig)
      const slab = record === undefined ? undefined : store.held.get(record.name)
      if (slab === undefined) continue
      const end = Math.min(slab.start + slab.bases.length, Math.ceil(region.end))
      if (slab.start > start || end <= start) continue
      return { start, bases: slab.bases.subarray(start - slab.start, end - slab.start) }
    }
    const held = basesOf(store, region.contig)
    if (held === undefined) continue
    const end = Math.min(held.length, Math.ceil(region.end))
    if (end <= start) continue
    return { start, bases: held.subarray(start, end) }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Formatting, for the one-line summaries
// ---------------------------------------------------------------------------

/** `16 sequences`, or `1 sequence` — the plural spelled, never `(s)`. */
function sequenceCount(total: number): string {
  return `${fmt.int(total)} sequence${total === 1 ? '' : 's'}`
}

/**
 * A header statistic with enough digits to be useful and no more.
 *
 * Grouped above a thousand, like every other number on the card. It was
 * `toFixed(0)`, so a bigWig whose values reach 1599 wrote `0.16 to 1599` on a
 * row two above one reading `12,110,231 bp` — the same card, one number
 * grouped and the next not, which reads as a different kind of quantity.
 */
function trim(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  if (magnitude === 0) return '0'
  if (magnitude >= 1000) return fmt.int(Math.round(value))
  if (magnitude >= 1) return value.toFixed(2).replace(/\.?0+$/, '')
  return value.toPrecision(2)
}
