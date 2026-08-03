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

import { BigWig } from '@gmod/bbi'
import { BlobFile, RemoteFile } from 'generic-filehandle2'

import { transfersFor } from '../../worker/protocol'
import { overlapWith } from '../featureset'
import { decodeAnnotationText, parseBed, parseBedpe, parseGtf, sniffFormat } from '../parse'
import type { Region, TrackSamples, TrackSampleSet } from '../types'
import {
  bbiMagic,
  type AnnotationRequest,
  type AnnotationResponse,
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
    case 'drop':
      tracks.delete(request.entry)
      return null
  }
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
  if (magic === 'bigbed') {
    throw new Error(
      'This is a bigBed. Only bigWig is read as a track; export the intervals as BED and ' +
        'drop that instead.',
    )
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
  const levels = header.zoomLevels.length

  return {
    format: 'bigwig',
    contigs,
    overlap: overlapWith(contigs, mapContigs),
    summary:
      `${count(contigs.length)} contigs · ${levels} zoom level${levels === 1 ? '' : 's'}` +
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
