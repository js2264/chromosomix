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

import type { AnnotationPayload, BaseRegion, ContigOverlap, Region, TrackSampleSet } from '../types'
import type { AssemblyOrigin, Contig } from '../../genome/assembly'

/**
 * What a file turned out to be, decided by its bytes (§8.3).
 *
 * `sizes` and `hdf5` were added for the genome browser, which starts from a file
 * rather than from a map: one of them declares an assembly outright and the
 * other is a contact matrix that belongs to the reader worker instead. Both are
 * decided here because this is already the only place that looks at bytes before
 * anything has committed to what they are.
 *
 * `fasta` is both at once — it declares an assembly *and* it is the thing being
 * annotated — which is why it is the one format that answers the `assembly`
 * question with exact lengths and still becomes a lane of its own.
 */
export type DetectedFormat =
  | 'bigwig'
  | 'bigbed'
  | 'gtf'
  | 'bed'
  | 'bedpe'
  | 'sizes'
  | 'hdf5'
  | 'fasta'

/** How to reach the bytes, in the shape that survives `postMessage`. */
export type WireSource = { kind: 'local'; file: File; name: string } | { kind: 'remote'; url: string; name: string }

export interface LoadResult {
  format: DetectedFormat
  /** Contig names as *this file* spells them. */
  contigs: string[]
  overlap: ContigOverlap
  /** One line for under the label: "7,071 transcripts", "16 contigs · 0 to 41.2". */
  summary: string
  /** Present for the text formats; a bigWig's data is fetched per view instead. */
  payload?: AnnotationPayload
  /** A bigWig's whole-file value range, from its header. Seeds a manual clip. */
  fileExtent?: { min: number; max: number }
}

/**
 * What a file says about the genome it is on.
 *
 * `contigs` is empty when the file names none — an HDF5 file, which is the
 * reader's business, or text this worker could not identify. The caller decides
 * what to do with that; refusing here would mean this request could not be used
 * to *route* a dropped file, which is most of what it is for.
 */
export interface AssemblyResult {
  format: DetectedFormat | null
  contigs: Contig[]
  origin: AssemblyOrigin
  /** `true` when the lengths are the file's own rather than a lower bound. */
  exact: boolean
}

/** The residues a view asked for, one window per region it could answer. */
export interface BaseResult {
  regions: BaseRegion[]
}

export interface AnnotationResultMap {
  load: LoadResult
  sample: TrackSampleSet
  bases: BaseResult
  assembly: AssemblyResult
  drop: null
}

export type AnnotationRequestKind = keyof AnnotationResultMap

export type AnnotationRequest =
  | { id: number; kind: 'load'; entry: string; source: WireSource; mapContigs: string[] }
  // What genome is this file on, and is it even one of ours? The one request
  // that may be made about a file nothing has decided to open yet — it is what
  // routes a drop between the reader worker and the genome browser.
  | { id: number; kind: 'assembly'; source: WireSource }
  | {
      id: number
      kind: 'sample'
      entry: string
      regions: Region[]
      /** Drives the file's own zoom-level choice; `basesPerSpan` in bbi's terms. */
      basesPerPixel: number
    }
  // The residues themselves, which only a FASTA can answer and only a view
  // zoomed in far enough to draw them ever asks for. Separate from `sample`
  // because it is a different *kind* of answer — letters rather than a value per
  // pixel — and because the window it is asked over is the one a screen of
  // single bases covers, never a chromosome.
  | { id: number; kind: 'bases'; entry: string; regions: Region[] }
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

/**
 * HDF5's own signature: `\x89HDF\r\n\x1a\n`.
 *
 * Read here, in the worker that reads every file's first bytes, so that a
 * cooler dropped on the genome browser is recognised as one *without* the
 * browser having to import h5wasm — which the layering rule (§6.1, and this
 * repo's three enforced rules) forbids outside `src/h5/`. Recognising is not
 * reading: what happens next is that the file is handed to the reader worker,
 * which is the only thing that opens it.
 */
const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]

/** `true` when the first eight bytes are HDF5's signature. */
export function isHdf5(head: Uint8Array): boolean {
  if (head.length < HDF5_SIGNATURE.length) return false
  return HDF5_SIGNATURE.every((byte, index) => head[index] === byte)
}

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
