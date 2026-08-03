/**
 * The annotations worker's vocabulary.
 *
 * A second worker beside the reader's, not a second set of messages inside it.
 * The two own unrelated things — one holds an open HDF5 mount, the other holds
 * open bigWig handles and parsed feature tables — and a `sample` request behind
 * a whole-genome pixel scan would wait for it. Separate workers means an
 * annotation never blocks a matrix read and a matrix read never blocks a track.
 *
 * The split of labour is the interesting part. Text formats are parsed **once**
 * and the result is handed to the main thread whole, because a parsed
 * `FeatureSet` is a few hundred kilobytes of typed arrays and having it locally
 * is what lets a pan redraw features with no round trip at all. A bigWig is the
 * other way round: the handle stays here, and each view asks for the values it
 * needs at the resolution it needs them (spec §8.2, §8.4).
 */

import type { AnnotationPayload, ContigOverlap, Region, TrackSampleSet } from '../types'

/** What a file turned out to be, decided by its bytes (§8.3). */
export type DetectedFormat = 'bigwig' | 'bigbed' | 'gtf' | 'bed' | 'bedpe'

/** How to reach the bytes, in the shape that survives `postMessage`. */
export type WireSource = { kind: 'local'; file: File; name: string } | { kind: 'remote'; url: string; name: string }

export interface LoadResult {
  format: DetectedFormat
  /** Contig names as *this file* spells them. */
  contigs: string[]
  overlap: ContigOverlap
  /** One line for under the label: "7,071 transcripts", "16 contigs · 5 zoom levels". */
  summary: string
  /** Present for the text formats; a bigWig's data is fetched per view instead. */
  payload?: AnnotationPayload
  /** A bigWig's whole-file value range, from its header. Seeds a manual clip. */
  fileExtent?: { min: number; max: number }
}

export interface AnnotationResultMap {
  load: LoadResult
  sample: TrackSampleSet
  drop: null
}

export type AnnotationRequestKind = keyof AnnotationResultMap

export type AnnotationRequest =
  | { id: number; kind: 'load'; entry: string; source: WireSource; mapContigs: string[] }
  | {
      id: number
      kind: 'sample'
      entry: string
      regions: Region[]
      /** Drives the file's own zoom-level choice; `basesPerSpan` in bbi's terms. */
      basesPerPixel: number
    }
  | { id: number; kind: 'drop'; entry: string }

export type AnnotationRequestOf<K extends AnnotationRequestKind> = Omit<
  Extract<AnnotationRequest, { kind: K }>,
  'id'
>

export type AnnotationResponse =
  | { type: 'result'; id: number; payload: unknown }
  | { type: 'error'; id: number; message: string }

/**
 * The two BBI magic numbers, little-endian as written.
 *
 * Read from the first four bytes rather than inferred from the suffix, because
 * a bigWig saved as `.bigwig`, `.bw` or with no suffix at all is the same file,
 * and because a *text* file called `.bw` should fail as text rather than as a
 * corrupt index.
 */
export const BIGWIG_MAGIC = 0x888ffc26
export const BIGBED_MAGIC = 0x8789f2eb

/** What the first bytes of a file say it is, or `null` for "not a BBI file". */
export function bbiMagic(head: Uint8Array): 'bigwig' | 'bigbed' | null {
  if (head.length < 4) return null
  const view = new DataView(head.buffer, head.byteOffset, 4)
  for (const littleEndian of [true, false]) {
    const magic = view.getUint32(0, littleEndian)
    if (magic === BIGWIG_MAGIC) return 'bigwig'
    if (magic === BIGBED_MAGIC) return 'bigbed'
  }
  return null
}
