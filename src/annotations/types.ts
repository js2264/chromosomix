/**
 * What an annotation *is*, before anything decides how to draw it.
 *
 * Everything in this module is deliberately free of DOM, canvas and worker
 * concerns: the same descriptions cross the worker boundary, get persisted to
 * session storage, and drive the renderers. Spec §8.
 *
 * Two shapes carry every text format the viewer accepts. {@link FeatureSet} is
 * one interval per row — a BED line, a narrowPeak, a GTF gene with its exons —
 * and {@link PairSet} is two intervals per row, which is a bedpe and nothing
 * else. Both are typed arrays with a parallel `string[]` for the human-readable
 * columns, because a 41,000-line GTF as an array of objects is four megabytes of
 * pointer-chasing to draw a picture that has at most a few hundred glyphs in it.
 */

// ---------------------------------------------------------------------------
// What was loaded
// ---------------------------------------------------------------------------

/**
 * The four things a loaded file can be.
 *
 * `sequence` is the odd one: a FASTA is not an annotation *of* a genome, it is
 * the genome, and what a lane shows for it depends entirely on the zoom — GC
 * content where a pixel is a hundred bases, the residues themselves where a base
 * is a pixel. Like a bigWig it carries no payload, because the sequence stays in
 * the worker and each view asks for the window it is drawing.
 *
 * `gtf` and `segments` are both {@link FeatureSet}s and differ only in what the
 * reader means by them: a gene model is drawn as exons on a spine and there may
 * be only one, a segment file is drawn as boxes and there may be any number.
 * The distinction is the user's, made by which drop area the file landed in, and
 * it is kept because "the annotation" and "a peak set" are not the same thing on
 * screen even when the file format is.
 */
import type { TrackOp } from './derived'

export type AnnotationKind = 'gtf' | 'track' | 'segments' | 'pairs' | 'sequence' | 'viewpoint'

/**
 * Which card an entry belongs to; see §8.1.
 *
 * `viewpoint` is the odd one and it belongs to no card at all: the virtual 4C
 * profile is a *reading of the matrix* rather than a file loaded against it, so
 * it has no row in the Tracks card, no place in the 1D browser, and nothing to
 * remember across a reload. It is here so that everything else about a lane —
 * its colour, its name, its value axis, its height, which edge it is drawn on,
 * where it sits in the stack — is the one implementation the other kinds use,
 * rather than a second copy of all of it (§5.8).
 */
export type AnnotationCard = 'linear' | 'overlay' | 'viewpoint'

/**
 * Where the bytes come from. The same two-case split as the reader's
 * `SourceSpec` (§6.1), and for the same reason: a dropped `File` is handed
 * around by reference and never uploaded (§11), a URL is fetched in ranges.
 */
export type AnnotationSource =
  | { kind: 'local'; file: File; name: string }
  | { kind: 'remote'; url: string; name: string }

/**
 * Which edge of the map a lane is drawn on.
 *
 * All four, and they are peers. `bottom` and `right` follow the map's columns
 * and rows respectively; `top` is `bottom`'s mirror and `left` is `right`'s, and
 * everything from the layout to the value axis is written in terms of *along*
 * and *across* so that adding the mirrors added no branch anybody has to keep in
 * step (`render/lane.ts`).
 */
export type LaneEdge = 'top' | 'right' | 'bottom' | 'left'

/**
 * The edges in the order a stack is laid out and drawn.
 *
 * Clockwise from the top, which is also the order they are listed in every
 * control that offers them, so a reader who has seen one list has seen them all.
 */
export const LANE_EDGES: readonly LaneEdge[] = ['top', 'right', 'bottom', 'left']

/**
 * Whether this kind is drawn as a value profile against an axis.
 *
 * The question every lane asks before it resolves a pair of limits, writes a
 * range under a name, or answers a readout with a number — and it is asked in a
 * dozen places, which is exactly why it is a function rather than a list of
 * kinds spelled out at each of them. A FASTA is one of these beside a map,
 * because at a bin per pixel a sequence can only be its GC content.
 */
export function drawsAProfile(kind: AnnotationKind): boolean {
  return kind === 'track' || kind === 'sequence' || kind === 'viewpoint'
}

/**
 * Whether the reader may move this kind's value axis.
 *
 * Everything {@link drawsAProfile} covers except a sequence: GC content is a
 * fraction pinned to the whole of `[0, 1]` on purpose, so that the same genome
 * looks the same in two views (see {@link defaultStyle}). A ceiling drag, a
 * ⌘-scroll and the autoscale button all ask this.
 */
