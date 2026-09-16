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

import type {
  AnnotationPayload,
  BaseRegion,
  ContigOverlap,
  ReadStyle,
  ReadWindow,
  Region,
  TrackSampleSet,
} from '../types'
import type { BinVector } from './binVector'
import type { AnalysisFraming, Params, TaskResult } from '../../analysis/types'
import type { TaskInputs } from '../../analysis/worker/protocol'
import type { S3Credential } from '../../s3/sigv4'
import type { AssemblyOrigin, Contig } from '../../genome/assembly'
import type { NamedSequence } from '../../genome/naming'

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
  // The two text signal formats. They resolve to a `track` exactly as a bigWig
  // does — a bedGraph *is* a bigWig written out — so nothing downstream of
  // `kindFor` learns they exist. See `annotations/signal.ts`.
  | 'bedgraph'
  | 'wig'
  | 'gtf'
  | 'bed'
  | 'bedpe'
  // Called variants (§8.14). Its own member rather than a `bed`, because what a
  // reader means by a row is different — and because `kindFor` sends it to a
  // kind with its own controls and its own card.
  | 'vcf'
  // A chart per feature (§8.17). Covers the text `.barChart` and the bigBed
  // written with a barChart schema alike: what a bigBarChart *is* on disk is a
  // bigBed, but what it holds is not a set of boxes, and the two answers to
  // "what is this" that matter downstream are the kind it becomes and the
  // parser that reads it — which are the same for both.
  | 'barchart'
  // UCSC's two interaction formats (§8.18). Both become a `PairSet`, which is
  // what a bedpe becomes, so both are `kindFor`'d to `'pairs'` and drawn as
  // arcs — but they stay two members because the summary line differs (a
  // longrange folds reciprocal lines and says so) and because a refusal that
  // named the wrong one would send a reader to the wrong specification.
  | 'interact'
  | 'longrange'
  // UCSC's gene-model tables (§8.19): `genePred`, `genePredExt` and `refFlat`,
  // with or without the leading `bin` column a MySQL dump carries. A
  // `FeatureSet` with exons, exactly as a GTF is, and its own member because
  // that is what lets the summary say *transcripts* and the refusal name the
  // ten columns rather than BED's three.
  | 'genepred'
  // Base-resolution modification calls (§8.20). A *track*, not a feature set —
  // it resolves to `'track'` exactly as a bedGraph does — and a member of its
  // own so that the lane can say which modification it is drawing and which
  // ones it is not.
  | 'bedmethyl'
  | 'sizes'
  | 'hdf5'
  | 'fasta'
  // UCSC's packed sequence format (§8.21). Named apart from `fasta` for the
  // reason `bam` is named apart from `alignments`: this is what the *bytes*
  // turned out to be. What it becomes is a sequence like any other.
  | 'twobit'
  // Aligned reads (§8.13). Named `bam` and not `alignments` because this is
  // what the *bytes* turned out to be, and CRAM — which is refused, and for its
  // own reasons — would be a second member here rather than the same one.
  | 'bam'

/**
 * How to reach the bytes, in the shape that survives `postMessage`.
 *
 * A remote track may carry the credential that signs it, for the reasons in
 * `worker/protocol.ts`'s `SourceSpec`: the worker has no credential store and
 * no `localStorage` to build one from, so the one key the URL needs travels
 * with the URL. Absent means an unsigned request, which is every public track.
 *
 * `headers` is the other kind of credential — a Google API key, a bearer token —
 * and travels for the same reason again, with one difference worth naming: it is
 * *static*, so it goes on every request this worker makes for the URL rather
 * than being recomputed per request the way a signature is (SPECS §24.7). Both
 * are merged by `sources/access.ts`, which is also what the reader worker uses,
 * so a private bigWig and a private cooler are authorised identically.
 *
 * `index` is a tabix sidecar (`annotations/tabix.ts`), and it travels the same
 * way for the same reason: the worker cannot go looking for a `File` the drop
 * target was handed, and probing a URL for one is the *caller's* network call to
 * account for. Absent means the file is read whole, which is what always
 * happened and still works.
 */
export type WireSource =
  | { kind: 'local'; file: File; name: string; index?: File }
  | {
      kind: 'remote'
      url: string
      name: string
      credential?: S3Credential
      headers?: Record<string, string>
      index?: string
    }

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
  register: null
  run: TaskResult
  drop: null
  cancel: null
  reads: ReadWindow
}

export type AnnotationRequestKind = keyof AnnotationResultMap

