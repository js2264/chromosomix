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
import { DEFAULT_DIVERGING_COLORMAP } from '../render/colormaps'
import type { TrackOp } from './derived'

/**
 * `metadata` and `classes` are the two the file itself supplies (§8.12). A
 * column of `/genomes`, `/contigs` or `/bins` is drawn against the map's own
 * cells rather than against base pairs, which is what lets one be drawn on a
 * genome × genome overview where nothing else can be — and the two kinds are
 * two *pictures* of one idea, because the ink a column deserves depends on
 * what is in it. A completeness fraction is a profile with an axis; an MGE call
 * is a run of colour with a legend, and drawn as a profile it would be a
 * barplot of the order the categories happen to be numbered in.
 */
export type AnnotationKind =
  | 'gtf'
  | 'track'
  | 'segments'
  // Called variants (§8.14). A `FeatureSet` like `segments` and `gtf` are, and
  // its own kind for the reason those two are each other's: they differ in what
  // the reader *means* by a row, and that is what decides the controls, the
  // card behind a click, and the colours the lane is drawn in. A peak has a
  // score; a variant has a REF, an ALT and a thing that happened.
  | 'variants'
  | 'pairs'
  | 'sequence'
  | 'metadata'
  | 'classes'
  // A BAM's depth (§8.13): one value per pixel, an axis, a ceiling — a track in
  // every sense except that its values are counted from reads rather than read
  // out of a file.
  | 'alignments'
  // The pile those reads make, which is a *second row* over the same file.
  //
  // Two kinds rather than two rungs of one, because they are two pictures with
  // nothing in common: one is a curve against an axis and is drawn at every
  // zoom on both surfaces, the other is a stack of rectangles that exists only
  // in the 1D browser and only once a read is wider than a pixel. Sharing a
  // lane made every question about it conditional — how tall is it, what does
  // the ceiling drag do, which band did the click land in — and a reader who
  // wanted the depth without the pile, or the pile without the depth, could ask
  // for neither.
  | 'reads'

/**
 * Which card an entry belongs to; see §8.1.
 *
 * `synthetic` is the interesting one (§18.5). An analysis that produces one
 * value per bin has produced a track, and a track belongs on the map rather than
 * in the drawer it was computed in. Its rows are `kind: 'track'` and are
 * indistinguishable from a loaded bigWig from the renderer down — what makes
 * them their own *card* is only that they are grouped under one heading and
 * carry an export row the loaded tracks have no use for.
 *
 * There was a fourth, `viewpoint`, for the virtual 4C lane that shift-drag used
 * to create: a reading of the picture rather than a file, belonging to no card,
 * remembered nowhere. The 4C *task* answers the same question from the file, so
 * the lane and its card are gone and the gesture is a 1D zoom (§18.9).
 */
export type AnnotationCard = 'linear' | 'overlay' | 'synthetic' | 'metadata'

/**
 * Where the bytes come from. The same two-case split as the reader's
 * `SourceSpec` (§6.1), and for the same reason: a dropped `File` is handed
 * around by reference and never uploaded (§11), a URL is fetched in ranges.
 *
 * `index` is the sidecar — a `.tbi`, a `.bai` or a `.csi` — and it lives *here*
 * rather than being handed to the loader alongside the source, because a
 * sidecar is not a fact about one load: it is part of how these bytes are
 * reached. Every road that carries a source forward therefore carries the index
 * with it, which is the difference between a BAM that survives a resolution
 * change and one that comes back refusing to open (§8.13). It is never
 * persisted — a `File` cannot be — so a restored row asks for the pair again.
 */
export type AnnotationSource =
  | { kind: 'local'; file: File; name: string; index?: File }
  | { kind: 'remote'; url: string; name: string; index?: string }
  | ComputedSource
  | MetadataSource

/**
 * A column of the open file's own tables (§8.12).
 *
 * The one source with no bytes of its own to name, and the only one that comes
 * back from a reload **whole**: a dropped file cannot be re-read without a
 * gesture and a computed profile has to be worked out again, but a metadata
 * column is in the file that is open, so restoring the row is re-reading two
 * strings. There is therefore no `detached` state on this road and no
 * Recompute button — the row simply draws.
 *
 * `table` and `column` rather than a joined string, because they are two
 * questions with two answers: which of the file's tables, and which of its
 * columns. A file that has since lost the column leaves the row saying so
 * (`ui/MetadataCard.ts`), which is the one thing a joined string could not do
 * without being taken apart again.
 */
export interface MetadataSource {
  kind: 'metadata'
  /** `contigs/mge_class` — what the row writes when it names its origin. */
  name: string
  table: 'genomes' | 'contigs' | 'bins'
  column: string
}