export function hasAMovableAxis(kind: AnnotationKind): boolean {
  return kind === 'track' || kind === 'viewpoint'
}

/** A half-open genomic interval on one contig, as every query here takes one. */
export interface Region {
  contig: string
  start: number
  end: number
}

// ---------------------------------------------------------------------------
// Parsed text formats
// ---------------------------------------------------------------------------

/**
 * What joins the attributes of one feature into its `detail` string.
 *
 * A shared constant because the string is written by two parsers and read back
 * apart by the dialog that lists a feature's attributes one to a line. Spelled
 * out at each of those three sites, the day one of them gained a space or lost
 * one would be the day the dialog quietly stopped splitting — and it would still
 * look like a working dialog, showing one long line where there were four.
 */
export const DETAIL_SEP = ' · '

/**
 * One interval per row, sorted by `(contig, start)`.
 *
 * The sort is what makes a range query a binary search rather than a scan, and
 * it is done once at parse time — in the worker, off the main thread — because
 * the alternative is doing it on every frame of a pan.
 *
 * `exonAt`/`exonStart`/`exonEnd` are the sub-structure a gene model or a BED12
 * row carries, flattened: feature `i` owns `exonStart[exonAt[i] .. exonAt[i+1]]`.
 * Left as three empty arrays for a format that has none, so the drawing code
 * asks one question ("does this feature have exons") rather than branching on
 * which parser produced it.
 */
export interface FeatureSet {
  /** Contig names, in the order this file first mentions them. */
  contigs: string[]
  /** Number of features. Every typed array below is this long, except the exons. */
  length: number
  /** Index into {@link contigs}, per feature. */
  contig: Int32Array
  /** 0-based, half-open — the BED convention, which GTF is converted into. */
  start: Int32Array
  end: Int32Array
  /** `+1`, `-1`, or `0` where the format carries no strand. */
  strand: Int8Array
  /** `NaN` where the format carries no score. */
  score: Float32Array
  /** What to write on the feature; `''` when there is nothing to write. */
  name: string[]
  /**
   * The attributes worth showing, joined with {@link DETAIL_SEP}.
   *
   * One string per feature rather than an array per feature, because there are
   * millions of them and a million small arrays is a million allocations for
   * text that is read one row at a time. Anything that wants the parts back
   * splits on the separator — which is why the separator is a constant both
   * sides import rather than a punctuation mark each side spells out.
   */
  detail: string[]
  /** `exonAt[i] .. exonAt[i + 1]` indexes the two arrays below. Length `n + 1`. */
  exonAt: Int32Array
  exonStart: Int32Array
  exonEnd: Int32Array
  /** Coding span (GTF CDS, BED `thickStart`), or `-1` for a feature with none. */
  cdsStart: Int32Array
  cdsEnd: Int32Array
  /** `contigAt[c] .. contigAt[c + 1]` is contig `c`'s run. Length `contigs.length + 1`. */
  contigAt: Int32Array
  /**
   * The longest feature on each contig.
   *
   * The rows are sorted by *start*, so a feature that begins before the window
   * can still end inside it, and a binary search for `start >= lo` would miss
   * exactly the long genes a reader is most likely to be looking at. Backing the
   * search off by this much is what makes the query correct, and keeping it per
   * contig is what stops one megabase-long feature from making every query on
   * every other contig scan from its start.
   */
  maxSpan: Int32Array
}

/**
 * Two intervals per row — a bedpe, and the only thing that is one.
 *
 * Not indexed, and deliberately: a loop call set is thousands of rows, not
 * millions, and the drawing pass culls by the visible window in one linear scan
 * that costs less than the binary searches it would replace. If a caller ever
 * arrives with a million pairs, this is the place to add the index, not the
 * place to have pre-emptively added it.
 */
export interface PairSet {
  contigs: string[]
  length: number
  contig1: Int32Array
  start1: Int32Array
  end1: Int32Array
  contig2: Int32Array
  start2: Int32Array
  end2: Int32Array
  /** `NaN` where the file carries no score column. */
  score: Float32Array
  name: string[]
  detail: string[]
}

/** A parsed text annotation, as it crosses the worker boundary. */
export type AnnotationPayload =
  | { kind: 'features'; data: FeatureSet }
  | { kind: 'pairs'; data: PairSet }

// ---------------------------------------------------------------------------
// bigWig samples
// ---------------------------------------------------------------------------

/**
 * One track's values over one requested region, at whatever resolution the
 * file's own zoom ladder supplied.
 *
 * `min`/`max` are present only for a summary level; at base resolution the
 * value *is* the extremum and duplicating it would be two more megabytes to
 * carry the same numbers. A drawing that wants a min/max band asks whether they
 * are there.
 */
