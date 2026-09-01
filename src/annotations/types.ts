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
  | 'pairs'
  | 'sequence'
  | 'metadata'
  | 'classes'
  // Aligned reads (§8.13). The second kind after `sequence` whose *picture*
  // changes with the zoom rather than merely its resolution — depth where a
  // pixel is a hundred bases, the pile itself where a read is wider than one —
  // and the first whose finer rungs exist only in the 1D browser, because a
  // read cannot be drawn where a pixel is a matrix bin.
  | 'alignments'

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
 */
export function drawnFromSamples(kind: AnnotationKind): boolean {
  return kind === 'track' || kind === 'sequence' || kind === 'alignments'
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
                : // An alignment lane is taller than a bigWig from the start,
                  // because it is not one band but a stack of three (§8.13):
                  // depth, the consensus, and however many rows of reads are
                  // left. At 120 the pile got four rows and the consensus a
                  // strip too thin to hold a letter, so a reader who came to
                  // look at reads spent their first gesture resizing it. A
                  // stored session keeps whatever they set instead.
                  kind === 'alignments'
                  ? 240
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
  /** Index into {@link contigs} for the mate, or `-1` where there is none. */
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
  /** Contig names this pile refers to, for mates on another sequence. */
  contigs: string[]
  /** Category labels, indexed by {@link group}. */
  groups: string[]
  /** Read names, kept only where a reader could ask for one. `[]` otherwise. */
  names: string[]
}

/** Base composition of one window, six counts per reference position. */
export interface BaseCounts {
  start: number
  /** Positions counted; `counts` is `6 × span` long. */
  span: number
  /**
   * `A C G T N -` per position, in that order — the first five are
   * {@link BASE_CODE}'s own order and the sixth is a deletion.
   *
   * One flat array rather than six, so it transfers as one buffer and a column
   * is `counts.subarray(at * 6, at * 6 + 6)`.
   */
  counts: Uint32Array
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
  /** Base composition for the consensus band, one entry per pile. */
  bases: BaseCounts[]
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