/**
 * A lane an analysis produced rather than a file (§18.5).
 *
 * It carries a **recipe** and not the numbers. A per-bin vector over a
 * metagenome is megabytes and session storage is not for that, so what survives
 * a reload is the task and everything it would need to be run again — and the
 * row comes back `detached` with a **Recompute** button, which is precisely the
 * state a dropped local file returns in and for precisely the same reason
 * (§8.6). An exported session therefore hands a colleague the analysis rather
 * than a number they have to take on trust.
 *
 * `recipe` is deliberately an opaque JSON record rather than the analysis
 * layer's own `Params` and `AnalysisFraming`. Those types describe an analysis
 * and this module describes an annotation; importing them here would make the
 * annotation layer depend on the analysis layer, when the true dependency runs
 * the other way. The analysis side is the one that knows the shape and is the
 * only thing that reads it back.
 */
export interface ComputedSource {
  kind: 'computed'
  name: string
  /** Task id, so the row can say what made it. */
  task: string
  /** Everything needed to run it again: parameters, framing, task version. */
  recipe: Record<string, unknown>
  /** `chrIV:1–1,531,933 at 1 kb, balanced` — the row's second line. */
  framing: string
}

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
  return (
    kind === 'track' || kind === 'sequence' || kind === 'metadata' || kind === 'alignments'
  )
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
  return kind === 'track' || kind === 'metadata' || kind === 'alignments'
}

/**
 * Whether a lane of this kind is filled from the annotations worker's `sample`.
 *
 * The question `BrowserView.fill` and `AnnotationLanes.buildEdge` ask before
 * they go and fetch anything, and it used to be spelled `kind !== 'track' &&
 * kind !== 'sequence'` at both. That is the most dangerous shape a kind test
 * takes here, because a kind missing from it is not drawn *badly* — it is not
 * drawn at all, and the lane is simply empty with no error anywhere.
 *
 * `metadata` is deliberately not in this list even though it draws a profile
 * and has a movable axis: its values are columns of the open file's own tables
 * and come from `cellsFor`, not from the worker (§8.12). Two roads to a
 * profile, and this names the one that goes over the wire.
 *
 * `reads` is not in it either, and for a third reason: it goes over the wire,
 * but by its own request. A `sample` answers one number per pixel and a pile is
 * not a number per pixel, so the road is `reads` — see `ReadCache`.
 */
export function drawnFromSamples(kind: AnnotationKind): boolean {
  return kind === 'track' || kind === 'sequence' || kind === 'alignments'
}

/**
 * Every {@link AnnotationKind}, once.
 *
 * A union cannot be enumerated at run time, so somewhere a list has to be
 * written out — and it was written out three times: in the store's stored-row
 * validator, in the kind tests, and very nearly in the analysis form. Three
 * copies of a list whose whole job is to be complete is three chances for a new
 * kind to be missing from one of them, which is the silent failure
 * `annotation-kinds.test.ts` exists to catch.
 *
 * The `satisfies` is what makes this a *check* rather than a fourth copy: a
 * kind added to the union and not to this array fails to compile here, and one
 * here that is not in the union fails too.
 */
export const ANNOTATION_KINDS = [
  'gtf',
  'track',
  'segments',
  'variants',
  'pairs',
  'sequence',
  'metadata',
  'classes',
  'alignments',
  'reads',
] as const satisfies readonly AnnotationKind[]

/**
 * Whether this kind is a set of intervals a task can aggregate over.
 *
 * A gene model, a peak set and a variant set are one shape and three meanings
 * (§8.1, §8.14): they are all `FeatureSet`s, and which one a file is depends on
 * what the reader means by a row rather than on anything a task cares about.
 * Every task that takes "a BED or a GTF" takes all three.
 *
 * A function rather than a list spelled at each site, for the reason
 * {@link hasTrackControls} is one and in the same words: four literals is not a
 * rule, it is a rule spelled four times. It was spelled four times here — the
 * form picker's `kindsFor`, and the availability gates of overlap, metaplot and
 * APA — and adding `variants` to the first without the other three produced
 * exactly the failure that shape produces: a task whose parameter would accept
 * a VCF, sitting behind a gate that would not open for one, telling the reader
 * to *load a BED or a GTF* while a variant set was on screen.
 */
export function isIntervalSet(kind: AnnotationKind): boolean {
  return kind === 'gtf' || kind === 'segments' || kind === 'variants'
}

/**
 * Whether this kind reads a BAM, and so carries a {@link ReadStyle}.
 *
 * The two rows an imported BAM makes: the depth and the pile. They are one
 * file, one open handle in the worker and one set of filters — a minimum
 * mapping quality applied to the pile and not to the depth under it would be
 * two pictures of two different files under one name — so everything that is
 * about *which reads count* is asked of both through this.
 */
export function readsAlignments(kind: AnnotationKind): boolean {
  return kind === 'alignments' || kind === 'reads'
}

