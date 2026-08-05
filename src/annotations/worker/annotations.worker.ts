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
import type { RefInfo } from '@gmod/bbi'
import { BlobFile, RemoteFile } from 'generic-filehandle2'

import { transfersFor } from '../../worker/protocol'
import { LOAD_REPORT_MS, startBusyProbe } from '../../perf/busy'
import { looksLikeChromSizes, parseChromSizes, type Contig } from '../../genome/assembly'
import { overlapWith } from '../featureset'
import { gcBins, looksLikeFasta, parseFasta, type SequenceStore } from '../fasta'
import {
  decodeAnnotationBytes,
  parseBed,
  parseBedpe,
  parseGtf,
  sniffFormat,
} from '../parse'
import type { BaseRegion, FeatureSet, Region, TrackSamples, TrackSampleSet } from '../types'
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

/** An open bigWig, kept for the life of the entry that owns it. */
interface OpenTrack {
  bigwig: BigWig
  /** Contig names as the file spells them, for skipping regions it cannot answer. */
  contigs: Set<string>
}

const tracks = new Map<string, OpenTrack>()

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

async function handle(request: AnnotationRequest): Promise<void> {
  try {
    const payload = await dispatch(request)
    const response: AnnotationResponse = { type: 'result', id: request.id, payload }
    ;(self as unknown as Worker).postMessage(response, transfersFor(payload))
  } catch (err) {
    const response: AnnotationResponse = {
      type: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(response)
  }
}

async function dispatch(request: AnnotationRequest): Promise<unknown> {
  switch (request.kind) {
    case 'load':
      return load(request.entry, request.source, request.mapContigs)
    case 'sample':
      return sample(request.entry, request.regions, request.basesPerPixel)
    case 'bases':
      return bases(request.entry, request.regions)
    case 'assembly':
      return assemblyOf(request.source)
    case 'drop': {
      tracks.delete(request.entry)
      // …and let go of the parse behind it. A sequence store is up to three
      // hundred megabytes, and `recentFasta` exists only to answer the second of
      // two consecutive questions about one drop — holding a dropped genome
      // alive afterwards would be the largest leak in the application.
      const store = sequences.get(request.entry)
      if (store !== undefined && recentFasta?.store === store) recentFasta = null
      sequences.delete(request.entry)
      return null
    }
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
  const head = await handle.read(8, 0)
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

function handleFor(source: WireSource): BlobFile | RemoteFile {
  return source.kind === 'local' ? new BlobFile(source.file) : new RemoteFile(source.url)
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
async function load(entry: string, source: WireSource, mapContigs: string[]): Promise<LoadResult> {
  const handle = handleFor(source)
  const head = await handle.read(4, 0)
  const magic = bbiMagic(head)

  if (magic === 'bigwig') return loadBigWig(entry, source, mapContigs)
  if (magic === 'bigbed') return loadBigBed(source, mapContigs)
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

  const bytes = await decodeAnnotationBytes(await handle.readFile())
  if (looksLikeFasta(bytes)) return loadFasta(entry, keepFasta(source, bytes), mapContigs)
  const text = new TextDecoder().decode(bytes)
  if (text.trim() === '') throw new Error('This file is empty.')

  const format: DetectedFormat = sniffFormat(text, source.name)
  if (format === 'bedpe') {
    const data = parseBedpe(text)
    return {
      format,
      contigs: data.contigs,
      overlap: overlapWith(data.contigs, mapContigs),
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
  mapContigs: string[],
): LoadResult {
  const exons = data.exonStart.length
  return {
    format,
    contigs: data.contigs,
    overlap: overlapWith(data.contigs, mapContigs),
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
function loadFasta(entry: string, store: SequenceStore, mapContigs: string[]): LoadResult {
  sequences.set(entry, store)
  const names = store.contigs.map((contig) => contig.name)
  return {
    format: 'fasta',
    contigs: names,
    overlap: overlapWith(names, mapContigs),
    summary: `${count(names.length)} sequence${names.length === 1 ? '' : 's'} · ${count(store.total)} bp`,
  }
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
    const seq = store.bases.get(region.contig)
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
    const seq = store.bases.get(region.contig)
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
async function loadBigBed(source: WireSource, mapContigs: string[]): Promise<LoadResult> {
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
  mapContigs: string[],
): Promise<LoadResult> {
  const bigwig = new BigWig({ filehandle: handleFor(source) })
  const header = await bigwig.getHeader()
  const contigs = Object.keys(header.refsByName)
  tracks.set(entry, { bigwig, contigs: new Set(contigs) })

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
    overlap: overlapWith(contigs, mapContigs),
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
): Promise<TrackSampleSet> {
  // A FASTA answers the same question with the same shape of answer, and this
  // is where the two formats part company: one has zoom levels on disk, the
  // other computes its summary from the residues it is holding.
  const sequence = sequences.get(entry)
  if (sequence !== undefined) return gcSamples(sequence, regions, basesPerPixel)

  const track = tracks.get(entry)
  if (track === undefined) {
    throw new Error('This track is no longer open. Drop the file again.')
  }
  const wanted = regions.filter((region) => track.contigs.has(region.contig) && region.end > region.start)
  if (wanted.length === 0) return { basesPerPixel, regions: [], extent: null }

  const packed = await track.bigwig.getFeaturesAsArraysMulti(
    wanted.map((region) => ({
      refName: region.contig,
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