export interface TrackSamples {
  /** The region this covers, echoed back so a late reply can be discarded. */
  contig: string
  start: number
  end: number
  /** Interval bounds, 0-based half-open, ascending and non-overlapping. */
  starts: Int32Array
  ends: Int32Array
  values: Float32Array
  min: Float32Array | null
  max: Float32Array | null
  /** `true` when these came from a zoom level rather than from base resolution. */
  summary: boolean
}

// ---------------------------------------------------------------------------
// FASTA residues
// ---------------------------------------------------------------------------

/**
 * The bases of one window, as they crossed the worker boundary.
 *
 * One ASCII byte per residue, exactly as the file wrote them — case included,
 * since a soft-masked genome says something by writing its repeats in lower
 * case. Never a whole sequence: this is only ever asked for at a zoom where
 * single bases are drawable, which is a few thousand of them.
 */
export interface BaseRegion {
  contig: string
  /** 0-based, half-open, as every window here is. */
  start: number
  end: number
  bases: Uint8Array
}

/** Everything one `sample` request answers, plus what it cost to answer it. */
export interface TrackSampleSet {
  /** Bases per pixel the samples were chosen for; the cache key. */
  basesPerPixel: number
  regions: TrackSamples[]
  /** Value extent across every region returned, ignoring NaN. `null` if empty. */
  extent: { min: number; max: number } | null
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Which edge (or edges) an annotation is drawn on. Any number may be true. */
export type Placement = Record<LaneEdge, boolean>

/** Nothing drawn anywhere — the base every placement is built from. */
export function noPlacement(): Placement {
  return { top: false, right: false, bottom: false, left: false }
}

/** A placement drawn on exactly one edge. */
export function placementOn(edge: LaneEdge): Placement {
  return { ...noPlacement(), [edge]: true }
}

/**
 * A stored placement, made whole.
 *
 * A session written before the top and left stacks existed carries two of the
 * four keys, and `undefined` is falsy enough that nothing would visibly break —
 * but a record with missing keys is one every `Object.entries` over it counts
 * wrong, and this is the one door those values come in through.
 */
export function normalisePlacement(placement: Partial<Placement> | undefined): Placement {
  const base = noPlacement()
  if (placement === undefined) return base
  for (const edge of LANE_EDGES) base[edge] = placement[edge] === true
  return base
}

/** How a value track is resolved into ink. */
export type TrackMode = 'line' | 'area' | 'bar'

/** A clip on the value axis. `auto` recomputes from what is in view. */
export interface Limits {
  auto: boolean
  min: number
  max: number
}

/** How an on-map segment is drawn: a line across the diagonal, or a box on it. */
export type OverlayShape = 'border' | 'element'

/**
 * Everything the settings row for one annotation controls.
 *
 * One flat record for all four kinds rather than a discriminated union per kind:
 * the fields that do not apply are simply not offered by the card, the store
 * stays a plain serialisable object, and adding a control to one kind does not
 * mean widening a union that three other call sites switch on.
 */
export interface AnnotationStyle {
  colour: string
  /** Lane thickness in CSS pixels — the height of a bottom lane, width of a right one. */
  size: number
  mode: TrackMode
  limits: Limits
  /**
   * Autoscale group. Tracks sharing a non-empty name resolve to one pair of
   * limits over the union of what they show, which is the only way two tracks
   * can be compared by eye. `''` means this track scales alone.
   */
  group: string
  shape: OverlayShape
  /** Radius of an off-diagonal pair circle, in CSS pixels. */
  radius: number
  opacity: number
  /**
   * Draw the value axis upside down, floor at the top.
   *
   * For the half of an experiment that is measured downwards. A stranded
   * RNA-seq pair is the case that asks for it: the forward strand read up from
   * a shared baseline and the reverse read *down* from it is one picture of one
   * locus, and two tracks both growing upwards is two pictures the reader has to
   * mirror in their head. It is a property of the track rather than of the group
   * because only one member of the pair is flipped.
   */
  flip: boolean
}

/**
 * The defaults a freshly dropped file starts with.
 *
 * The lane height is what a track is *read* at rather than what fits the most
 * of them on a screen: at 44 pixels a coverage profile is a smear with a
 * skyline, and the peaks that matter are three pixels apart. Ninety is about
 * where a yeast ATAC track starts showing the shape of a promoter, and a stack
 * that then runs off the bottom is what "fit tracks into the space" is for.
 */
export function defaultStyle(kind: AnnotationKind, colour: string): AnnotationStyle {
  return {
    colour,
    // The 4C strip opens at 68 rather than at a track's 90: it is a reading of
    // the picture beside it rather than a track in its own right, and it should
    // not take a third of the map's height the moment it is switched on.
    size:
      kind === 'track'
        ? 90
        : kind === 'gtf'
          ? 92
          : kind === 'sequence'
            ? 46
            : kind === 'viewpoint'
              ? 68
              : 16,
    mode: kind === 'sequence' ? 'line' : 'area',
    // GC content is a fraction, and a fraction has an axis whether or not this
    // window happens to use all of it. Autoscaling it would make the same
    // sequence look different in two views and put "0.41 – 0.44" under a line
    // that is really flat — so a sequence lane starts pinned to the whole of it.
    limits: kind === 'sequence' ? { auto: false, min: 0, max: 1 } : { auto: true, min: 0, max: 1 },
    group: '',
    shape: 'element',
    radius: 7,
    opacity: kind === 'pairs' ? 0.9 : 1,
    flip: false,
  }
}

// ---------------------------------------------------------------------------
// The loaded entry
// ---------------------------------------------------------------------------

/**
 * How many of the map's contigs this file actually mentions.
 *
 * Spec §8.2 makes this non-negotiable and it applies to every format, not only
 * to bigWig: a silent zero-overlap — a GTF using `chrI` against a map using `I`
 * — is the most likely support question there is, and it presents as "the
 * feature does not work" rather than as "these two files disagree about names".
 */
export interface ContigOverlap {
  matched: number
  /** Contigs in the map. */
  total: number
  /** Up to a handful of the map's contigs this file never mentions. */
  missing: string[]
  /** Up to a handful of this file's contigs the map has never heard of. */
  extra: string[]
}

export type AnnotationStatus = 'loading' | 'ready' | 'error' | 'detached'

/**
 * One row of one card.
 *
 * `payload` is present for the text formats, which are parsed once and then
 * live here; a bigWig has none, because its data is whatever the current view
 * asked for and it is fetched through the worker per view (§8.4).
 *
 * `detached` is the state a *local* file comes back in after a page reload: the
 * settings survived in session storage, the bytes cannot — no browser will
 * re-read a dropped file without a fresh gesture — so the row is shown with its
 * colours and limits intact and a button to point at the file again.
 */
export interface AnnotationEntry {
  id: string
  card: AnnotationCard
  kind: AnnotationKind
  /** What to call it on screen. Starts as the file name, minus its suffix. */
  label: string
  /**
   * Where this came from.
   *
   * `derived` is the case with no file behind it at all: the 4C profile is
   * computed from the block already on screen, so there is nothing to name, to
   * re-read after a reload, or to report a contig overlap against.
   */
  source: AnnotationSource | { kind: 'detached'; name: string } | { kind: 'derived'; name: string }
  /**
   * The two tracks this one is computed from, where it is computed from any.
   *
   * Ids rather than samples, because the operands are ordinary rows with their
   * own fetches and their own caches: a derived lane holds no data of its own and
   * reads whatever the two it names have in hand at the moment it is drawn
   * (`annotations/derived.ts`). Which is also why an operand that is removed
   * leaves this row unable to draw rather than wrong — `annotations/store.ts`
   * takes the derived row with it.
   */
  derivedFrom?: { a: string; b: string; op: TrackOp }
  status: AnnotationStatus
  /** Set when `status === 'error'`; the message is shown in the row. */
  error?: string
  overlap?: ContigOverlap
  /** One line under the label: "7,071 genes", "5,105 peaks", "16 contigs". */
  summary?: string
  visible: boolean
  placement: Placement
  style: AnnotationStyle
  payload?: AnnotationPayload
  /** Value extent over the whole bigWig, from its header. Seeds a manual clip. */
  fileExtent?: { min: number; max: number }
  /**
   * The feature set the browser's search reads.
   *
   * Several gene models can be *drawn* — comparing two annotations of one genome
   * is a thing people do — but a search box that answers from all of them at
   * once answers "GAL4" with four rows that differ only in which file they came
   * from. So one of them is the one being searched, marked with a filled star,
   * and the others carry an empty one that makes them it.
   */
  primary?: boolean
}

/** The part of an entry that is worth remembering across a reload (§8.6). */
export interface StoredEntry {
  id: string
  card: AnnotationCard
  kind: AnnotationKind
  label: string
  source: { kind: 'local' | 'remote'; name: string; url?: string }
  visible: boolean
  placement: Placement
  style: AnnotationStyle
  /** Which feature set the search reads; see {@link AnnotationEntry.primary}. */
  primary?: boolean
}