export type AnnotationRequest =
  | {
      id: number
      kind: 'load'
      entry: string
      source: WireSource
      /**
       * The map's sequences, **with their lengths** where the map knows them.
       *
       * Names alone would do for the §8.2 overlap report, and did. The lengths
       * are what {@link renameInto} needs: matching a track's names onto the
       * map's under another convention (§5.9) is only safe while a length that
       * disagrees can veto it, and a map that hands over names alone gets a
       * matcher with nothing to check its own guesses against.
       */
      mapContigs: NamedSequence[]
    }
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
      /**
       * The lane's read controls, for the one kind that has any.
       *
       * On the request rather than held per entry in the worker, which is the
       * decision worth recording. A `configure` message setting `OpenBam.filter`
       * would be one message where this is a field — but it makes the answer to
       * a `sample` depend on the order two messages happened to arrive in, and
       * it leaves the cached samples on this side keyed on nothing that changed.
       * Carrying the controls means a request states in full what it is asking,
       * and a cache mismatch is a mismatched key rather than a race.
       *
       * Optional because no other kind has these controls; absent means the
       * defaults, which is what every non-alignment lane sends.
       */
      reads?: ReadStyle
      /**
       * Answer at the data's own resolution, however many intervals that is.
       *
       * A `sample` is normally answering a **frame**: a few hundred pixels wide,
       * so a computed vector folds its bins into at most a few thousand buckets
       * (`binVector.ts`) and a bigWig is read from whichever zoom level suits
       * the span. Both are right for drawing and both are a *reduction*.
       *
       * An **export** is not a frame. A comparison of two loaded tracks written
       * to a file has to carry what the operands actually say — the reader who
       * divided two 10 bp tracks wants a 10 bp file back — and a bucketed answer
       * is a re-binning nothing on the way out could undo or even detect. So the
       * one caller that is writing a file asks for the data instead of a picture
       * of it, and no lane ever sets this.
       */
      exact?: true
    }
  // The residues themselves, which only a FASTA can answer and only a view
  // zoomed in far enough to draw them ever asks for. Separate from `sample`
  // because it is a different *kind* of answer — letters rather than a value per
  // pixel — and because the window it is asked over is the one a screen of
  // single bases covers, never a chromosome.
  | { id: number; kind: 'bases'; entry: string; regions: Region[] }
  // A lane whose values were computed rather than read (§18.5). Registered
  // once, and answered by `sample` from then on exactly as a bigWig is —
  // which is the whole of what makes a synthetic track a track. See
  // `binVector.ts` for why this is a registration rather than a fourth kind
  // of lane fed from the main thread every frame.
  | { id: number; kind: 'register'; entry: string; vector: BinVector }
  // An analysis task whose inputs are already here (§18.3). The same shape the
  // analysis worker's own `run` takes, deliberately: two venues, one request,
  // so the main-thread runner routes rather than translating.
  | {
      id: number
      kind: 'run'
      task: string
      params: Params
      framing: AnalysisFraming
      inputs: TaskInputs
    }
  /**
   * The reads themselves, and the base counts under them (§8.13).
   *
   * Its own request rather than a wider `sample`, and for the reason `bases`
   * is: it is a different *kind* of answer. `sample` returns a value per pixel
   * and every lane in the application draws it the same way; this returns
   * individual molecules with rows, mates, CIGARs and disagreements, over a
   * window a screen of readable reads covers rather than a chromosome.
   *
   * Only the 1D browser ever sends one. A read is drawn along the axis at its
   * own extent, and beside a heatmap the axis is an axis of matrix bins where
   * the finest unit is a bin — there is nothing there for a read to be drawn
   * *on*.
   */
  | {
      id: number
      kind: 'reads'
      entry: string
      regions: Region[]
      /** Rows the lane can draw, which is what the thinning is budgeted against. */
      maxRows: number
      /** Bases per pixel, so the worker knows whether names could be read. */
      basesPerPixel: number
      /**
       * The lane's read controls. Required here, unlike on `sample`: only an
       * alignment lane ever sends this request, so there is no caller for whom
       * the field would be meaningless.
       */
      reads: ReadStyle
    }
  | { id: number; kind: 'drop'; entry: string }
  /**
   * Call off a request that is still running.
   *
   * This worker went without one for a long time, and the reason is written in
   * `client.ts`: the longest request was a third of a second, and the shortest
   * was the one a pan would cancel a hundred of. Alignments end that. A window
   * of alignment records is tens of BGZF blocks to inflate before a single
   * record is decoded, and a fast drag across a deep region queues one of those
   * per frame — behind which every bigWig's `sample` waits, because this thread
   * answers them all and `onmessage` fires each `handle` without a queue.
   *
   * Cooperative, exactly as `reader.worker.ts`'s is: the worker checks between
   * units of work and stops at the next boundary rather than being killed
   * mid-write, and the check is only reached because the work yields with
   * `yieldToEventLoop()` — a microtask would drain inside the same task and
   * this message would sit unread until the work it cancels had finished.
   */
  | { id: number; kind: 'cancel'; target: number }

export type AnnotationRequestOf<K extends AnnotationRequestKind> = Omit<
  Extract<AnnotationRequest, { kind: K }>,
  'id'
>

export type AnnotationResponse =
  | { type: 'result'; id: number; payload: unknown }
  /**
   * `cancelled` distinguishes "you called this off" from "this went wrong", so
   * a lane that has moved on can drop the answer silently instead of drawing a
   * failure the reader caused by panning.
   */
  | { type: 'error'; id: number; message: string; cancelled?: boolean }
  // Only an analysis task reports progress from here. A `load` or a `sample` is
  // over in milliseconds and a bar for one would flicker; a metaplot over five
  // thousand features and four tracks is a job, and §18.3 says a job reports.
  | { type: 'progress'; id: number; done: number; total: number; note?: string }
  // Unsolicited: how busy this thread has been, for the status bar's CPU
  // figure. No id, because it answers no request (see `perf/busy.ts`). Not
  // called `load` — that is already a *request* kind here, and one word for two
  // unrelated messages in one protocol is how a switch ends up in the wrong arm.
  | { type: 'busy'; fraction: number }

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
