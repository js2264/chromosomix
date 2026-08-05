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
import { looksLikeChromSizes, parseChromSizes, type Contig } from '../../genome/assembly'
import { overlapWith } from '../featureset'
import { decodeAnnotationText, parseBed, parseBedpe, parseGtf, sniffFormat } from '../parse'
import type { FeatureSet, Region, TrackSamples, TrackSampleSet } from '../types'
import {
  bbiMagic,
  isHdf5,
  type AnnotationRequest,
  type AnnotationResponse,
  type AssemblyResult,
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

/** A local file's identity for {@link recent}; a URL is its own. */
function cacheKey(source: WireSource): string {
  return source.kind === 'local' ? `${source.name}|${source.file.size}` : source.url
}

self.onmessage = (event: MessageEvent<AnnotationRequest>) => {
  void handle(event.data)
}

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
    case 'assembly':
      return assemblyOf(request.source)
    case 'drop':
      tracks.delete(request.entry)
      return null
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

  const bytes = await handle.readFile()
  const text = await decodeAnnotationText(bytes)
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

  const bytes = await handle.readFile()
  const text = await decodeAnnotationText(bytes)
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