/**
 * Whether a lane of this kind gets the *whole* set of a track's controls:
 * typed limits, autoscale-group membership, the mode and flip switches, and the
 * ceiling drag.
 *
 * A third predicate rather than a fourth spelling of `kind === 'track'`, and it
 * is here because those four behaviours were gated by that literal at four
 * scattered call sites — `store.scaleGroups`, two arms of `AnnotationCard`, and
 * `BrowserView.scalableLane`. Four literals is not a rule, it is a rule spelled
 * four times, and the way it fails is instructive: setting
 * {@link hasAMovableAxis} reaches none of them, so a new kind gets a ceiling
 * drag that works beside the map and silently does nothing in the browser.
 *
 * Deliberately narrower than {@link hasAMovableAxis}. A metadata column may be
 * rescaled and may not join a group: it is a column of the open file rather
 * than a measurement, and putting one on a shared axis with a bigWig would be
 * asserting they are in the same units.
 */
export function hasTrackControls(kind: AnnotationKind): boolean {
  return kind === 'track' || kind === 'alignments'
}

/** Whether this kind is one of the file's own columns (§8.12). */
export function isMetadata(kind: AnnotationKind): boolean {
  return kind === 'metadata' || kind === 'classes'
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
   * The **accession** behind the name, where the format carries one: a GTF or
   * GFF gene id.
   *
   * Its own array rather than the first field of {@link detail}, because it is
   * asked three questions the other attributes are not. It is what a reader
   * types into the search box — half of genomics addresses its genes by
   * systematic id and the other half by symbol, and often the same reader in one
   * afternoon. It is what they copy out of the feature card, which is why the
   * card writes `gene ID:` beside it rather than leaving it as one unlabelled
   * part of a joined string. And it is what tells the two apart when a file gives
   * a gene both: `name` is the symbol and this is the accession.
   *
   * `''` for a format with no such notion (a BED name is the only name there is)
   * and for a gene the file names but does not identify. **`name === id` means
   * the file gave no symbol** — the display name has fallen back to the
   * accession — and that is the one convention worth stating here, because it is
   * what stops the feature card printing the same string on two lines.
   */
  id: string[]
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
  /**
   * The share of {@link values} that disagrees with a reference, or `null`.
   *
   * Only an alignment lane ever carries this, and only where a FASTA covering
   * the window is open in the same session and the bins are narrow enough for
   * "there is a variant here" to name a place (§8.13). Same units and same
   * intervals as `values`, so the ratio of the two is the non-reference
   * fraction.
   *
   * `null` rather than zeros wherever there was nothing to compare against:
   * "these reads agree with the reference" and "no reference was loaded" are
   * different claims, and an array of zeros would draw them alike.
   */
  variant: Float32Array | null
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
  /**
   * Why there is nothing here, when there is nothing here.
   *
   * Every other kind answers this question by not being asked it: a bigWig has
   * zoom levels all the way out, a FASTA is held whole, a computed vector spans
   * whatever it was computed over. An alignment file has none of those, so a
   * window can be *legitimately unanswerable* — too many bytes to read at this
   * width — and an empty lane and a lane over a region with no reads in it
   * would otherwise look identical (§8.13).
   *
   * A sentence for the reader, not a code: it goes under the lane's name, and
   * the doctrine at §10 is that a refusal names the actual state and the
   * concrete fix. Absent means the answer is simply the answer.
   */
  note?: string
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Which edge (or edges) an annotation is drawn on. Any number may be true. */
export type Placement = Record<LaneEdge, boolean>

/** Nothing drawn on any edge — the base every placement is built from. */
export function emptyPlacement(): Placement {
  return { top: false, right: false, bottom: false, left: false }
}

/** A placement drawn on exactly one edge. */
export function placementOn(edge: LaneEdge): Placement {
  return { ...emptyPlacement(), [edge]: true }
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
  const base = emptyPlacement()
  if (placement === undefined) return base
  for (const edge of LANE_EDGES) base[edge] = placement[edge] === true
  return base
}

/** How a value track is resolved into ink. */
/**
 * How a value profile is resolved into ink.
 *
 * The first three draw the value as a *position* across the lane and are the
 * three a genome browser has always had. `heatmap` draws it as a **colour**
 * instead, filling the lane's whole thickness, which trades the precision of a
 * position for the one thing a position cannot do: it costs no height. A track
 * that is unreadable at 20 pixels as a line is perfectly readable at 20 pixels
 * as a strip of colour, so a stack of them fits on a screen — which is what
 * multi-scale insulation needs and what `laneBands` divides a lane for.
 */
export type TrackMode = 'line' | 'area' | 'bar' | 'heatmap'

/** Every mode, in the order the picker offers them. */
export const TRACK_MODES: readonly TrackMode[] = ['area', 'line', 'bar', 'heatmap']

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
/**
 * What a one-signed heatmap lane draws with when nobody has chosen.
 *
 * `viridis` rather than the map's own `afmhot_r`: a lane is a thin strip beside
 * a picture that is already `afmhot_r`, and two different quantities in one
 * palette read as one. It is also the one this repository already names as
 * colour-vision-safe.
 */
export const DEFAULT_HEATMAP_LANE_COLORMAP = 'viridis'

/** The axis a track's values are drawn on. See {@link AnnotationStyle.scale}. */
export type TrackScale = 'linear' | 'log2'

/** Every scale, in the order the picker offers them. */
export const TRACK_SCALES: readonly TrackScale[] = ['linear', 'log2']

/**
 * The colormap a heatmap lane draws with: the reader's, or the data's own.
 *
 * Diverging when the values straddle zero, sequential when they do not. See
 * {@link AnnotationStyle.colormap}.
 */
export function colormapOf(
  style: { colormap?: string },
  limits: { min: number; max: number },
): string {
  if (typeof style.colormap === 'string' && style.colormap !== '') return style.colormap
  return limits.min < 0 && limits.max > 0 ? DEFAULT_DIVERGING_COLORMAP : DEFAULT_HEATMAP_LANE_COLORMAP
}

/**
 * Whether the tracks sharing a lane stack inside it instead of overlaying.
 *
 * **Heatmaps stack, they do not overlay.** Two translucent lines in one lane are
 * legible because ink adds and a reader can follow either; two translucent
 * colour maps are a third colour that means neither. So a lane whose members all
 * draw as heatmaps divides its own thickness between them — the height the
 * reader set stays the height of the *group*, which is what makes a four-scale
 * insulation set cost one lane and not four — and every other mode goes on
 * sharing the lane as it always did.
 *
 * All of them, not most: one line among three heatmaps has nowhere to be drawn
 * except across the whole lane, over the colours, and dividing the lane under it
 * would leave the line a fraction of the height its axis is labelled for. A
 * mixed lane overlays, and the reader who wanted the stack sets the odd one out.
 *
 * Here rather than in either painter because both draw it, and a rule about what
 * a lane *is* that lives in one renderer is a rule the other one drifts from —
 * which is exactly what the group modes did before `annotations/groups.ts`.
 */
export function stacksAsHeatmaps(members: ReadonlyArray<{ style: { mode: TrackMode } }>): boolean {
  return members.length > 1 && members.every((member) => member.style.mode === 'heatmap')
}

/** This lane's scale, or the linear one every lane starts on. */
export function scaleOf(style: { scale?: TrackScale }): TrackScale {
  return style.scale === 'log2' ? 'log2' : 'linear'
}

/**
 * A value as the axis draws it.
 *
 * `NaN` for anything a logarithm cannot answer for, which the renderer already
 * knows to leave as a hole. See {@link AnnotationStyle.scale}.
 */
export function onScale(value: number, scale: TrackScale): number {
  if (scale !== 'log2') return value
  return value > 0 ? Math.log2(value) : Number.NaN
}

export interface AnnotationStyle {
  /**
   * The controls only an alignment lane has (§8.13).
   *
   * Optional, so nothing else changes shape — see {@link ReadStyle}.
   */
  reads?: ReadStyle
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
   * The axis this lane's values are drawn on.
   *
   * **A display scale and nothing else** — the numbers behind the lane, and
   * every number that leaves it as a file, stay exactly as they were read or
   * computed. What changes is where a value lands between the two limits, which
   * is why the tick labels come out in the same units the axis is in and need no
   * separate handling.
   *
   * `log2` exists for the one lane that is systematically unreadable without it:
   * a ratio. On a linear axis "half" occupies the bottom half-unit and "double"
   * a whole unit above the middle — the same finding at two very different
   * sizes, with depletion squashed into a sliver against the floor. The
   * logarithm makes the two symmetric and puts *no change* on the baseline the
   * plot already draws.
   *
   * A value at or below zero has no logarithm and comes back as a **gap**, which
   * is the same answer this app gives everywhere a log would be an infinity: a
   * `-Infinity` cannot be drawn between two limits, would take the axis of the
   * whole lane with it, and is not a reading. It is therefore the wrong scale
   * for a difference track, which crosses zero on purpose, and the right one for
   * a ratio, which cannot.
   *
   * Optional so that nothing else changes shape and a stored session written by
   * an older build restores unchanged — {@link scaleOf} is the one reader.
   */
  scale?: TrackScale
  /**
   * The colormap a `heatmap` lane is drawn with.
   *
   * Absent means *chosen from the data*, which is the right answer far more
   * often than a picker is: a track whose values cross zero is a departure from
   * something and wants a diverging map with its middle on the zero, and a
   * one-signed one wants a ramp. That is the same reading `resolveLimits`
   * already makes about the axis, so a lane's colours and its limits agree
   * without either being told about the other.
   *
   * Read only by a heatmap lane, and the control that sets it appears only when
   * the style is one — a colormap on a line track is a setting that does
   * nothing, which is worse than an absent one.
   */
  colormap?: string
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
    // A metadata profile is read at a glance beside the map rather than
    // studied, and there are usually several of them: 56 pixels is enough to
    // tell one MAG's contamination from its neighbour's without spending a
    // quarter of the picture on it. A categorical strip needs only enough to
    // see the colour and, where a run is wide, to write the category in it.
    size:
      kind === 'track'
        ? 90
        : kind === 'gtf'
          ? 92
          : kind === 'sequence'
            ? 46
            : kind === 'metadata'
              ? 56
              : kind === 'classes'
                ? 20
                : // A depth lane is a bigWig's picture and takes a bigWig's
                  // height. The pile beside it is a stack of rows, and 180 is
                  // about a dozen of them — enough that a heterozygous site
                  // shows two alleles rather than a coin flip. Both are what a
                  // reader *starts* at; a stored session keeps what they set.
                  kind === 'alignments'
                  ? 90
                  : kind === 'reads'
                    ? 180
                    : 16,
    // Bars, because one cell is one unit: a metadata column has a value per
    // genome, per contig or per bin and nothing in between, so a line drawn
    // through the tops of them would interpolate between two MAGs that have no
    // ground between them to interpolate over.
    mode: kind === 'sequence' ? 'line' : kind === 'metadata' ? 'bar' : 'area',
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
    // Present only where it means something, which is the whole point of it
    // being optional — see {@link ReadStyle}. `readsOf` supplies the same
    // defaults for a lane whose stored style predates this field.
    ...(readsAlignments(kind) ? { reads: defaultReadStyle() } : {}),
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
  /**
   * The **genome layer's** view of the same question (§8.5).
   *
   * Present only on a file that has one, and it is what makes the report
   * readable there. A metagenome is one co-assembly binned into MAGs, so a
   * track over it — coverage from the same BAM, an annotation of the same
   * contigs — routinely covers a handful of organisms out of fifty, and the
   * sequence counts say `412 of 20,566`, which is arithmetically true and reads
   * exactly like a file that failed to match. The number a reader wants is how
   * many *MAGs* it touches, and which.
   *
   * `matched` counts genomes with at least one sequence in the file; `total` is
   * every genome the map has; `named` is a handful of the matched ones, ready
   * to print.
   */
  genomes?: { matched: number; total: number; named: string[] }
  /**
   * Sequences matched across two conventions whose **lengths disagree**.
   *
   * The one hole the rename (§5.9) would otherwise open in §8.2's promise. A
   * track renamed into the map's vocabulary is renamed *before* the overlap is
   * counted, so a cross-convention match then reports as a full match and this
   * warning goes quiet — which is right when the two are the same sequence and
   * a lie when they are not. An hg19 track's `MT` against an hg38 map's `chrM`
   * is the case: one name apiece, one rename, and two sequences two bases
   * apart. Named here, so the card can say so.
   *
   * Written as `asked → answered`, ready to print.
   */
  contested?: string[]
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
  /**
   * The other row over the same file, where this row has one (§8.13).
   *
   * A BAM imports as two: its depth and its pile. They are separate rows all
   * the way down — separate lanes, separate heights, either closable without
   * the other — and what this holds together is the one thing that would be a
   * lie if they drifted, *which reads are being counted*. A minimum mapping
   * quality applied to the pile and not to the depth drawn above it is two
   * pictures of two different files under one name, so `readStyleKey`'s
   * settings are written through to both (`ui/laneSettings.ts`).
   *
   * Symmetric: each row names the other. Cleared on the survivor when one of
   * them is closed, so a write-through cannot chase an id that has gone.
   */
  partner?: string
}

/** The part of an entry that is worth remembering across a reload (§8.6). */
export interface StoredEntry {
  id: string
  card: AnnotationCard
  kind: AnnotationKind
  label: string
  /**
   * `computed` carries its recipe; the other two carry only a name and a URL,
   * because the bytes behind them are not this app's to remember (§8.6).
   */
  source: {
    kind: 'local' | 'remote' | 'computed' | 'metadata'
    name: string
    url?: string
    /**
     * `remote` only: the sidecar index, where it was *named* rather than guessed.
     *
     * A guessed one (`<url>.bai`) is re-derived on every load and needs no
     * storage. A named one cannot be: `#index=` exists precisely for the URLs
     * where appending a suffix means nothing — a presigned URL, or one carrying
     * a query string — so dropping it here would make a share link and a
     * reloaded tab open a BAM this app cannot index (§8.13). A local `File`
     * still cannot be written down and is not.
     */
    index?: string
    task?: string
    recipe?: Record<string, unknown>
    framing?: string
    /** `metadata` only: which of the open file's tables, and which column. */
    table?: 'genomes' | 'contigs' | 'bins'
    column?: string
  }
  visible: boolean
  placement: Placement
  style: AnnotationStyle
  /**
   * What the session's own map does with this track, when it is not simply
   * *draw it where the track says* — and `null` when it does not draw it at all.
   *
   * ## Why the lead needs a record of its own
   *
   * Every other map's lane is written down by file, in `deck:lanes`
   * (`AnnotationStore.parkedFor`), and the lead is deliberately excluded there:
   * a `StoredLane` is keyed on the companion's URI and the lead has no such key
   * to be found under. So the two things a lane can say that a track cannot —
   * *I am not on this map* and *my range here is different* — were sayable about
   * every map in a deck except the one every session has.
   *
   * Both were losable in ordinary use. Taking a track off the lead is one press
   * of the last lit edge in the location row (`ui/lanePlacement.ts`), and every
   * analysis result computed against a starred companion is placed on that
   * companion and taken off the lead (`analysis/workspace.ts`) — after which
   * `placement` still names the edge the track *would* go on, and a restore
   * dutifully put it there. A deck of four came back with the fourth's tracks
   * stacked on the first as well.
   *
   * ## Absent is not `null`
   *
   * Three states, and conflating any two of them loses something:
   *
   * - **absent** — every config written before this field existed, and every
   *   track that is on the lead at its own placement with nothing to add. Read
   *   as *drawn on the lead, as `placement` says*, which is what those files
   *   meant and what a plain track means today.
   * - **`null`** — the lead does not draw it. `placement` is still carried,
   *   because it is the default any *new* lane of this track is given.
   * - **an object** — the lead draws it, and here is what it says differently:
   *   its own edges, and the sparse patch `LANE_OVERRIDES` allows over the
   *   track's style (`annotations/placement.ts`).
   */
  lead?: { placement: Placement; style?: Partial<Pick<AnnotationStyle, 'limits' | 'flip'>> } | null
  /** Which feature set the search reads; see {@link AnnotationEntry.primary}. */
  primary?: boolean
  /**
   * The other row over the same BAM; see {@link AnnotationEntry.partner}.
   *
   * Written down because the pair is a *decision*, not a derivation. A reader
   * who closed the pile and kept the depth must get back a lone depth row, and
   * a restore that re-derived the pairing from "this row is a BAM" would hand
   * them the pile again on every reload. Ids survive a restore intact, so the
   * link comes back pointing at the same two rows.
   */
  partner?: string
}

// ---------------------------------------------------------------------------
// Alignments: a window of reads (§8.13)
// ---------------------------------------------------------------------------

/**
 * The reads under one window, packed as parallel arrays.
 *
 * The same shape, for the same reason, as {@link FeatureSet}: twenty thousand
 * reads as an array of objects is megabytes of pointer-chasing to draw a
 * picture that is a few thousand rectangles, and none of it survives
 * `postMessage` without being copied. Everything here is a typed array or a
 * `string[]`, so `transfersFor` moves the buffers rather than cloning them.
 *
 * Unlike a `FeatureSet` this is **not** the whole file. It is one window,
 * fetched for one view and thrown away when the view moves, because a BAM has
 * no bounded whole-file form to hold (§8.13). That is also why the rows are
 * packed here rather than at paint time: row assignment depends on which *other*
 * reads are present, so packing per frame would make reads jump rows under the
 * hand.
 */
export interface ReadPile {
  /** The map's spelling for the sequence these are on. */
  contig: string
  /** The window packed, which is wider than the view by `FETCH_PAD`. */
  start: number
  end: number
  /** Number of reads. Every per-read array below is this long. */
  length: number
  /** First aligned reference base. Soft clips are *not* included. */
  refStart: Int32Array
  /** One past the last aligned reference base. */
  refEnd: Int32Array
  /** Soft-clipped bases before `refStart` and after `refEnd`, for drawing them. */
  clipStart: Int32Array
  clipEnd: Int32Array
  /** Which packed row this read is drawn in. */
  row: Int16Array
  /** The SAM flag, whole — strand, pairing and the rest are read off it. */
  flags: Uint16Array
  mapq: Uint8Array
  /**
   * Index into {@link contigs} for the mate, or `-1` where there is none.
   *
   * An index into that compact table rather than the file's own reference id:
   * see `nameMates`, which does the remapping and is also what puts the *map's*
   * spelling on the read's own sequence.
   */
  mateContig: Int32Array
  /** The mate's leftmost position, or `-1`. */
  matePos: Int32Array
  /** Observed template length; `0` where the file carries none. */
  tlen: Int32Array
  /** Index into {@link groups} — which colour this read takes. */
  group: Uint8Array
  /**
   * The other end of this template, as an index into this pile, or `-1`.
   *
   * Resolved here and not by the renderer, because it is a join over the whole
   * window and doing it per frame is a map rebuilt sixty times a second. `-1`
   * covers both "not paired" and "the mate is outside this window", which are
   * drawn the same way: a stub, not a line to nowhere.
   */
  mate: Int32Array
  /**
   * The read's CIGAR, flattened: ops `opAt[i] … opAt[i + 1]`.
   *
   * The same `n + 1` offset array a `FeatureSet` flattens its exons with. A
   * read needs its ops rather than only its extent because an insertion, a
   * deletion and a spliced gap are three different marks, and the gap in
   * particular is most of what an RNA-seq pile is *for*.
   */
  opAt: Int32Array
  opCode: Uint8Array
  opLen: Int32Array
  /**
   * Where this read disagrees with the reference, flattened the same way.
   *
   * Empty for every read when {@link ReadWindow.diffs} is `'none'` — which is
   * the common case, since neither `bwa` nor `minimap2` writes an `MD` tag by
   * default and `=`/`X` operations are rarer still.
   */
  diffAt: Int32Array
  /** Reference position of each disagreement. */
  diffPos: Int32Array
  /** The base the *read* has there, as a `BASE_CODE` value. */
  diffBase: Uint8Array
  /**
   * Contig names this pile refers to, for mates on another sequence.
   *
   * Only the ones some mate in this window actually lands on — a header's whole
   * `@SQ` list is a hundred thousand strings on a scaffolded assembly, and it
   * would be sent per window. Empty when nothing here has a mate.
   */
  contigs: string[]
  /** Category labels, indexed by {@link group}. */
  groups: string[]
  /** Read names, kept only where a reader could ask for one. `[]` otherwise. */
  names: string[]
}

/**
 * How a pile is coloured.
 *
 * Not how it is *grouped*: `place` in `bam/reads.ts` packs rows by position and
 * has never looked at the category, so the colours are interleaved down the
 * pile. A band per category is a separate feature this lane does not have, and
 * saying otherwise here was the doc describing an intention rather than a
 * function.
 *
 * Here rather than in `bam/reads.ts` because it crosses the worker boundary
 * *and* is written into a stored session: a type in either position cannot live
 * in a module that imports this one.
 */
export type ColourBy = 'strand' | 'mapq' | 'pair' | 'mate' | 'insert' | 'none'

/**
 * The controls an alignment lane has that no other kind does (§8.13).
 *
 * A nested optional record rather than fields on {@link AnnotationStyle}
 * itself. The doc there defends one flat shape for every kind, and it is right
 * to: a `mode` or a `colour` means something for all of them. These do not —
 * a MAPQ floor is meaningless on a bedGraph — and being optional means no
 * existing kind, no `defaultStyle` arm and no stored row changes shape.
 */
export interface ReadStyle {
  colourBy: ColourBy
  /** Reads below this mapping quality are not drawn, and not counted. */
  minMapq: number
  /**
   * Hide reads a pipeline marked as duplicates.
   *
   * Off by default, and that is the decision §8.13 records: marking them is a
   * pipeline's choice, and hiding them silently would make this app disagree
   * with every other reading of the same file.
   */
  hideDuplicates: boolean
  /**
   * How a template is laid out, and what is drawn between its two ends.
   *
   * `pairs` is the default and is what a paired library wants: both ends on one
   * row, joined by a dotted thread. It replaced a `pairs: boolean` that drew a
   * solid thread and left the packing to position alone — so the two ends of a
   * fragment landed on different rows at any real depth, and the thread ran
   * from one of them towards a mate that was not there. The picture read as a
   * scatter of unrelated reads.
   *
   * `fragments` fills the gap instead of threading it, for a reader who wants
   * the fragment as one object; `reads` packs every record on its own, which is
   * what a single-ended library wants and what this lane did originally.
   */
  layout: PairLayout
  /**
   * Show supplementary alignments — the other pieces of a split read.
   *
   * Off by default and separate from everything else here, because it is the
   * one switch that changes what an alignment *is*. A supplementary record is a
   * second piece of one molecule that the aligner could not place in one run:
   * across a structural breakpoint, across a fusion, or across the junction a
   * long read spans. Showing them is how a reader sees a split; counting them
   * would be counting the same molecule twice.
   *
   * So it reaches what is *drawn* and never what is *counted*: `readFilterKey`
   * deliberately does not mention it, so the depth row beside the pile never
   * sees it, and `pileOf` takes two filters so the base counts made alongside
   * the pile do not see it either.
   */
  splits: boolean
}

/** What an alignment lane starts with. */
export function defaultReadStyle(): ReadStyle {
  return {
    colourBy: 'strand',
    minMapq: 0,
    hideDuplicates: false,
    layout: 'pairs',
    splits: false,
  }
}

/**
 * One lane's read controls, whether or not its style carries any.
 *
 * The accessor every reader of the field goes through, so that `reads` being
 * optional costs one call rather than a `??` at each of a dozen sites — and so
 * that a session stored before this field existed opens with the defaults
 * instead of with `undefined` reaching a renderer.
 *
 * It does **not** validate, and that is worth being explicit about: the
 * clamping happens once, at the boundary, in `AnnotationStore.stored`. That is
 * enough only because `reads` is not among the per-map style overrides and no
 * caller resolves a lane style before reaching here. If either changes, this is
 * where {@link readStyleOf} has to be called instead.
 */
export function readsOf(style: AnnotationStyle): ReadStyle {
  return style.reads ?? defaultReadStyle()
}

/**
 * Read a stored read style back, clamping every field.
 *
 * Stored state outlives the build that wrote it and arrives from a share link,
 * so this is untrusted input: `isStoredEntry` checks that `style` is an object
 * and no more, which is enough to hand a renderer a negative MAPQ or a colouring
 * it has never heard of.
 */
export function readStyleOf(value: unknown): ReadStyle {
  const fallback = defaultReadStyle()
  if (typeof value !== 'object' || value === null) return fallback
  const row = value as Record<string, unknown>
  const by = row['colourBy']
  const mapq = row['minMapq']
  return {
    colourBy: COLOUR_BY.includes(by as ColourBy) ? (by as ColourBy) : fallback.colourBy,
    minMapq:
      typeof mapq === 'number' && Number.isFinite(mapq)
        ? Math.max(0, Math.min(255, Math.round(mapq)))
        : fallback.minMapq,
    hideDuplicates: row['hideDuplicates'] === true,
    // A session stored before this was a mode carries `pairs: false`, which
    // meant "do not join them" — which is `reads`.
    layout: PAIR_LAYOUTS.includes(row['layout'] as PairLayout)
      ? (row['layout'] as PairLayout)
      : row['pairs'] === false
        ? 'reads'
        : fallback.layout,
    splits: row['splits'] === true,
  }
}

/** Every colouring, in the order they are offered. */
export const COLOUR_BY: ColourBy[] = ['strand', 'pair', 'insert', 'mate', 'mapq', 'none']

/**
 * How the two ends of a template are laid out. See {@link ReadStyle.layout}.
 *
 * Here rather than in `render/alignments.ts` for the reason {@link ColourBy} is:
 * it is persisted into a stored session, so it cannot live in a module that
 * imports this one.
 */
export type PairLayout = 'pairs' | 'fragments' | 'reads'

/** Every layout, in the order they are offered. */
export const PAIR_LAYOUTS: PairLayout[] = ['pairs', 'fragments', 'reads']

/**
 * The style as a cache key, for the caches that hold *reads*.
 *
 * Four of the five fields are in it, because each changes what comes back: the
 * colouring decides the category column the worker sends back, and the floor,
 * the duplicate switch and the split switch decide which reads exist at all.
 *
 * `pairs` is deliberately **out**. It is the one field the worker never reads —
 * a mate thread is drawn from columns the pile already carries, so the reply is
 * byte-identical with it on or off — and putting it in the key spends a whole
 * window of BGZF decoding on a switch that only changes what the renderer does
 * with what it already has. If that ever stops being true, this is the line
 * that has to change with it.
 */
export function readStyleKey(style: ReadStyle): string {
  const flags = `${style.hideDuplicates ? 'd' : ''}${style.splits ? 's' : ''}`
  return `${style.colourBy}|${style.minMapq}|${flags}`
}

/**
 * The lane's own reading of a stored `pairs` boolean, for the one caller that
 * still has to understand the old spelling. See {@link ReadStyle.layout}.
 */
export function joinsPairs(style: ReadStyle): boolean {
  return style.layout !== 'reads'
}

/**
 * The style as a cache key, for the caches that hold *coverage*.
 *
 * Deliberately narrower than {@link readStyleKey}: depth is a count, and a
 * count does not care how the reads that made it were coloured or whether their
 * mates were joined. Using the wider key here would throw away a whole-genome
 * coverage scan every time a reader tried a different colouring — the most
 * expensive read in the application, discarded for a change that cannot move
 * the line by a pixel.
 */
export function readFilterKey(style: ReadStyle): string {
  return `${style.minMapq}|${style.hideDuplicates ? 'd' : ''}`
}

/** Where a lane's disagreements came from, or why there are none. */
export type DiffSource =
  /** The aligner wrote `=`/`X` operations, which say it outright. */
  | 'cigar'
  /** Derived from the `MD` tag against the read's own bases. */
  | 'md'
  /** Compared against a FASTA already open in this worker. */
  | 'reference'
  /** Nothing to compare against — *not* "no differences here". */
  | 'none'

/** The answer to a `reads` request: what to draw, and what was left out. */
export interface ReadWindow {
  piles: ReadPile[]
  /** Reads the window held before filtering and downsampling. */
  total: number
  /** Reads actually returned. */
  kept: number
  /** `true` when reads were dropped to fit — the lane says so (§8.13). */
  capped: boolean
  /** How many rows the packing used, so a lane can size itself. */
  rows: number
  /**
   * Where the disagreements came from.
   *
   * Surfaced rather than inferred, because "no mismatches in this window" and
   * "mismatches cannot be computed for this file" are the same empty picture
   * and must not read as the same claim.
   */
  diffs: DiffSource
  /** Why nothing was returned, when nothing was — the same contract as `TrackSampleSet.note`. */
  note?: string
}
